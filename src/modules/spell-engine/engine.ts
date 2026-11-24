// The spell engine's state object (Section 7.7).
//
// It joins each stroke with its recognition (by stroke id, in either order), combines them with what
// the voice heard, applies the pack's rules, and returns the events to publish, in order. It never
// touches the bus, timers or the browser: the module passes `now` (the kernel clock) into every call,
// publishes what comes back, and calls tick() at nextWake(). Decisions are made on capture times
// (stroke t0/t1, incantation t0/t1); timers only wake the engine (contracts/module.ts Kernel.now).
// So every behavior here can be tested with plain numbers for time.
//
// Exactly one decision per stroke: the segmenter waits in 'evaluating' for a spell.cast or
// spell.fizzle carrying its strokeId (spell.pending asks it to wait longer).

import type {
  CastingMode, Incantation, PracticeAttempt, Recognition, RecognitionDetail, ReplayState, RequestPayload,
  SceneProps, SpellCast, SpellFizzle, Spellbook, SpellbookEntry, StageSteering, Stroke, TipSample, TrackerStatus, VoiceStatus,
} from '../../contracts';
import { KernelError, gesturePaceMs } from '../../kernel';
import type { Candidate, StrokeDecision } from './decision';
import { decideStroke, judgeGesture, rankCandidates, withLockedSpell } from './decision';
import type { HintAdvice, HintContext } from './hints';
import { adviseFizzle, adviseImprovement, needsActiveHint, strictHint, TEXT, unavailableHint } from './hints';
import type { StrokeFacts } from './measure';
import { castPower, fizzleQuality, isFlickGesture, playAreaCentre, strokeFacts, strokeQuality, VOICE_POWER, WHOLE_MIRROR } from './measure';
import type { ActiveCast } from './rules';
import { activationFor, ActiveSpells, Cooldowns } from './rules';
import { effectScaleOf, pickTarget, pickVariant, startingProps } from './targets';
import type { EngineOutput, EngineSettings } from './types';
import { clamp01, compact, DEFAULT_ASPECT, REPLAY_TRACKER_ID } from './types';
import type { HeardIncantation } from './voice-log';
import { VoiceLog, voiceWindow } from './voice-log';

/** A stroke whose recognition has not arrived by then is let go with an 'ignored' fizzle, so the
 *  segmenter (which gives up at segmenter.evaluateTimeoutMs, 1.5 s) is never left waiting. */
export const RECOGNITION_WAIT_MS = 1200;
/** A recognition whose stroke.end never came is dropped after this. The bus delivers stroke.end to
 *  every subscriber before the recognizer's answer, so this is only a safety net; with no stroke.end
 *  no segmenter is waiting for the decision. */
export const STROKE_WAIT_MS = 500;
/** Voice-only casts aim at the last filtered tip if it is younger than this (contracts/v1.ts). */
export const TIP_FRESH_MS = 1000;
/** Replays of spells that last until ended: default hold (contracts/requests.ts engine.cast). */
export const REPLAY_HOLD_MS = 4000;
export const REPLAY_HOLD_MAX_MS = 8000;
/** Finals are kept long enough for any stroke window to find them (strokes last up to 4 s). */
const HEARD_KEEP_EXTRA_MS = 6000;
/** Stroke ids remembered as decided, so a late or repeated event never makes a second decision. */
const DECIDED_MEMORY = 256;

export type EngineCastRequest = RequestPayload<'engine.cast'>;

export interface EngineCoreOptions {
  /** Current settings; read at every decision. */
  settings: () => EngineSettings;
  /** Id maker (newId from the kernel; a counter in tests). */
  newId: (prefix: string) => string;
}

type GestureMode = Exclude<CastingMode, 'voice'>;
type FinalDecision = Exclude<StrokeDecision, { kind: 'wait' }>;

/** A stroke held back in assisted or strict mode until speech arrives or `until` passes. */
interface WaitingStroke {
  stroke: Stroke;
  rec: Recognition;
  mode: GestureMode;
  until: number;
  /** The voice latency allowance has been added (it is added once). */
  extended: boolean;
}

interface RuleBlock {
  reason: 'needs-active' | 'cooldown';
  hint: string;
}

type Outcome = { kind: 'cast'; cast: SpellCast } | { kind: 'fizzle'; fizzle: SpellFizzle };

interface Job {
  at: number;
  run: () => EngineOutput[];
}

/** How many stroke.begin times the engine keeps (voiceSpan). */
const BEGINS_KEPT = 16;

export class SpellEngineCore {
  private readonly opts: EngineCoreOptions;

  // Sticky context, fed from the latest events.
  private entries = new Map<string, SpellbookEntry>();
  private props: SceneProps | null = null;
  private focus: string | null = null;
  private attempts = 0;
  private voiceState: VoiceStatus['state'] | null = null;
  private replayPlaying = false;
  private steeringCastId: string | null = null;
  private lastTip: { t: number; x: number; y: number; src?: string } | null = null;
  /** Whether the tracker running now (its latest tracker.status) is pen-style. */
  private runningPen = false;
  /** tracker.status pen, kept per tracker (contracts/events.ts tip event rule 1). */
  private penTrackers = new Map<string, boolean>();

