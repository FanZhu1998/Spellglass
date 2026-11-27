// A minimal fake AudioContext for the audio module's tests (never imported by the app). It records
// the graph and every automation call, and is as strict as the real API where mistakes hide:
// exponential ramps to zero, negative or non-finite times, and starting a source twice all throw.
// currentTime follows a clock while the context runs and stands still while it is suspended.

import type { Spell, SpellPack, Spellbook, SpellbookEntry, ThemePack } from '../../../contracts';
import coreCharms from '../../../../public/packs/core-charms/pack.json';
import furtherSpells from '../../../../public/packs/further-spells/pack.json';
import restrictedSection from '../../../../public/packs/restricted-section/pack.json';
import candlelit from '../../../../public/packs/theme-candlelit/pack.json';

function checkTime(t: number, what: string): void {
  if (!Number.isFinite(t)) throw new TypeError(`${what}: time must be finite`);
  if (t < 0) throw new RangeError(`${what}: time must not be negative`);
}

export interface ParamEvent {
  type: 'set' | 'linear' | 'exp' | 'target' | 'cancel';
  v?: number;
  t: number;
  tc?: number;
}

export class FakeParam {
  events: ParamEvent[] = [];
  /** Nodes connected to this param (LFOs). */
  inputs: FakeNode[] = [];
  constructor(public value: number, readonly name: string) {}
  setValueAtTime(v: number, t: number): this {
    checkTime(t, `${this.name}.setValueAtTime`);
    if (!Number.isFinite(v)) throw new TypeError('value must be finite');
    this.events.push({ type: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    checkTime(t, `${this.name}.linearRampToValueAtTime`);
    if (!Number.isFinite(v)) throw new TypeError('value must be finite');
    this.events.push({ type: 'linear', v, t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    checkTime(t, `${this.name}.exponentialRampToValueAtTime`);
    if (!Number.isFinite(v) || v === 0) throw new RangeError(`${this.name}: exponential ramp to ${v}`);
    this.events.push({ type: 'exp', v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    checkTime(t, `${this.name}.setTargetAtTime`);
    if (!(tc >= 0)) throw new RangeError('time constant must not be negative');
    this.events.push({ type: 'target', v, t, tc });
    return this;
  }
  cancelScheduledValues(t: number): this {
    checkTime(t, `${this.name}.cancelScheduledValues`);
    this.events.push({ type: 'cancel', t });
    return this;
  }
  /** The value the last event aims for (what the param is heading to). */
  get target(): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.v !== undefined) return e.v;
    }
    return this.value;
  }
}

export class FakeNode {
  readonly connections: (FakeNode | FakeParam)[] = [];
  disconnected = false;
  constructor(readonly ctx: FakeAudioContext, readonly kind: string) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (dest instanceof FakeNode && dest.ctx !== this.ctx) throw new Error('connect across contexts');
    this.connections.push(dest);
    if (dest instanceof FakeParam) dest.inputs.push(this);
    return dest;
  }
  disconnect(dest?: FakeNode | FakeParam): void {
    if (dest) {
      const i = this.connections.indexOf(dest);
      if (i < 0) throw new Error('not connected');
      this.connections.splice(i, 1);
      return;
    }
    this.connections.length = 0;
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1, 'gain');
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam(350, 'frequency');
  readonly Q = new FakeParam(1, 'Q');
  readonly gain = new FakeParam(0, 'gain');
  readonly detune = new FakeParam(0, 'detune');
}

export class FakeSource extends FakeNode {
  startedAt?: number;
  offset?: number;
  stoppedAt?: number;
  onended: (() => void) | null = null;
  ended = false;
  start(t = 0, offset?: number): void {
    if (this.startedAt !== undefined) throw new Error('InvalidStateError: started twice');
    checkTime(t, `${this.kind}.start`);
    this.startedAt = t;
    this.offset = offset;
  }
  stop(t = 0): void {
    if (this.startedAt === undefined) throw new Error('InvalidStateError: stop before start');
    checkTime(t, `${this.kind}.stop`);
    this.stoppedAt = t;
  }
}

export class FakeOscillator extends FakeSource {
  type = 'sine';
  readonly frequency = new FakeParam(440, 'frequency');
  readonly detune = new FakeParam(0, 'detune');
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1, 'playbackRate');
}

export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  normalize = true;
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24, 'threshold');
  readonly knee = new FakeParam(30, 'knee');
  readonly ratio = new FakeParam(12, 'ratio');
  readonly attack = new FakeParam(0.003, 'attack');
  readonly release = new FakeParam(0.25, 'release');
}

