import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EffectEvent, EffectStep, Envelope, Point, SceneProps, Spellbook, SpellbookEntry, SpellCast, StageSteering, TrackerStatus,
} from '../../../../contracts';
import { CAST_SEQUENCE, EFFECT_LIMITS, PROP_IDS, PROP_START, PROP_TAGS } from '../../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../../kernel';
import type { FrameInfo, Layers, PropAction, PropView, Shelf, StageServices } from '../types';
import { MANIFEST } from '../index';
import { createShelf } from '../props';
import { MEND_MS } from '../props/teacup';
import { hasShape } from './ink';
import { MAX_DIM_RATE_PER_MS } from './limits';
import { REPLAY_TAIL_MS } from './replay';
import type { Sprites } from './sprites';
import { StageCore } from './stage';

class FakeProp implements PropView {
  readonly home: { x: number; y: number };
  x: number;
  y: number;
  readonly radius = 0.05;
  timeScale = 1;
  applied: { use: string; action: PropAction }[] = [];
  ended: string[] = [];
  resets = 0;
  canApply = true;
  lit = false;

  constructor(readonly id: PropView['id'], x: number, y: number, private baseTags: string[]) {
    this.home = { x, y };
    this.x = x;
    this.y = y;
  }

  label(): string {
    return this.id;
  }
  tags(): string[] {
    return this.lit ? [...this.baseTags.filter((t) => t !== PROP_TAGS.flammable), PROP_TAGS.burning] : this.baseTags;
  }
  state(): Record<string, boolean> {
    return this.id === 'candle' ? { lit: this.lit } : {};
  }
  update(_frame: FrameInfo, _services: StageServices): void {}
  draw(_layers: Layers, _frame: FrameInfo, _services: StageServices): void {}
  apply(use: string, action: PropAction, services: StageServices): boolean {
    this.applied.push({ use, action });
    if (!this.canApply) return false;
    if (use === 'prop.ignite') this.lit = true;
    if (use === 'prop.douse') this.lit = false;
    services.propsChanged();
    return true;
  }
  end(castId: string): void {
    this.ended.push(castId);
  }
  reset(): void {
    this.resets++;
    this.lit = false;
    this.x = this.home.x;
    this.y = this.home.y;
  }
}

function entry(id: string, steps: EffectStep[], lasts: SpellbookEntry['lasts'] = null, gesture: SpellbookEntry['spell']['gesture'] = { flick: 'up' }): SpellbookEntry {
  return {
    spell: { id, incantation: id[0].toUpperCase() + id.slice(1), gesture, effect: { steps, fallback: 'sparkle' } }, packId: 'test', packTitle: 'Test',
    available: true, status: 'open', enabled: true, overridden: false, gestureSource: 'pack', gestureKey: 'k', mirrored: false,
    templates: [], lasts, skippedSteps: [], accepted: 0,
  };
}

const BOOK: Spellbook = {
  revision: 1, packs: [], unlockedTier: 3, learnAfter: 3,
  theme: { schema: 'themepack/1', id: 'candlelit', version: '1.0.0', tokens: { candle: '#F2B84B' }, fonts: { display: 'IM Fell English', text: 'Spectral' }, grades: { cast: [], fizzle: [] }, hidden_ink: ['Ink fades. Intent does not.'] },
  spells: [
    entry('lumos', [{ use: 'light.orb', at: 'tip', hold: true }, { use: 'scene.dim', amount: 0.35, hold: true }, { use: 'audio.cue', cue: 'chime-rise' }], 'until-ended'),
    entry('nox', [{ use: 'light.snuff', spell: 'lumos', smoke: true }]),
    entry('incendio', [{ use: 'prop.ignite', hold: true }, { use: 'particles.burst', preset: 'embers', at: 'target', count: 40 }], 'until-ended'),
    entry('aguamenti', [{ use: 'particles.stream', preset: 'water', from: 'tip', to: 'target', duration_ms: 1500, arc: 0.35 }, { use: 'prop.douse', all: true, delay_ms: 500 }]),
    entry('leviosa', [{ use: 'prop.levitate', follow_tip: true, duration_ms: 8000 }], 8000),
    entry('alohomora', [{ use: 'prop.unlock' }]),
    entry('finite', [{ use: 'effects.end', scope: 'all' }]),
    entry('obliviate', [{ use: 'effects.end', scope: 'trails' }, { use: 'log.fade' }]),
    entry('revelio', [{ use: 'scene.reveal', duration_ms: 6000 }, { use: 'text.inscribe', style: 'hidden-ink' }]),
    entry('empty', []),
  ],
};

interface Rig {
  kernel: KernelHost;
  core: StageCore;
  props: Record<'candle' | 'feather' | 'dummy', FakeProp>;
  events: Envelope[];
  of<T>(type: string): T[];
  advance(ms: number): void;
  cast(spellId: string, over?: Partial<SpellCast>): SpellCast;
  now(): number;
}

let clock = 0;

async function rig(settings: Record<string, unknown> = {}, realShelf?: Shelf): Promise<Rig> {
  clock = 1000;
  const kernel = createKernel({ persistence: memoryPersistence(settings), features: ['platform.dom'], clock: () => clock });
  const props = {
    candle: new FakeProp('candle', 0.12, 0.86, [PROP_TAGS.any, PROP_TAGS.movable, PROP_TAGS.flammable]),
    feather: new FakeProp('feather', 0.27, 0.9, [PROP_TAGS.any, PROP_TAGS.movable, PROP_TAGS.levitatable]),
    dummy: new FakeProp('dummy', 0.88, 0.8, [PROP_TAGS.any, PROP_TAGS.dummy]),
  };
  const shelf: Shelf = realShelf ?? { props: [props.candle, props.feather, props.dummy], drawShelf: () => {} };
  const core = new StageCore(MANIFEST, { host: null, shelf, headless: true, seed: 7 });
  kernel.register(core.module());
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  await kernel.init();
  await kernel.start();
  kernel.emit('spellbook.changed', BOOK, 'kernel.packs');
  let n = 0;
  const r: Rig = {
    kernel, core, props, events,
    of: <T,>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T),
    advance(ms) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + 16);
        core.tick(clock, false);
      }
    },
    cast(spellId, over = {}) {
      const c: SpellCast = { id: `cast-${++n}`, spellId, t: clock, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.6 }, ...over };
      kernel.emit('spell.cast', c, 'engine');
      return c;
    },
    now: () => clock,
  };
  await Promise.resolve();
  return r;
}

afterEach(() => {
  vi.useRealTimers();
});

/** A rig on the real shelf (props/), its props by id. */
async function realRig(settings: Record<string, unknown> = {}): Promise<{ r: Rig; prop: Record<string, PropView> }> {
  const shelf = createShelf();
  const r = await rig(settings, shelf);
  return { r, prop: Object.fromEntries(shelf.props.map((p) => [p.id, p])) };
}

/** Add spells to the rig's spellbook. */
function addSpells(r: Rig, spells: SpellbookEntry[]): void {
  r.kernel.emit('spellbook.changed', { ...BOOK, revision: 2, spells: [...BOOK.spells, ...spells] }, 'kernel.packs');
}

