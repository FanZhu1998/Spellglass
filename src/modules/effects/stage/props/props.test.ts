import { describe, expect, it } from 'vitest';
import { PROP_IDS, PROP_START, PROP_TAGS, SHELF_LAYOUT, type PropId } from '../../../../contracts';
import type { PropView } from '../types';
import { createShelf } from './index';
import { RELOCK_MS } from './box';
import { DIMS } from './geometry';
import { MEND_MS } from './teacup';
import { act, fakeStage, frameAt, run, runUntil, type FakeStage } from './testing';

const T = PROP_TAGS;

function setup(): { props: Record<PropId, PropView>; list: PropView[]; stage: FakeStage } {
  const shelf = createShelf();
  const stage = fakeStage();
  const props = Object.fromEntries(shelf.props.map((p) => [p.id, p])) as Record<PropId, PropView>;
  // One frame so every prop has read the view.
  run(shelf.props, stage, 16);
  return { props, list: shelf.props, stage };
}

const SMALL: PropId[] = ['candle', 'feather', 'box', 'teacup', 'plant'];

describe('the shelf', () => {
  it('lists the six props in PROP_IDS order, at home, starting exactly as PROP_START says', () => {
    const shelf = createShelf();
    expect(shelf.props.map((p) => p.id)).toEqual([...PROP_IDS]);
    for (const p of shelf.props) {
      const start = PROP_START[p.id];
      expect(p.home).toEqual(SHELF_LAYOUT[p.id]);
      expect([p.x, p.y]).toEqual([SHELF_LAYOUT[p.id].x, SHELF_LAYOUT[p.id].y]);
      expect(p.label()).toBe(start.label);
      expect(p.tags()).toEqual(start.tags);
      expect(p.state()).toEqual(start.state);
      expect(p.timeScale).toBe(1);
      expect(p.radius).toBeGreaterThan(0.01);
      expect(p.radius).toBeLessThan(0.12);
    }
  });

  it('gives the dummy the largest hit radius and converts radii to caster-x units', () => {
    const { props, stage } = setup();
    expect(props.dummy.radius).toBeGreaterThan(props.candle.radius);
    // 1600x900: one mirror height is 9/16 of the caster width.
    expect(props.teacup.radius).toBeCloseTo((DIMS.teacup.radius / 1000) * (900 / 1600), 5);
    void stage;
  });

  it('refuses primitives that are not its own, so the core can sparkle', () => {
    const { props, stage } = setup();
    const s = stage.services;
    expect(props.plant.apply('prop.unlock', act('c1', 'prop.unlock').action, s)).toBe(false);
    expect(props.feather.apply('prop.ignite', act('c1', 'prop.ignite').action, s)).toBe(false);
    expect(props.box.apply('prop.mend', act('c1', 'prop.mend').action, s)).toBe(false);
    expect(props.candle.apply('prop.freeze', act('c1', 'prop.freeze').action, s)).toBe(false);
    expect(props.teacup.apply('prop.costume', act('c1', 'prop.costume').action, s)).toBe(false);
    expect(props.plant.apply('prop.reel', act('c1', 'prop.reel').action, s)).toBe(false);
    for (const id of PROP_IDS) expect(props[id].apply('prop.nonsense', act('c1', 'prop.nonsense').action, s)).toBe(false);
  });

  it('takes water without complaint, even where nothing burns (Aguamenti aims at prop.any)', () => {
    const { props, stage } = setup();
    for (const id of PROP_IDS) expect(props[id].apply('prop.douse', act('w1', 'prop.douse', { all: true }).action, stage.services)).toBe(true);
    expect(stage.bursts).toHaveLength(0);
  });

  it('gives only the feather the feather tag (Leviosa asks for it first), and it comes back when mended', () => {
    const { props, list, stage } = setup();
    expect(list.filter((p) => p.tags().includes(T.feather)).map((p) => p.id)).toEqual(['feather']);
    props.feather.apply('prop.scale', act('blast', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services);
    expect(props.feather.tags()).not.toContain(T.feather);
    props.feather.apply('prop.mend', act('fix', 'prop.mend').action, stage.services);
    expect(props.feather.tags()).toEqual(PROP_START.feather.tags);
  });
});

describe('settled (a replay waits for it before the shelf resets)', () => {
  it('is true at rest, and false until what was done has finished showing', () => {
    const { props, list, stage } = setup();
    const s = stage.services;
    expect(list.every((p) => p.settled?.() === true)).toBe(true);
    // The box: until its lid is fully open and its glow lit.
    props.box.apply('prop.unlock', act('a', 'prop.unlock').action, s);
    expect(runUntil(props.box, stage, () => props.box.settled!())).toBeGreaterThan(700);
    expect(props.box.state()).toEqual({ locked: false });
    // The teacup: until the crack has knitted and the glow of its gold seam has faded.
    props.teacup.apply('prop.mend', act('b', 'prop.mend').action, s);
    expect(runUntil(props.teacup, stage, () => props.teacup.settled!())).toBeGreaterThanOrEqual(MEND_MS);
    // The candle: until its flame has caught (its flicker never counts).
    props.candle.apply('prop.ignite', act('c', 'prop.ignite', { hold: true }).action, s);
    expect(runUntil(props.candle, stage, () => props.candle.settled!())).toBeGreaterThan(300);
    run(props.candle, stage, 2000);
    expect(props.candle.settled!()).toBe(true);
    // A small prop: until it is home again after its flight.
    props.feather.apply('prop.levitate', act('d', 'prop.levitate', { duration_ms: 1000 }).action, s);
    expect(runUntil(props.feather, stage, () => props.feather.settled!())).toBeGreaterThan(1000);
    expect([props.feather.x, props.feather.y]).toEqual([props.feather.home.x, props.feather.home.y]);
    // Size: until it has grown, not while it holds the size.
    props.plant.apply('prop.scale', act('e', 'prop.scale', { factor: 1.6, duration_ms: 8000 }).action, s);
    expect(runUntil(props.plant, stage, () => props.plant.settled!())).toBeLessThan(1000);
    expect(props.plant.state().scale).toBe(1.6);
    // Shattered: once its heap and outline have fully appeared.
    props.teacup.apply('prop.scale', act('f', 'prop.scale', { factor: 0, mode: 'shatter' }).action, s);
    expect(runUntil(props.teacup, stage, () => props.teacup.settled!())).toBeGreaterThan(800);
    // The dummy: until its wand has landed and it has stopped rocking. The wand lying on the shelf is
    // what Expelliarmus shows, so that counts as settled.
    props.dummy.apply('prop.disarm', act('g', 'prop.disarm').action, s);
    expect(props.dummy.settled!()).toBe(false);
    expect(runUntil(props.dummy, stage, () => props.dummy.settled!())).toBeGreaterThan(800);
    expect(props.dummy.state().disarmed).toBe(true);
  });
});

describe('candle', () => {
  it('lights and swaps flammable for burning, once', () => {
    const { props, stage } = setup();
    const c = props.candle;
    const before = stage.changes;
    expect(c.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services)).toBe(true);
    expect(stage.changes).toBe(before + 1);
    expect(c.label()).toBe('lit candle');
    expect(c.tags()).toContain(T.burning);
    expect(c.tags()).not.toContain(T.flammable);
    expect(c.state()).toEqual({ lit: true });
  });

  it('adopts a recast: Incendio on a lit candle keeps it burning when the earlier cast ends', () => {
    const { props, stage } = setup();
    const c = props.candle;
    c.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services);
    expect(c.apply('prop.ignite', act('fire2', 'prop.ignite', { hold: true }).action, stage.services)).toBe(true);
    c.end('fire');
    expect(c.state()).toEqual({ lit: true });
    c.end('fire2');
    expect(c.state()).toEqual({ lit: false });
  });

  it('goes out with a wisp of smoke when the igniting cast ends, not when another does', () => {
    const { props, stage } = setup();
    const c = props.candle;
    c.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services);
    run(c, stage, 400);
    c.end('someone-else');
    expect(c.state()).toEqual({ lit: true });
    c.end('fire');
    expect(c.state()).toEqual({ lit: false });
    expect(c.tags()).toEqual(PROP_START.candle.tags);
    expect(c.label()).toBe('candle');
    expect(stage.bursts.map((b) => b.preset)).toEqual(['smoke']);
  });

  it('trails a curl of smoke for a moment as it goes out, and has settled once it has risen', () => {
    const { props, stage } = setup();
    const c = props.candle;
    c.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services);
    run(c, stage, 1200);
    expect(c.settled!()).toBe(true);
    c.end('fire');
    run(c, stage, 400);
    // The flame is out, but its smoke is still rising: a replay waits for it.
    expect(c.state()).toEqual({ lit: false });
    expect(c.settled!()).toBe(false);
    run(c, stage, 2000);
    expect(c.settled!()).toBe(true);
  });

  it('is put out by water with smoke and steam, and by end("*")', () => {
    const { props, stage } = setup();
    const c = props.candle;
    c.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services);
    expect(c.apply('prop.douse', act('water', 'prop.douse', { all: true }).action, stage.services)).toBe(true);
    expect(c.state()).toEqual({ lit: false });
    expect(stage.bursts.map((b) => b.preset)).toEqual(['smoke', 'mist']);
    // The smoke rises from the wick, above the candle's centre.
    expect(stage.bursts[0].y).toBeLessThan(c.y);
    c.apply('prop.ignite', act('fire2', 'prop.ignite', { hold: true }).action, stage.services);
    c.end('*');
    expect(c.state()).toEqual({ lit: false });
  });

  it('burns for duration_ms when not held, then goes out and reports done once', () => {
    const { props, stage } = setup();
    const a = act('fire', 'prop.ignite', { duration_ms: 1000 });
    props.candle.apply('prop.ignite', a.action, stage.services);
    run(props.candle, stage, 900);
    expect(props.candle.state()).toEqual({ lit: true });
    run(props.candle, stage, 200);
    expect(props.candle.state()).toEqual({ lit: false });
    expect(a.done).toBe(1);
    run(props.candle, stage, 500);
    expect(a.done).toBe(1);
  });

  it('a held ignite never reports done on its own', () => {
    const { props, stage } = setup();
    const a = act('fire', 'prop.ignite', { hold: true });
    props.candle.apply('prop.ignite', a.action, stage.services);
    run(props.candle, stage, 40000, 100);
    expect(props.candle.state()).toEqual({ lit: true });
    props.candle.end('fire');
    run(props.candle, stage, 100);
    expect(a.done).toBe(0);
  });
});

