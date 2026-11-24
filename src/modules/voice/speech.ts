// The parts of the Web Speech API that voice uses, declared here because TypeScript 6's DOM library
// has none of them (SpeechRecognition, SpeechRecognitionPhrase, processLocally, phrases, available(),
// install()). Shapes follow the W3C draft (webaudio.github.io/web-speech-api) and MDN's "Using the
// Web Speech API", checked in November 2026:
//
//   static available({ langs, processLocally, quality }) → 'unavailable' | 'downloadable' |
//     'downloading' | 'available'. With processLocally true, browsers mask the answer as
//     'downloadable' until this site has called install() (a fingerprinting defence).
//   static install({ langs, processLocally, quality }) → true when the language pack is installed.
//     Starting a download needs transient user activation (a click), else it rejects NotAllowedError.
//   processLocally: keep audio and transcripts on the device. start() then fails with
//     'service-not-allowed' if the pack is missing.
//   phrases: SpeechRecognitionPhrase(phrase, boost = 1) objects; boost outside 0..10 throws.
//     A recognizer without contextual biasing fails start() with 'phrases-not-supported'.
//   error codes: no-speech, aborted, audio-capture, network, not-allowed, service-not-allowed,
//     language-not-supported, phrases-not-supported.
//
// Every piece is feature-detected: older Chromium has only webkitSpeechRecognition with no
// available(), and other browsers have none of it. Nothing here touches a global at import time.

export type SpeechQuality = 'command' | 'dictation' | 'conversation';
export type SpeechAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface SpeechOptions {
  langs: string[];
  processLocally?: boolean;
  quality?: SpeechQuality;
}

export interface SpeechAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
  /** Newer drafts: seconds on the session audio timeline. */
  readonly speechStartTime?: number;
  readonly speechEndTime?: number;
}

export interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
}

export interface SpeechResultEventLike {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}

export interface SpeechErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechPhraseLike {
  readonly phrase: string;
  readonly boost: number;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Absent in browsers without on-device recognition. */
  processLocally?: boolean;
  /** An ObservableArray in the browser; assigning a plain array converts it. */
  phrases?: SpeechPhraseLike[];
  onstart: ((ev: unknown) => void) | null;
  onaudiostart: ((ev: unknown) => void) | null;
  onresult: ((ev: SpeechResultEventLike) => void) | null;
  onerror: ((ev: SpeechErrorEventLike) => void) | null;
  onend: ((ev: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?: (options: SpeechOptions) => Promise<SpeechAvailability | string>;
  install?: (options: SpeechOptions) => Promise<boolean>;
}

export type SpeechPhraseCtor = new (phrase: string, boost?: number) => SpeechPhraseLike;

/** What this browser offers. */
export interface SpeechApi {
  Recognition: SpeechRecognitionCtor;
  /** SpeechRecognitionPhrase, where contextual biasing exists. */
  Phrase: SpeechPhraseCtor | null;
  /** available() and install() exist: on-device recognition can be asked for and verified. */
  onDevice: boolean;
}

type SpeechGlobal = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  SpeechRecognitionPhrase?: unknown;
};

/** Detect the Web Speech API on a global object. Never throws; null when there is none. */
export function detectSpeech(g: unknown = globalThis): SpeechApi | null {
  try {
    const o = g as SpeechGlobal;
    const Recognition = (o.SpeechRecognition ?? o.webkitSpeechRecognition) as SpeechRecognitionCtor | undefined;
    if (typeof Recognition !== 'function') return null;
    const Phrase = typeof o.SpeechRecognitionPhrase === 'function' ? (o.SpeechRecognitionPhrase as SpeechPhraseCtor) : null;
    // WebIDL attributes live on the prototype; without processLocally the checks would be pointless.
    const proto = (Recognition as { prototype?: object }).prototype;
    const onDevice =
      typeof Recognition.available === 'function' && typeof Recognition.install === 'function' && !!proto && 'processLocally' in proto;
    return { Recognition, Phrase, onDevice };
  } catch {
    return null;
  }
}

/** Copy a result list out of an event (the browser's objects are live and array-like). */
export function snapshotResults(list: SpeechResultListLike): {
  isFinal: boolean;
  alternatives: { transcript: string; confidence: number }[];
  speechStartTime?: number;
  speechEndTime?: number;
}[] {
  const out = [];
  const n = typeof list?.length === 'number' ? list.length : 0;
  for (let i = 0; i < n; i++) {
    const r = list[i];
    if (!r) {
      out.push({ isFinal: false, alternatives: [] });
      continue;
    }
    const alternatives = [];
    const m = typeof r.length === 'number' ? r.length : 0;
    for (let k = 0; k < m; k++) {
      const a = r[k];
      if (a && typeof a.transcript === 'string') alternatives.push({ transcript: a.transcript, confidence: Number(a.confidence) });
    }
    const snap: { isFinal: boolean; alternatives: typeof alternatives; speechStartTime?: number; speechEndTime?: number } = { isFinal: r.isFinal === true, alternatives };
    if (typeof r.speechStartTime === 'number') snap.speechStartTime = r.speechStartTime;
    if (typeof r.speechEndTime === 'number') snap.speechEndTime = r.speechEndTime;
    out.push(snap);
  }
  return out;
}