/** Answer engine.reset and engine.cast as the engine does for a replay, noting the order they came in. */
function fakeEngine(r: Rig, asked: string[] = []): string[] {
  r.kernel.handle('engine.reset', () => {
    asked.push('engine.reset');
  });
  r.kernel.handle('engine.cast', (p: Record<string, unknown>) => {
    asked.push('engine.cast');
    const cast: SpellCast = {
      id: `replay-${asked.length}`, spellId: String(p.spellId), t: r.now(), via: 'gesture', quality: 1, power: 0.5, aim: p.aim as { x: number; y: number },
      replay: true, ...(typeof p.targetId === 'string' ? { targetId: p.targetId } : {}),
    };
    r.kernel.emit('spell.cast', cast, 'engine');
    return cast;
  });
  return asked;
}

/** A replay payload: a straight stroke from `from` to `to`. */
function replayOf(spellId: string, from: Point, to: Point, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const points = Array.from({ length: 64 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 63, from[1] + ((to[1] - from[1]) * i) / 63] as Point);
  return { spellId, points, aspect: 16 / 9, durationMs: 600, via: 'gesture', quality: 1, power: 0.5, variant: false, ...extra };
}

// ------------------------------------------------------------------ a light meter
// What the light and shade layers show at a few points, worked out from the draw calls: light adds
// up ('lighter'), the dimming veil is a fill with soft holes cut out of it ('destination-out'). Every
// sprite is taken as the soft glow's profile (sprites.ts), as bright as any of them at its centre.

const GLOW_STOPS: [number, number][] = [[0, 1], [0.12, 0.85], [0.3, 0.42], [0.55, 0.14], [0.8, 0.035], [1, 0]];

function glowAt(u: number): number {
  if (u >= 1) return 0;
  for (let i = 1; i < GLOW_STOPS.length; i++) {
    const [u1, a1] = GLOW_STOPS[i];
    const [u0, a0] = GLOW_STOPS[i - 1];
    if (u <= u1) return a0 + ((a1 - a0) * (u - u0)) / (u1 - u0);
  }
  return 0;
}

interface Meter {
  ctx: CanvasRenderingContext2D;
  /** Light at each point (clamped), veil alpha at each point. */
  light: number[];
  veil: number[];
  clear(): void;
}

function meter(points: { x: number; y: number }[]): Meter {
  const m: Meter = {
    ctx: null as unknown as CanvasRenderingContext2D,
    light: points.map(() => 0),
    veil: points.map(() => 0),
    clear() {
      m.light.fill(0);
      m.veil.fill(0);
    },
  };
  const state = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    fillRect() {
      if (state.globalCompositeOperation === 'source-over') m.veil = m.veil.map((v) => state.globalAlpha + v * (1 - state.globalAlpha));
    },
    drawImage(_img: unknown, x: number, y: number, w: number, h: number) {
      points.forEach((p, i) => {
        const k = state.globalAlpha * glowAt(Math.hypot(p.x - (x + w / 2), p.y - (y + h / 2)) / (w / 2));
        if (state.globalCompositeOperation === 'lighter') m.light[i] += k;
        else if (state.globalCompositeOperation === 'destination-out') m.veil[i] *= 1 - k;
      });
    },
  };
  m.ctx = state as unknown as CanvasRenderingContext2D;
  return m;
}

const SPRITES = { glow: () => ({}), rays: () => ({}), flash: () => ({}) } as unknown as Sprites;

/**
 * WCAG's flash: a pair of opposing changes in luminance (Section 10.6 caps them at three a second).
 * A change is the picture at a point moving by more than 0.1 within 100 ms, the line EFFECT_LIMITS
 * draws for dimming. Returns the most flashes that begin in any one second.
 */
function mostFlashesInASecond(series: number[], frameMs: number): number {
  const lag = Math.round(96 / frameMs);
  const changes: { t: number; sign: number }[] = [];
  let run = 0;
  for (let i = lag; i < series.length; i++) {
    const d = series[i] - series[i - lag];
    const sign = d > 0.1 ? 1 : d < -0.1 ? -1 : 0;
    if (sign !== 0 && sign !== run) changes.push({ t: i * frameMs, sign });
    run = sign;
  }
  let most = 0;
  for (let i = 0; i < changes.length; i++) {
    let n = 0;
    let open = 0;
    for (let j = i; j < changes.length && changes[j].t < changes[i].t + 1000; j++) {
      if (open !== 0 && changes[j].sign === -open) {
        n++;
        open = 0;
      } else {
        open = changes[j].sign;
      }
    }
    most = Math.max(most, n);
  }
  return most;
}

describe('scene.props', () => {
  it('is published at start from each prop, with the caster aspect', async () => {
    const r = await rig();
    const sp = r.kernel.last<SceneProps>('scene.props')!.payload;
    expect(sp.aspect).toBeCloseTo(16 / 9);
    expect(sp.props.map((p) => p.id)).toEqual(['candle', 'feather', 'dummy']);
    expect(sp.props[0]).toEqual({ id: 'candle', label: 'candle', x: 0.12, y: 0.86, r: 0.05, tags: r.props.candle.tags(), state: { lit: false } });
  });

  it('is republished when a prop reports a change, and after stage.reset', async () => {
    const r = await rig();
    const before = r.of<SceneProps>('scene.props').length;
    r.cast('incendio', { targetId: 'candle' });
    r.advance(CAST_SEQUENCE.bloomDelayMs + 40);
    const sp = r.kernel.last<SceneProps>('scene.props')!.payload;
    expect(r.of('scene.props').length).toBeGreaterThan(before);
    expect(sp.props[0].tags).toContain(PROP_TAGS.burning);
    expect(sp.props[0].state).toEqual({ lit: true });
    await r.kernel.request('stage.reset');
    expect(r.props.candle.resets).toBe(1);
    expect(r.kernel.last<SceneProps>('scene.props')!.payload.props[0].state).toEqual({ lit: false });
    // The held ignite ended with the reset.
    expect(r.of<EffectEvent>('effect.end').some((e) => e.use === 'prop.ignite' && e.reason === 'reset')).toBe(true);
  });
});

describe('prop steps', () => {
  it('go to the target prop with the cast, the step as run and the scale', async () => {
    const r = await rig();
    const c = r.cast('alohomora', { targetId: 'feather', effectScale: 1.6 });
    r.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    expect(r.props.feather.applied.map((a) => a.use)).toEqual(['prop.unlock']);
    const action = r.props.feather.applied[0].action;
    expect(action.cast.id).toBe(c.id);
    expect(action.scale).toBe(1.6);
    expect(action.step.use).toBe('prop.unlock');
    // An instant step ends at once.
    expect(r.of<EffectEvent>('effect.end').find((e) => e.use === 'prop.unlock')?.reason).toBe('done');
  });

  it('play a sparkle when no prop can do it', async () => {
    const r = await rig();
    r.props.dummy.canApply = false;
    r.cast('alohomora', { targetId: 'dummy' });
    r.cast('alohomora');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    const starts = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'prop.unlock');
    expect(starts).toHaveLength(2);
    expect(starts.every((e) => e.params?.sparkle === true)).toBe(true);
    expect(r.core.particles.count).toBeGreaterThan(0);
  });

  it('Aguamenti douses every burning prop, and its douse releases Incendio’s held fire', async () => {
    const r = await rig();
    const fire = r.cast('incendio', { targetId: 'candle' });
    r.advance(400);
    expect(r.props.candle.lit).toBe(true);
    const water = r.cast('aguamenti', { targetId: 'candle' });
    r.kernel.emit('spell.ended', { spellId: 'incendio', castId: fire.id, t: r.now(), by: 'aguamenti', byCastId: water.id }, 'engine');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 300);
    expect(r.props.candle.ended).toEqual([]);
    r.advance(300);
    expect(r.props.candle.applied.map((a) => a.use)).toEqual(['prop.ignite', 'prop.douse']);
    expect(r.props.candle.ended).toContain(fire.id);
    const end = r.of<EffectEvent>('effect.end').find((e) => e.castId === fire.id && e.use === 'prop.ignite');
    expect(end?.reason).toBe('spell-ended');
  });

  it('spell.ended ends a cast’s prop actions through prop.end(castId)', async () => {
    const r = await rig();
    const c = r.cast('leviosa', { targetId: 'feather' });
    r.advance(300);
    r.kernel.emit('spell.ended', { spellId: 'leviosa', castId: c.id, t: r.now(), by: 'finite-incantatem' }, 'engine');
    expect(r.props.feather.ended).toEqual([c.id]);
  });
});