describe('box', () => {
  it('unlocks and opens, then relocks with a click after about 25 s', () => {
    const { props, stage } = setup();
    const b = props.box;
    expect(b.apply('prop.unlock', act('open', 'prop.unlock').action, stage.services)).toBe(true);
    expect(b.label()).toBe('open box');
    expect(b.tags()).not.toContain(T.lockable);
    expect(b.state()).toEqual({ locked: false });
    expect(b.apply('prop.unlock', act('open2', 'prop.unlock').action, stage.services)).toBe(false);
    run(b, stage, RELOCK_MS - 1000, 50);
    expect(b.state()).toEqual({ locked: false });
    run(b, stage, 2000, 50);
    expect(b.state()).toEqual({ locked: true });
    expect(b.tags()).toEqual(PROP_START.box.tags);
    expect(b.label()).toBe('locked box');
    // It can be practised again.
    expect(b.apply('prop.unlock', act('open3', 'prop.unlock').action, stage.services)).toBe(true);
  });

  it('relocks later under time.slow (local time)', () => {
    const { props, stage } = setup();
    const b = props.box;
    b.timeScale = 0.5;
    b.apply('prop.unlock', act('open', 'prop.unlock').action, stage.services);
    run(b, stage, RELOCK_MS + 2000, 50);
    expect(b.state()).toEqual({ locked: false });
    run(b, stage, RELOCK_MS, 50);
    expect(b.state()).toEqual({ locked: true });
  });

  it('end("*") does not relock it: opening is a change, not an ongoing effect', () => {
    const { props, stage } = setup();
    props.box.apply('prop.unlock', act('open', 'prop.unlock').action, stage.services);
    props.box.end('*');
    expect(props.box.state()).toEqual({ locked: false });
  });
});

