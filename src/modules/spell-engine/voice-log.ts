// What the engine has heard (Section 7.7 "Combining gesture and voice").
//
// Final incantations are kept for a few seconds so a stroke can find the one spoken in its window,
// "between 2.5 s before and 1 s after the stroke" (engine.voiceBeforeMs before the stroke's start to
// engine.voiceAfterMs after stroke.t1, on the capture clock). The start is the press (stroke.begin) or
// Stroke.t0, whichever is earlier: a pen stroke that rested after the press starts where it moved, and
// a word said at the press still counts (engine.ts voiceSpan). An incantation matches when its
// speech, [t0, t1] (or just t), overlaps that window. Each incantation id serves at most one
// decision (contracts/v1.ts Incantation.id): once used it is consumed.
//
// An incantation goes with the stroke it was spoken around (Section 7.7), also when its final result
// arrives after that stroke was decided: assisted mode casts a passing gesture at once, and every
// mode decides at its deadline. The windows of two strokes in a row overlap, so the log remembers
// the last decided stroke, and whether it has had its incantation: one its decision used (agreeing
// or not), or a late final since.
//  - Until it has, speech begun before it ended never serves a later stroke (finalsFor): that may be
//    its own word, arriving late. Once it has, it has nothing left to claim, and only speech begun
//    before the stroke ahead of it ended is still held back.
//  - A late final inside its window that names the spell it cast (or came nearest to) is its own
//    incantation, and is consumed there (pairLate), unless the speech began once the next stroke had
//    begun (stroke.begin: the press of a pen stroke, the start of a hold-still one's lead-in): then it
//    was said for that stroke. Speech begun after it that names another spell is left for the next.
//
// Speech times are estimates (voice/heard.ts TIMING), off by up to a few hundred milliseconds. The
// windows are wide enough for that not to matter, except for speech that starts right where one
// stroke ends or the next begins: an error there can move it to the other stroke. That is why the
// cut-off at a stroke's end is lifted once the stroke has had its word, so a word for the next
// stroke, said at once and timed a little early, is not lost then.
//
// Interim results never decide anything; they only mark an utterance as under way, which lets a
// waiting stroke hold on for engine.voiceLatencyMs more (contracts/settings.ts).

import type { Incantation } from '../../contracts';

export interface HeardIncantation {
  /** Incantation.id, or a generated key for results without one. */
  key: string;
  /** Set only when the spellbook knows the spell. */
  spellId?: string;
  text: string;
  conf: number;
  t: number;
  /** Speech start and end on the capture clock (t when the voice module gave no estimate). */
  t0: number;
  t1: number;
  /** Kernel time it arrived (for pruning). */
  receivedAt: number;
  /** It has served a decision. */
  consumed: boolean;
}

/** The last stroke the engine decided, as the voice log needs it to pair finals with strokes. */
interface DecidedStroke {
  t0: number;
  t1: number;
  /** Where its own speech could begin (sinceFor, when it was decided). */
  since: number;
  /** The spell it cast, or the one it came nearest to. */
  spellId?: string;
  /** It has had its incantation: one served its decision (also one that disagreed), or a late
   *  final since. */
  heard: boolean;
}

/** An interim result older than this, with no final, is taken as an abandoned utterance. */
export const UTTERANCE_STALE_MS = 3000;
/** Interim results without an id share this key (their final clears it). */
const ANONYMOUS = '(no id)';
/** How many final ids to remember, so a repeated final of the same utterance is not heard twice. */
const REMEMBERED_IDS = 256;

export class VoiceLog {
  private heard: HeardIncantation[] = [];
  private finalIds: string[] = [];
  private finalIdSet = new Set<string>();
  private utterances = new Map<string, { t0: number; lastAt: number }>();
  private anonymous = 0;
  private last: DecidedStroke | null = null;
  /** When the next stroke began (began), once one has begun after the last decided stroke ended. */
  private nextBegin: number | null = null;

  /** An interim result: an utterance is under way. */
  interim(inc: Incantation, now: number): void {
    if (inc.id && this.finalIdSet.has(inc.id)) return;
    const key = inc.id ?? ANONYMOUS;
    const t0 = finite(inc.t0) ?? inc.t;
    const prev = this.utterances.get(key);
    this.utterances.set(key, { t0: prev ? Math.min(prev.t0, t0) : t0, lastAt: now });
  }

  /** A final result. Returns what was heard, or null for a repeated final of an utterance. */
  final(inc: Incantation, now: number, knownSpell: (spellId: string) => boolean): HeardIncantation | null {
    if (inc.id) {
      this.utterances.delete(inc.id);
      if (this.finalIdSet.has(inc.id)) return null;
      this.rememberId(inc.id);
    } else {
      this.utterances.delete(ANONYMOUS);
    }
    const a = finite(inc.t0) ?? inc.t;
    const b = finite(inc.t1) ?? inc.t;
    const heard: HeardIncantation = {
      key: inc.id ?? `heard-${++this.anonymous}`,
      spellId: inc.spellId && knownSpell(inc.spellId) ? inc.spellId : undefined,
      text: inc.text,
      conf: inc.conf,
      t: inc.t,
      t0: Math.min(a, b),
      t1: Math.max(a, b),
      receivedAt: now,
      consumed: false,
    };
    this.heard.push(heard);
    return heard;
  }

