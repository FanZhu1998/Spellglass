import { describe, expect, it } from 'vitest';
import { Creature, CreatureRenderer, HARE_LANDMARKS, poseHare } from './creature';
import type { CreatureParams } from './limits';
import type { ParticleSystem } from './particles';
import { View } from './view';

const PARAMS: CreatureParams = { kind: 'hare', hold: false, duration_ms: 7000, color: '#DDE8FF', size: 1 };
const PHASES = Array.from({ length: 40 }, (_, i) => i / 40);

/** Counts what a creature spawns, by preset. */
function particles(): { system: ParticleSystem; spawned: Record<string, number> } {
  const spawned: Record<string, number> = {};
  const system = {
    spawn: (o: { preset: string; count?: number }) => {
      spawned[o.preset] = (spawned[o.preset] ?? 0) + (o.count ?? 0);
      return o.count ?? 0;
    },
  } as unknown as ParticleSystem;
  return { system, spawned };
}

function run(c: Creature, ms: number, reduced = false, p = particles().system, from = 0): void {
  for (let t = 16; t <= ms; t += 16) c.update(from + t, 16, 16 / 9, p, reduced);
}

describe('the patronus hare', () => {
  it('stays whole through its gallop: every point finite and well inside the square its glow is drawn in', () => {
    for (const phase of PHASES) {
      const { x, y } = poseHare(phase);
      for (let i = 0; i < x.length; i++) {
        expect(Number.isFinite(x[i]) && Number.isFinite(y[i])).toBe(true);
        expect(x[i]).toBeGreaterThan(-1);
        expect(x[i]).toBeLessThan(0.75);
        expect(y[i]).toBeGreaterThan(-0.7);
        expect(y[i]).toBeLessThan(0.5);
      }
    }
  });

  it('keeps its head rigid and its ears up and paws down at every phase', () => {
    const { eye, nose, earTips, toes, paw } = HARE_LANDMARKS;
    const rest = poseHare(0);
    const span = Math.hypot(rest.x[nose] - rest.x[eye], rest.y[nose] - rest.y[eye]);
    for (const phase of PHASES) {
      const { x, y } = poseHare(phase);
      expect(Math.hypot(x[nose] - x[eye], y[nose] - y[eye])).toBeCloseTo(span, 5);
      expect(y[earTips[0]]).toBeLessThan(y[eye] - 0.15);
      expect(y[toes]).toBeGreaterThan(y[eye] + 0.2);
      expect(y[paw]).toBeGreaterThan(y[eye] + 0.2);
    }
  });

  it('gallops: stretched out, the hind feet trail far behind; gathered, they swing past the forepaws', () => {
    const { tail, toes, paw } = HARE_LANDMARKS;
    const out = poseHare(0.02);
    expect(out.x[toes]).toBeLessThan(out.x[tail] - 0.2);
    expect(out.x[paw]).toBeGreaterThan(0.3);
    const gathered = poseHare(0.56);
    expect(gathered.x[toes]).toBeGreaterThan(gathered.x[paw]);
  });

  it('sheds fewer motes and less mist under reduced motion', () => {
    const full = particles(), cut = particles();
    run(new Creature('a', PARAMS, { x: 0.5, y: 0.3 }, 0), 3000, false, full.system);
    run(new Creature('b', PARAMS, { x: 0.5, y: 0.3 }, 0), 3000, true, cut.system);
    expect(full.spawned.stars).toBeGreaterThan(60);
    expect(full.spawned.mist).toBeGreaterThan(12);
    expect(cut.spawned.stars).toBeLessThan(full.spawned.stars * 0.4);
    expect(cut.spawned.mist).toBeLessThan(full.spawned.mist * 0.5);
  });

  it('holds still when time stops (Arresto Momentum), sheds nothing, and runs on when it starts again', () => {
    const c = new Creature('c', PARAMS, { x: 0.5, y: 0.3 }, 0);
    const p = particles();
    run(c, 1500, false, p.system);
    const before = { ...c.pose, turn: c.turn, tilt: c.tilt, clock: c.clock };
    const shed = (p.spawned.stars ?? 0) + (p.spawned.mist ?? 0);
    for (let t = 0; t < 1000; t += 16) c.update(1500 + t, 0, 16 / 9, p.system, false);
    expect({ ...c.pose, turn: c.turn, tilt: c.tilt, clock: c.clock }).toEqual(before);
    expect((p.spawned.stars ?? 0) + (p.spawned.mist ?? 0)).toBe(shed);
    run(c, 200, false, p.system, 2500);
    expect(c.clock).toBeGreaterThan(before.clock);
  });

  it('narrows through a turn at the end of its loop rather than flipping in one frame', () => {
    const c = new Creature('d', PARAMS, { x: 0.5, y: 0.3 }, 0);
    let flipped = -1;
    for (let t = 16; t <= 4000 && flipped < 0; t += 16) {
      const facing = c.facing;
      c.update(t, 16, 16 / 9, particles().system, false);
      if (c.pose.alpha > 0.5 && c.facing !== facing) flipped = t;
    }
    expect(flipped).toBeGreaterThan(0);
    // Just after the flip it is still turning; a quarter of a second later it has turned.
    expect(Math.abs(c.turn)).toBeLessThan(0.9);
    run(c, 250, false, particles().system, flipped);
    expect(c.turn).toBeCloseTo(c.facing, 1);
  });

  it('draws without a canvas to hand (Node), leaving the light layer as it found it', () => {
    const coords: number[] = [];
    const transforms: number[][] = [];
    const gradient = { addColorStop: () => {} };
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1, imageSmoothingEnabled: true, filter: 'none',
      setTransform: (...m: number[]) => transforms.push(m),
      beginPath: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {}, drawImage: () => {},
      moveTo: (x: number, y: number) => coords.push(x, y), lineTo: (x: number, y: number) => coords.push(x, y), arc: () => {},
      createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    } as unknown as CanvasRenderingContext2D;
    const view = new View();
    view.update(1280, 720, 2, 16 / 9);
    const c = new Creature('e', PARAMS, { x: 0.5, y: 0.3 }, 0);
    run(c, 2000);
    new CreatureRenderer().draw(ctx, c, view);
    expect(coords.length).toBeGreaterThan(1000);
    expect(coords.every(Number.isFinite)).toBe(true);
    expect(transforms[transforms.length - 1]).toEqual([1, 0, 0, 1, 0, 0]);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
});