describe('teacup', () => {
  it('starts cracked and is mended once', () => {
    const { props, stage } = setup();
    const t = props.teacup;
    expect(t.apply('prop.mend', act('mend', 'prop.mend').action, stage.services)).toBe(true);
    expect(t.label()).toBe('teacup');
    expect(t.tags()).not.toContain(T.mendable);
    expect(t.state()).toEqual({ cracked: false });
    run(t, stage, 1200);
    expect(t.apply('prop.mend', act('mend2', 'prop.mend').action, stage.services)).toBe(false);
  });
});

describe('shatter and mend (Reducto, Reparo)', () => {
  it.each(SMALL)('%s bursts to dust, keeps only any and mendable, and comes back', (id) => {
    const { props, stage } = setup();
    const p = props[id];
    const startTags = p.tags();
    const startLabel = p.label();
    expect(p.apply('prop.scale', act('blast', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services)).toBe(true);
    expect(p.tags()).toEqual([T.any, T.mendable]);
    expect(p.label()).toBe(`shattered ${startLabel.replace(/^(cracked|locked) /, '')}`);
    expect(p.state().shattered).toBe(true);
    expect(stage.bursts.length).toBeGreaterThan(0);
    expect(stage.bursts.every((b) => b.preset === 'dust')).toBe(true);
    // Nothing else works on dust.
    expect(p.apply('prop.levitate', act('lift', 'prop.levitate').action, stage.services)).toBe(false);
    expect(p.apply('prop.scale', act('big', 'prop.scale', { factor: 1.6 }).action, stage.services)).toBe(false);
    expect(p.apply('prop.mend', act('fix', 'prop.mend').action, stage.services)).toBe(true);
    expect(p.tags()).toEqual(startTags);
    expect(p.label()).toBe(startLabel);
    expect(p.state().shattered).toBeUndefined();
  });

  it('a lit candle that shatters is no longer burning, and comes back unlit', () => {
    const { props, stage } = setup();
    props.candle.apply('prop.ignite', act('fire', 'prop.ignite', { hold: true }).action, stage.services);
    props.candle.apply('prop.scale', act('blast', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services);
    expect(props.candle.tags()).not.toContain(T.burning);
    props.candle.apply('prop.mend', act('fix', 'prop.mend').action, stage.services);
    expect(props.candle.state()).toEqual({ lit: false });
  });

  it('a prop shattered in mid-air leaves its outline at home', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.5, y: 0.3 };
    f.apply('prop.levitate', act('lift', 'prop.levitate', { follow_tip: true, duration_ms: 8000 }).action, stage.services);
    run(f, stage, 1500);
    expect(f.y).toBeLessThan(f.home.y - 0.1);
    f.apply('prop.scale', act('blast', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services);
    expect([f.x, f.y]).toEqual([f.home.x, f.home.y]);
    // The dust burst where the feather was, high above the shelf.
    expect(stage.bursts[0].y).toBeLessThan(0.7);
  });

  it('the dummy is never shattered', () => {
    const { props, stage } = setup();
    expect(props.dummy.apply('prop.scale', act('blast', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services)).toBe(false);
    expect(props.dummy.tags()).toEqual(PROP_START.dummy.tags);
  });
});

describe('levitate', () => {
  it('follows the tip with a lag, reports done at the end of its duration, then drifts home', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.4, y: 0.35 };
    const a = act('leviosa', 'prop.levitate', { follow_tip: true, duration_ms: 3000 });
    expect(f.apply('prop.levitate', a.action, stage.services)).toBe(true);
    expect(f.state().motion).toBe('levitating');
    run(f, stage, 200);
    // Still rising: not yet at the tip.
    expect(Math.hypot(f.x - 0.4, f.y - 0.35)).toBeGreaterThan(0.1);
    run(f, stage, 2000);
    expect(Math.abs(f.x - 0.4)).toBeLessThan(0.05);
    expect(f.y).toBeLessThan(0.5);
    stage.tip = { x: 0.7, y: 0.3 };
    run(f, stage, 100);
    // A gentle lag: it has not caught up yet.
    expect(f.x).toBeLessThan(0.65);
    expect(a.done).toBe(0);
    run(f, stage, 800);
    expect(a.done).toBe(1);
    expect(f.state().motion).toBeUndefined();
    runUntil(f, stage, () => f.x === f.home.x && f.y === f.home.y, 5000);
    expect([f.x, f.y]).toEqual([f.home.x, f.home.y]);
    expect(a.done).toBe(1);
  });

  it('end(castId) before its time drifts home without reporting done', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.5, y: 0.4 };
    const a = act('leviosa', 'prop.levitate', { follow_tip: true, duration_ms: 8000 });
    f.apply('prop.levitate', a.action, stage.services);
    run(f, stage, 1000);
    f.end('other-cast');
    expect(f.state().motion).toBe('levitating');
    f.end('leviosa');
    expect(f.state().motion).toBeUndefined();
    runUntil(f, stage, () => f.y === f.home.y, 5000);
    expect([f.x, f.y]).toEqual([f.home.x, f.home.y]);
    expect(a.done).toBe(0);
  });

  it('without follow_tip it rises by `height` and hovers in place', () => {
    const { props, stage } = setup();
    const p = props.plant;
    stage.tip = { x: 0.1, y: 0.1 };
    p.apply('prop.levitate', act('up', 'prop.levitate', { height: 0.2, duration_ms: 4000 }).action, stage.services);
    run(p, stage, 2500);
    expect(Math.abs(p.x - p.home.x)).toBeLessThan(0.02);
    expect(p.home.y - p.y).toBeGreaterThan(0.17);
    expect(p.home.y - p.y).toBeLessThan(0.23);
  });

  it('under reduced motion it does not sway', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.3, y: 0.4 };
    f.apply('prop.levitate', act('lift', 'prop.levitate', { follow_tip: true, duration_ms: 4000 }).action, stage.services);
    let maxRot = 0;
    for (let i = 0; i < 150; i++) {
      run(f, stage, 16, 16, { reducedMotion: true });
      maxRot = Math.max(maxRot, Math.abs((f as unknown as { rot: number }).rot));
    }
    expect(maxRot).toBeLessThan(1e-6);
  });
});