  // Work in flight.
  private strokes = new Map<string, { stroke: Stroke; at: number }>();
  private recs = new Map<string, { rec: Recognition; at: number }>();
  private waiting = new Map<string, WaitingStroke>();
  /** Strokes from pen-style trackers, noted when they arrive: a replay sets its status back to pen
   *  false once it has played, while its last stroke may still be waiting for speech. */
  private penStrokes = new Set<string>();
  /** stroke.begin t0 by stroke id: the press of a pen stroke, which a rest after it puts before
   *  Stroke.t0. The few latest only: a press the segmenter discards never reaches stroke.end. */
  private begins = new Map<string, number>();
  private decidedIds: string[] = [];
  private decidedSet = new Set<string>();

  private readonly voice = new VoiceLog();
  private readonly active = new ActiveSpells();
  private readonly cooldowns = new Cooldowns();

  constructor(opts: EngineCoreOptions) {
    this.opts = opts;
  }

  // ------------------------------------------------------------------------------ context

  /** A new spellbook. Active spells whose entry is gone or no longer available end ('unavailable'). */
  setSpellbook(book: Spellbook | null, now: number): EngineOutput[] {
    const entries = new Map<string, SpellbookEntry>();
    for (const e of book?.spells ?? []) if (e?.spell && !entries.has(e.spell.id)) entries.set(e.spell.id, e);
    this.entries = entries;
    const out: EngineOutput[] = [];
    for (const a of this.active.list()) {
      const e = entries.get(a.spellId);
      if (!e || !e.available) out.push(this.end(a, 'unavailable', now));
    }
    return out;
  }

  setProps(props: SceneProps | null): void {
    this.props = props && Array.isArray(props.props) ? props : null;
  }

  /** Every practice.focus starts a new session: attempts count from 1 again. */
  setFocus(spellId: string | null): void {
    this.focus = typeof spellId === 'string' && spellId ? spellId : null;
    this.attempts = 0;
  }

  setVoiceStatus(status: VoiceStatus | null): void {
    this.voiceState = status?.state ?? null;
  }

  /** When a stage replay finishes, the spells it cast end with it ('replay'). */
  setReplayState(state: ReplayState | null, now: number): EngineOutput[] {
    const was = this.replayPlaying;
    this.replayPlaying = !!state?.playing;
    if (!was || this.replayPlaying) return [];
    return this.active.list().filter((a) => a.fromRequest).map((a) => this.end(a, 'replay', now));
  }

  setSteering(steering: StageSteering | null): void {
    this.steeringCastId = steering?.castId ?? null;
  }

  noteTip(tip: TipSample): void {
    if (tip && Number.isFinite(tip.t) && Number.isFinite(tip.x) && Number.isFinite(tip.y)) this.lastTip = { t: tip.t, x: tip.x, y: tip.y, src: tip.src };
  }

  /** tracker.status: whether the tracker is pen-style (mouse and touch), by Stroke.src. */
  setTrackerStatus(status: TrackerStatus | null): void {
    if (!status || typeof status.tracker !== 'string') return;
    this.penTrackers.set(status.tracker, status.pen === true);
    // The tracker the player is using now (a replay's status is not the player's).
    if (status.state !== 'stopped' && status.tracker !== REPLAY_TRACKER_ID) this.runningPen = status.pen === true;
  }

  // ------------------------------------------------------------------------------- inputs

  /** stroke.begin: a stroke is being traced. Speech begun from its start was said for it, never for
   *  the stroke decided before it (VoiceLog.began, Section 7.7). It decides nothing. */
  strokeBegin(stroke: Stroke): void {
    if (stroke) this.voice.began(stroke.t0);
    if (stroke && typeof stroke.id === 'string' && Number.isFinite(stroke.t0)) {
      this.begins.set(stroke.id, stroke.t0);
      if (this.begins.size > BEGINS_KEPT) this.begins.delete(this.begins.keys().next().value!);
    }
  }

  /** stroke.end */
  stroke(stroke: Stroke, now: number): EngineOutput[] {
    const out = this.tick(now);
    if (!stroke || typeof stroke.id !== 'string') return out;
    const id = stroke.id;
    if (this.decidedSet.has(id) || this.waiting.has(id) || this.strokes.has(id)) return out;
    // A stroke the engine will not evaluate gets its answer at once: the segmenter is waiting.
    if (this.ignoring(this.opts.settings())) {
      out.push(...this.ignore(stroke));
      return out;
    }
    if (typeof stroke.src === 'string' && this.penTrackers.get(stroke.src) === true) this.penStrokes.add(id);
    const pending = this.recs.get(id);
    if (pending) {
      this.recs.delete(id);
      out.push(...this.evaluate(stroke, pending.rec, now));
    } else {
      this.strokes.set(id, { stroke, at: now });
    }
    return out;
  }

