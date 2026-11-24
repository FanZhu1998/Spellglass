// The session recorder (Section 13: "The diagnostics overlay in the Workshop screen records sessions in
// the fixture format, so building the test set is a matter of casting each spell twenty times").
//
// Pure: the module (index.ts) feeds it bus events and kernel times; it never reads a clock itself, so it
// is tested without a kernel. The output is a RecordedSession (contracts/session.ts) that validates
// against session-1.json and plays back through the replay tracker.
//
// What is recorded, and why:
//  - Events: tip.sample, tip.found, tip.lost and voice.incantation, from any source except the replay
//    tracker (a replay is never recorded as new ground truth). Tip events come from one tracker only:
//    the one active when recording started (or the first to report, when none was). Times are capture
//    times relative to t0, the moment recording started; anything captured earlier is dropped, and when
//    the tip is already held at t0 the session opens with a tip.found at t = 0, so a replay starts in the
//    same state.
//  - Expectations: one per stroke of the recorded tracker that began after t0, at the stroke's t1
//    (SpellCast.t carries the same capture time), with its strokeId. decided is what the engine did (the
//    cast's spell, or null for a fizzle). When the caster was told which spell to cast (the intended
//    label), spellId is that spell: ground truth for the confusion matrix (Section 13). Without a label,
//    spellId is what was decided. Voice-only casts, which have no stroke, are recorded at the
//    incantation's capture time. Replayed casts never count.
//  - The tracker, its aspect, pen flag and segmentation needs (from tracker.status; the needs since
//    contracts 1.2, so that a replay segments the samples as they were segmented live), the camera (from
//    camera.status, for camera trackers), the non-default settings that shape the pipeline, and the
//    enabled spells.
// A recording is one tracker in one shape: when another tracker takes over, or the recorded tracker
// stops or changes aspect, pen mode or segmentation needs, status() says the recording must stop.

import type {
  FizzleReason, Incantation, RecordedSession, SegmentationNeeds, SessionEvent, SessionExpectation, Stroke, TipSample, TrackerStatus,
} from '../../contracts';
import { SEGMENTATION_NEED_MAX_MS, SESSION_SCHEMA } from '../../contracts';

export const REPLAY_TRACKER = 'tracker.replay';

/** Session schema bounds (session-1.json): positions -1..2, fractions 0..1, short strings. */
const POS_MIN = -1;
const POS_MAX = 2;
const MAX_TEXT = 500;
const MAX_ID = 128;
const MAX_SPELL_ID = 64;
/** ... and SegmentationNeeds.minSamples up to this. */
const MAX_MIN_SAMPLES = 1000;

/** Aspects closer than this are the same shape (rounding in different trackers). */
const ASPECT_TOLERANCE = 0.01;
/** Decisions kept while waiting for their stroke.end (which the bus normally delivers first). */
const EARLY_LIMIT = 32;

export interface RecorderStart {
  id: string;
  /** Kernel time recording started; event times are relative to it. */
  t0: number;
  recordedAt: string;
  title?: string;
  intended?: string | null;
  /** The active tracker's status at t0, if any tracker was active (not the replay tracker). */
  status: TrackerStatus | null;
  /** Where the active tracker's tip is, if it is held at t0. */
  heldTip: { x: number; y: number; conf: number } | null;
  enabledSpells?: string[];
  camera?: RecordedSession['camera'];
}

export type StopReason = 'tracker-changed' | 'tracker-stopped' | 'shape-changed';

interface ExpectationDraft {
  strokeId?: string;
  /** Relative capture time of the decision's input (stroke t1). */
  t: number;
  intended: string | null;
  /** undefined while the decision is still to come. */
  decided?: string | null;
  reason?: FizzleReason;
}

