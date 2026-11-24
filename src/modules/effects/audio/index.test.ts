import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCaption, EffectEvent, Envelope, SpellCast } from '../../../contracts';
import { CAST_SEQUENCE } from '../../../contracts';
import { ask, createKernel, emit, memoryPersistence, setSetting } from '../../../kernel';
import { DEFAULT_CAPTIONS } from './cues';
import { createAudioModuleWith, MANIFEST, UNLOCK_DELAY_MS, type AudioModuleDeps } from './index';
import { MASTER_LEVEL, MUFFLE_HZ } from './synth';
import { asAudioContext, FakeAudioContext, FakeBiquad, FakeGain, SEED_THEME, seedSpell, seedSpellbook, type FakeContextOptions } from './testing';

const BLOOM = CAST_SEQUENCE.bloomDelayMs;

interface Booted {
  kernel: ReturnType<typeof createKernel>;
  contexts: FakeAudioContext[];
  ctx(): FakeAudioContext;
  captions: AudioCaption[];
  effects: { type: string; e: EffectEvent }[];
  cast(spellId: string, over?: Partial<SpellCast>): SpellCast;
}

async function boot(
  o: { settings?: Record<string, unknown>; context?: FakeContextOptions | null; deps?: AudioModuleDeps; start?: boolean } = {},
): Promise<Booted> {
  const kernel = createKernel({ persistence: memoryPersistence(o.settings ?? {}), features: ['platform.audio'], clock: () => Date.now() });
  const contexts: FakeAudioContext[] = [];
  kernel.register(
    createAudioModuleWith({
      createContext: () => {
        if (o.context === null) return null;
        const fake = new FakeAudioContext(() => Date.now(), o.context ?? {});
        contexts.push(fake);
        return asAudioContext(fake);
      },
      hasBeenActive: () => true,
      isActive: () => true,
      ...o.deps,
    }),
  );
  await kernel.init();
  kernel.emit('spellbook.changed', seedSpellbook(), 'kernel.packs');
  const captions: AudioCaption[] = [];
  const effects: Booted['effects'] = [];
  kernel.subscribe('audio.caption', (e: Envelope<AudioCaption>) => captions.push(e.payload));
  for (const type of ['effect.start', 'effect.end']) {
    kernel.subscribe(type, (e: Envelope<EffectEvent>) => {
      if (e.source === MANIFEST.id) effects.push({ type, e: e.payload });
    });
  }
  if (o.start !== false) await kernel.start();
  let n = 0;
  return {
    kernel, contexts, captions, effects,
    ctx: () => contexts[contexts.length - 1],
    cast(spellId, over = {}) {
      const c: SpellCast = { id: `cast-${++n}`, spellId, t: Date.now(), via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...over };
      emit(kernel, 'engine.rules', 'spell.cast', c);
      return c;
    },
  };
}

const volumeGain = (fake: FakeAudioContext) => fake.nodes.find((n) => n.connections.includes(fake.destination)) as FakeGain;
const muffleFilter = (fake: FakeAudioContext) => fake.nodes.find((n): n is FakeBiquad => n instanceof FakeBiquad)!;