describe('steering', () => {
  it('is published while a follow-the-tip action runs, draws no ink, and clears when the prop is done', async () => {
    const r = await rig();
    const c = r.cast('leviosa', { targetId: 'feather' });
    r.advance(300);
    expect(r.kernel.last<StageSteering>('stage.steering')!.payload).toEqual({ castId: c.id, spellId: 'leviosa' });
    // Tracing while steering leaves no ink.
    r.kernel.emit('segmenter.state', { state: 'tracing', t: r.now(), mode: 'hold-still', strokeId: 's9' }, 'stroke');
    r.kernel.emit('tip.filtered', { t: r.now(), x: 0.3, y: 0.3, conf: 1, src: 'tracker.pointer' }, 'stroke');
    r.kernel.emit('tip.filtered', { t: r.now() + 16, x: 0.35, y: 0.3, conf: 1, src: 'tracker.pointer' }, 'stroke');
    expect(r.core.ink.get('s9')).toBeUndefined();
    expect(r.core.ink.strokes.filter((s) => s.state === 'wet')).toHaveLength(0);
    r.props.feather.applied[0].action.done();
    expect(r.kernel.last<StageSteering>('stage.steering')!.payload).toEqual({ castId: null });
    expect(r.of<EffectEvent>('effect.end').find((e) => e.use === 'prop.levitate')?.reason).toBe('done');
  });
});

describe('the tip on the glass', () => {
  const status = (tracker: string, segmentation?: unknown) =>
    ({ tracker, state: 'tracking', lock: 1, fps: 30, aspect: 16 / 9, pen: false, ...(segmentation ? { segmentation } : {}) }) as TrackerStatus;
  const sample = (r: Rig, src: string) => r.kernel.emit('tip.filtered', { t: r.now(), x: 0.4, y: 0.5, conf: 1, src }, 'stroke');

  it("counts the tip as gone when the segmenter does: after the tracker's longer lostMs, else the setting's", async () => {
    const r = await rig();
    r.kernel.emit('tracker.status', status('tracker.hand', { lostMs: 500, minSamples: 5, pauseMs: 300 }), 'tracker.hand');
    // A 350 ms dropout the hand tracker and the segmenter bridge: the tip stays, for the glow and for
    // what follows it (a steered prop), until the segmenter's 500 ms (plus the stage's 50 ms of slack).
    sample(r, 'tracker.hand');
    r.advance(350);
    expect(r.core.liveTip()).toEqual({ x: 0.4, y: 0.5 });
    r.advance(190);
    expect(r.core.liveTip()).not.toBeNull();
    r.advance(30);
    expect(r.core.liveTip()).toBeNull();
    // The hand's need is not another tracker's: the bright tip's samples keep the setting's 200 ms.
    sample(r, 'tracker.bright-tip');
    r.advance(240);
    expect(r.core.liveTip()).not.toBeNull();
    r.advance(30);
    expect(r.core.liveTip()).toBeNull();
    // tip.lost still ends it at once.
    sample(r, 'tracker.hand');
    r.kernel.emit('tip.lost', { t: r.now(), src: 'tracker.hand' }, 'tracker.hand');
    expect(r.core.liveTip()).toBeNull();
  });

  it('reads the need as the segmenter does, and lets a setting that is more forgiving win', async () => {
    const r = await rig();
    // Held to SEGMENTATION_NEED_MAX_MS (2 s).
    r.kernel.emit('tracker.status', status('tracker.hand', { lostMs: 60_000 }), 'tracker.hand');
    sample(r, 'tracker.hand');
    r.advance(2000);
    expect(r.core.liveTip()).not.toBeNull();
    r.advance(100);
    expect(r.core.liveTip()).toBeNull();
    // A need that is no number counts as none, and so does a status without needs.
    for (const odd of [{ lostMs: -5 }, { lostMs: Number.NaN }, { lostMs: '900' }, undefined]) {
      r.kernel.emit('tracker.status', status('tracker.hand', odd), 'tracker.hand');
      sample(r, 'tracker.hand');
      r.advance(270);
      expect(r.core.liveTip(), JSON.stringify(odd)).toBeNull();
    }
    // segmenter.lostMs 800 beats the hand's 500.
    r.kernel.emit('tracker.status', status('tracker.hand', { lostMs: 500 }), 'tracker.hand');
    await r.kernel.settings.set('segmenter.lostMs', 800);
    sample(r, 'tracker.hand');
    r.advance(800);
    expect(r.core.liveTip()).not.toBeNull();
    r.advance(80);
    expect(r.core.liveTip()).toBeNull();
  });

  it('takes the needs of a tracker that reported before the stage started', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.dom'], clock: () => clock });
    clock = 1000;
    const core = new StageCore(MANIFEST, { host: null, shelf: { props: [], drawShelf: () => {} }, headless: true, seed: 7 });
    kernel.register(core.module());
    await kernel.init();
    kernel.emit('tracker.status', status('tracker.hand', { lostMs: 500 }), 'tracker.hand');
    await kernel.start();
    kernel.emit('tip.filtered', { t: clock, x: 0.4, y: 0.5, conf: 1, src: 'tracker.hand' }, 'stroke');
    clock += 400;
    expect(core.liveTip()).not.toBeNull();
    await kernel.stop();
  });
});

function trace(r: Rig, strokeId: string, points: Point[]): void {
  r.kernel.emit('segmenter.state', { state: 'tracing', t: r.now(), mode: 'hold-still', strokeId }, 'stroke');
  for (const [x, y] of points) {
    r.kernel.emit('tip.filtered', { t: r.now(), x, y, conf: 1, src: 'tracker.pointer' }, 'stroke');
    r.advance(16);
  }
  r.kernel.emit('segmenter.state', { state: 'evaluating', t: r.now(), mode: 'hold-still', strokeId }, 'stroke');
}

const upStroke: Point[] = Array.from({ length: 20 }, (_, i) => [0.5 + Math.sin(i) * 0.003, 0.7 - i * 0.02] as Point);

