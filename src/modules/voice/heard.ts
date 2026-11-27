// From recognition results to incantations (Section 7.6, contracts/v1.ts Incantation). Pure: the
// module feeds in snapshots of 'result' events and the kernel time they arrived, and publishes what
// comes back.
//
// Three jobs:
//  1. Utterances. Continuous recognition reports a growing list of results; a result is interim
//     until it turns final. One utterance = one result index within one recognition session, so its
//     id is `${session}:${index}`, the same for every interim and its final (contracts: "stable across
//     the interim and final results of one utterance"). Chrome sometimes splits the words still being
//     heard into several interim results (a stable part and an unstable tail); those are joined into
//     one utterance keyed by the first of them, which is where the final lands.
//  2. Timing. Web Speech gives no word timings in today's browsers, so t0 and t1 are estimated on the
//     kernel clock from when results arrive (see estimateSpeech). Newer drafts of the spec add
//     SpeechRecognitionResult.speechStartTime and speechEndTime (seconds on the session's audio
//     timeline); when a browser provides plausible values they are used instead.
//  3. The decision: which spell the words name, through the fuzzy matcher, with conf = similarity ×
//     the recognizer's confidence and the threshold 'voice.minConf'.

import type { Incantation } from '../../contracts';
import { matchTranscript, normalizeWords, type SpellForms, type SpellMatch } from './fuzzy';

// ------------------------------------------------------------------------------- utterances

export interface AlternativeSnapshot {
  transcript: string;
  /** 0..1 as the recognizer reports it; 0 or NaN means it gave none. */
  confidence: number;
}

/** A copy of one SpeechRecognitionResult, taken inside the event handler. */
export interface ResultSnapshot {
  isFinal: boolean;
  alternatives: AlternativeSnapshot[];
  /** Seconds on the session audio timeline (newer spec drafts), when the browser gives them. */
  speechStartTime?: number;
  speechEndTime?: number;
}

/** What one utterance looks like after a result event. */
export interface UtteranceUpdate {
  id: string;
  final: boolean;
  /** Alternatives, best first. Joined interim parts have one alternative: the joined text. */
  alternatives: AlternativeSnapshot[];
  /** Kernel time the utterance was first reported, and its words then. */
  firstAt: number;
  firstText: string;
  /** The first report was already final (no interim results came first). */
  firstFinal: boolean;
  /** Kernel time of this report. */
  at: number;
  /** Speech start and end in seconds on the session audio timeline, when the browser gave them. */
  audio?: { start: number; end?: number };
}

interface Seen {
  firstAt: number;
  firstText: string;
  firstFinal: boolean;
  lastText: string;
  final: boolean;
}

/** Results of one recognition session, turned into utterance updates. A new session needs a new
 *  tracker (result indexes start again at 0). */
export class UtteranceTracker {
  private seen = new Map<number, Seen>();

  constructor(readonly session: string) {}

  /**
   * One 'result' event. `results` is the whole result list, `resultIndex` the first entry that
   * changed. Returns an update per utterance whose words changed: finals once each, interims when
   * their text changes.
   */
  update(results: readonly ResultSnapshot[], resultIndex: number, now: number): UtteranceUpdate[] {
    const out: UtteranceUpdate[] = [];
    const from = Number.isInteger(resultIndex) && resultIndex >= 0 ? resultIndex : 0;
    let group: number[] = [];
    const flushGroup = () => {
      if (!group.length) return;
      const first = group[0];
      const parts = group.map((i) => topText(results[i])).filter(Boolean);
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      const alternatives = group.length === 1 ? cleanAlternatives(results[first]) : [{ transcript: text, confidence: 0 }];
      const u = this.note(first, text, false, now);
      if (u) out.push({ ...u, alternatives, audio: audioTimes(results[first], results[group[group.length - 1]]) });
      group = [];
    };
    for (let i = from; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (r.isFinal) {
        flushGroup();
        const u = this.note(i, topText(r), true, now);
        if (u) out.push({ ...u, alternatives: cleanAlternatives(r), audio: audioTimes(r, r) });
      } else {
        group.push(i);
      }
    }
    flushGroup();
    return out;
  }