  /** recognition.result */
  recognition(rec: Recognition, now: number): EngineOutput[] {
    const out = this.tick(now);
    // Shadow recognizers score silently (Section 9.1 rule 9).
    if (!rec || rec.shadow || typeof rec.strokeId !== 'string') return out;
    const id = rec.strokeId;
    if (this.decidedSet.has(id) || this.waiting.has(id)) return out;
    const pending = this.strokes.get(id);
    if (pending) {
      this.strokes.delete(id);
      out.push(...this.evaluate(pending.stroke, rec, now));
    } else if (!this.recs.has(id)) {
      this.recs.set(id, { rec, at: now });
    }
    return out;
  }

  /** voice.incantation */
  incantation(inc: Incantation, now: number): EngineOutput[] {
    const out = this.tick(now);
    if (!inc || !Number.isFinite(inc.t)) return out;
    // A replay owns the stage: live speech is not evaluated (contracts/events.ts ReplayState).
    if (this.replayPlaying) return out;
    const s = this.opts.settings();
    if (!inc.final) {
      this.voice.interim(inc, now);
      out.push(...this.extendWaits(now, s));
      return out;
    }
    const heard = this.voice.final(inc, now, (spellId) => this.entries.has(spellId));
    if (!heard) return out;
    if (s.mode === 'voice' && this.voiceUsable()) {
      if (heard.spellId) out.push(...this.castByVoice(heard, s, now));
      return out;
    }
    out.push(...this.reconsiderWaits(now, s));
    // Waiting strokes choose first. Otherwise a late final for the stroke just decided stays with
    // it, instead of deciding the next stroke (Section 7.7).
    this.voice.pairLate(heard, s.voiceBeforeMs, s.voiceAfterMs);
    return out;
  }

  /** Decide whatever fell due by `now`: voice deadlines, timed spells, strokes nobody recognized. */
  tick(now: number): EngineOutput[] {
    const out: EngineOutput[] = [];
    const s = this.opts.settings();
    // Earliest first, so a timed spell that ran out before a waiting stroke's deadline is no longer
    // active when that stroke is decided.
    for (let job = this.nextJob(now, s); job; job = this.nextJob(now, s)) out.push(...job.run());
    this.voice.prune(now, s.voiceBeforeMs + s.voiceAfterMs + s.voiceLatencyMs + HEARD_KEEP_EXTRA_MS);
    return out;
  }

  /** Kernel time of the next thing that will fall due, or null. */
  nextWake(): number | null {
    let next = this.active.nextDue() ?? Infinity;
    for (const w of this.waiting.values()) next = Math.min(next, w.until);
    for (const st of this.strokes.values()) next = Math.min(next, st.at + RECOGNITION_WAIT_MS);
    for (const r of this.recs.values()) next = Math.min(next, r.at + STROKE_WAIT_MS);
    return Number.isFinite(next) ? next : null;
  }

  // ----------------------------------------------------------------------------- requests

  /**
   * 'engine.cast': cast without a stroke, for replays. Variants, targeting, durations and ends apply;
   * needs_active and cooldowns do not (a replay shows what happened), and a replay never sets a
   * cooldown for live play. Spells of unavailable packs are refused, so a shared link cannot bring a
   * pack the player turned off (the restricted section) onto their stage.
   */
  cast(req: EngineCastRequest, now: number): { cast: SpellCast; out: EngineOutput[] } {
    const entry = req && typeof req.spellId === 'string' ? this.entries.get(req.spellId) : undefined;
    if (!entry) throw new KernelError('invalid-payload', `No spell '${String(req?.spellId)}' in the spellbook`);
    if (!entry.available) throw new KernelError('not-supported', `${entry.spell.incantation} is not available`);
    const out = this.tick(now);
    const s = this.opts.settings();
    const quality = clamp01(req.quality);
    const power = clamp01(req.power);
    const aim = validPoint(req.aim) ?? playAreaCentre(s.playArea);
    // variant true: the original was a variant, so keep it even if the rounded power no longer
    // reaches the band; false: it was not; absent: decide from power and quality.
    let variant = req.variant === false ? undefined : pickVariant(entry.spell.variants, power, quality);
    if (!variant && req.variant === true) variant = entry.spell.variants?.find((v) => typeof v?.label === 'string');
    const cast: SpellCast = compact({
      id: this.opts.newId('cast'),
      spellId: entry.spell.id,
      t: now,
      via: req.via === 'voice' || req.via === 'both' ? req.via : 'gesture',
      quality,
      power,
      aim,
      variant: variant?.label,
      effectScale: effectScaleOf(variant),
      targetId: typeof req.targetId === 'string' && req.targetId ? req.targetId : pickTarget(entry.spell.targets, aim, this.scene(DEFAULT_ASPECT)),
      incantation: entry.spell.incantation,
      detail: req.detail,
      replay: true,
    });
    out.push(...this.commit(cast, entry, now, replayHold(entry, req.holdMs)));
    return { cast, out };
  }