export class SessionRecorder {
  readonly id: string;
  readonly t0: number;
  private readonly recordedAt: string;
  private readonly title?: string;
  private tracker: string | null = null;
  private aspect = 16 / 9;
  private aspectKnown = false;
  private pen = false;
  /** The recorded tracker's segmentation needs, as the segmenter reads them; null for none. */
  private segmentation: SegmentationNeeds | null = null;
  private camera?: RecordedSession['camera'];
  private settings: Record<string, unknown> = {};
  private readonly enabledSpells?: string[];
  private readonly startIntended: string | null;
  private intended: string | null;
  private labelChanged = false;
  /** No more tip or voice events once stopping; decisions for recorded strokes still count. */
  private closed = false;

  private events: SessionEvent[] = [];
  private expectations: ExpectationDraft[] = [];
  private byStroke = new Map<string, ExpectationDraft>();
  /** Decisions that arrived before their stroke.end (the bus delivers them after, but join either way). */
  private early = new Map<string, { spellId: string | null; reason?: FizzleReason }>();

  constructor(start: RecorderStart) {
    this.id = start.id;
    this.t0 = start.t0;
    this.recordedAt = start.recordedAt;
    this.title = start.title?.slice(0, 200) || undefined;
    this.startIntended = start.intended ?? null;
    this.intended = this.startIntended;
    this.enabledSpells = start.enabledSpells?.slice(0, 500);
    this.camera = start.camera;
    if (start.status && start.status.tracker !== REPLAY_TRACKER && start.status.state !== 'stopped') this.adopt(start.status);
    if (this.tracker && start.heldTip) {
      const p = start.heldTip;
      this.events.push({ type: 'tip.found', t: 0, x: pos(p.x), y: pos(p.y), conf: frac(p.conf) });
    }
  }

  get recordedTracker(): string | null {
    return this.tracker;
  }

  get stopping(): boolean {
    return this.closed;
  }

  /** Strokes whose decision has not arrived yet. */
  get pending(): number {
    let n = 0;
    for (const e of this.expectations) if (e.strokeId && e.decided === undefined) n++;
    return n;
  }

  setSettings(settings: Record<string, unknown>): void {
    this.settings = { ...settings };
  }

  setCamera(camera: RecordedSession['camera'] | undefined): void {
    if (camera) this.camera = camera;
  }

  /** The intended spell changed (session.record.label). Strokes from now on carry the new label. */
  label(spellId: string | null): void {
    if (spellId === this.intended) return;
    this.intended = spellId;
    this.labelChanged = true;
  }

  /** No more events: the recording is stopping and only waits for decisions. */
  close(): void {
    this.closed = true;
  }

  /** A tracker.status. Returns why the recording must stop, or null to go on. */
  status(s: TrackerStatus): StopReason | null {
    if (this.closed || s.tracker === REPLAY_TRACKER) return null;
    if (this.tracker === null) {
      if (s.state !== 'stopped') this.adopt(s);
      return null;
    }
    if (s.tracker !== this.tracker) return s.state === 'stopped' ? null : 'tracker-changed';
    if (s.state === 'stopped') return 'tracker-stopped';
    if (!this.aspectKnown) {
      this.adopt(s);
      return null;
    }
    if (Math.abs(s.aspect - this.aspect) > ASPECT_TOLERANCE || !!s.pen !== this.pen) return 'shape-changed';
    // A replay applies one set of needs to the whole session: new ones are a new shape.
    if (!sameNeeds(needsOf(s.segmentation), this.segmentation)) return 'shape-changed';
    return null;
  }

  /** tip.found or tip.sample. `source` is the envelope's source. */
  tip(type: 'tip.found' | 'tip.sample', s: TipSample, source: string): void {
    if (!this.accepts(s.src || source, source, s.t)) return;
    const base = { t: rel(s.t, this.t0), x: pos(s.x), y: pos(s.y), conf: frac(s.conf) };
    const frame = typeof s.frame === 'number' && Number.isInteger(s.frame) && s.frame >= 0 ? { frame: s.frame } : {};
    if (type === 'tip.found') {
      this.events.push({ type, ...base, ...frame });
    } else {
      const size = typeof s.size === 'number' && Number.isFinite(s.size) ? { size: round(Math.min(1, Math.max(0, s.size)), 5) } : {};
      this.events.push({ type, ...base, ...size, ...frame });
    }
  }

