// Synthetic recorded sessions (contracts/session.ts) for the recorded-session test (Section 13,
// Section 9.1 rule 8). Each session is a 30 fps 'tip.sample' stream from 'tracker.bright-tip' in
// caster space (aspect 16/9), following the hold-still rhythm of Section 7.4 for several casts:
//
//   tip found → hold still about 0.45 s (within 1% of the frame width) → trace at a natural pace
//   with mild noise → pause about 0.4 s → move away to the next start, or lower the wand ('tip.lost')
//
// Shapes come from the noise model in synth.ts at 0.8 of its strength (a careful caster), traced at
// 0.9 to 1.3 times the gesture's intended pace (gesturePaceMs) with uneven speed, plus tracking
// jitter of about 1.5 px at 1920 px and slight frame-time jitter with an occasional dropped frame.
// Scribbles are random wandering curves that must fizzle. Protego starts at one of its stored start
// points (see synth.ts StartMode).
//
// Every cast is checked before it is kept: the recognizer must classify it with a margin (score at
// least 0.75 and a lead of at least 0.06, or a clean stage-1 flick) under several cuts of the stroke
// and with and without a heavy One Euro filter, so a segmenter that cuts a few samples differently
// still gets the same answer. A cast that fails is drawn again with the next seed. No spell appears
// twice in a session, so learning (three casts) never changes a session's results.

import { fileURLToPath } from 'node:url';
import type { Gesture, Point, RecordedSession, SessionEvent, SessionExpectation, SpellPack } from '../../src/contracts';
import { SESSION_SCHEMA } from '../../src/contracts';
import { bbox, resample } from '../../src/kernel/geometry';
import { gesturePaceMs } from '../../src/kernel/gestures';
import { DEFAULT_ASPECT, recognize, type RecognitionCore } from '../../src/modules/recognizers/template/recognize';
import type { PreparedSpell } from '../../src/modules/recognizers/template/templates';
import { prepareSpells, spellsOf } from './packs';
import { Rng, seedFrom } from './random';
import { segmentSession, type FoundStroke } from './segment';
import { decide } from './simulate';
import { NOISE, distortGesture } from './synth';

export const SCRIBBLE = 'scribble';
export const FPS = 30;
export const ASPECT = DEFAULT_ASPECT;
export const TRACKER = 'tracker.bright-tip';
/** The shape noise of a careful caster: the simulation's model at this strength. */
export const SHAPE_NOISE = 0.8;
/** Tracking jitter per sample, caster-x units (about 1.5 px at 1920 px). */
const JITTER = 0.0008;
/** Margins every kept cast must clear (stricter than the engine's 0.72 and 0.04). */
export const MARGIN = { score: 0.75, lead: 0.06, scribbleMax: 0.64 };

/** The hold-still rhythm, ms ranges (Section 7.4). */
export const RHYTHM = {
  /** Holding still before a trace: arms after 0.3 s. */
  holdMs: [460, 540] as const,
  /** The pause after a cast's trace: ends the stroke after 0.25 s. */
  pauseMs: [480, 540] as const,
  /** The pause after a scribble, before the wand comes down. */
  scribblePauseMs: [300, 340] as const,
};

export interface SessionPlan {
  id: string;
  title: string;
  /** Spell ids in casting order; SCRIBBLE for a deliberate scribble that should fizzle. */
  steps: string[];
}

/**
 * 24 spells of the two default packs, each cast twice across six sessions and never twice in one.
 * Nox needs Lumos active, so it always follows Lumos in the same session with no Finite between.
 */