describe('pull (Accio)', () => {
  it('flies to the tip, hovers for hold_ms following it, reports done, then floats home', () => {
    const { props, stage } = setup();
    const c = props.teacup;
    stage.tip = { x: 0.3, y: 0.3 };
    const a = act('accio', 'prop.pull', { hold_ms: 2000 }, { x: 0.3, y: 0.3 });
    expect(c.apply('prop.pull', a.action, stage.services)).toBe(true);
    run(c, stage, 700);
    expect(Math.abs(c.x - 0.3)).toBeLessThan(0.03);
    stage.tip = { x: 0.45, y: 0.35 };
    run(c, stage, 800);
    expect(Math.abs(c.x - 0.45)).toBeLessThan(0.03);
    expect(a.done).toBe(0);
    run(c, stage, 1300);
    expect(a.done).toBe(1);
    runUntil(c, stage, () => c.y === c.home.y, 5000);
    expect([c.x, c.y]).toEqual([c.home.x, c.home.y]);
  });

  it('flies to the aim when the tip is out of view', () => {
    const { props, stage } = setup();
    const c = props.candle;
    stage.tip = null;
    c.apply('prop.pull', act('accio', 'prop.pull', { hold_ms: 3000 }, { x: 0.6, y: 0.5 }).action, stage.services);
    run(c, stage, 800);
    expect(Math.abs(c.x - 0.6)).toBeLessThan(0.02);
  });

  it('is quicker under reduced motion', () => {
    const { props, stage } = setup();
    const c = props.box;
    stage.tip = { x: 0.6, y: 0.3 };
    c.apply('prop.pull', act('accio', 'prop.pull').action, stage.services);
    run(c, stage, 300, 16, { reducedMotion: true });
    expect(Math.abs(c.x - 0.6)).toBeLessThan(0.02);
  });

  it('replacing a running pull reports the old one done (the core would keep steering for it)', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.4, y: 0.3 };
    const lift = act('leviosa', 'prop.levitate', { follow_tip: true, duration_ms: 8000 });
    f.apply('prop.levitate', lift.action, stage.services);
    run(f, stage, 500);
    const pull = act('accio', 'prop.pull', { hold_ms: 1000 });
    f.apply('prop.pull', pull.action, stage.services);
    // Reported on the next frame, after the prop's state has settled.
    expect(lift.done).toBe(0);
    run(f, stage, 16);
    expect(lift.done).toBe(1);
    expect(f.state().motion).toBe('pulled');
    f.end('leviosa');
    expect(f.state().motion).toBe('pulled');
  });

  it('the dummy is too heavy to pull, push or levitate', () => {
    const { props, stage } = setup();
    for (const use of ['prop.pull', 'prop.push', 'prop.levitate']) {
      expect(props.dummy.apply(use, act('x', use).action, stage.services)).toBe(false);
    }
  });
});