describe('ink', () => {
  it('starts where the tip was held still: stroke.begin seeds the lead-in before tracing', async () => {
    const r = await rig();
    const sample = (x: number, y: number, t: number) => ({ t, x, y, conf: 1, src: 'tracker.pointer' });
    const t = r.now();
    // The segmenter's order on the sample that leaves the arm radius: state, stroke.begin, tip.filtered.
    r.kernel.emit('segmenter.state', { state: 'tracing', t, mode: 'hold-still', strokeId: 'stroke-1' }, 'stroke');
    const lead = [sample(0.5, 0.7, t - 48), sample(0.5, 0.69, t - 32), sample(0.5, 0.68, t - 16), sample(0.5, 0.67, t)];
    r.kernel.emit('stroke.begin', { id: 'stroke-1', points: lead, t0: t - 48, t1: t, quality: 1 }, 'stroke');
    r.kernel.emit('tip.filtered', lead[3], 'stroke');
    const ink = r.core.ink.get('stroke-1')!;
    expect(ink.points[0]).toMatchObject({ x: 0.5, y: 0.7 });
    expect(ink.points.map((p) => p.y)).toEqual([0.7, 0.69, 0.68, 0.67]);
  });

  it('a pen-mode stroke (no lead-in points) starts at the first traced sample', async () => {
    const r = await rig();
    const t = r.now();
    r.kernel.emit('segmenter.state', { state: 'tracing', t, mode: 'pen', strokeId: 'stroke-2' }, 'stroke');
    r.kernel.emit('stroke.begin', { id: 'stroke-2', points: [], t0: t, t1: t, quality: 1 }, 'stroke');
    r.kernel.emit('tip.filtered', { t, x: 0.4, y: 0.4, conf: 1, src: 'tracker.pointer' }, 'stroke');
    expect(r.core.ink.get('stroke-2')!.points.map((p) => [p.x, p.y])).toEqual([[0.4, 0.4]]);
  });
});

describe('the casting moment', () => {
  it('settles the ink on a cast, writes the incantation once it has settled, then blooms', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    const ink = r.core.ink.get('stroke-1')!;
    expect(ink.points.length).toBeGreaterThan(10);
    expect(ink.state).toBe('waiting');
    const t0 = r.now();
    r.cast('lumos', { strokeId: 'stroke-1', variant: 'Lumos Maxima', effectScale: 1.6 });
    expect(ink.state).toBe('settling');
    expect(r.core.text.incantation?.lines).toEqual(['Lumos Maxima']);
    expect(r.core.text.incantation!.start).toBe(t0 + CAST_SEQUENCE.settleMs);
    r.advance(CAST_SEQUENCE.settleMs + 20);
    expect(ink.state).toBe('settled');
    const orb = r.of<EffectEvent>('effect.start').find((e) => e.use === 'light.orb')!;
    expect(orb.t - t0).toBeGreaterThanOrEqual(CAST_SEQUENCE.bloomDelayMs);
    expect(orb.params?.radius).toBeCloseTo(0.06 * 1.6);
    expect(r.core.light.dims[0].amount).toBeCloseTo(0.56);
  });

  it('a fizzle dulls and drips the ink; a steering or ignored fizzle only fades', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    r.kernel.emit('spell.fizzle', { id: 'f1', t: r.now(), strokeId: 'stroke-1', reason: 'low-score', quality: 0.4 }, 'engine');
    expect(r.core.ink.get('stroke-1')!.state).toBe('dripping');
    trace(r, 'stroke-2', upStroke);
    r.kernel.emit('spell.fizzle', { id: 'f2', t: r.now(), strokeId: 'stroke-2', reason: 'ignored', quality: 0 }, 'engine');
    expect(r.core.ink.get('stroke-2')!.state).toBe('fading');
  });

  it('shows the listening shimmer while the engine waits for speech', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    r.kernel.emit('spell.pending', { strokeId: 'stroke-1', until: r.now() + 2000, waitingFor: 'voice' }, 'engine');
    expect(r.core.ink.get('stroke-1')!.pending).toBe(true);
    r.cast('lumos', { strokeId: 'stroke-1' });
    expect(r.core.ink.get('stroke-1')!.pending).toBe(false);
  });

  it('keeps listening ink wet past the usual wait, but not for ever if no decision comes', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    r.kernel.emit('spell.pending', { strokeId: 'stroke-1', until: r.now() + 5000, waitingFor: 'voice' }, 'engine');
    r.advance(6000);
    expect(r.core.ink.get('stroke-1')?.state).toBe('waiting');
    r.advance(3000);
    expect(r.core.ink.get('stroke-1')?.state ?? 'gone').not.toBe('waiting');
  });

  it('under reduced motion: the ink and the incantation appear at once, the effect blooms at once', async () => {
    const r = await rig({ 'access.reducedMotion': 'on' });
    trace(r, 'stroke-1', upStroke);
    const t0 = r.now();
    r.cast('lumos', { strokeId: 'stroke-1' });
    expect(r.core.ink.get('stroke-1')!.state).toBe('settled');
    expect(r.core.text.incantation!.still).toBe(true);
    expect(r.core.text.incantation!.start).toBe(t0);
    r.advance(16);
    expect(r.of<EffectEvent>('effect.start').find((e) => e.use === 'light.orb')!.t - t0).toBeLessThan(CAST_SEQUENCE.bloomDelayMs);
  });

  it('a voice-only cast sketches the gesture at the aim', async () => {
    const r = await rig();
    r.cast('lumos', { via: 'voice' });
    expect(r.core.ink.strokes.some((s) => s.id.startsWith('sketch-'))).toBe(true);
  });

  it('plays the fallback sparkle for a spell with no steps', async () => {
    const r = await rig();
    r.cast('empty');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    const start = r.of<EffectEvent>('effect.start').find((e) => e.use === 'fallback:sparkle')!;
    expect(start.step).toBe(-1);
    expect(start.params).toEqual({ preset: 'stars', at: 'tip', count: 24 });
  });
});

describe('ending everything', () => {
  it('Finite’s effects.end ends earlier effects and every prop’s actions', async () => {
    const r = await rig();
    const lumos = r.cast('lumos');
    r.cast('incendio', { targetId: 'candle' });
    r.advance(400);
    const finite = r.cast('finite');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    const ends = r.of<EffectEvent>('effect.end').filter((e) => e.reason === 'effects-end');
    expect(ends.map((e) => e.use).sort()).toEqual(['light.orb', 'prop.ignite', 'scene.dim']);
    expect(ends.some((e) => e.castId === finite.id)).toBe(false);
    expect(r.props.dummy.ended).toContain('*');
    expect(r.core.light.orbs.every((o) => o.state !== 'lit')).toBe(true);
    void lumos;
  });

  it('Obliviate clears the trails and only announces log.fade', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    r.cast('obliviate', { strokeId: 'stroke-1' });
    r.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    expect(r.core.ink.strokes.every((s) => s.state === 'fading')).toBe(true);
    expect(r.core.ink.history).toEqual([]);
    const fade = r.of<EffectEvent>('effect.start').find((e) => e.use === 'log.fade')!;
    expect(r.of<EffectEvent>('effect.end').find((e) => e.id === fade.id)?.reason).toBe('done');
  });

  it('a settled shape that is faded keeps its clean form (it never jumps back to the raw trace)', async () => {
    const r = await rig();
    trace(r, 'stroke-1', upStroke);
    r.cast('lumos', { strokeId: 'stroke-1' });
    r.advance(CAST_SEQUENCE.settleMs + 40);
    const ink = r.core.ink.get('stroke-1')!;
    expect(ink.state).toBe('settled');
    r.core.ink.forgetAll(r.now());
    expect(ink.state).toBe('fading');
    expect(ink.morphK).toBe(1);
    expect(hasShape(ink)).toBe(true);
    // Ink that never settled fades as it was traced.
    trace(r, 'stroke-2', upStroke);
    const raw = r.core.ink.get('stroke-2')!;
    r.core.ink.fade(raw, r.now());
    expect(hasShape(raw)).toBe(false);
  });

  it('Revelio reveals for its duration and writes a line of the theme’s hidden ink', async () => {
    const r = await rig();
    r.cast('revelio');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 800);
    expect(r.core.services.revealAlpha()).toBeGreaterThan(0.9);
    expect(r.core.text.extras[0].lines).toEqual(['Ink fades. Intent does not.']);
    expect(r.core.text.extras[0].style).toBe('hidden-ink');
  });
});