describe('sound module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the manifest the app and the packs depend on', () => {
    expect(MANIFEST).toMatchObject({
      id: 'effect.audio', kind: 'effect', contract: '^1.1', provides: ['audio@1'], requires: ['platform.audio'], effects: ['audio.cue', 'audio.muffle'],
    });
  });

  it('starts without making an AudioContext', async () => {
    const b = await boot();
    expect(b.contexts).toHaveLength(0);
    expect(b.kernel.modules().find((m) => m.manifest.id === MANIFEST.id)?.state).toBe('running');
  });

  it("plays a spell's cue at the bloom, on ctx.currentTime, with the theme's caption", async () => {
    const b = await boot();
    const c = b.cast('alohomora');
    vi.advanceTimersByTime(BLOOM - 1);
    expect(b.captions).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const ctx = b.ctx();
    expect(b.captions).toEqual([{ cue: 'latch', text: SEED_THEME.captions!.latch, t: Date.now() }]);
    const sources = ctx.sources().filter((s) => s.startedAt !== undefined);
    expect(sources.length).toBeGreaterThan(0);
    expect(Math.min(...sources.map((s) => s.startedAt!))).toBeCloseTo(ctx.currentTime + 0.01, 5);
    const index = seedSpell('alohomora').effect.steps.findIndex((s) => s.use === 'audio.cue');
    expect(b.effects[0]).toMatchObject({ type: 'effect.start', e: { castId: c.id, use: 'audio.cue', id: `${c.id}#${index}`, step: index, params: { cue: 'latch' } } });
    expect(b.effects[0].e.params?.silent).toBeUndefined();
    vi.advanceTimersByTime(2000);
    expect(b.effects.map((x) => x.type)).toEqual(['effect.start', 'effect.end']);
  });

  it('blooms at once with reduced motion on', async () => {
    const b = await boot({ settings: { 'access.reducedMotion': 'on' } });
    b.cast('nox');
    vi.advanceTimersByTime(0);
    expect(b.captions.map((x) => x.cue)).toEqual(['snuff']);
  });

  it('drops cues while audio is suspended, but still captions them and keeps its books', async () => {
    const b = await boot({ context: { state: 'suspended', allowResume: false } });
    b.cast('lumos');
    vi.advanceTimersByTime(BLOOM);
    const ctx = b.ctx();
    expect(ctx.state).toBe('suspended');
    // Only the bus exists: no cue voices were scheduled to burst out later.
    expect(ctx.sources()).toHaveLength(0);
    expect(b.captions.map((x) => x.cue)).toEqual(['chime-rise']);
    expect(b.effects[0].e.params).toMatchObject({ cue: 'chime-rise', silent: true });
  });

  it('makes no AudioContext for cues before the page has had a user gesture', async () => {
    const b = await boot({ deps: { hasBeenActive: () => false } });
    b.cast('stupefy');
    vi.advanceTimersByTime(BLOOM);
    expect(b.contexts).toHaveLength(0);
    expect(b.captions.map((x) => x.cue)).toEqual(['stun']);
    expect(b.effects[0].e.params).toMatchObject({ silent: true });
  });

  it('captions while muted, and mutes through the volume', async () => {
    const b = await boot({ settings: { 'audio.muted': true } });
    await ask(b.kernel, 'audio.play', { cue: 'page-turn' });
    const ctx = b.ctx();
    expect(b.captions.map((x) => x.text)).toEqual([SEED_THEME.captions!['page-turn']]);
    expect(volumeGain(ctx).gain.target).toBe(0);
    await setSetting(b.kernel, 'audio.muted', false);
    await setSetting(b.kernel, 'audio.volume', 0.5);
    expect(volumeGain(ctx).gain.target).toBeCloseTo(MASTER_LEVEL * 0.5);
  });

  it('warms the context up once the page is idle, so the first press only resumes it (Section 13)', async () => {
    let warm: (() => void) | null = null;
    let cancelled = 0;
    const b = await boot({
      context: { state: 'suspended' },
      deps: { hasBeenActive: () => false, isActive: () => false, warmUp: (make) => { warm = make; return () => { cancelled++; }; } },
    });
    expect(b.contexts).toHaveLength(0);
    warm!();
    // Made before any gesture: it waits, suspended, and nothing is resumed yet.
    expect(b.contexts).toHaveLength(1);
    expect(b.ctx().resumeCalls).toBe(0);
    // The first press: the same context, resumed.
    await ask(b.kernel, 'audio.unlock');
    expect(b.contexts).toHaveLength(1);
    expect(b.ctx().resumeCalls).toBe(1);
    // Stopping cancels a warm-up that has not run yet.
    const c = await boot({ deps: { warmUp: () => () => { cancelled++; } } });
    await c.kernel.stop();
    expect(cancelled).toBe(1);
  });

  it("'audio.unlock' makes the context and resumes it", async () => {
    const b = await boot({ context: { state: 'suspended' } });
    const r = await ask(b.kernel, 'audio.unlock');
    expect(b.contexts).toHaveLength(1);
    expect(b.ctx().resumeCalls).toBe(1);
    expect(b.ctx().state).toBe('running');
    expect(r.state).toBe('running');
    await ask(b.kernel, 'audio.unlock');
    expect(b.contexts).toHaveLength(1);
  });

  it("'audio.unlock' answers 'unavailable' without Web Audio, and nothing throws", async () => {
    const b = await boot({ context: null });
    await expect(ask(b.kernel, 'audio.unlock')).resolves.toEqual({ state: 'unavailable' });
    b.cast('lumos');
    vi.advanceTimersByTime(BLOOM + 2000);
    expect(b.captions).toHaveLength(1);
    expect(b.effects.map((x) => x.type)).toEqual(['effect.start', 'effect.end']);
    await expect(ask(b.kernel, 'audio.play', { cue: 'shutter' })).resolves.toBeUndefined();
    await expect(ask(b.kernel, 'audio.capture.start', { requester: 'share' })).rejects.toMatchObject({ code: 'not-supported' });
  });

  it("'audio.play' plays at once; unknown cues play chime; a missing cue is refused", async () => {
    const b = await boot();
    await ask(b.kernel, 'audio.play', { cue: 'shutter', gain: 0.5 });
    expect(b.captions.map((x) => x.cue)).toEqual(['shutter']);
    expect(b.ctx().sources().length).toBeGreaterThan(0);
    await ask(b.kernel, 'audio.play', { cue: 'no-such-cue' });
    expect(b.captions[1]).toMatchObject({ cue: 'chime', text: SEED_THEME.captions!.chime });
    await expect(ask(b.kernel, 'audio.play', {} as never)).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('a request made in a click plays even while the resume it started is still finishing', async () => {
    const b = await boot({ context: { state: 'suspended', allowResume: false } });
    await ask(b.kernel, 'audio.play', { cue: 'page-turn' });
    // Scheduled on the suspended clock: it sounds as soon as the context runs.
    expect(b.ctx().sources().length).toBeGreaterThan(0);
  });

  it('plays the fizzle at once, except for steering and ignored strokes', async () => {
    const b = await boot();
    emit(b.kernel, 'engine.rules', 'spell.fizzle', { id: 'f1', t: Date.now(), reason: 'low-score', quality: 0.3 });
    expect(b.captions.map((x) => x.cue)).toEqual(['fizzle']);
    vi.advanceTimersByTime(500);
    emit(b.kernel, 'engine.rules', 'spell.fizzle', { id: 'f2', t: Date.now(), reason: 'steering', quality: 0 });
    emit(b.kernel, 'engine.rules', 'spell.fizzle', { id: 'f3', t: Date.now(), reason: 'ignored', quality: 0 });
    expect(b.captions).toHaveLength(1);
  });

  it('ticks once when the segmenter arms', async () => {
    const b = await boot();
    const state = (s: 'hovering' | 'armed' | 'tracing') => emit(b.kernel, 'segmenter.hold-still', 'segmenter.state', { state: s, t: Date.now(), mode: 'hold-still' });
    state('hovering');
    state('armed');
    state('armed');
    expect(b.captions.map((x) => x.cue)).toEqual(['arm-tick']);
    state('tracing');
    vi.advanceTimersByTime(1000);
    state('hovering');
    state('armed');
    expect(b.captions.map((x) => x.cue)).toEqual(['arm-tick', 'arm-tick']);
  });

  it('plays the fanfare when a tier unlocks, after the spell has had its moment', async () => {
    const b = await boot();
    emit(b.kernel, 'kernel.packs', 'progress.changed', { spellId: 'lumos', accepted: 3, learned: true });
    emit(b.kernel, 'kernel.packs', 'progress.changed', { spellId: 'nox', accepted: 3, learned: true, unlockedTier: 2, unlockedSpells: ['alohomora'] });
    vi.advanceTimersByTime(UNLOCK_DELAY_MS - 1);
    expect(b.captions).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(b.captions).toEqual([expect.objectContaining({ cue: 'unlock-tier', text: SEED_THEME.captions!['unlock-tier'] })]);
  });

  it('muffles until the spell ends, and Finite\'s effects.end (from the stage) ends it too', async () => {
    const b = await boot();
    const m = b.cast('muffliato');
    vi.advanceTimersByTime(BLOOM);
    const ctx = b.ctx();
    expect(muffleFilter(ctx).frequency.target).toBe(MUFFLE_HZ);
    expect(b.captions.map((x) => x.cue)).toEqual(['buzz']);
    const finite = b.cast('finite-incantatem');
    vi.advanceTimersByTime(BLOOM);
    emit(b.kernel, 'effect.stage', 'effect.start', {
      spellId: 'finite-incantatem', castId: finite.id, use: 'effects.end', t: Date.now(), id: `${finite.id}#0`, step: 0, params: { scope: 'all' },
    });
    expect(muffleFilter(ctx).frequency.target).toBeGreaterThan(MUFFLE_HZ);
    expect(b.effects.filter((x) => x.type === 'effect.end' && x.e.castId === m.id).map((x) => x.e.reason)).toContain('effects-end');
    // Finite's own cue is not ended by its own effects.end.
    expect(b.effects.some((x) => x.type === 'effect.end' && x.e.castId === finite.id && x.e.reason === 'effects-end')).toBe(false);
  });

  it("ignores Obliviate's effects.end, which only clears trails", async () => {
    const b = await boot();
    b.cast('muffliato');
    vi.advanceTimersByTime(BLOOM);
    emit(b.kernel, 'effect.stage', 'effect.start', { spellId: 'obliviate', castId: 'x', use: 'effects.end', t: Date.now(), params: { scope: 'trails' } });
    expect(muffleFilter(b.ctx()).frequency.target).toBe(MUFFLE_HZ);
  });

  it('ends a held muffle on spell.ended for its cast', async () => {
    const b = await boot();
    const m = b.cast('muffliato');
    vi.advanceTimersByTime(BLOOM);
    emit(b.kernel, 'engine.rules', 'spell.ended', { spellId: 'muffliato', castId: m.id, t: Date.now(), by: 'reset' });
    expect(muffleFilter(b.ctx()).frequency.target).toBeGreaterThan(MUFFLE_HZ);
    expect(b.effects.filter((x) => x.e.use === 'audio.muffle').map((x) => [x.type, x.e.reason])).toEqual([['effect.start', undefined], ['effect.end', 'spell-ended']]);
  });

  it('hands out a capture stream of the master bus, and stops it with the last requester', async () => {
    const b = await boot();
    const { stream } = await ask(b.kernel, 'audio.capture.start', { requester: 'share' });
    expect(stream).toBeTruthy();
    await ask(b.kernel, 'audio.capture.start', { requester: 'other' });
    const dest = b.ctx().nodes.find((n) => n.kind === 'stream-destination')!;
    const feeding = () => b.ctx().nodes.some((n) => n.connections.includes(dest));
    await ask(b.kernel, 'audio.capture.stop', { requester: 'share' });
    expect(feeding()).toBe(true);
    await ask(b.kernel, 'audio.capture.stop', { requester: 'other' });
    expect(feeding()).toBe(false);
  });

  it('stop() ends everything with reason reset and opens the muffle', async () => {
    const b = await boot();
    b.cast('muffliato');
    vi.advanceTimersByTime(BLOOM);
    b.cast('lumos');
    await b.kernel.stop();
    expect(muffleFilter(b.ctx()).frequency.target).toBeGreaterThan(MUFFLE_HZ);
    expect(b.effects.filter((x) => x.type === 'effect.end').every((x) => x.e.reason === 'reset')).toBe(true);
    vi.advanceTimersByTime(BLOOM * 4);
    expect(b.captions.map((x) => x.cue)).toEqual(['buzz']);
  });

  it('falls back to a readable caption when the theme has none', async () => {
    const b = await boot();
    b.kernel.emit('spellbook.changed', { ...seedSpellbook(), theme: null }, 'kernel.packs');
    await ask(b.kernel, 'audio.play', { cue: 'honk' });
    expect(b.captions[0].text).toBe(DEFAULT_CAPTIONS.honk);
  });
});