export const PLANS: SessionPlan[] = [
  { id: 'synthetic-01-core', title: 'Core charms, first round', steps: ['lumos', 'wingardium-leviosa', 'alohomora', 'accio', SCRIBBLE, 'nox', 'expelliarmus', 'stupefy', 'protego'] },
  { id: 'synthetic-02-core-further', title: 'Core and further spells', steps: ['expecto-patronum', 'reparo', 'incendio', 'aguamenti', 'petrificus-totalus', SCRIBBLE, 'impedimenta', 'riddikulus', 'revelio'] },
  { id: 'synthetic-03-further', title: 'Further spells', steps: ['finite-incantatem', 'obliviate', 'reducto', SCRIBBLE, 'arresto-momentum', 'muffliato', 'locomotor', 'engorgio', 'reducio'] },
  { id: 'synthetic-04-mixed', title: 'Mixed, with light', steps: ['lumos', 'accio', 'protego', 'reparo', 'nox', 'revelio', SCRIBBLE, 'obliviate', 'engorgio'] },
  { id: 'synthetic-05-mixed', title: 'Mixed, duelling', steps: ['stupefy', 'expelliarmus', SCRIBBLE, 'wingardium-leviosa', 'incendio', 'aguamenti', 'riddikulus', 'reducto', 'muffliato'] },
  { id: 'synthetic-06-mixed', title: 'Mixed, finishing', steps: ['alohomora', 'expecto-patronum', 'petrificus-totalus', 'impedimenta', SCRIBBLE, 'finite-incantatem', 'arresto-momentum', 'locomotor', 'reducio'] },
];

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** What one cast contributed to a session, for the report and the checks. */
export interface CastRecord {
  intended: string | null;
  /** Indices into the session's events of the traced samples. */
  traceFrom: number;
  traceTo: number;
  traceEnd: number;
  attempts: number;
  score: number;
  lead: number;
}

export interface GeneratedSession {
  session: RecordedSession;
  casts: CastRecord[];
}

/** The spells of the two default packs, prepared for checking. */
export function defaultSpells(packs: readonly SpellPack[]): { prepared: PreparedSpell[]; gestures: Map<string, Gesture> } {
  const chosen = packs.filter((p) => p.default_enabled !== false);
  return { prepared: prepareSpells(chosen), gestures: new Map(spellsOf(chosen).map((s) => [s.id, s.gesture])) };
}

export function generateSession(plan: SessionPlan, packs: readonly SpellPack[], seed = 1): GeneratedSession {
  const { prepared, gestures } = defaultSpells(packs);
  const events: SessionEvent[] = [];
  const casts: CastRecord[] = [];
  const clock = new FrameClock(new Rng(seedFrom(seed, plan.id, 'clock')), 520);
  const motion = new Rng(seedFrom(seed, plan.id, 'motion'));
  let pos: Point | null = null;

  plan.steps.forEach((step, index) => {
    // Draw the cast (shape, size, place, pace) until it passes the checks.
    let attempt = 0;
    let shape: Point[] = [];
    let durationMs = 0;
    let check: { score: number; lead: number } | null = null;
    for (; attempt < 60; attempt++) {
      const rng = new Rng(seedFrom(seed, plan.id, index, step, attempt));
      const drawn = step === SCRIBBLE ? scribble(rng) : drawCast(gestures.get(step)!, rng);
      shape = drawn.points;
      durationMs = drawn.durationMs;
      check = checkCast(shape, durationMs, step, prepared, rng);
      if (check) break;
    }
    if (!check) throw new Error(`${plan.id}: no acceptable cast of ${step} in 60 attempts`);

    // How the wand gets to the start: the first appearance, a move from the last cast, or the wand
    // raised back into view after a 'tip.lost'.
    const start = shape[0];
    if (!pos) {
      appear(events, clock, start, motion);
    } else if (events[events.length - 1]?.type === 'tip.lost') {
      clock.skip(motion.uniform(600, 1100));
      appear(events, clock, start, motion);
    } else {
      move(events, clock, pos, start, motion);
    }
    hold(events, clock, start, motion.uniform(RHYTHM.holdMs[0], RHYTHM.holdMs[1]), motion);
    const traceFrom = events.length;
    trace(events, clock, shape, durationMs, motion);
    const traceTo = events.length - 1;
    const traceEnd = (events[traceTo] as Sample).t;
    const end = shape[shape.length - 1];
    const last = index === plan.steps.length - 1;
    // The pause that ends the stroke. After a cast it lasts 0.42 to 0.48 s: a segmenter working on
    // filtered positions sees the tip settle up to about 0.15 s late and then needs 0.25 s of
    // stillness, and the cast's 0.4 s cooldown covers the move away. After a scribble the pause is
    // short and the wand comes down, because a fizzle goes straight back to hovering (no cooldown)
    // and a tip left still there could arm again. Casters sometimes lower the wand after a cast too.
    const lower = step === SCRIBBLE || last || motion.chance(0.3);
    hold(events, clock, end, step === SCRIBBLE ? motion.uniform(RHYTHM.scribblePauseMs[0], RHYTHM.scribblePauseMs[1]) : motion.uniform(RHYTHM.pauseMs[0], RHYTHM.pauseMs[1]), motion);
    if (lower) lose(events, clock);
    pos = end;
    casts.push({ intended: step === SCRIBBLE ? null : step, traceFrom, traceTo, traceEnd, attempts: attempt + 1, score: check.score, lead: check.lead });
  });

  const expected: SessionExpectation[] = casts.map((c) => ({
    spellId: c.intended,
    // About when the trace ends (Stroke.t1, which SpellCast.t carries), a little later for the
    // filter's lag; the decision itself comes about segmenter.pauseMs after that.
    t: Math.round(c.traceEnd + 150),
    ...(c.intended ? { intended: c.intended } : {}),
    decided: c.intended,
  }));

  const session: RecordedSession = {
    schema: SESSION_SCHEMA,
    id: plan.id,
    title: `Synthetic: ${plan.title}`,
    recordedAt: '2026-11-20T00:00:00.000Z',
    tracker: TRACKER,
    aspect: ASPECT,
    pen: false,
    settings: { 'spells.unlockAll': true },
    enabledSpells: prepared.map((s) => s.spellId),
    camera: { label: 'Synthetic camera (gesture lab)', width: 1920, height: 1080, fps: FPS },
    events,
    expected,
  };
  return { session, casts };
}