export class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0, 'pan');
}

export class FakeStreamDestination extends FakeNode {
  readonly stream = { id: `fake-stream-${this.ctx.nodes.length}` };
}

export class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    if (!(numberOfChannels > 0 && length > 0 && sampleRate > 0)) throw new RangeError('bad buffer');
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    const d = this.data[c];
    if (!d) throw new RangeError('no such channel');
    return d;
  }
}

export interface FakeContextOptions {
  state?: 'suspended' | 'running';
  sampleRate?: number;
  /** resume() works (as after a user gesture). */
  allowResume?: boolean;
  /** No createMediaStreamDestination (older browsers). */
  noCapture?: boolean;
}

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed';
  readonly sampleRate: number;
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  onstatechange: (() => void) | null = null;
  resumeCalls = 0;
  allowResume: boolean;
  private elapsed = 0;
  private since: number;
  createMediaStreamDestination?: () => FakeStreamDestination;

  constructor(private readonly clock: () => number = () => 0, o: FakeContextOptions = {}) {
    this.state = o.state ?? 'running';
    this.sampleRate = o.sampleRate ?? 8000;
    this.allowResume = o.allowResume ?? true;
    this.since = clock();
    this.destination = new FakeNode(this, 'destination');
    if (!o.noCapture) this.createMediaStreamDestination = () => new FakeStreamDestination(this, 'stream-destination');
  }

  get currentTime(): number {
    return this.elapsed + (this.state === 'running' ? (this.clock() - this.since) / 1000 : 0);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.allowResume && this.state === 'suspended') this.setState('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    if (this.state === 'running') this.setState('suspended');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }

  createGain(): FakeGain {
    return new FakeGain(this, 'gain');
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this, 'biquad');
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator(this, 'oscillator');
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this, 'buffer-source');
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver(this, 'convolver');
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this, 'compressor');
  }
  createStereoPanner(): FakePanner {
    return new FakePanner(this, 'panner');
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }

  /** Sources (oscillators and buffer sources) created so far. */
  sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  }

  /** Fire onended for sources whose stop time has passed, as the browser would. */
  flush(): void {
    const now = this.currentTime;
    for (const s of this.sources()) {
      if (!s.ended && s.stoppedAt !== undefined && s.stoppedAt <= now) {
        s.ended = true;
        s.onended?.();
      }
    }
  }

  private setState(state: FakeAudioContext['state']): void {
    if (this.state === 'running') this.elapsed = this.currentTime;
    this.since = this.clock();
    this.state = state;
    this.onstatechange?.();
  }
}

/** The fake, typed as the real thing for code under test. */
export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

// ------------------------------------------------------------------------------- spellbook

export const SEED_PACKS: SpellPack[] = [coreCharms, furtherSpells, restrictedSection].map((p) => p as unknown as SpellPack);
export const SEED_THEME = candlelit as unknown as ThemePack;

/** SpellbookEntry.lasts as the pack service computes it. */
export function lastsOf(spell: Spell): SpellbookEntry['lasts'] {
  if (typeof spell.duration_ms === 'number' && spell.duration_ms > 0) return spell.duration_ms;
  return spell.effect.steps.some((s) => s.hold === true) ? 'until-ended' : null;
}

export function entryOf(spell: Spell, over: Partial<SpellbookEntry> = {}): SpellbookEntry {
  return {
    spell, packId: 'test', packTitle: 'Test', available: true, status: 'open', enabled: true, overridden: false,
    gestureSource: 'pack', gestureKey: 'k', mirrored: false, templates: [], lasts: lastsOf(spell), skippedSteps: [], accepted: 0,
    ...over,
  };
}

/** Every seed spell, with the candlelit theme (or none). Extra spells may be added for a test. */
export function seedSpellbook(extra: Spell[] = [], theme: ThemePack | null = SEED_THEME): Spellbook {
  const spells = [...SEED_PACKS.flatMap((p) => p.spells), ...extra].map((s) => entryOf(s));
  return { revision: 1, packs: [], spells, theme, unlockedTier: 7, learnAfter: 3 };
}

export function seedSpell(id: string): Spell {
  for (const p of SEED_PACKS) {
    const s = p.spells.find((x) => x.id === id);
    if (s) return s;
  }
  throw new Error(`no seed spell ${id}`);
}

/** A made-up spell with the given steps, for tests. */
export function spellWith(id: string, steps: Spell['effect']['steps'], more: Partial<Spell> = {}): Spell {
  return { id, incantation: id, gesture: { flick: 'up' }, effect: { steps, fallback: 'sparkle' }, ...more };
}