  /** 'engine.reset': end every active spell ('reset') and clear cooldowns. */
  reset(now: number): EngineOutput[] {
    const out = this.tick(now);
    for (const a of this.active.list()) out.push(this.end(a, 'reset', now));
    this.cooldowns.clear();
    return out;
  }

  /** The module stops: strokes in flight are let go ('ignored') and active spells end ('stopped'). */
  stop(now: number): EngineOutput[] {
    const out = this.tick(now);
    for (const w of [...this.waiting.values()]) out.push(...this.ignore(w.stroke));
    for (const st of [...this.strokes.values()]) out.push(...this.ignore(st.stroke));
    this.recs.clear();
    for (const a of this.active.list()) out.push(this.end(a, 'stopped', now));
    this.cooldowns.clear();
    this.voice.clear();
    return out;
  }

  /** Active spells, oldest first (diagnostics and tests). */
  activeSpells(): ActiveCast[] {
    return this.active.list();
  }

  // ----------------------------------------------------------------------------- strokes

  private evaluate(stroke: Stroke, rec: Recognition, now: number): EngineOutput[] {
    const s = this.opts.settings();
    if (this.ignoring(s)) return this.ignore(stroke);
    const cands = this.candidates(rec);
    if (!cands.length) return this.finish(stroke, rec, cands, { kind: 'fizzle', reason: 'no-candidates' }, now);
    const mode = this.effectiveMode(s);
    // While steering, never wait for speech: decide with what has been heard (see finish()).
    const decision = this.decide(stroke, rec, cands, mode, s, now, !this.steering());
    if (decision.kind === 'wait') return this.wait(stroke, rec, mode, s, now);
    return this.finish(stroke, rec, cands, decision, now);
  }

  private decide(stroke: Stroke, rec: Recognition, cands: readonly Candidate[], mode: GestureMode, s: EngineSettings, now: number, mayWait: boolean): StrokeDecision {
    // The lead margin is waived only when the flick stage produced the winner and the winner really
    // is a flick spell (a defensive check: the recognizer's stage refers to its own first candidate).
    const flickStage = rec.stage === 'flick' && !!cands[0] && isFlickGesture(this.entries.get(cands[0].spellId)?.spell.gesture);
    const verdict = withLockedSpell(
      judgeGesture(cands, flickStage, s.acceptScore, s.leadMargin),
      rec,
      (id) => { const e = this.entries.get(id); return !!e && e.available && e.status === 'locked'; },
      s.acceptScore,
      s.leadMargin,
    );
    const [, w1] = voiceWindow(stroke, s.voiceBeforeMs, s.voiceAfterMs);
    return decideStroke({
      mode,
      verdict,
      candidates: cands,
      voice: { finals: this.voice.finalsFor(this.voiceSpan(stroke), s.voiceBeforeMs, s.voiceAfterMs), inProgress: this.voice.inProgress(w1, now) },
      assistedScore: s.assistedScore,
      isEnabled: (id) => this.isEnabled(id),
      mayWait,
    });
  }

  /** Hold a stroke until speech arrives: until = t1 + voiceAfterMs, plus voiceLatencyMs when an
   *  utterance is already under way. spell.pending tells the segmenter to keep evaluating. */
  private wait(stroke: Stroke, rec: Recognition, mode: GestureMode, s: EngineSettings, now: number): EngineOutput[] {
    const [, w1] = voiceWindow(stroke, s.voiceBeforeMs, s.voiceAfterMs);
    const speaking = this.voice.inProgress(w1, now);
    const until = stroke.t1 + s.voiceAfterMs + (speaking ? s.voiceLatencyMs : 0);
    if (now >= until) {
      // The deadline had already passed when the stroke could be judged: decide now.
      const cands = this.candidates(rec);
      return this.finish(stroke, rec, cands, this.decideFinal(stroke, rec, cands, mode, s, now), now);
    }
    this.waiting.set(stroke.id, { stroke, rec, mode, until, extended: speaking });
    return [{ type: 'spell.pending', payload: { strokeId: stroke.id, until, waitingFor: 'voice' } }];
  }

  /** Decide a stroke with no further waiting (its deadline has passed). */
  private decideFinal(stroke: Stroke, rec: Recognition, cands: readonly Candidate[], mode: GestureMode, s: EngineSettings, now: number): FinalDecision {
    const d = this.decide(stroke, rec, cands, mode, s, now, false);
    // decideStroke never waits when mayWait is false; this keeps the type honest.
    return d.kind === 'wait' ? { kind: 'fizzle', reason: 'low-score', nearest: cands[0] } : d;
  }