describe('push', () => {
  it('mode away slides along the shelf away from the aim, rests, and slides home', () => {
    const { props, stage } = setup();
    const b = props.box;
    const a = act('shove', 'prop.push', { mode: 'away', distance: 0.2, duration_ms: 1500 }, { x: 0.3, y: 0.8 });
    expect(b.apply('prop.push', a.action, stage.services)).toBe(true);
    run(b, stage, 600);
    expect(b.x).toBeGreaterThan(b.home.x + 0.08);
    expect(b.y).toBeCloseTo(b.home.y, 6);
    // A 420 ms slide, then it rests for duration_ms before going home.
    run(b, stage, 1200);
    expect(a.done).toBe(0);
    run(b, stage, 200);
    expect(a.done).toBe(1);
    runUntil(b, stage, () => b.x === b.home.x, 5000);
    expect(b.x).toBe(b.home.x);
  });

  it('slides left when the aim is to its right', () => {
    const { props, stage } = setup();
    const p = props.plant;
    p.apply('prop.push', act('shove', 'prop.push', {}, { x: 0.9, y: 0.8 }).action, stage.services);
    run(p, stage, 600);
    expect(p.x).toBeLessThan(p.home.x - 0.05);
  });

  it('mode follow (Locomotor) slides wherever the tip points, on the shelf, then reports done', () => {
    const { props, stage } = setup();
    const t = props.teacup;
    const a = act('loco', 'prop.push', { mode: 'follow', duration_ms: 3000 });
    t.apply('prop.push', a.action, stage.services);
    stage.tip = { x: 0.2, y: 0.3 };
    run(t, stage, 1500);
    expect(Math.abs(t.x - 0.2)).toBeLessThan(0.03);
    expect(t.y).toBeCloseTo(t.home.y, 3);
    stage.tip = { x: 0.8, y: 0.6 };
    run(t, stage, 1400);
    expect(Math.abs(t.x - 0.8)).toBeLessThan(0.05);
    expect(a.done).toBe(0);
    run(t, stage, 200);
    expect(a.done).toBe(1);
    runUntil(t, stage, () => t.x === t.home.x, 8000);
    expect(t.x).toBe(t.home.x);
  });
});