  lost(p: { t: number; src: string; lastSeen?: number }, source: string): void {
    if (!this.accepts(p.src || source, source, p.t)) return;
    const lastSeen = typeof p.lastSeen === 'number' && p.lastSeen >= this.t0 ? { lastSeen: rel(p.lastSeen, this.t0) } : {};
    this.events.push({ type: 'tip.lost', t: rel(p.t, this.t0), ...lastSeen });
  }

  voice(inc: Incantation, source: string): void {
    if (this.closed || source === REPLAY_TRACKER || !Number.isFinite(inc.t) || inc.t < this.t0) return;
    if (typeof inc.text !== 'string' || typeof inc.final !== 'boolean') return;
    const e: Extract<SessionEvent, { type: 'voice.incantation' }> = {
      type: 'voice.incantation',
      t: rel(inc.t, this.t0),
      text: inc.text.slice(0, MAX_TEXT),
      conf: frac(inc.conf),
      final: inc.final,
    };
    if (typeof inc.spellId === 'string') e.spellId = inc.spellId.slice(0, MAX_SPELL_ID);
    if (typeof inc.id === 'string') e.id = inc.id.slice(0, MAX_ID);
    if (typeof inc.t0 === 'number' && inc.t0 >= this.t0) e.t0 = rel(inc.t0, this.t0);
    if (typeof inc.t1 === 'number' && inc.t1 >= this.t0) e.t1 = rel(inc.t1, this.t0);
    this.events.push(e);
  }

  /** A stroke of the recorded tracker that began after t0 becomes an expectation awaiting its decision. */
  strokeEnd(stroke: Stroke): void {
    if (this.closed || !stroke || typeof stroke.id !== 'string') return;
    if (stroke.src === REPLAY_TRACKER) return;
    if (this.tracker !== null && stroke.src !== undefined && stroke.src !== this.tracker) return;
    if (!(stroke.t0 >= this.t0) || this.byStroke.has(stroke.id)) return;
    const draft: ExpectationDraft = { strokeId: stroke.id.slice(0, MAX_ID), t: rel(stroke.t1, this.t0), intended: this.intended };
    const early = this.early.get(stroke.id);
    if (early !== undefined) {
      draft.decided = early.spellId;
      if (early.reason) draft.reason = early.reason;
      this.early.delete(stroke.id);
    }
    this.byStroke.set(stroke.id, draft);
    this.expectations.push(draft);
  }

  /** A spell.cast or spell.fizzle. decided: the cast's spell, or null for a fizzle. */
  decision(d: { strokeId?: string; spellId: string | null; t: number; replay?: boolean; reason?: FizzleReason }): void {
    if (d.replay) return;
    if (d.strokeId) {
      const draft = this.byStroke.get(d.strokeId);
      if (draft) {
        if (draft.decided === undefined) {
          draft.decided = d.spellId;
          if (d.reason) draft.reason = d.reason;
        }
      } else if (!this.closed) {
        // Most of these belong to strokes that are not recorded (a replay, another tracker): keep few.
        this.early.set(d.strokeId, { spellId: d.spellId, reason: d.reason });
        if (this.early.size > EARLY_LIMIT) this.early.delete(this.early.keys().next().value as string);
      }
      return;
    }
    // A voice-only cast: no stroke, decided at the incantation's capture time.
    if (this.closed || d.spellId === null || !(d.t >= this.t0)) return;
    this.expectations.push({ t: rel(d.t, this.t0), intended: this.intended, decided: d.spellId });
  }

