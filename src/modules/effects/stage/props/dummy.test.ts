import { describe, expect, it } from 'vitest';
import { PROP_START, PROP_TAGS } from '../../../../contracts';
import { COSTUMES } from './art/dummy';
import { Dummy, WAND_AWAY_MS } from './dummy';
import { createShelf } from './index';
import { act, fakeStage, run, runUntil, type FakeStage } from './testing';

function setup(): { d: Dummy; stage: FakeStage } {
  const shelf = createShelf();
  const d = shelf.props.find((p) => p.id === 'dummy') as Dummy;
  const stage = fakeStage();
  run(d, stage, 16);
  return { d, stage };
}

describe('training dummy', () => {
  it('keeps its tags whatever happens to it', () => {
    const { d, stage } = setup();
    d.apply('prop.freeze', act('a', 'prop.freeze', { topple: true }).action, stage.services);
    d.apply('prop.costume', act('b', 'prop.costume').action, stage.services);
    run(d, stage, 1000);
    expect(d.tags()).toEqual(PROP_START.dummy.tags);
    expect(d.tags()).toContain(PROP_TAGS.dummy);
    expect([d.x, d.y]).toEqual([d.home.x, d.home.y]);
  });

  it('reels back and recovers (Stupefy)', () => {
    const { d, stage } = setup();
    expect(d.apply('prop.reel', act('stun', 'prop.reel', { intensity: 0.8 }).action, stage.services)).toBe(true);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      run(d, stage, 16);
      peak = Math.max(peak, d.debugPose.lean);
    }
    expect(peak).toBeGreaterThan(0.12);
    run(d, stage, 3000);
    expect(Math.abs(d.debugPose.lean)).toBeLessThan(0.01);
  });

  it('reels in slow motion under Impedimenta (local time scale)', () => {
    const fast = setup();
    const slow = setup();
    slow.d.timeScale = 0.2;
    fast.d.apply('prop.reel', act('a', 'prop.reel', { intensity: 0.6 }).action, fast.stage.services);
    slow.d.apply('prop.reel', act('a', 'prop.reel', { intensity: 0.6 }).action, slow.stage.services);
    run(fast.d, fast.stage, 100);
    run(slow.d, slow.stage, 100);
    expect(slow.d.debugPose.lean).toBeLessThan(fast.d.debugPose.lean * 0.6);
    expect(slow.d.debugPose.lean).toBeGreaterThan(0);
  });

  it('loses its wand in an arc and gets it back after a few seconds (Expelliarmus)', () => {
    const { d, stage } = setup();
    expect(d.apply('prop.disarm', act('exp', 'prop.disarm').action, stage.services)).toBe(true);
    expect(d.state()).toEqual({ disarmed: true });
    run(d, stage, 1000);
    expect(d.debugPose.wand).toBe('dropped');
    // The wand landed on the shelf, left of the dummy.
    expect(stage.bursts.at(-1)?.x).toBeLessThan(d.home.x);
    run(d, stage, WAND_AWAY_MS);
    expect(d.debugPose.wand).toBe('returning');
    run(d, stage, 800);
    expect(d.state()).toEqual({});
    // Disarming an empty hand only makes it flinch.
    d.apply('prop.disarm', act('exp2', 'prop.disarm').action, stage.services);
    expect(d.apply('prop.disarm', act('exp3', 'prop.disarm').action, stage.services)).toBe(true);
  });

  it('gets its wand back at once on end("*")', () => {
    const { d, stage } = setup();
    d.apply('prop.disarm', act('exp', 'prop.disarm').action, stage.services);
    run(d, stage, 1000);
    d.end('*');
    run(d, stage, 800);
    expect(d.state().disarmed).toBeUndefined();
  });

  it('snaps rigid with a tint and topples, then rights itself when the spell ends (Petrificus Totalus)', () => {
    const { d, stage } = setup();
    const a = act('petri', 'prop.freeze', { topple: true, duration_ms: 6000 });
    expect(d.apply('prop.freeze', a.action, stage.services)).toBe(true);
    expect(d.label()).toBe('frozen training dummy');
    expect(d.state()).toEqual({ frozen: true, toppled: true });
    run(d, stage, 1000);
    expect(d.debugPose.fall).toBe(1);
    d.end('another-cast');
    expect(d.state().frozen).toBe(true);
    d.end('petri');
    expect(d.state()).toEqual({});
    expect(d.label()).toBe('training dummy');
    run(d, stage, 1500);
    expect(d.debugPose.fall).toBe(0);
    expect(a.done).toBe(0);
  });

  it('a freeze that runs its course reports done and the dummy gets up', () => {
    const { d, stage } = setup();
    const a = act('petri', 'prop.freeze', { topple: true, duration_ms: 2000 });
    d.apply('prop.freeze', a.action, stage.services);
    run(d, stage, 2100);
    expect(a.done).toBe(1);
    expect(d.state()).toEqual({});
    run(d, stage, 1500);
    expect(d.debugPose.fall).toBe(0);
  });

  it('a freeze without topple keeps it standing', () => {
    const { d, stage } = setup();
    d.apply('prop.freeze', act('f', 'prop.freeze', { duration_ms: 3000 }).action, stage.services);
    run(d, stage, 1000);
    expect(d.state()).toEqual({ frozen: true });
    expect(d.debugPose.fall).toBe(0);
  });

  it('drops to the floor and rights itself later (Avada Kedavra)', () => {
    const { d, stage } = setup();
    const a = act('ak', 'prop.topple', { duration_ms: 3000 });
    expect(d.apply('prop.topple', a.action, stage.services)).toBe(true);
    expect(d.label()).toBe('toppled training dummy');
    run(d, stage, 1000);
    expect(d.debugPose.fall).toBe(1);
    // It lands with a puff of dust on the shelf.
    expect(stage.bursts.some((b) => b.preset === 'dust')).toBe(true);
    run(d, stage, 2100);
    expect(a.done).toBe(1);
    expect(d.state()).toEqual({});
    run(d, stage, 1200);
    expect(d.debugPose.fall).toBe(0);
  });

  it('topples slower under a slow local time', () => {
    const { d, stage } = setup();
    d.timeScale = 0.2;
    const a = act('ak', 'prop.topple', { duration_ms: 1000 });
    d.apply('prop.topple', a.action, stage.services);
    run(d, stage, 4000);
    expect(a.done).toBe(0);
    run(d, stage, 1200);
    expect(a.done).toBe(1);
  });

  it('gets a silly costume, a different one each time, until Finite (Riddikulus)', () => {
    const { d, stage } = setup();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      expect(d.apply('prop.costume', act(`r${i}`, 'prop.costume', { costume: 'random' }).action, stage.services)).toBe(true);
      const c = d.state().costume as string;
      expect(COSTUMES).toContain(c);
      if (seen.length) expect(c).not.toBe(seen[seen.length - 1]);
      seen.push(c);
      run(d, stage, 400);
    }
    d.apply('prop.costume', act('named', 'prop.costume', { costume: 'ruff' }).action, stage.services);
    expect(d.state().costume).toBe('ruff');
    d.end('*');
    expect(d.state().costume).toBeUndefined();
  });

  it('copies the wand: leans toward the tip and with it, then reports done (Imperio)', () => {
    const { d, stage } = setup();
    const a = act('imp', 'prop.mimic', { duration_ms: 2000 });
    expect(d.apply('prop.mimic', a.action, stage.services)).toBe(true);
    expect(d.state()).toEqual({ mimicking: true });
    stage.tip = { x: d.home.x + 0.15, y: 0.3 };
    run(d, stage, 800);
    expect(d.debugPose.lean).toBeGreaterThan(0.1);
    // Tip high: the wand arm is raised.
    expect(d.debugPose.arms).toBeGreaterThan(0.05);
    stage.tip = { x: d.home.x - 0.2, y: 0.6 };
    run(d, stage, 800);
    expect(d.debugPose.lean).toBeLessThan(-0.1);
    run(d, stage, 500);
    expect(a.done).toBe(1);
    expect(d.state()).toEqual({});
    run(d, stage, 2000);
    expect(Math.abs(d.debugPose.lean)).toBeLessThan(0.02);
  });

  it('cannot mimic while frozen or lying down', () => {
    const { d, stage } = setup();
    d.apply('prop.freeze', act('f', 'prop.freeze').action, stage.services);
    expect(d.apply('prop.mimic', act('imp', 'prop.mimic').action, stage.services)).toBe(false);
    d.end('*');
    d.apply('prop.topple', act('t', 'prop.topple').action, stage.services);
    expect(d.apply('prop.mimic', act('imp2', 'prop.mimic').action, stage.services)).toBe(false);
  });

  it('a freeze replaces Imperio and reports it done', () => {
    const { d, stage } = setup();
    const imp = act('imp', 'prop.mimic', { duration_ms: 5000 });
    d.apply('prop.mimic', imp.action, stage.services);
    run(d, stage, 200);
    d.apply('prop.freeze', act('f', 'prop.freeze').action, stage.services);
    run(d, stage, 16);
    expect(imp.done).toBe(1);
    expect(d.state().mimicking).toBeUndefined();
  });

  it('grows and shrinks, but refuses everything a heavy dummy cannot do', () => {
    const { d, stage } = setup();
    const r0 = d.radius;
    expect(d.apply('prop.scale', act('g', 'prop.scale', { factor: 1.6, duration_ms: 1000 }).action, stage.services)).toBe(true);
    run(d, stage, 800);
    expect(d.radius).toBeGreaterThan(r0 * 1.5);
    for (const use of ['prop.levitate', 'prop.pull', 'prop.push', 'prop.unlock', 'prop.mend', 'prop.ignite']) {
      expect(d.apply(use, act('x', use).action, stage.services)).toBe(false);
    }
  });

  it('end("*") ends freeze, topple, mimic and costume together; reset() starts over', () => {
    const { d, stage } = setup();
    d.apply('prop.topple', act('t', 'prop.topple', { duration_ms: 9000 }).action, stage.services);
    d.apply('prop.freeze', act('f', 'prop.freeze', { duration_ms: 9000 }).action, stage.services);
    d.apply('prop.costume', act('c', 'prop.costume', { costume: 'hat' }).action, stage.services);
    run(d, stage, 1000);
    d.end('*');
    expect(d.state()).toEqual({});
    run(d, stage, 1500);
    expect(d.debugPose.fall).toBe(0);
    d.apply('prop.disarm', act('e', 'prop.disarm').action, stage.services);
    d.apply('prop.topple', act('t2', 'prop.topple').action, stage.services);
    run(d, stage, 300);
    d.reset();
    expect(d.state()).toEqual(PROP_START.dummy.state);
    expect(d.label()).toBe(PROP_START.dummy.label);
    expect(d.debugPose).toEqual({ lean: 0, fall: 0, arms: 0, wand: 'hand' });
  });

  it('settles after a reel under reduced motion without wobbling', () => {
    const { d, stage } = setup();
    d.apply('prop.reel', act('s', 'prop.reel', { intensity: 1 }).action, stage.services);
    let crossings = 0;
    let last = 0;
    for (let i = 0; i < 200; i++) {
      run(d, stage, 16, 16, { reducedMotion: true });
      const l = d.debugPose.lean;
      if (Math.sign(l) !== Math.sign(last) && Math.abs(l) > 0.002) crossings++;
      last = l;
    }
    expect(crossings).toBeLessThanOrEqual(1);
  });

  it('reports changes when the wand comes back', () => {
    const { d, stage } = setup();
    d.apply('prop.disarm', act('e', 'prop.disarm').action, stage.services);
    const before = stage.changes;
    runUntil(d, stage, () => d.state().disarmed === undefined, 10000);
    expect(stage.changes).toBe(before + 1);
  });
});