// ------------------------------------------------------------------------------------- drawing

/** A cast's shape in caster space (start to end) and how long it takes to trace. */
function drawCast(gesture: Gesture, rng: Rng): { points: Point[]; durationMs: number } {
  const flick = 'flick' in gesture;
  // Dense shape without per-sample jitter: the tracker's jitter is added per frame.
  const iso = distortGesture(gesture, rng, SHAPE_NOISE, { ...NOISE, jitter: 0 }, 240);
  // A comfortable size: the larger side 32% to 45% of the frame's height (flicks a little longer).
  const size = flick ? rng.uniform(0.36, 0.5) : rng.uniform(0.32, 0.45);
  const points = place(iso, size, rng);
  const pace = gesturePaceMs(gesture);
  const durationMs = Math.min(3600, pace * rng.uniform(0.9, 1.3));
  return { points, durationMs };
}

/** A scribble: a smooth curve wandering through random points, long enough to be evaluated. */
function scribble(rng: Rng): { points: Point[]; durationMs: number } {
  const n = rng.int(6, 9);
  const ctrl: Point[] = [];
  for (let i = 0; i < n; i++) ctrl.push([rng.uniform(0, 1), rng.uniform(0, 1)]);
  const iso = resample(catmullRom(ctrl, 24), 240);
  const points = place(iso, rng.uniform(0.35, 0.45), rng);
  return { points, durationMs: rng.uniform(1600, 2600) };
}

/** Scale an isotropic shape so its larger side is `size` of the frame height, and put it somewhere
 *  near the middle of the frame, in caster space. */
function place(iso: readonly Point[], size: number, rng: Rng): Point[] {
  const b = bbox(iso);
  const side = Math.max(b.w, b.h) || 1;
  const s = size / side;
  const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
  const cx = rng.uniform(0.4, 0.6), cy = rng.uniform(0.38, 0.52);
  return iso.map(([x, y]) => [cx + ((x - mx) * s) / ASPECT, cy + (y - my) * s] as Point);
}

function catmullRom(pts: readonly Point[], perSegment: number): Point[] {
  const out: Point[] = [];
  const p = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)) as Point);
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// ------------------------------------------------------------------------------------- the stream