  /** The recording in the fixture format. `fallbackTracker` names the tracker when none ever reported. */
  finish(fallbackTracker: string): RecordedSession {
    const events = this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map(({ e }) => e);
    const expected: SessionExpectation[] = [];
    for (const d of [...this.expectations].sort((a, b) => a.t - b.t)) {
      const spellId = d.intended ?? (d.decided === undefined ? undefined : d.decided);
      // Without a label and without a decision there is nothing to expect.
      if (spellId === undefined) continue;
      const out: SessionExpectation = { spellId: spellId === null ? null : spellId.slice(0, MAX_SPELL_ID), t: d.t };
      if (d.intended) out.intended = d.intended.slice(0, MAX_SPELL_ID);
      if (d.decided !== undefined) out.decided = d.decided === null ? null : d.decided.slice(0, MAX_SPELL_ID);
      if (d.strokeId) out.strokeId = d.strokeId;
      if (d.reason && d.decided === null) out.reason = d.reason;
      expected.push(out);
    }
    const session: RecordedSession = {
      schema: SESSION_SCHEMA,
      id: this.id,
      recordedAt: this.recordedAt,
      tracker: (this.tracker ?? fallbackTracker).slice(0, 64) || 'unknown',
      aspect: this.aspect > 0 && this.aspect <= 10 ? this.aspect : 16 / 9,
      pen: this.pen,
      // Only when the tracker asked for something: a session without needs replays as before.
      ...(this.segmentation ? { segmentation: { ...this.segmentation } } : {}),
      events,
      expected,
    };
    if (this.title) session.title = this.title;
    if (Object.keys(this.settings).length) session.settings = { ...this.settings };
    if (this.enabledSpells) session.enabledSpells = [...this.enabledSpells];
    // A single-spell recording keeps its intended spell at the top level; a relabelled one only per stroke.
    if (this.startIntended && !this.labelChanged) session.intended = this.startIntended.slice(0, MAX_SPELL_ID);
    if (this.camera && !this.pen) session.camera = this.camera;
    return session;
  }

  private adopt(s: TrackerStatus): void {
    this.tracker = s.tracker;
    if (Number.isFinite(s.aspect) && s.aspect > 0) {
      this.aspect = s.aspect;
      this.aspectKnown = true;
    }
    this.pen = !!s.pen;
    this.segmentation = needsOf(s.segmentation);
  }

  /** Tip events count from the recorded tracker only, never from a replay, never from before t0. */
  private accepts(src: string, source: string, t: number): boolean {
    if (this.closed || src === REPLAY_TRACKER || source === REPLAY_TRACKER) return false;
    if (!Number.isFinite(t) || t < this.t0) return false;
    // No tracker has reported yet: the first one to send tips is the one recorded.
    if (this.tracker === null) this.tracker = src;
    return src === this.tracker;
  }
}

/** A tracker's segmentation needs as the segmenter reads them (contracts/events.ts SegmentationNeeds):
 *  only finite numbers of zero or more count, lostMs and pauseMs held to SEGMENTATION_NEED_MAX_MS, and
 *  minSamples to the schema's bound (a need that large asks for nothing the settings do not already
 *  give). Null when none is usable. */
function needsOf(n: unknown): SegmentationNeeds | null {
  if (!n || typeof n !== 'object') return null;
  const v = n as Record<string, unknown>;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const out: SegmentationNeeds = {};
  if (ok(v.lostMs)) out.lostMs = Math.min(v.lostMs, SEGMENTATION_NEED_MAX_MS);
  if (ok(v.minSamples)) out.minSamples = Math.min(v.minSamples, MAX_MIN_SAMPLES);
  if (ok(v.pauseMs)) out.pauseMs = Math.min(v.pauseMs, SEGMENTATION_NEED_MAX_MS);
  return Object.keys(out).length ? out : null;
}

function sameNeeds(a: SegmentationNeeds | null, b: SegmentationNeeds | null): boolean {
  return a?.lostMs === b?.lostMs && a?.minSamples === b?.minSamples && a?.pauseMs === b?.pauseMs;
}

function rel(t: number, t0: number): number {
  return round(t - t0, 1);
}

function pos(v: number): number {
  return round(Math.min(POS_MAX, Math.max(POS_MIN, Number.isFinite(v) ? v : 0.5)), 5);
}

function frac(v: number): number {
  return round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)), 3);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
