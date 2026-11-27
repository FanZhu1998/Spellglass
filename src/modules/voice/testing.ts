// Test doubles for the voice module's *.test.ts files (never imported by the app): a fake Web Speech
// API that records what the module asks of it and lets a test fire recognition events, and a
// spellbook built from the seed packs the way the pack service presents it.

import type { Spell, SpellPack, Spellbook, SpellbookEntry, ThemePack } from '../../contracts';
import coreCharms from '../../../public/packs/core-charms/pack.json';
import furtherSpells from '../../../public/packs/further-spells/pack.json';
import restrictedSection from '../../../public/packs/restricted-section/pack.json';
import type {
  SpeechApi, SpeechErrorEventLike, SpeechOptions, SpeechPhraseLike, SpeechRecognitionCtor, SpeechRecognitionLike, SpeechResultEventLike,
} from './speech';

export const SEED_PACKS: SpellPack[] = [coreCharms, furtherSpells, restrictedSection].map((p) => p as unknown as SpellPack);

/** Every seed spell. The restricted section ships off (default_enabled false): unavailable. */
export function seedSpellbook(over: Record<string, Partial<SpellbookEntry>> = {}, revision = 1): Spellbook {
  const spells = SEED_PACKS.flatMap((pack) =>
    pack.spells.map((spell: Spell): SpellbookEntry => {
      const on = pack.default_enabled !== false;
      return {
        spell, packId: pack.id, packTitle: pack.title, available: on, status: 'open', enabled: on, overridden: false,
        gestureSource: 'pack', gestureKey: 'k', mirrored: false, templates: [], lasts: null, skippedSteps: [], accepted: 0,
        ...(on ? {} : { unavailableReason: 'The pack is off.' }),
        ...over[spell.id],
      };
    }),
  );
  return {
    revision,
    packs: SEED_PACKS.map((p) => ({ id: p.id, kind: 'spellpack' as const, title: p.title, version: p.version, enabled: p.default_enabled !== false, user: false, unmet: [] })),
    spells,
    theme: null as ThemePack | null,
    unlockedTier: 7,
    learnAfter: 3,
  };
}

/** SpeechRecognitionPhrase: the real one throws a SyntaxError for a boost outside 0..10. */
export class FakePhrase implements SpeechPhraseLike {
  constructor(readonly phrase: string, readonly boost = 1) {
    if (!(boost >= 0 && boost <= 10)) {
      const err = new Error(`boost ${boost} is outside 0..10`);
      err.name = 'SyntaxError';
      throw err;
    }
  }
}

interface FakeResult {
  final?: boolean;
  /** [transcript, confidence] pairs, best first. */
  alts: [string, number][];
  speechStartTime?: number;
  speechEndTime?: number;
}

/** A SpeechRecognition the test drives by hand. processLocally and phrases are prototype accessors,
 *  as WebIDL attributes are in the browser, so feature detection sees them. */