/** Camera frame times: 30 fps with a little jitter and an occasional dropped frame. */
class FrameClock {
  frame = 0;
  t: number;
  private base: number;
  constructor(private rng: Rng, startMs: number) {
    this.base = startMs;
    this.t = startMs;
  }
  /** Advance to the next delivered frame. */
  next(): { t: number; frame: number } {
    this.frame += this.rng.chance(1 / 90) ? 2 : 1;
    const nominal = this.base + (this.frame * 1000) / FPS;
    this.t = Math.max(this.t + 5, nominal + this.rng.normal(0.6));
    return { t: round(this.t, 1), frame: this.frame };
  }
  /** Let time pass with no frames delivered to the stream (tip out of view). */
  skip(ms: number): void {
    this.frame += Math.round((ms * FPS) / 1000);
    this.t = this.base + (this.frame * 1000) / FPS;
  }
}

function sample(events: SessionEvent[], clock: FrameClock, p: Point, rng: Rng, jitter = JITTER): void {
  const f = clock.next();
  events.push({
    type: 'tip.sample',
    t: f.t,
    x: round(p[0] + rng.normal(jitter), 5),
    y: round(p[1] + rng.normal(jitter * ASPECT), 5),
    conf: round(Math.min(1, Math.max(0.6, 0.92 + rng.normal(0.03))), 3),
    size: round(0.0018 + rng.normal(0.00015), 5),
    frame: f.frame,
  });
}

/** The tip comes into view: 'tip.found' just before the first sample, with the same t. */
function appear(events: SessionEvent[], clock: FrameClock, p: Point, rng: Rng): void {
  sample(events, clock, p, rng);
  const s = events.pop() as Extract<SessionEvent, { type: 'tip.sample' }>;
  events.push({ type: 'tip.found', t: s.t, x: s.x, y: s.y, conf: s.conf, frame: s.frame }, s);
}

/** Holding still: a slow drift of about a millimetre plus the tracker's jitter, well inside 1% of the
 *  frame width. */
function hold(events: SessionEvent[], clock: FrameClock, p: Point, ms: number, rng: Rng): void {
  const t0 = clock.t;
  const phase = rng.uniform(0, 2 * Math.PI);
  const amp = rng.uniform(0.0005, 0.0015);
  while (clock.t - t0 < ms) {
    const k = (clock.t - t0) / 1000;
    sample(events, clock, [p[0] + amp * Math.sin(2 * Math.PI * 1.3 * k + phase), p[1] + amp * Math.cos(2 * Math.PI * 0.9 * k + phase)], rng, JITTER * 0.6);
  }
}

/** Trace a shape over durationMs: the shape is already spaced by the hand's uneven pace, so equal
 *  steps in time are equal steps along its points. The frame that lands past the end shows the end. */
function trace(events: SessionEvent[], clock: FrameClock, shape: readonly Point[], durationMs: number, rng: Rng): void {
  const t0 = clock.t;
  const n = shape.length - 1;
  for (;;) {
    const before = events.length;
    sample(events, clock, [0, 0], rng);
    const s = events[before] as Extract<SessionEvent, { type: 'tip.sample' }>;
    const u = Math.min(1, (s.t - t0) / durationMs) * n;
    const i = Math.min(n - 1, Math.floor(u));
    const k = u - i;
    const x = shape[i][0] + k * (shape[i + 1][0] - shape[i][0]);
    const y = shape[i][1] + k * (shape[i + 1][1] - shape[i][1]);
    s.x = round(x + rng.normal(JITTER), 5);
    s.y = round(y + rng.normal(JITTER * ASPECT), 5);
    if (s.t - t0 >= durationMs) break;
  }
}

/**
 * Move the wand to the next start: a sideways arc (never doubling back, so the tip never stops on
 * the way), at a speed that starts and ends at 30% of its mean and never reaches zero, so the move
 * can never pass for a hold and arm the segmenter. Distances are measured in frame widths.
 */
