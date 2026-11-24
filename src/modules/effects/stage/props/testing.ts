// Test support for the props (used by the *.test.ts files next to it; nothing in the app imports it).
// A fake stage with a real caster-to-pixel mapping, a controllable tip and clock, and a recording 2D
// context that fails on the mistakes a browser would throw on or silently draw wrong: non-finite
// numbers, negative radii, gradient stops outside 0..1, and unbalanced save/restore.

import type { EffectStep, SpellCast } from '../../../../contracts';
import type { BurstOptions, FrameInfo, Layers, PropAction, PropView, StageServices, StageView } from '../types';
import type { CanvasFactory, Surface } from './art/canvas';

export interface FakeStage {
  services: StageServices;
  bursts: BurstOptions[];
  /** Times propsChanged() was called. */
  readonly changes: number;
  now: number;
  tip: { x: number; y: number } | null;
  reveal: number;
}

export interface StageSize {
  width?: number;
  height?: number;
  dpr?: number;
  /** The caster rectangle in CSS px inside the mirror (letterboxing); default: the whole mirror. */
  caster?: { x: number; y: number; w: number; h: number };
}

const FAKE_IMAGE = { width: 64, height: 64 } as unknown as CanvasImageSource;

export function fakeStage(size: StageSize = {}): FakeStage {
  const width = size.width ?? 1600;
  const height = size.height ?? 900;
  const dpr = size.dpr ?? 1;
  const c = size.caster ?? { x: 0, y: 0, w: width, h: height };
  const view: StageView = {
    width, height, dpr, aspect: width / height,
    toPx: (x, y) => [(c.x + x * c.w) * dpr, (c.y + y * c.h) * dpr],
    fromPx: (px, py) => [(px / dpr - c.x) / c.w, (py / dpr - c.y) / c.h],
    size: (f) => f * height * dpr,
  };
  let seed = 12345;
  let changes = 0;
  const stage: FakeStage = {
    bursts: [],
    get changes() {
      return changes;
    },
    now: 0,
    tip: null,
    reveal: 0,
    services: undefined as unknown as StageServices,
  };
  stage.services = {
    view,
    particles: {
      burst: (o) => {
        stage.bursts.push(o);
      },
      count: 0,
    },
    tip: () => (stage.tip ? { x: stage.tip.x, y: stage.tip.y } : null),
    glow: () => FAKE_IMAGE,
    now: () => stage.now,
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    },
    propsChanged: () => {
      changes++;
    },
    revealAlpha: () => stage.reveal,
  };
  return stage;
}

export function frameAt(now: number, dt = 16, extra: Partial<FrameInfo> = {}): FrameInfo {
  return { now, dt, rawDt: dt, timeScale: 1, reducedMotion: false, quality: 'high', ...extra };
}

/** Run `ms` of frames on some props. */
export function run(props: PropView | PropView[], stage: FakeStage, ms: number, step = 16, extra: Partial<FrameInfo> = {}): void {
  const list = Array.isArray(props) ? props : [props];
  for (let t = 0; t < ms; t += step) {
    stage.now += step;
    const f = frameAt(stage.now, step, extra);
    for (const p of list) p.update(f, stage.services);
  }
}

/** Run frames until `until()` holds or `maxMs` passes; returns the ms it took. */
export function runUntil(prop: PropView, stage: FakeStage, until: () => boolean, maxMs = 60000, step = 16, extra: Partial<FrameInfo> = {}): number {
  let t = 0;
  while (t < maxMs && !until()) {
    stage.now += step;
    t += step;
    prop.update(frameAt(stage.now, step, extra), stage.services);
  }
  return t;
}

export interface TestAction {
  action: PropAction;
  /** Times done() was called. */
  readonly done: number;
}

export function act(castId: string, use: string, params: Record<string, unknown> = {}, aim = { x: 0.5, y: 0.5 }, scale = 1): TestAction {
  let done = 0;
  const cast: SpellCast = { id: castId, spellId: 'test-spell', t: 0, via: 'gesture', quality: 1, power: 0.5, aim };
  const step: EffectStep = { use, ...params };
  return {
    action: { cast, step, scale, done: () => { done++; } },
    get done() {
      return done;
    },
  };
}