  /** A final incantation arrived: waiting strokes may now be decidable (oldest first). */
  private reconsiderWaits(now: number, s: EngineSettings): EngineOutput[] {
    const out: EngineOutput[] = [];
    for (const w of [...this.waiting.values()]) {
      const cands = this.candidates(w.rec);
      const d = this.decide(w.stroke, w.rec, cands, w.mode, s, now, now < w.until);
      if (d.kind !== 'wait') out.push(...this.finish(w.stroke, w.rec, cands, d, now));
    }
    return out;
  }

  /** An interim result: an utterance under way buys waiting strokes the latency allowance, once. */
  private extendWaits(now: number, s: EngineSettings): EngineOutput[] {
    const out: EngineOutput[] = [];
    for (const w of this.waiting.values()) {
      if (w.extended) continue;
      const [, w1] = voiceWindow(w.stroke, s.voiceBeforeMs, s.voiceAfterMs);
      if (!this.voice.inProgress(w1, now)) continue;
      w.extended = true;
      const until = w.stroke.t1 + s.voiceAfterMs + s.voiceLatencyMs;
      if (until > w.until) {
        w.until = until;
        out.push({ type: 'spell.pending', payload: { strokeId: w.stroke.id, until, waitingFor: 'voice' } });
      }
    }
    return out;
  }

  /**
   * Turn a decision into events: the cast (after needs_active and cooldown) or the fizzle, and the
   * practice attempt. While the stage is steering a follow-the-tip spell, a stroke that casts still
   * casts (so Finite can end the spell), and anything else fizzles 'steering' without a hint.
   */
  private finish(stroke: Stroke, rec: Recognition, cands: readonly Candidate[], d: FinalDecision, now: number): EngineOutput[] {
    this.markDecided(stroke.id);
    this.waiting.delete(stroke.id);
    if (d.incantation) this.voice.consume(d.incantation);
    this.voice.decided(this.voiceSpan(stroke), d.kind === 'cast' ? d.spellId : d.nearest?.spellId, d.incantation);
    const s = this.opts.settings();
    // Pen-style trackers play in the whole mirror (contracts/settings.ts segmenter.minExtent), as the
    // segmenter measures them; a play area from Wand tuning applies to camera trackers only.
    const pen = this.penStrokes.has(stroke.id);
    this.penStrokes.delete(stroke.id);
    this.begins.delete(stroke.id);
    const facts = strokeFacts(stroke, pen ? WHOLE_MIRROR : s.playArea, rec.linearity);
    const replay = stroke.src === REPLAY_TRACKER_ID;
    // Replays never count toward progress, so they are never practice either.
    const practice = this.focus !== null && !replay;
    const steering = this.steering();
    const t = d.kind === 'cast' && d.voiceDecided && d.incantation ? Math.max(stroke.t1, d.incantation.t) : stroke.t1;
    const out: EngineOutput[] = [];
    const outcome = this.settle(stroke, rec, d, facts, t, replay, practice, steering, s, now);
    if (outcome.kind === 'cast') out.push(...outcome.events);
    else out.push({ type: 'spell.fizzle', payload: outcome.fizzle });

    // Practice grades every stroke against the practised spell, except strokes that were steering
    // or ignored (contracts/v1.ts FizzleReason).
    const skipped = outcome.kind === 'fizzle' && (outcome.fizzle.reason === 'steering' || outcome.fizzle.reason === 'ignored');
    if (practice && !skipped) out.push({ type: 'practice.attempt', payload: this.attempt(stroke, rec, cands, d, facts, outcome, s) });
    return out;
  }

  /** The cast (with the events committing it) or the fizzle a stroke decision comes to. */
  private settle(
    stroke: Stroke, rec: Recognition, d: FinalDecision, facts: StrokeFacts, t: number,
    replay: boolean, practice: boolean, steering: boolean, s: EngineSettings, now: number,
  ): (Outcome & { kind: 'cast'; events: EngineOutput[] }) | (Outcome & { kind: 'fizzle' }) {
    if (d.kind === 'fizzle') {
      const fizzle = steering
        ? this.fizzle({ t, strokeId: stroke.id, reason: 'steering', nearest: d.nearest, quality: fizzleQuality(d.nearest?.score ?? 0), practice })
        : this.strokeFizzle(stroke, rec, d, facts, t, practice, s);
      return { kind: 'fizzle', fizzle };
    }
    const nearest = { spellId: d.spellId, score: d.score };
    const entry = this.entries.get(d.spellId);
    // Candidates are filtered to enabled entries at decision time, so the entry is there; this guard
    // only covers a spellbook swapped out mid-decision.
    if (!entry) {
      return { kind: 'fizzle', fizzle: this.fizzle({ t, strokeId: stroke.id, reason: steering ? 'steering' : 'unavailable', nearest, quality: fizzleQuality(d.score), practice }) };
    }
    const block = this.ruleBlock(entry, t);
    if (block) {
      const fizzle = steering
        ? this.fizzle({ t, strokeId: stroke.id, reason: 'steering', nearest, quality: fizzleQuality(d.score), practice })
        : this.fizzle({ t, strokeId: stroke.id, reason: block.reason, nearest, hint: block.hint, quality: fizzleQuality(d.score), practice });
      return { kind: 'fizzle', fizzle };
    }
    const cast = this.strokeCast(stroke, rec, d, entry, facts, t, replay, practice, s);
    return { kind: 'cast', cast, events: this.commit(cast, entry, now) };
  }