describe('how lasting effects end', () => {
  it('a summoned creature leaves when its time is up, though nothing ends its spell', async () => {
    const r = await rig();
    addSpells(r, [entry('hare', [{ use: 'creature.summon', duration_ms: 2000 }])]);
    r.cast('hare');
    r.advance(CAST_SEQUENCE.bloomDelayMs + 100);
    expect(r.core.creatures).toHaveLength(1);
    r.advance(2000);
    expect(r.of<EffectEvent>('effect.end').find((e) => e.use === 'creature.summon')?.reason).toBe('done');
    // Its leap away, and the stars it sheds, are over a moment later.
    r.advance(1500);
    expect(r.core.creatures).toHaveLength(0);
  });

  it('a held step runs until its spell ends, for every primitive that lasts', async () => {
    const r = await rig();
    const held: EffectStep[] = [
      { use: 'shield.dome', hold: true },
      { use: 'creature.summon', hold: true },
      { use: 'scene.reveal', hold: true },
      { use: 'particles.stream', preset: 'stars', from: 'tip', to: 'center', hold: true },
      { use: 'time.slow', scope: 'all', factor: 0.5, hold: true },
      { use: 'text.inscribe', text: 'Steady', hold: true },
    ];
    addSpells(r, [entry('steady', held, 'until-ended')]);
    const c = r.cast('steady');
    r.advance(40_000);
    expect(r.of<EffectEvent>('effect.end').filter((e) => e.castId === c.id)).toEqual([]);
    const starts = r.of<EffectEvent>('effect.start').filter((e) => e.castId === c.id);
    expect(starts.map((e) => e.use)).toEqual(held.map((s) => s.use));
    // Held: no length of their own.
    expect(starts.every((e) => e.durationMs === undefined && e.params?.hold === true && e.params?.duration_ms === undefined)).toBe(true);
    expect(r.core.shields).toHaveLength(1);
    expect(r.core.creatures).toHaveLength(1);
    expect(r.core.services.revealAlpha()).toBeGreaterThan(0.9);
    expect(r.core.time.global(r.now())).toBeCloseTo(0.5);
    expect(r.core.text.extras.map((e) => e.lines)).toEqual([['Steady']]);
    expect(r.core.director().ongoing(c.id)).toHaveLength(held.length);

    r.kernel.emit('spell.ended', { spellId: 'steady', castId: c.id, t: r.now(), by: 'finite-incantatem' }, 'engine');
    const ends = r.of<EffectEvent>('effect.end').filter((e) => e.castId === c.id);
    expect(ends.map((e) => e.use)).toEqual(held.map((s) => s.use));
    expect(ends.every((e) => e.reason === 'spell-ended')).toBe(true);
    r.advance(2500);
    expect(r.core.shields).toHaveLength(0);
    expect(r.core.creatures).toHaveLength(0);
    expect(r.core.services.revealAlpha()).toBe(0);
    expect(r.core.time.global(r.now())).toBe(1);
    expect(r.core.text.extras).toHaveLength(0);
  });

  it('a held prop action holds too, on every prop, until its spell ends', async () => {
    const { r, prop } = await realRig();
    addSpells(r, [
      entry('hold-up', [{ use: 'prop.levitate', hold: true }], 'until-ended'),
      entry('hold-pull', [{ use: 'prop.pull', hold: true }], 'until-ended'),
      entry('hold-push', [{ use: 'prop.push', mode: 'away', hold: true }], 'until-ended'),
      entry('hold-follow', [{ use: 'prop.push', mode: 'follow', hold: true }], 'until-ended'),
      entry('hold-grow', [{ use: 'prop.scale', factor: 1.5, hold: true }], 'until-ended'),
      entry('hold-freeze', [{ use: 'prop.freeze', hold: true }], 'until-ended'),
      entry('hold-drop', [{ use: 'prop.topple', hold: true }], 'until-ended'),
      entry('hold-copy', [{ use: 'prop.mimic', hold: true }], 'until-ended'),
    ]);
    const hold = (casts: SpellCast[], check: () => void) => {
      r.advance(40_000);
      for (const c of casts) {
        expect(r.of<EffectEvent>('effect.start').find((e) => e.castId === c.id)?.durationMs, c.spellId).toBeUndefined();
        expect(r.of<EffectEvent>('effect.end').filter((e) => e.castId === c.id), c.spellId).toEqual([]);
      }
      check();
      for (const c of casts) r.kernel.emit('spell.ended', { spellId: c.spellId, castId: c.id, t: r.now(), by: 'finite-incantatem' }, 'engine');
      for (const c of casts) expect(r.of<EffectEvent>('effect.end').find((e) => e.castId === c.id)?.reason, c.spellId).toBe('spell-ended');
      r.advance(4000);
    };
    const first = [
      r.cast('hold-up', { targetId: 'feather' }), r.cast('hold-pull', { targetId: 'plant' }), r.cast('hold-push', { targetId: 'box' }),
      r.cast('hold-follow', { targetId: 'candle' }), r.cast('hold-grow', { targetId: 'teacup' }), r.cast('hold-freeze', { targetId: 'dummy' }),
    ];
    hold(first, () => {
      expect(prop.feather.state().motion).toBe('levitating');
      expect(prop.plant.state().motion).toBe('pulled');
      expect(prop.box.state().motion).toBe('pushed');
      expect(prop.candle.state().motion).toBe('pushed');
      expect(prop.teacup.state().scale).toBe(1.5);
      expect(prop.dummy.state().frozen).toBe(true);
    });
    for (const id of ['feather', 'plant', 'box', 'candle']) expect(prop[id].state().motion, id).toBeUndefined();
    expect(prop.teacup.state().scale).toBeUndefined();
    expect(prop.dummy.state().frozen).toBeUndefined();
    hold([r.cast('hold-drop', { targetId: 'dummy' })], () => expect(prop.dummy.state().toppled).toBe(true));
    expect(prop.dummy.state().toppled).toBeUndefined();
    hold([r.cast('hold-copy', { targetId: 'dummy' })], () => expect(prop.dummy.state().mimicking).toBe(true));
    expect(prop.dummy.state().mimicking).toBeUndefined();
  });
});