  /** Record a report for result index i; null when there is nothing new to say. */
  private note(i: number, text: string, final: boolean, now: number): Omit<UtteranceUpdate, 'alternatives' | 'audio'> | null {
    let s = this.seen.get(i);
    if (s?.final) return null; // a final is reported once
    if (!s) {
      if (!text) return null; // nothing heard yet
      s = { firstAt: now, firstText: text, firstFinal: final, lastText: '', final: false };
      this.seen.set(i, s);
    }
    if (!final && text === s.lastText) return null;
    s.lastText = text;
    s.final = final;
    return { id: `${this.session}:${i}`, final, firstAt: s.firstAt, firstText: s.firstText, firstFinal: s.firstFinal, at: now };
  }
}

function topText(r: ResultSnapshot | undefined): string {
  const t = r?.alternatives?.[0]?.transcript;
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
}

function cleanAlternatives(r: ResultSnapshot): AlternativeSnapshot[] {
  return (r.alternatives ?? [])
    .filter((a) => a && typeof a.transcript === 'string' && a.transcript.trim())
    .map((a) => ({ transcript: a.transcript.replace(/\s+/g, ' ').trim(), confidence: Number.isFinite(a.confidence) ? a.confidence : 0 }));
}

/** Spec timings when present and sane: non-negative, end not before start. */
function audioTimes(first: ResultSnapshot, last: ResultSnapshot): UtteranceUpdate['audio'] {
  const s = first.speechStartTime;
  const e = last.speechEndTime;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return undefined;
  if (typeof e === 'number' && Number.isFinite(e) && e >= s && e > 0) return { start: s, end: e };
  return { start: s };
}

// ------------------------------------------------------------------------------- timing

/**
 * The estimates behind t0 and t1, in ms. Rough on purpose: the engine's incantation window runs from
 * 2.5 s before a stroke to 1 s after it (plus engine.voiceLatencyMs while an utterance is under way),
 * so an error of a few hundred milliseconds rarely changes which stroke an incantation pairs with:
 * only speech that starts right where one stroke ends or the next begins can move to the other stroke
 * (spell-engine/voice-log.ts says how the engine decides those).
 */
export const TIMING = {
  /** From the end of the words in a result to the result arriving, for interim results. */
  interimLagMs: 300,
  /** From the end of speech to the final result: the recognizer waits for a pause, then finishes. */
  finalLagMs: 600,
  /** One syllable at a deliberate casting pace. */
  syllableMs: 200,
};

/** Syllables in a text, counted as vowel groups per word (at least one per word). */
export function syllables(text: string): number {
  let n = 0;
  for (const w of normalizeWords(text)) n += Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length);
  return n;
}

export interface SpeechTimes {
  t0: number;
  t1: number;
}

/**
 * Estimated start and end of the speech, on the kernel clock.
 *  - Interim first: the words of the first interim had been spoken before it arrived, so
 *    t0 = firstAt − interimLagMs − syllables(firstText) × syllableMs.
 *  - Final first (no interims): t0 = at − finalLagMs − syllables(text) × syllableMs.
 *  - t1: for interims, at − interimLagMs; for finals, at − finalLagMs. Never before t0.
 *  - Spec timings, when the browser provides them, replace these: audioStartAt (kernel time the
 *    session's audio began, from its 'audiostart' event) plus the offsets in seconds.
 *  - floor: speech cannot have started before the session's audio did.
 */
export function estimateSpeech(u: UtteranceUpdate, text: string, opts: { audioStartAt?: number; floor?: number } = {}): SpeechTimes {
  const T = TIMING;
  let t0: number;
  let t1: number;
  if (u.firstFinal) t0 = u.at - T.finalLagMs - syllables(text) * T.syllableMs;
  else t0 = u.firstAt - T.interimLagMs - syllables(u.firstText) * T.syllableMs;
  t1 = u.final ? u.at - T.finalLagMs : u.at - T.interimLagMs;
  const base = opts.audioStartAt;
  if (u.audio && typeof base === 'number' && Number.isFinite(base)) {
    const s = base + u.audio.start * 1000;
    // Trust the spec offsets only while they are consistent with when the result arrived.
    if (s <= u.at) {
      t0 = s;
      if (u.audio.end !== undefined) {
        const e = base + u.audio.end * 1000;
        if (e <= u.at + 1) t1 = e;
      }
    }
  }
  if (typeof opts.floor === 'number' && Number.isFinite(opts.floor)) t0 = Math.max(t0, opts.floor);
  t0 = Math.min(t0, u.at);
  t1 = Math.min(Math.max(t1, t0), u.at);
  return { t0: Math.round(t0), t1: Math.round(t1) };
}