  private strokeCast(
    stroke: Stroke, rec: Recognition, d: Extract<FinalDecision, { kind: 'cast' }>, entry: SpellbookEntry, facts: StrokeFacts,
    t: number, replay: boolean, practice: boolean, s: EngineSettings,
  ): SpellCast {
    const gesture = entry.spell.gesture;
    const quality = strokeQuality(gesture, d.score, facts);
    const power = castPower(facts, isFlickGesture(gesture), s.minExtent);
    const variant = pickVariant(entry.spell.variants, power, quality);
    const aim = { x: facts.end.x, y: facts.end.y };
    return compact({
      id: this.opts.newId('cast'),
      spellId: d.spellId,
      t,
      via: d.via,
      quality,
      power,
      aim,
      strokeId: stroke.id,
      score: d.score,
      variant: variant?.label,
      effectScale: effectScaleOf(variant),
      targetId: pickTarget(entry.spell.targets, aim, this.scene(facts.aspect)),
      incantation: entry.spell.incantation,
      detail: detailFor(rec, d.spellId),
      replay: replay || undefined,
      practice: practice || undefined,
    });
  }

  private strokeFizzle(
    stroke: Stroke, rec: Recognition, d: Extract<FinalDecision, { kind: 'fizzle' }>, facts: StrokeFacts,
    t: number, practice: boolean, s: EngineSettings,
  ): SpellFizzle {
    const nearest = d.nearest;
    const entry = nearest ? this.entries.get(nearest.spellId) : undefined;
    let advice: HintAdvice = {};
    if ((d.reason === 'low-score' || d.reason === 'ambiguous') && entry && nearest) {
      advice = adviseFizzle(this.hintContext(entry, detailFor(rec, nearest.spellId), facts, s), d.reason);
    } else if (d.reason === 'unavailable') {
      advice = { hint: unavailableHint(entry) };
    } else if (d.reason === 'strict-mismatch') {
      advice = { hint: strictHint(d.voiceIssue) };
    }
    // Graded on the nearest score (measure.ts fizzleQuality): a near miss Poor, worse Dreadful, a scribble Troll.
    return this.fizzle({ t, strokeId: stroke.id, reason: d.reason, nearest, hint: advice.hint, quality: fizzleQuality(nearest?.score ?? 0), stray: advice.stray, practice });
  }

  /**
   * A practice attempt: the stroke graded against the practised spell, with one hint. Success means
   * the decision accepted the practised spell (thresholds, flick or assisted rule, or a strict-mode
   * gesture that passed), whether or not a rule then stopped the cast (blockedBy).
   */
  private attempt(
    stroke: Stroke, rec: Recognition, cands: readonly Candidate[], d: FinalDecision, facts: StrokeFacts, outcome: Outcome, s: EngineSettings,
  ): PracticeAttempt {
    const focusId = this.focus!;
    const entry = this.entries.get(focusId);
    const detail = detailFor(rec, focusId);
    const score = cands.find((c) => c.spellId === focusId)?.score ?? clamp01(detail?.score ?? 0);
    const success =
      (d.kind === 'cast' && d.spellId === focusId) ||
      (d.kind === 'fizzle' && d.reason === 'strict-mismatch' && d.nearest?.spellId === focusId);
    const blockedBy = success && outcome.kind === 'fizzle' ? outcome.fizzle.reason : undefined;
    const ctx = entry ? this.hintContext(entry, detail, facts, s) : null;
    let quality: number;
    let advice: HintAdvice = {};
    if (success) {
      quality = outcome.kind === 'cast' ? outcome.cast.quality : entry ? strokeQuality(entry.spell.gesture, score, facts) : score;
      if (outcome.kind === 'fizzle') advice = { hint: outcome.fizzle.hint };
      else if (ctx) advice = adviseImprovement(ctx, quality);
    } else {
      // Missed, or another spell was cast: graded like a fizzle, with what to change to draw the practised one.
      quality = fizzleQuality(score);
      const ambiguous = d.kind === 'fizzle' && d.reason === 'ambiguous' && d.nearest?.spellId === focusId;
      if (ctx) advice = adviseFizzle(ctx, ambiguous ? 'ambiguous' : 'low-score');
    }
    this.attempts += 1;
    return compact({
      spellId: focusId,
      attempt: this.attempts,
      success,
      blockedBy,
      castSpellId: outcome.kind === 'cast' ? outcome.cast.spellId : undefined,
      score,
      quality,
      hint: advice.hint,
      stray: advice.stray,
      detail,
      strokeId: stroke.id,
    });
  }