describe('scale (Engorgio, Reducio)', () => {
  it('grows for duration_ms, reports done, and eases back', () => {
    const { props, stage } = setup();
    const p = props.plant;
    const r0 = p.radius;
    const a = act('grow', 'prop.scale', { factor: 1.6, mode: 'grow', duration_ms: 2000 });
    expect(p.apply('prop.scale', a.action, stage.services)).toBe(true);
    expect(p.state().scale).toBe(1.6);
    run(p, stage, 1500);
    expect(p.radius / r0).toBeCloseTo(1.6, 2);
    run(p, stage, 1000);
    expect(a.done).toBe(1);
    expect(p.state().scale).toBeUndefined();
    run(p, stage, 1000);
    expect(p.radius).toBeCloseTo(r0, 6);
  });

  it('shrinks, and end(castId) brings it back early without done', () => {
    const { props, stage } = setup();
    const p = props.box;
    const a = act('shrink', 'prop.scale', { factor: 0.55, mode: 'shrink', duration_ms: 8000 });
    p.apply('prop.scale', a.action, stage.services);
    run(p, stage, 1000);
    expect(p.state().scale).toBe(0.55);
    p.end('shrink');
    run(p, stage, 1200);
    expect(p.state().scale).toBeUndefined();
    expect(a.done).toBe(0);
  });

  it('a stronger variant stretches the change, within limits', () => {
    const { props, stage } = setup();
    props.plant.apply('prop.scale', act('grow', 'prop.scale', { factor: 1.6 }, { x: 0.5, y: 0.5 }, 1.5).action, stage.services);
    expect(props.plant.state().scale).toBe(1.9);
    props.feather.apply('prop.scale', act('grow', 'prop.scale', { factor: 9 }).action, stage.services);
    expect(props.feather.state().scale).toBe(2.2);
  });
});