function move(events: SessionEvent[], clock: FrameClock, from: Point, to: Point, rng: Rng): void {
  // Work in a space where both axes are in frame widths: (x, y ÷ aspect).
  const f: Point = [from[0], from[1] / ASPECT];
  const g: Point = [to[0], to[1] / ASPECT];
  const dx = g[0] - f[0], dy = g[1] - f[1];
  const dist = Math.hypot(dx, dy);
  const side = rng.chance(0.5) ? 1 : -1;
  let ctrl: Point[];
  if (dist < 0.12) {
    // Close by: swing out and back in, like lowering the wand a little between casts.
    const a = rng.uniform(0, 2 * Math.PI);
    const r = rng.uniform(0.12, 0.18);
    ctrl = [f, [f[0] + r * Math.cos(a), f[1] + r * Math.sin(a)], [g[0] + r * Math.cos(a + side * 0.6), g[1] + r * Math.sin(a + side * 0.6)], g];
  } else {
    const px = (-dy / dist) * side, py = (dx / dist) * side;
    const h = rng.uniform(0.15, 0.3) * dist;
    ctrl = [f, [f[0] + dx * 0.33 + px * h, f[1] + dy * 0.33 + py * h], [f[0] + dx * 0.67 + px * h, f[1] + dy * 0.67 + py * h], g];
  }
  const path = resample(catmullRom(ctrl, 16), 200).map(([x, y]) => [x, y * ASPECT] as Point);
  const ms = rng.uniform(550, 800);
  const t0 = clock.t;
  const n = path.length - 1;
  for (;;) {
    const before = events.length;
    sample(events, clock, [0, 0], rng);
    const s = events[before] as Extract<SessionEvent, { type: 'tip.sample' }>;
    const u = Math.min(1, (s.t - t0) / ms);
    // Speed 1 − 0.7·cos(2πu) times the mean: 30% at both ends, 170% in the middle.
    const e = Math.min(1, Math.max(0, u - (0.7 * Math.sin(2 * Math.PI * u)) / (2 * Math.PI)));
    const i = Math.min(n - 1, Math.floor(e * n));
    const k = e * n - i;
    s.x = round(path[i][0] + k * (path[i + 1][0] - path[i][0]) + rng.normal(JITTER), 5);
    s.y = round(path[i][1] + k * (path[i + 1][1] - path[i][1]) + rng.normal(JITTER * ASPECT), 5);
    if (u >= 1) break;
  }
}

/** The wand goes out of view: the tracker declares 'tip.lost' after six missed frames. */
function lose(events: SessionEvent[], clock: FrameClock): void {
  const lastSeen = clock.t;
  clock.skip(6000 / FPS);
  events.push({ type: 'tip.lost', t: round(clock.t, 1), lastSeen: round(lastSeen, 1) });
}

// ------------------------------------------------------------------------------------- checking

/**
 * Check a drawn cast the way the pipeline will see it, sampled at 30 fps over its duration:
 *  - cut directly several ways: as traced; with a few hold samples before and pause samples after;
 *    two samples short at each end (a segmenter that starts or stops a little differently);
 *  - and in a small stream (hold, trace, pause, tip lost) through the lab's approximate segmenter,
 *    raw and with each filter of CHECK_FILTERS, which also decides where the stroke starts and ends.
 * Returns the weakest score and lead, or null when any version misses the margins (or the segmenter
 * does not find exactly one stroke).
 */