// ------------------------------------------------------------------ a recording 2D context

export interface Recorder {
  factory: CanvasFactory;
  /** Two layer contexts like the core's. */
  layers: Layers;
  problems: string[];
  /** Drawing calls made (drawImage, fill, stroke...). */
  calls: number;
  /** save() minus restore() per context; must return to 0 after each draw. */
  depth(ctx: CanvasRenderingContext2D): number;
  surfaces: number;
}

const DRAWING = new Set(['drawImage', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText']);

export function recorder(): Recorder {
  const problems: string[] = [];
  const depths = new Map<unknown, number>();
  const rec: Recorder = {
    factory: (w, h) => makeSurface(w, h),
    layers: undefined as unknown as Layers,
    problems,
    calls: 0,
    depth: (ctx) => depths.get(ctx) ?? 0,
    surfaces: 0,
  };

  const gradient = {
    addColorStop(offset: number, color: string) {
      if (!(offset >= 0 && offset <= 1)) problems.push(`addColorStop offset ${offset}`);
      if (typeof color !== 'string' || !color) problems.push('addColorStop without a color');
    },
  };

  function check(name: string, args: unknown[]): void {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) {
        problems.push(`${name}(${args.map(String).join(', ')})`);
        return;
      }
    }
    const n = args as number[];
    if (name === 'arc' && n[2] < 0) problems.push(`arc radius ${n[2]}`);
    if (name === 'ellipse' && (n[2] < 0 || n[3] < 0)) problems.push(`ellipse radii ${n[2]}, ${n[3]}`);
    if (name === 'createRadialGradient' && (n[2] < 0 || n[5] < 0)) problems.push(`radial gradient radii ${n[2]}, ${n[5]}`);
    if (name === 'drawImage' && args.length >= 5 && (n[3] < 0 || n[4] < 0)) problems.push(`drawImage negative size ${n[3]}, ${n[4]}`);
  }

  function makeCtx(width: number, height: number): CanvasRenderingContext2D {
    const target: Record<string | symbol, unknown> = {
      canvas: { width, height },
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      lineWidth: 1,
      fillStyle: '#000',
      strokeStyle: '#000',
    };
    let ctx: CanvasRenderingContext2D;
    const handler: ProxyHandler<Record<string | symbol, unknown>> = {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createConicGradient') {
          return (...args: unknown[]) => {
            check(String(prop), args);
            return gradient;
          };
        }
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'save') return () => depths.set(ctx, (depths.get(ctx) ?? 0) + 1);
        if (prop === 'restore') {
          return () => {
            const d = (depths.get(ctx) ?? 0) - 1;
            if (d < 0) problems.push('restore() without save()');
            depths.set(ctx, Math.max(0, d));
          };
        }
        return (...args: unknown[]) => {
          check(String(prop), args);
          if (DRAWING.has(String(prop))) rec.calls++;
        };
      },
      set(t, prop, value) {
        if (prop === 'globalAlpha' && !(typeof value === 'number' && Number.isFinite(value))) problems.push(`globalAlpha ${String(value)}`);
        if (prop === 'lineWidth' && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) problems.push(`lineWidth ${String(value)}`);
        t[prop] = value;
        return true;
      },
    };
    ctx = new Proxy(target, handler) as unknown as CanvasRenderingContext2D;
    return ctx;
  }

  function makeSurface(w: number, h: number): Surface {
    if (!(w > 0 && h > 0 && Number.isFinite(w + h))) problems.push(`surface ${w}x${h}`);
    if (w > 4096 || h > 4096) problems.push(`surface too large ${w}x${h}`);
    rec.surfaces++;
    const ctx = makeCtx(w, h);
    return { canvas: ctx.canvas as unknown as CanvasImageSource, ctx, width: Math.ceil(w), height: Math.ceil(h) };
  }

  rec.layers = { shade: makeCtx(1600, 900), light: makeCtx(1600, 900) };
  return rec;
}