describe('safety across casts', () => {
  it('never shows more than three full flashes in a second, whatever the packs ask', async () => {
    const r = await rig();
    const strobe = { ...BOOK, revision: 2, spells: [...BOOK.spells, entry('strobe', Array.from({ length: 10 }, (_, i) => ({ use: 'light.flash', intensity: 1, delay_ms: i * 40 })))] };
    r.kernel.emit('spellbook.changed', strobe, 'kernel.packs');
    r.cast('strobe');
    r.advance(1500);
    const starts = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'light.flash');
    expect(starts).toHaveLength(10);
    const full = starts.filter((e) => e.params?.softened !== true);
    expect(full.length).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
    expect(starts.every((e) => (e.params?.intensity as number) <= EFFECT_LIMITS.flashMaxIntensity)).toBe(true);
  });

  it('an orb lit and snuffed over and over flashes no more than three times a second, nor does the dimmed room', async () => {
    const r = await rig();
    // An imported pack's strobe: a full-size orb blooms every 250 ms and is snuffed 50 ms later,
    // in a room that a held dim has darkened (as Lumos Maxima does).
    const steps: EffectStep[] = [];
    for (let i = 0; i < 16; i++) {
      steps.push({ use: 'light.orb', at: 'center', radius: 0.15, intensity: 1, duration_ms: 30000, delay_ms: i * 250 });
      steps.push({ use: 'light.snuff', spell: 'orb-strobe', smoke: false, delay_ms: i * 250 + 50 });
    }
    addSpells(r, [entry('gloom', [{ use: 'scene.dim', amount: 0.56, hold: true }], 'until-ended'), entry('orb-strobe', steps)]);
    r.cast('gloom');
    r.advance(1500);
    expect(r.core.light.dim).toBeCloseTo(0.56);
    r.cast('orb-strobe');
    const v = r.core.view;
    const H = v.height * v.dpr;
    // The orb's centre, and 0.2, 0.3 and 0.5 mirror heights from it.
    const points = [0, 0.2, 0.3, 0.5].map((d) => ({ x: v.px(0.5) + d * H, y: v.py(0.5) }));
    const m = meter(points);
    const light: number[][] = points.map(() => []);
    const veil: number[][] = points.map(() => []);
    const seen: number[][] = points.map(() => []);
    for (let t = 0; t < 5500; t += 16) {
      r.advance(16);
      m.clear();
      r.core.light.drawShade(m.ctx, v, SPRITES, r.now());
      r.core.light.drawLight(m.ctx, v, SPRITES, r.now(), false);
      points.forEach((_, i) => {
        const l = Math.min(1, m.light[i]);
        light[i].push(l);
        veil[i].push(m.veil[i]);
        // Over a white wall: the veil darkens the room, the light layer is screened over it.
        seen[i].push(1 - (1 - l) * m.veil[i]);
      });
    }
    for (let i = 0; i < points.length; i++) {
      expect(mostFlashesInASecond(light[i], 16), `light ${i}`).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
      expect(mostFlashesInASecond(veil[i], 16), `veil ${i}`).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
      expect(mostFlashesInASecond(seen[i], 16), `picture ${i}`).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
    }
    // The orb still shows: the changes the budget refused were made softly, and said so.
    expect(Math.max(...light[0])).toBeGreaterThan(0.3);
    const orbs = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'light.orb');
    expect(orbs).toHaveLength(16);
    expect(orbs.some((e) => e.params?.softened === true)).toBe(true);
  });

  it('flashes the budget refused glow softly, and however many come at once they flash no more than three times a second', async () => {
    const r = await rig();
    // An imported pack's strobe: six of the brightest, widest flashes at the same moment, every
    // 400 ms. A few get through as flashes; the rest are refused, all at the same place and time.
    const steps: EffectStep[] = [];
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < 6; k++) steps.push({ use: 'light.flash', at: 'center', radius: 0.35, intensity: 1, delay_ms: i * 400 });
    }
    addSpells(r, [entry('flash-crowd', steps)]);
    const c = r.cast('flash-crowd');
    const v = r.core.view;
    const H = v.height * v.dpr;
    // The flashes' centre, and 0.05 to 0.3 mirror heights from it.
    const points = [0, 0.05, 0.1, 0.15, 0.2, 0.3].map((d) => ({ x: v.px(0.5) + d * H, y: v.py(0.5) }));
    const m = meter(points);
    const light: number[][] = points.map(() => []);
    let glowsAfterTheEnd = 0;
    for (let t = 0; t < 8000; t += 16) {
      r.advance(16);
      m.clear();
      r.core.light.drawShade(m.ctx, v, SPRITES, r.now());
      r.core.light.drawLight(m.ctx, v, SPRITES, r.now(), false);
      // Over a dark wall the light layer is the picture.
      points.forEach((_, i) => light[i].push(Math.min(1, m.light[i])));
      // Every step says it is over only once what it shows has gone (a replay waits for that).
      if (!r.core.director().busy(c.id) && r.core.light.flashes.length) glowsAfterTheEnd++;
    }
    for (let i = 0; i < points.length; i++) {
      expect(mostFlashesInASecond(light[i], 16), `light ${i}`).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
    }
    expect(glowsAfterTheEnd).toBe(0);
    // The refused ones still glowed, said so, and were over in the end.
    const starts = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'light.flash');
    expect(starts).toHaveLength(72);
    expect(starts.filter((e) => e.params?.softened === true).length).toBeGreaterThan(55);
    expect(r.of<EffectEvent>('effect.end').filter((e) => e.use === 'light.flash')).toHaveLength(72);
    expect(r.core.light.flashes).toHaveLength(0);
  });

  it('a refused flash that glows as the room lifts changes the picture no faster than dimming may, and lasts as long as its glow', async () => {
    const r = await rig();
    addSpells(r, [
      entry('gloom', [{ use: 'scene.dim', amount: 0.8, fade_ms: 300, hold: true }], 'until-ended'),
      entry('glimmer', [0, 1].map(() => ({ use: 'light.flash', at: 'center', radius: 0.35, intensity: 1 }))),
    ]);
    const gloom = r.cast('gloom');
    r.advance(1500);
    expect(r.core.light.dim).toBeCloseTo(0.8);
    // The flashes come when the budget is spent, just as the room starts to lift: both brighten the
    // picture at once.
    r.cast('glimmer');
    r.advance(CAST_SEQUENCE.bloomDelayMs - 10);
    for (let k = 0; k < 3; k++) r.core.light.limiter.change(r.now() - 3 + k);
    r.kernel.emit('spell.ended', { spellId: 'gloom', castId: gloom.id, t: r.now(), by: 'finite-incantatem' }, 'engine');
    const glowingAtTheEnd: boolean[] = [];
    r.kernel.subscribe<EffectEvent>('effect.end', (e) => {
      if (e.payload.use === 'light.flash') glowingAtTheEnd.push(r.core.light.flashes.some((f) => f.soft));
    });
    const v = r.core.view;
    const H = v.height * v.dpr;
    const points = [0, 0.1, 0.2].map((d) => ({ x: v.px(0.5) + d * H, y: v.py(0.5) }));
    const m = meter(points);
    const seen: number[][] = points.map(() => []);
    for (let t = 0; t < 3000; t += 16) {
      r.advance(16);
      m.clear();
      r.core.light.drawShade(m.ctx, v, SPRITES, r.now());
      r.core.light.drawLight(m.ctx, v, SPRITES, r.now(), false);
      // Over a white wall, where the lifting veil shows most.
      points.forEach((_, i) => seen[i].push(1 - (1 - Math.min(1, m.light[i])) * m.veil[i]));
    }
    for (let i = 0; i < points.length; i++) {
      let worst = 0;
      for (let j = 6; j < seen[i].length; j++) worst = Math.max(worst, Math.abs(seen[i][j] - seen[i][j - 6]));
      expect(worst, `picture ${i}`).toBeLessThan(0.1);
    }
    const flashes = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'light.flash');
    expect(flashes.map((e) => e.params?.softened)).toEqual([true, true]);
    // Both steps ended, and only once the glow had faded out; the room is back.
    expect(glowingAtTheEnd).toEqual([false, false]);
    expect(r.core.light.dim).toBe(0);
  });

  it('a refused flash glowing over a lit orb flashes no more than three times a second, whatever its flicker is doing', async () => {
    // A held orb lit at the centre, as Lumos at a still tip, then an imported spell with four bright
    // flashes there, 80 ms long and 112 ms apart: three get through the budget, the fourth is refused
    // and glows. Cast at every phase of the orb's flicker, whose two waves beat about every 1.4 s.
    const quad: EffectStep[] = [0, 112, 224, 336].map((d) => ({ use: 'light.flash', at: 'center', radius: 0.35, intensity: 1, duration_ms: 80, delay_ms: d }));
    const most: number[] = [];
    for (let offset = 0; offset < 1600; offset += 32) {
      const r = await rig();
      addSpells(r, [entry('lamp', [{ use: 'light.orb', at: 'center', hold: true }], 'until-ended'), entry('quad', quad)]);
      r.cast('lamp');
      r.advance(2000 + offset);
      r.cast('quad');
      const v = r.core.view;
      const H = v.height * v.dpr;
      // Where the orb's light is nearly full, so its flicker moves the picture most.
      const points = [0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06].map((d) => ({ x: v.px(0.5) + d * H, y: v.py(0.5) }));
      const m = meter(points);
      const light: number[][] = points.map(() => []);
      for (let t = 0; t < 2500; t += 16) {
        r.advance(16);
        m.clear();
        r.core.light.drawLight(m.ctx, v, SPRITES, r.now(), false);
        points.forEach((_, i) => light[i].push(Math.min(1, m.light[i])));
      }
      const flashes = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'light.flash');
      expect(flashes.map((e) => e.params?.softened === true)).toEqual([false, false, false, true]);
      most.push(Math.max(...light.map((s) => mostFlashesInASecond(s, 16))));
      await r.kernel.stop();
    }
    expect(Math.max(...most)).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
  });

  it('nothing that changes softly over a lit orb adds up with its flicker: a refused flash’s glow, a soft bloom, the room’s dimming', async () => {
    // Each alone changes the picture no faster than dimming may. While a light changes softly the
    // orb's flicker waits, and the dimming shows only where the light is not full. So at every phase
    // of the flicker, over a dark wall or a white one, the picture changes no faster than dimming
    // alone may.
    const soft: Record<string, EffectStep[]> = {
      glow: [{ use: 'light.flash', at: 'center', radius: 0.35, intensity: 1 }],
      bloom: [{ use: 'light.orb', at: 'center', hold: true }],
      dim: [{ use: 'scene.dim', amount: 0.8, fade_ms: 300, hold: true }],
    };
    for (const [kind, steps] of Object.entries(soft)) {
      let worst = 0;
      for (let offset = 0; offset < 1400; offset += 64) {
        const r = await rig();
        addSpells(r, [entry('lamp', [{ use: 'light.orb', at: 'center', hold: true }], 'until-ended'), entry('soft', steps, 'until-ended')]);
        r.cast('lamp');
        r.advance(2000 + offset);
        const c = r.cast('soft');
        // The budget is spent when its step runs, so a flash or a bloom is made softly.
        r.advance(CAST_SEQUENCE.bloomDelayMs - 10);
        for (let k = 0; k < 3; k++) r.core.light.limiter.change(r.now() - 3 + k);
        const v = r.core.view;
        const H = v.height * v.dpr;
        // From the orb's centre out past the pool it clears in the dimming.
        const points = [0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5].map((d) => ({ x: v.px(0.5) + d * H, y: v.py(0.5) }));
        const m = meter(points);
        const seen: number[][] = [...points, ...points].map(() => []);
        // Until the glow and the dimming are over; the bloom is still under way.
        for (let t = 0; t < 1500; t += 16) {
          r.advance(16);
          m.clear();
          r.core.light.drawShade(m.ctx, v, SPRITES, r.now());
          r.core.light.drawLight(m.ctx, v, SPRITES, r.now(), false);
          points.forEach((_, i) => {
            const l = Math.min(1, m.light[i]);
            seen[i].push(l);
            seen[points.length + i].push(1 - (1 - l) * m.veil[i]);
          });
        }
        for (const s of seen) for (let j = 6; j < s.length; j++) worst = Math.max(worst, Math.abs(s[j] - s[j - 6]));
        if (kind === 'dim') expect(r.core.light.dim).toBeCloseTo(0.8);
        else expect(r.of<EffectEvent>('effect.start').find((e) => e.castId === c.id)?.params?.softened, kind).toBe(true);
        await r.kernel.stop();
      }
      expect(worst, kind).toBeLessThanOrEqual(MAX_DIM_RATE_PER_MS * 96 + 1e-9);
    }
  });

  it('caps particles at the pool size', async () => {
    const r = await rig();
    for (let i = 0; i < 20; i++) r.core.particles.burst({ preset: 'sparks', x: 0.5, y: 0.5, count: 400 });
    expect(r.core.particles.count).toBeLessThanOrEqual(EFFECT_LIMITS.particlesMax);
  });

  it('under reduced motion every step’s particle count drops by the factor, once', async () => {
    const r = await rig({ 'access.reducedMotion': 'on' });
    r.cast('incendio', { targetId: 'candle' });
    r.advance(40);
    const burst = r.of<EffectEvent>('effect.start').find((e) => e.use === 'particles.burst')!;
    expect(burst.params?.count).toBe(Math.round(40 * EFFECT_LIMITS.reducedMotionParticleFactor));
    expect(r.core.particles.count).toBe(burst.params?.count);
  });
});