  // ------------------------------------------------------------------------------- voice

  /** Voice-only mode: the incantation alone casts, aimed at the tip (if recent) or the centre. */
  private castByVoice(heard: HeardIncantation, s: EngineSettings, now: number): EngineOutput[] {
    const entry = heard.spellId ? this.entries.get(heard.spellId) : undefined;
    if (!entry) return [];
    this.voice.consume(heard);
    // No stroke to grade: the recognizer's confidence stands in for quality.
    const quality = clamp01(heard.conf);
    const practice = this.focus !== null;
    const nearest = { spellId: entry.spell.id, score: quality };
    if (!entry.enabled) {
      return [{ type: 'spell.fizzle', payload: this.fizzle({ t: heard.t, reason: 'unavailable', nearest, hint: unavailableHint(entry), quality, practice }) }];
    }
    const block = this.ruleBlock(entry, heard.t);
    if (block) {
      return [{ type: 'spell.fizzle', payload: this.fizzle({ t: heard.t, reason: block.reason, nearest, hint: block.hint, quality, practice }) }];
    }
    const aim = this.voiceAim(s, now);
    const variant = pickVariant(entry.spell.variants, VOICE_POWER, quality);
    const cast: SpellCast = compact({
      id: this.opts.newId('cast'),
      spellId: entry.spell.id,
      t: heard.t,
      via: 'voice',
      quality,
      power: VOICE_POWER,
      aim,
      variant: variant?.label,
      effectScale: effectScaleOf(variant),
      targetId: pickTarget(entry.spell.targets, aim, this.scene(DEFAULT_ASPECT)),
      incantation: entry.spell.incantation,
      practice: practice || undefined,
    });
    return this.commit(cast, entry, now);
  }

  private voiceAim(s: EngineSettings, now: number): { x: number; y: number } {
    const tip = this.lastTip;
    if (tip && Math.abs(now - tip.t) < TIP_FRESH_MS) return { x: tip.x, y: tip.y };
    // Otherwise the centre of where the player plays: the whole mirror for pen-style trackers, which
    // the play area does not apply to (contracts/settings.ts), the play area for camera trackers.
    const pen = tip?.src !== undefined ? this.penTrackers.get(tip.src) === true : this.runningPen;
    return playAreaCentre(pen ? WHOLE_MIRROR : s.playArea);
  }

  // ------------------------------------------------------------------------------- rules

  private ruleBlock(entry: SpellbookEntry, t: number): RuleBlock | null {
    const missing = this.active.missingNeeds(entry.spell);
    if (missing.length) {
      return { reason: 'needs-active', hint: needsActiveHint(missing.map((id) => this.entries.get(id)?.spell.incantation ?? id)) };
    }
    if (this.cooldowns.blocked(entry.spell, t)) return { reason: 'cooldown', hint: TEXT.cooldown };
    return null;
  }

  /**
   * Publish order for a cast that ends others (contracts/v1.ts SpellEnded): the cast first, then one
   * spell.ended per cast it ended, with byCastId. The ended casts leave the registry before the new
   * one joins, so a spell cast again replaces its earlier activation.
   */
  private commit(cast: SpellCast, entry: SpellbookEntry, now: number, replayHoldMs?: number): EngineOutput[] {
    const s = this.opts.settings();
    const fromRequest = replayHoldMs !== undefined;
    const ending = this.active.endedBy(entry.spell, this.entries);
    for (const a of ending) this.active.remove(a.spellId);
    const activation = activationFor(entry.lasts, now, s.bloomDelayMs, replayHoldMs);
    if (activation) this.active.add({ castId: cast.id, spellId: cast.spellId, since: now, ...activation, fromRequest });
    if (!fromRequest) this.cooldowns.note(cast.spellId, cast.t);
    const out: EngineOutput[] = [{ type: 'spell.cast', payload: cast }];
    for (const a of ending) {
      out.push({ type: 'spell.ended', payload: { spellId: a.spellId, castId: a.castId, t: now, by: cast.spellId, byCastId: cast.id } });
    }
    return out;
  }

  private end(a: ActiveCast, by: string, t: number): EngineOutput {
    if (this.active.get(a.spellId)?.castId === a.castId) this.active.remove(a.spellId);
    return { type: 'spell.ended', payload: { spellId: a.spellId, castId: a.castId, t, by } };
  }

  // ----------------------------------------------------------------------------- helpers