describe('time and notifications', () => {
  it('advances by frame.dt × timeScale', () => {
    const { props, stage } = setup();
    const p = props.plant;
    p.timeScale = 0.25;
    const a = act('grow', 'prop.scale', { factor: 1.6, duration_ms: 1000 });
    p.apply('prop.scale', a.action, stage.services);
    run(p, stage, 3000);
    expect(a.done).toBe(0);
    run(p, stage, 2000);
    expect(a.done).toBe(1);
  });

  it('publishes moves at most a few times per second, and once more when it comes to rest', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.4, y: 0.3 };
    f.apply('prop.levitate', act('lift', 'prop.levitate', { follow_tip: true, duration_ms: 2000 }).action, stage.services);
    const before = stage.changes;
    run(f, stage, 2000);
    const during = stage.changes - before;
    expect(during).toBeGreaterThanOrEqual(4);
    expect(during).toBeLessThanOrEqual(2000 / 250 + 3);
    runUntil(f, stage, () => f.y === f.home.y, 6000);
    // The final resting position is still published (at most once more)...
    const atRest = stage.changes;
    run(f, stage, 400);
    expect(stage.changes - atRest).toBeLessThanOrEqual(1);
    // ...and then nothing moves, so nothing more is published.
    const settled = stage.changes;
    run(f, stage, 2000);
    expect(stage.changes).toBe(settled);
  });

  it('does not publish while nothing changes', () => {
    const { list, stage } = setup();
    run(list, stage, 500);
    const n = stage.changes;
    run(list, stage, 3000);
    expect(stage.changes).toBe(n);
  });

  it('copes with a long frame and odd numbers', () => {
    const { props, stage } = setup();
    const f = props.feather;
    stage.tip = { x: 0.4, y: 0.3 };
    f.apply('prop.levitate', act('lift', 'prop.levitate', { follow_tip: true, duration_ms: 'soon', height: Number.NaN }).action, stage.services);
    stage.now += 5000;
    f.update(frameAt(stage.now, 5000), stage.services);
    f.update(frameAt(stage.now + 16, Number.NaN), stage.services);
    expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
  });
});

describe('end("*") and reset()', () => {
  it('end("*") ends every ongoing action on every prop', () => {
    const { props, list, stage } = setup();
    const s = stage.services;
    stage.tip = { x: 0.5, y: 0.4 };
    props.candle.apply('prop.ignite', act('a', 'prop.ignite', { hold: true }).action, s);
    props.feather.apply('prop.levitate', act('b', 'prop.levitate', { follow_tip: true, duration_ms: 8000 }).action, s);
    props.plant.apply('prop.scale', act('c', 'prop.scale', { factor: 1.6, duration_ms: 8000 }).action, s);
    props.teacup.apply('prop.push', act('d', 'prop.push', { mode: 'follow', duration_ms: 5000 }).action, s);
    run(list, stage, 800);
    for (const p of list) p.end('*');
    run(list, stage, 3000);
    expect(props.candle.state()).toEqual({ lit: false });
    for (const id of SMALL) {
      expect([props[id].x, props[id].y]).toEqual([props[id].home.x, props[id].home.y]);
      expect(props[id].state().motion).toBeUndefined();
      expect(props[id].state().scale).toBeUndefined();
    }
  });

  it('reset() puts everything back as PROP_START, at home, without reporting done', () => {
    const { props, list, stage } = setup();
    const s = stage.services;
    stage.tip = { x: 0.5, y: 0.4 };
    const lift = act('b', 'prop.levitate', { follow_tip: true, duration_ms: 8000 });
    props.candle.apply('prop.ignite', act('a', 'prop.ignite', { hold: true }).action, s);
    props.feather.apply('prop.levitate', lift.action, s);
    props.box.apply('prop.unlock', act('c', 'prop.unlock').action, s);
    props.teacup.apply('prop.mend', act('d', 'prop.mend').action, s);
    props.plant.apply('prop.scale', act('e', 'prop.scale', { factor: 0, mode: 'shatter' }).action, s);
    props.dummy.apply('prop.freeze', act('f', 'prop.freeze', { topple: true }).action, s);
    props.dummy.apply('prop.costume', act('g', 'prop.costume').action, s);
    props.dummy.apply('prop.disarm', act('h', 'prop.disarm').action, s);
    props.plant.timeScale = 0.2;
    run(list, stage, 700);
    for (const p of list) p.reset();
    for (const p of list) {
      const start = PROP_START[p.id];
      expect(p.label()).toBe(start.label);
      expect(p.tags()).toEqual(start.tags);
      expect(p.state()).toEqual(start.state);
      expect([p.x, p.y]).toEqual([p.home.x, p.home.y]);
      expect(p.timeScale).toBe(1);
    }
    run(list, stage, 2000);
    expect(lift.done).toBe(0);
  });
});