// ------------------------------------------------------------------------------- the decision

/** The best spell must lead the next one by this much, unless they matched different words. */
export const LEAD_MARGIN = 0.05;
/** Spells below this are not listed as alternatives. */
export const ALTERNATIVE_FLOOR = 0.3;
/** Without a confidence from the recognizer, lower-ranked alternatives count a little less. */
const RANK_DISCOUNT = 0.1;
const MAX_TEXT = 160;

interface Scored {
  spellId: string;
  conf: number;
  from: number;
  to: number;
  /** Which alternative it came from. */
  alt: number;
}

export interface DecideOptions {
  minConf: number;
  /** Kernel time the session's audio began, for spec timings. */
  audioStartAt?: number;
  /** Earliest possible speech start (the session's start). */
  floor?: number;
}

/**
 * Build the Incantation for an utterance update. conf = similarity × the recognizer's confidence,
 * except that interim results (whose confidence is often 0 or meaningless) and results without one
 * use the similarity alone, slightly lowered for lower-ranked alternatives. spellId is set when the
 * best spell reaches minConf and is not ambiguous.
 *
 * Ambiguity: when the two best spells matched overlapping words, the best must lead by LEAD_MARGIN.
 * When they matched different words ("Lumos ... Nox" in one breath) both were said; the later one is
 * taken, as the one closer to whatever comes next, and the other is listed as an alternative.
 */
export function decideIncantation(u: UtteranceUpdate, spells: readonly SpellForms[], opts: DecideOptions): Incantation {
  const scored = new Map<string, Scored>();
  u.alternatives.forEach((alt, k) => {
    const recognizer = u.final && alt.confidence > 0 ? Math.min(1, alt.confidence) : Math.max(0, 1 - RANK_DISCOUNT * k);
    for (const m of matchTranscript(alt.transcript, spells)) {
      const conf = m.score * recognizer;
      const prev = scored.get(m.spellId);
      if (!prev || conf > prev.conf) scored.set(m.spellId, { spellId: m.spellId, conf, from: m.from, to: m.to, alt: k });
    }
  });
  const ranked = [...scored.values()].sort((a, b) => b.conf - a.conf || b.from - a.from);

  let chosen: Scored | undefined;
  const [best, second] = ranked;
  if (best && best.conf >= opts.minConf) {
    if (!second || best.conf - second.conf >= LEAD_MARGIN) chosen = best;
    else if (second.conf >= opts.minConf && !overlaps(best, second)) chosen = best.from >= second.from ? best : second;
  }

  const text = (u.alternatives[chosen?.alt ?? 0]?.transcript ?? '').slice(0, MAX_TEXT);
  const times = estimateSpeech(u, text, { audioStartAt: opts.audioStartAt, floor: opts.floor });
  // Words before the incantation were spoken first: move t0 to where the matched words begin.
  if (chosen && chosen.from > 0) {
    const before = normalizeWords(text).slice(0, chosen.from).join(' ');
    times.t0 = Math.min(times.t1, times.t0 + syllables(before) * TIMING.syllableMs);
  }

  const alternatives = ranked
    .filter((s) => s !== chosen && s.conf >= ALTERNATIVE_FLOOR)
    .slice(0, 3)
    .map((s) => ({ spellId: s.spellId, conf: round(s.conf) }));
  const inc: Incantation = {
    t: times.t0,
    text,
    conf: round(chosen?.conf ?? best?.conf ?? 0),
    final: u.final,
    id: u.id,
    t0: times.t0,
    t1: times.t1,
  };
  if (chosen) inc.spellId = chosen.spellId;
  if (alternatives.length) inc.alternatives = alternatives;
  return inc;
}

function overlaps(a: Pick<SpellMatch, 'from' | 'to'> & { alt: number }, b: Pick<SpellMatch, 'from' | 'to'> & { alt: number }): boolean {
  // Matches from different alternatives are readings of the same words.
  if (a.alt !== b.alt) return true;
  return a.from < b.to && b.from < a.to;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