function checkCast(shape: readonly Point[], durationMs: number, step: string, spells: readonly PreparedSpell[], rng: Rng): { score: number; lead: number } | null {
  const frames = Math.max(2, Math.round((durationMs * FPS) / 1000));
  const n = shape.length - 1;
  const traced: Point[] = [];
  for (let f = 0; f <= frames; f++) {
    const u = (f / frames) * n;
    const i = Math.min(n - 1, Math.floor(u));
    const k = u - i;
    traced.push([shape[i][0] + k * (shape[i + 1][0] - shape[i][0]) + rng.normal(JITTER), shape[i][1] + k * (shape[i + 1][1] - shape[i][1]) + rng.normal(JITTER * ASPECT)]);
  }
  if (traced.length < 10) return null;
  const head = traced[0], tail = traced[traced.length - 1];
  const versions: Point[][] = [traced, [head, head, head, ...traced, tail, tail, tail], traced.slice(2, -2)];

  // The same trace in a stream: 0.5 s hold, the trace, 0.5 s pause, the tip lost.
  const events: SessionEvent[] = [];
  let t = 0;
  const push = (p: Point, jitter: number) => {
    t += 1000 / FPS;
    events.push({ type: 'tip.sample', t, x: p[0] + rng.normal(jitter), y: p[1] + rng.normal(jitter * ASPECT), conf: 0.95 });
  };
  for (let i = 0; i < 15; i++) push(head, JITTER * 0.6);
  for (const p of traced.slice(1)) push(p, 0);
  for (let i = 0; i < 15; i++) push(tail, JITTER * 0.6);
  events.push({ type: 'tip.lost', t: t + 200, lastSeen: t });
  for (const scale of CHECK_FILTERS) {
    const found = segmentSession(events, { aspect: ASPECT, filterScale: scale }, () => true);
    if (found.length !== 1) return null;
    versions.push(found[0].points.map((p) => [p.x, p.y] as Point));
  }

  let weakest = { score: Infinity, lead: Infinity };
  for (const v of versions) {
    const r = recognize(v, ASPECT, spells);
    if (step === SCRIBBLE) {
      if (r.candidates[0].score >= MARGIN.scribbleMax) return null;
      weakest = { score: Math.min(weakest.score, r.candidates[0].score), lead: 0 };
      continue;
    }
    const verdict = margins(r, step);
    if (!verdict) return null;
    weakest = { score: Math.min(weakest.score, verdict.score), lead: Math.min(weakest.lead, verdict.lead) };
  }
  return weakest;
}

/** The cast is the intended spell with room to spare; null otherwise. */
function margins(r: RecognitionCore, spellId: string): { score: number; lead: number } | null {
  const top = r.matches[0];
  if (!top || top.spellId !== spellId) return null;
  const lead = top.score - (r.matches[1]?.score ?? 0);
  if (top.score < MARGIN.score) return null;
  if (!(r.stage === 'flick') && lead < MARGIN.lead) return null;
  return { score: top.score, lead: r.stage === 'flick' ? Math.max(lead, MARGIN.lead) : lead };
}

/** Where the fixtures live. */
export const SESSIONS_DIR = fileURLToPath(new URL('../../tests/fixtures/sessions/', import.meta.url));

/** Filters the session check runs with: none, One Euro on pixels (almost no smoothing), One Euro on
 *  caster units (the heaviest smoothing the default settings allow). */
export const CHECK_FILTERS: (number | null)[] = [null, 1920, 1];

/** JSON with one event per line, so fixture diffs stay readable. */
export function serializeSession(s: RecordedSession): string {
  const { events, expected, ...head } = s;
  const lines = ['{'];
  for (const [k, v] of Object.entries(head)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push('  "events": [');
  lines.push(events.map((e) => `    ${JSON.stringify(e)}`).join(',\n'));
  lines.push('  ],');
  lines.push('  "expected": [');
  lines.push(expected.map((e) => `    ${JSON.stringify(e)}`).join(',\n'));
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Replay a generated session through the lab's approximate segmenter and the recognizer. Returns
 *  the decisions (spell id or null) for comparison with `expected`. */
export function replayDecisions(session: RecordedSession, spells: readonly PreparedSpell[], filterScale: number | null): { strokes: FoundStroke[]; decisions: (string | null)[] } {
  const decisions: (string | null)[] = [];
  const strokes = segmentSession(session.events, { aspect: session.aspect, filterScale }, (s) => {
    const r = recognize(s.points.map((p) => [p.x, p.y] as Point), session.aspect, spells);
    const d = decide(r.matches, 0.72, 0.04);
    decisions.push(d.spellId);
    return d.kind === 'cast';
  });
  return { strokes, decisions };
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