describe('with the real shelf (props/)', () => {
  it('builds, publishes all six props from PROP_START, and lets a cast act on one', async () => {
    const { createShelf } = await import('../props');
    clock = 1000;
    const kernel = createKernel({ persistence: memoryPersistence({}), features: ['platform.dom'], clock: () => clock });
    const core = new StageCore(MANIFEST, { host: null, shelf: createShelf(), headless: true, seed: 3 });
    kernel.register(core.module());
    await kernel.init();
    await kernel.start();
    kernel.emit('spellbook.changed', BOOK, 'kernel.packs');
    const sp = kernel.last<SceneProps>('scene.props')!.payload;
    expect(sp.props.map((p) => p.id)).toEqual(PROP_IDS);
    for (const p of sp.props) {
      const start = PROP_START[p.id as keyof typeof PROP_START];
      expect(p.label).toBe(start.label);
      expect([...p.tags].sort()).toEqual([...start.tags].sort());
    }
    kernel.emit('spell.cast', { id: 'c1', spellId: 'incendio', t: clock, via: 'gesture', quality: 1, power: 0.5, aim: { x: 0.12, y: 0.86 }, targetId: 'candle' }, 'engine');
    for (let i = 0; i < 40; i++) {
      clock += 16;
      core.tick(clock, false);
    }
    const candle = kernel.last<SceneProps>('scene.props')!.payload.props.find((p) => p.id === 'candle')!;
    expect(candle.tags).toContain(PROP_TAGS.burning);
    expect(candle.state.lit).toBe(true);
    await kernel.request('stage.reset');
    expect(kernel.last<SceneProps>('scene.props')!.payload.props.find((p) => p.id === 'candle')!.state.lit).toBe(false);
    await kernel.stop();
  });
});