  /** The earliest job due by `now`. Expiries are listed first, so on a tie a spell ends before a
   *  stroke decided at the same moment. */
  private nextJob(now: number, s: EngineSettings): Job | null {
    const jobs: Job[] = [];
    for (const a of this.active.list()) {
      if (a.endsAt !== null) jobs.push({ at: a.endsAt, run: () => [this.end(a, a.endBy ?? 'timeout', a.endsAt!)] });
    }
    for (const w of this.waiting.values()) {
      jobs.push({
        at: w.until,
        run: () => {
          const cands = this.candidates(w.rec);
          return this.finish(w.stroke, w.rec, cands, this.decideFinal(w.stroke, w.rec, cands, w.mode, s, now), now);
        },
      });
    }
    for (const st of this.strokes.values()) jobs.push({ at: st.at + RECOGNITION_WAIT_MS, run: () => this.ignore(st.stroke) });
    for (const [id, r] of this.recs) {
      jobs.push({
        at: r.at + STROKE_WAIT_MS,
        run: () => {
          this.recs.delete(id);
          return [];
        },
      });
    }
    let best: Job | null = null;
    for (const j of jobs) if (j.at <= now && (best === null || j.at < best.at)) best = j;
    return best;
  }

  /** Where speech for a stroke may lie: its window runs from the press (stroke.begin) or Stroke.t0,
   *  whichever is earlier, so a word said at the press still counts after a rest (Section 7.7). */
  private voiceSpan(stroke: Stroke): { t0: number; t1: number } {
    const b = this.begins.get(stroke.id);
    return { t0: b !== undefined ? Math.min(b, stroke.t0) : stroke.t0, t1: stroke.t1 };
  }

  /** Let a stroke go without evaluating it (a replay is playing, voice-only mode, or nothing answered). */
  private ignore(stroke: Stroke): EngineOutput[] {
    this.begins.delete(stroke.id);
    this.markDecided(stroke.id);
    this.strokes.delete(stroke.id);
    this.recs.delete(stroke.id);
    this.waiting.delete(stroke.id);
    this.penStrokes.delete(stroke.id);
    return [{ type: 'spell.fizzle', payload: this.fizzle({ t: stroke.t1, strokeId: stroke.id, reason: 'ignored', quality: 0 }) }];
  }

  private fizzle(f: Omit<SpellFizzle, 'id' | 'practice'> & { practice?: boolean }): SpellFizzle {
    return compact({ ...f, id: this.opts.newId('fizzle'), quality: clamp01(f.quality), practice: f.practice || undefined });
  }

  private hintContext(entry: SpellbookEntry, detail: RecognitionDetail | undefined, facts: StrokeFacts, s: EngineSettings): HintContext {
    return { gesture: entry.spell.gesture, detail, facts, paceMs: gesturePaceMs(entry.spell.gesture), flickLinearity: s.flickLinearity };
  }

  /** Strokes are not evaluated while a replay plays on the stage, or in voice-only mode with voice
   *  working (its segmenter is paused; any stroke that still arrives is answered 'ignored'). */
  private ignoring(s: EngineSettings): boolean {
    return this.replayPlaying || (s.mode === 'voice' && this.voiceUsable());
  }

  /** Voice counts only while the voice module says it is ready or listening; otherwise every mode
   *  plays by gesture rules (Section 7.9: gesture play is unaffected). */
  private voiceUsable(): boolean {
    return this.voiceState === 'ready' || this.voiceState === 'listening';
  }

  private effectiveMode(s: EngineSettings): GestureMode {
    if (!this.voiceUsable()) return 'gesture';
    return s.mode === 'assisted' || s.mode === 'strict' ? s.mode : 'gesture';
  }

  private steering(): boolean {
    return this.steeringCastId !== null;
  }

  private isEnabled(spellId: string): boolean {
    return this.entries.get(spellId)?.enabled === true;
  }

  private candidates(rec: Recognition): Candidate[] {
    return rankCandidates(rec, (id) => this.isEnabled(id));
  }

  /** The shelf: the stage's latest props, or the starting shelf until it publishes them. */
  private scene(aspect: number): SceneProps {
    return this.props ?? startingProps(aspect);
  }

  private markDecided(id: string): void {
    if (this.decidedSet.has(id)) return;
    this.decidedSet.add(id);
    this.decidedIds.push(id);
    while (this.decidedIds.length > DECIDED_MEMORY) this.decidedSet.delete(this.decidedIds.shift()!);
  }
}

function detailFor(rec: Recognition, spellId: string): RecognitionDetail | undefined {
  return Array.isArray(rec.details) ? rec.details.find((d) => d?.spellId === spellId) : undefined;
}

function validPoint(p: { x: number; y: number } | undefined): { x: number; y: number } | undefined {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : undefined;
}

/** engine.cast holdMs: as given, else min(duration_ms, 8000) when the spell has one, else 4000. */
function replayHold(entry: SpellbookEntry, holdMs: number | undefined): number {
  if (typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs >= 0) return holdMs;
  const d = entry.spell.duration_ms;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return Math.min(d, REPLAY_HOLD_MAX_MS);
  return REPLAY_HOLD_MS;
}