  /** Unconsumed finals that name a spell and whose speech overlaps [w0, w1], oldest first. */
  finalsIn(w0: number, w1: number): HeardIncantation[] {
    return this.heard.filter((h) => !h.consumed && h.spellId !== undefined && h.t0 <= w1 && h.t1 >= w0);
  }

  /** The finals a stroke may use: those in its window (voiceWindow) whose speech began where its own
   *  could begin (sinceFor), oldest first. */
  finalsFor(stroke: { t0: number; t1: number }, beforeMs: number, afterMs: number): HeardIncantation[] {
    const [w0, w1] = voiceWindow(stroke, beforeMs, afterMs);
    const since = this.sinceFor(stroke);
    return this.finalsIn(w0, w1).filter((h) => h.t0 >= since);
  }

  /** A stroke was decided: `spellId` is the spell it cast or came nearest to, `used` the incantation
   *  its decision used. Strokes are decided one at a time, in order; the one that ended last is kept. */
  decided(stroke: { t0: number; t1: number }, spellId: string | undefined, used: HeardIncantation | undefined): void {
    if (this.last && stroke.t1 < this.last.t1) return;
    const since = this.sinceFor(stroke);
    // Whatever its decision used up was its incantation, also one that named another spell (strict
    // mode fizzles on it): it has had its word, and a later one is not taken from the next stroke.
    this.last = { t0: stroke.t0, t1: stroke.t1, since, spellId, heard: used !== undefined };
    // Its own start is behind it now; the next stroke is one begun after it ended.
    if (this.nextBegin !== null && this.nextBegin <= stroke.t1) this.nextBegin = null;
  }

  /** A stroke began at t0: stroke.begin, whose t0 is the press for a pen stroke and the start of the
   *  lead-in for a hold-still one. Once a stroke has begun after the last decided one ended, speech
   *  begun from then on was said for it, not for the decided one (pairLate). The first such start is
   *  kept, also when that stroke was then dropped as too short or small: the player had moved on. */
  began(t0: number): void {
    if (!Number.isFinite(t0) || (this.last && t0 <= this.last.t1)) return;
    if (this.nextBegin === null || t0 < this.nextBegin) this.nextBegin = t0;
  }

  /**
   * A final no waiting stroke took. When it names the spell the last decided stroke cast (or came
   * nearest to), is one that stroke could have used (in its window, begun where its own speech could
   * begin), began before the next stroke did, and that stroke has not had its incantation yet, it is
   * that incantation arriving late, and it is consumed so the next stroke cannot take it. Speech begun
   * once the next stroke had begun was said for that stroke, also when it names the same spell (a
   * second Lumos, a retry). A final naming another spell is left alone: if it began before that
   * stroke ended, finalsFor keeps it from later strokes while the stroke has had no incantation, and
   * if it began after, it may be meant for the next stroke.
   */
  pairLate(h: HeardIncantation, beforeMs: number, afterMs: number): boolean {
    const last = this.last;
    if (!last || last.heard || h.consumed || h.spellId === undefined || h.spellId !== last.spellId) return false;
    if (this.nextBegin !== null && h.t0 >= this.nextBegin) return false;
    const [w0, w1] = voiceWindow(last, beforeMs, afterMs);
    if (h.t0 > w1 || h.t1 < w0 || h.t0 < last.since) return false;
    h.consumed = true;
    last.heard = true;
    return true;
  }

  /** An utterance that began no later than w1 is still under way (recent interims, no final). */
  inProgress(w1: number, now: number): boolean {
    for (const u of this.utterances.values()) {
      if (now - u.lastAt < UTTERANCE_STALE_MS && u.t0 <= w1) return true;
    }
    return false;
  }

  consume(h: HeardIncantation): void {
    h.consumed = true;
  }

  /** Forget finals that arrived more than keepMs ago, and abandoned utterances. */
  prune(now: number, keepMs: number): void {
    if (this.heard.length) this.heard = this.heard.filter((h) => now - h.receivedAt <= keepMs);
    for (const [key, u] of this.utterances) if (now - u.lastAt >= UTTERANCE_STALE_MS) this.utterances.delete(key);
  }

  clear(): void {
    this.heard = [];
    this.utterances.clear();
    this.last = null;
    this.nextBegin = null;
  }

  /**
   * Where a stroke's own speech may begin, when the last decided stroke ended before it. Speech begun
   * before that stroke ended was spoken around it, and may be its own word arriving late, as long as
   * it has had none. Once it has, it has nothing left to claim: speech begun around it is free for the
   * next stroke (whose word, said at once, may be timed a little early), and the bound goes back to
   * where the decided stroke's own speech could begin, since what was held back from it still is.
   */
  private sinceFor(stroke: { t0: number }): number {
    const last = this.last;
    if (!last || last.t1 > stroke.t0) return -Infinity;
    return last.heard ? last.since : last.t1;
  }

  private rememberId(id: string): void {
    this.finalIds.push(id);
    this.finalIdSet.add(id);
    while (this.finalIds.length > REMEMBERED_IDS) this.finalIdSet.delete(this.finalIds.shift()!);
  }
}

function finite(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The incantation window of a stroke: [t0 - before, t1 + after] on the capture clock. */
export function voiceWindow(stroke: { t0: number; t1: number }, beforeMs: number, afterMs: number): [number, number] {
  return [stroke.t0 - beforeMs, stroke.t1 + afterMs];
}