describe('replays (stage.replay)', () => {
  it('draws the trace, casts through engine.cast as a replay, resets the shelf and reports replay.state', async () => {
    vi.useFakeTimers();
    const r = await rig();
    let asked: Record<string, unknown> | null = null;
    const order: string[] = [];
    r.kernel.handle('engine.reset', () => {
      order.push(`engine.reset, shelf reset ${r.props.feather.resets} times`);
    });
    r.kernel.handle('engine.cast', (p: Record<string, unknown>) => {
      asked = p;
      order.push(`engine.cast, shelf reset ${r.props.feather.resets} times`);
      const cast: SpellCast = {
        id: 'replay-cast', spellId: String(p.spellId), t: r.now(), via: 'gesture', quality: 1, power: 0.5, aim: p.aim as { x: number; y: number },
        replay: true, ...(typeof p.targetId === 'string' ? { targetId: p.targetId } : {}),
      };
      r.kernel.emit('spell.cast', cast, 'engine');
      return cast;
    });
    const ticker = setInterval(() => {
      clock += 16;
      r.core.tick(clock, false);
    }, 16);
    const points = Array.from({ length: 64 }, (_, i) => [0.5, 0.8 - i * 0.008] as Point);
    const done = r.kernel.request<{ castId: string; durationMs: number }>('stage.replay', {
      spellId: 'alohomora', points, aspect: 16 / 9, durationMs: 600, via: 'gesture', quality: 1, power: 0.5, variant: false, targetId: 'feather',
    });
    expect(r.kernel.last<{ playing: boolean }>('replay.state')!.payload.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await done;
    clearInterval(ticker);
    expect(result.castId).toBe('replay-cast');
    expect(asked).toMatchObject({ spellId: 'alohomora', replay: true, targetId: 'feather' });
    expect(r.props.feather.applied.map((a) => a.use)).toEqual(['prop.unlock']);
    // The live spells end and the shelf goes back to its start before the cast, and it resets again after.
    expect(order).toEqual(['engine.reset, shelf reset 0 times', 'engine.cast, shelf reset 1 times']);
    expect(r.props.feather.resets).toBe(2);
    const states = r.of<{ playing: boolean; castId?: string }>('replay.state');
    expect(states[states.length - 1]).toMatchObject({ playing: false, castId: 'replay-cast' });
    expect(r.core.ink.history).toHaveLength(1);
  });

  it('ignores live tip input for ink while a replay plays', async () => {
    vi.useFakeTimers();
    const r = await rig();
    r.kernel.handle('engine.cast', () => new Promise(() => {}));
    void r.kernel.request('stage.replay', {
      spellId: 'lumos', points: [[0.5, 0.8], [0.5, 0.4]], aspect: 16 / 9, durationMs: 500, via: 'gesture', quality: 1, power: 0.5, variant: false,
    }).catch(() => {});
    trace(r, 'live', upStroke);
    expect(r.core.ink.get('live')).toBeUndefined();
    await r.kernel.stop();
  });

  /** Tick the stage every 16 ms of fake time, calling `each` after every tick. */
  function ticking(r: Rig, each: () => void = () => {}): () => void {
    const ticker = setInterval(() => {
      clock += 16;
      r.core.tick(clock, false);
      each();
    }, 16);
    return () => clearInterval(ticker);
  }

  it('starts from the shelf as it began: a replayed Reparo knits a cup the player had mended already', async () => {
    vi.useFakeTimers();
    const { r, prop } = await realRig();
    addSpells(r, [entry('reparo', [{ use: 'prop.mend' }])]);
    const asked = fakeEngine(r);
    r.cast('reparo', { targetId: 'teacup' });
    r.advance(CAST_SEQUENCE.bloomDelayMs + 40);
    expect(prop.teacup.state()).toEqual({ cracked: false });
    const stop = ticking(r);
    const done = r.kernel.request('stage.replay', replayOf('reparo', [0.4, 0.5], [0.6, 0.5], { targetId: 'teacup' }));
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    stop();
    const mends = r.of<EffectEvent>('effect.start').filter((e) => e.use === 'prop.mend');
    expect(mends).toHaveLength(2);
    // It knitted the cup on screen, rather than sparkling at a whole one.
    expect(mends[1].params?.sparkle).toBeUndefined();
    // The live spells were ended before the replay, so the engine never counts as active a spell
    // whose prop the reset put back.
    expect(asked).toEqual(['engine.reset', 'engine.cast']);
  });

  it('lets the replayed prop finish what it shows before the shelf resets', async () => {
    vi.useFakeTimers();
    const { r, prop } = await realRig();
    addSpells(r, [entry('reparo', [{ use: 'prop.mend' }]), entry('expelliarmus', [{ use: 'prop.disarm' }])]);
    fakeEngine(r);
    // Reparo: the crack knits and its gold seam fades before the cup is cracked again.
    let mendAt = -1;
    let crackedAt = -1;
    let stop = ticking(r, () => {
      const cracked = prop.teacup.state().cracked === true;
      if (!cracked && mendAt < 0) mendAt = clock;
      if (cracked && mendAt >= 0 && crackedAt < 0) crackedAt = clock;
    });
    let done = r.kernel.request('stage.replay', replayOf('reparo', [0.4, 0.5], [0.6, 0.5], { targetId: 'teacup' }));
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    stop();
    expect(mendAt).toBeGreaterThan(0);
    expect(crackedAt - mendAt).toBeGreaterThanOrEqual(MEND_MS + REPLAY_TAIL_MS);

    // Expelliarmus: the wand lands on the shelf, and lies there a beat, before it is back in the hand.
    let landedAt = -1;
    let backAt = -1;
    stop = ticking(r, () => {
      const away = prop.dummy.state().disarmed === true;
      if (away && landedAt < 0 && prop.dummy.settled?.()) landedAt = clock;
      if (!away && landedAt >= 0 && backAt < 0) backAt = clock;
    });
    done = r.kernel.request('stage.replay', replayOf('expelliarmus', [0.5, 0.5], [0.8, 0.4], { targetId: 'dummy' }));
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    stop();
    expect(landedAt).toBeGreaterThan(0);
    expect(backAt - landedAt).toBeGreaterThanOrEqual(REPLAY_TAIL_MS);
  });

  it('leaves live effects on the live tip: a live Lumos stays on the wand while a replay traces elsewhere', async () => {
    vi.useFakeTimers();
    const r = await rig();
    fakeEngine(r);
    const tipAt = () => r.kernel.emit('tip.filtered', { t: clock, x: 0.82, y: 0.4, conf: 1, src: 'tracker.pointer' }, 'stroke');
    tipAt();
    r.cast('lumos');
    for (let i = 0; i < 60; i++) {
      tipAt();
      r.advance(16);
    }
    const orb = r.core.light.orbs[0];
    expect(orb.x).toBeCloseTo(0.82, 2);
    let worst = 0;
    const stop = ticking(r, () => {
      tipAt();
      worst = Math.max(worst, Math.hypot(orb.x - 0.82, orb.y - 0.4));
    });
    // A replay traced along the left of the glass, as Keepsakes' Watch plays it.
    const done = r.kernel.request('stage.replay', replayOf('alohomora', [0.12, 0.42], [0.37, 0.42], { targetId: 'feather', durationMs: 1200 }));
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    stop();
    expect(orb.state).toBe('lit');
    expect(worst).toBeLessThan(0.01);
  });
});