export class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: ((ev: unknown) => void) | null = null;
  onaudiostart: ((ev: unknown) => void) | null = null;
  onresult: ((ev: SpeechResultEventLike) => void) | null = null;
  onerror: ((ev: SpeechErrorEventLike) => void) | null = null;
  onend: ((ev: unknown) => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  private local = false;
  private list: SpeechPhraseLike[] = [];

  get processLocally(): boolean {
    return this.local;
  }
  set processLocally(v: boolean) {
    this.local = v === true;
  }
  get phrases(): SpeechPhraseLike[] {
    return this.list;
  }
  set phrases(v: SpeechPhraseLike[]) {
    this.list = [...v];
  }

  start(): void {
    if (this.started) {
      const err = new Error('already started');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  abort(): void {
    this.aborted = true;
  }

  // ---- driving it from a test
  fireStart(): void {
    this.onstart?.({});
    this.onaudiostart?.({});
  }
  /** Fire a 'result' event with the whole result list (as the browser does) and the changed index. */
  fireResults(results: FakeResult[], resultIndex = 0): void {
    const list = results.map((r) => {
      const item: Record<string | number, unknown> = { isFinal: r.final === true, length: r.alts.length };
      r.alts.forEach(([transcript, confidence], i) => (item[i] = { transcript, confidence }));
      if (r.speechStartTime !== undefined) item.speechStartTime = r.speechStartTime;
      if (r.speechEndTime !== undefined) item.speechEndTime = r.speechEndTime;
      return item;
    });
    const resultList: Record<string | number, unknown> = { length: list.length };
    list.forEach((r, i) => (resultList[i] = r));
    this.onresult?.({ resultIndex, results: resultList as unknown as SpeechResultEventLike['results'] });
  }
  fireError(error: string): void {
    this.onerror?.({ error });
  }
  fireEnd(): void {
    this.onend?.({});
  }
}

/** A recognizer from before on-device recognition: no processLocally, no phrases. */
export class LegacyRecognition implements SpeechRecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: ((ev: unknown) => void) | null = null;
  onaudiostart: ((ev: unknown) => void) | null = null;
  onresult: ((ev: SpeechResultEventLike) => void) | null = null;
  onerror: ((ev: SpeechErrorEventLike) => void) | null = null;
  onend: ((ev: unknown) => void) | null = null;
  started = false;
  aborted = false;
  start(): void {
    this.started = true;
  }
  stop(): void {}
  abort(): void {
    this.aborted = true;
  }
}

export interface FakeSpeechOptions {
  /** Answer of available() for on-device (processLocally true) and online checks. */
  local?: string | ((o: SpeechOptions) => string | Promise<string>);
  cloud?: string;
  /** What install() does: resolve true or false, or reject with an error of this name. */
  install?: boolean | { reject: string };
  /** No available()/install(): a browser without on-device recognition. */
  legacy?: boolean;
  /** No SpeechRecognitionPhrase. */
  noPhrases?: boolean;
}

export interface FakeSpeech {
  api: SpeechApi;
  /** Every recognizer created, oldest first. */
  instances: FakeRecognition[];
  availableCalls: SpeechOptions[];
  installCalls: SpeechOptions[];
  /** The newest recognizer. */
  last(): FakeRecognition;
}

export function fakeSpeech(o: FakeSpeechOptions = {}): FakeSpeech {
  const instances: FakeRecognition[] = [];
  const availableCalls: SpeechOptions[] = [];
  const installCalls: SpeechOptions[] = [];
  if (o.legacy) {
    class Legacy extends LegacyRecognition {
      constructor() {
        super();
        instances.push(this as unknown as FakeRecognition);
      }
    }
    return {
      api: { Recognition: Legacy as unknown as SpeechRecognitionCtor, Phrase: null, onDevice: false },
      instances, availableCalls, installCalls,
      last: () => instances[instances.length - 1],
    };
  }
  class Rec extends FakeRecognition {
    static available(opts: SpeechOptions): Promise<string> {
      availableCalls.push(opts);
      if (opts.processLocally) {
        const local = typeof o.local === 'function' ? o.local(opts) : o.local ?? 'available';
        return Promise.resolve(local);
      }
      return Promise.resolve(o.cloud ?? 'available');
    }
    static install(opts: SpeechOptions): Promise<boolean> {
      installCalls.push(opts);
      const i = o.install ?? true;
      if (typeof i === 'object') {
        const err = new Error('install refused');
        err.name = i.reject;
        return Promise.reject(err);
      }
      return Promise.resolve(i);
    }
    constructor() {
      super();
      instances.push(this);
    }
  }
  return {
    api: { Recognition: Rec as unknown as SpeechRecognitionCtor, Phrase: o.noPhrases ? null : FakePhrase, onDevice: true },
    instances, availableCalls, installCalls,
    last: () => instances[instances.length - 1],
  };
}
