import { describe, expect, it } from 'vitest';
import { flashEnvelope, LightLayer, ORB_GAIN } from './light';
import { MAX_DIM_RATE_PER_MS, ORB_BLOOM_MS, prepareDim, prepareFlash, prepareOrb, type PrepareContext } from './limits';

const ctx: PrepareContext = { scale: 1, reducedMotion: false, lasts: 'until-ended' };
const CENTRE = { x: 0.5, y: 0.5 };

/** Spend the flash budget, so whatever comes next is refused or made softly. */
function spend(light: LightLayer, now: number): void {
  for (let k = 0; k < 3; k++) light.limiter.change(now - 3 + k);
}

/** The soft changes at one moment: the room's dimming, and how much each orb and each soft glow adds
 *  to the picture where it is brightest. An orb adds up to ORB_GAIN per unit of intensity × level; a
 *  soft glow its intensity × envelope, since the glow sprite peaks at 1. One that has gone is dark. */
interface Snapshot { dim: number; orbs: Map<object, number>; glows: Map<object, number> }

function snapshot(light: LightLayer, now: number): Snapshot {
  const s: Snapshot = { dim: light.dim, orbs: new Map(), glows: new Map() };
  for (const o of light.orbs) s.orbs.set(o, ORB_GAIN * o.level * o.params.intensity);
  for (const f of light.flashes) if (f.soft) s.glows.set(f, f.intensity * flashEnvelope(f, now));
  return s;
}

/** The most the soft changes between two moments can move the picture at any one point. Summed as
 *  sizes, so that changes going opposite ways count in full too. */
function softChange(a: Snapshot, b: Snapshot): number {
  const moved = (x: Map<object, number>, y: Map<object, number>) => {
    let s = 0;
    for (const [k, v] of x) s += Math.abs(v - (y.get(k) ?? 0));
    for (const [k, v] of y) if (!x.has(k)) s += Math.abs(v);
    return s;
  };
  return Math.abs(a.dim - b.dim) + moved(a.orbs, b.orbs) + moved(a.glows, b.glows);
}

const total = (m: Map<object, number>) => [...m.values()].reduce((a, b) => a + b, 0);

/** The worst soft change in any 96 ms (six frames) of a run. */
function worstSoftChange(seen: Snapshot[]): number {
  let worst = 0;
  for (let i = 6; i < seen.length; i++) worst = Math.max(worst, softChange(seen[i], seen[i - 6]));
  return worst;
}

describe('orbs (Section 10.6: light that never jumps)', () => {
  it('goes out from where its bloom had got to, never from full brightness', () => {
    const light = new LightLayer();
    const timed = light.addOrb('c1', 'brief', prepareOrb({ use: 'light.orb', at: 'center', duration_ms: 100 }, ctx), CENTRE, null, 0);
    const snuffed = light.addOrb('c2', 'snuffed', prepareOrb({ use: 'light.orb', at: 'center', hold: true }, ctx), CENTRE, null, 0);
    // A timed orb lasts at least its bloom.
    expect(timed.params.duration_ms).toBe(ORB_BLOOM_MS);
    const before = [timed.level, snuffed.level];
    let worst = 0;
    // The timed orb's fade comes over the budget (two blooms and a snuff took it), so it is soft.
    for (let t = 16; t <= 6000; t += 16) {
      if (t === 64) light.snuff('snuffed', t);
      light.update(t, 16, 16);
      worst = Math.max(worst, Math.abs(timed.level - before[0]), Math.abs(snuffed.level - before[1]));
      before[0] = timed.level;
      before[1] = snuffed.level;
    }
    // The quickest an orb may move is a quick snuff: full to nothing in 200 ms.
    expect(worst).toBeLessThanOrEqual(16 / 200 + 1e-9);
    expect(light.orbs).toHaveLength(0);
  });

  it('counts its bloom, fade and snuff against the flash budget, and goes softly once it is spent', () => {
    const light = new LightLayer();
    const p = prepareOrb({ use: 'light.orb', at: 'center', hold: true }, ctx);
    const a = light.addOrb('c1', 's', p, CENTRE, null, 0);
    light.snuff('s', 50);
    const b = light.addOrb('c2', 's', p, CENTRE, null, 250);
    const c = light.addOrb('c3', 's', p, CENTRE, null, 500);
    expect([a.quick, b.quick, c.quick]).toEqual([true, true, false]);
    expect(light.limiter.recent(500)).toBe(3);
    // A flash that follows is not held back by an orb's bloom: it only finds the budget spent.
    expect(light.addFlash({ at: 'tip', color: '#FFFFFF', radius: 0.2, intensity: 0.5, duration_ms: 200, red: false }, CENTRE, 520).soft).toBe(true);
    // A second later there is room again: the fade is quick.
    for (let t = 516; t <= 1300; t += 16) light.update(t, 16, 16);
    light.fadeOrb(b, 1300);
    expect(b.quick).toBe(true);
  });

  it('a crowd of orbs changing softly together still changes the picture under 0.1 per 100 ms', () => {
    const light = new LightLayer();
    // The budget is spent, so every bloom below is soft.
    for (let t = 0; t < 3; t++) expect(light.limiter.change(t)).toBe(true);
    const p = prepareOrb({ use: 'light.orb', at: 'center', hold: true, intensity: 1 }, ctx);
    const orbs = Array.from({ length: 12 }, (_, i) => light.addOrb(`c${i}`, 'crowd', p, CENTRE, null, 10));
    expect(orbs.every((o) => !o.quick)).toBe(true);
    const total = () => orbs.reduce((s, o) => s + o.level * o.params.intensity, 0);
    const seen: number[] = [];
    for (let t = 26; t <= 6000; t += 16) {
      if (t === 4010) {
        // Put them all out at once, with the budget spent again: softly too.
        for (let k = 0; k < 3; k++) light.limiter.change(t - 5 + k);
        light.snuff('crowd', t);
      }
      light.update(t, 16, 16);
      seen.push(total());
    }
    let worst = 0;
    for (let i = 6; i < seen.length; i++) worst = Math.max(worst, Math.abs(seen[i] - seen[i - 6]));
    // Six frames are 96 ms; ORB_GAIN is the most an orb's level can change the picture by.
    expect(worst * ORB_GAIN).toBeLessThan(0.1);
    expect(worst * ORB_GAIN).toBeGreaterThan(0.5 * MAX_DIM_RATE_PER_MS * 96);
    // They still came on, softly.
    expect(Math.max(...seen)).toBeGreaterThan(0.5);
  });

  it('a lit tip stays on the wand while it fades, however slowly', () => {
    const light = new LightLayer();
    let tip = { x: 0.3, y: 0.4 };
    const o = light.addOrb('c1', 's', prepareOrb({ use: 'light.orb', at: 'tip', hold: true }, ctx), tip, () => tip, 0);
    for (let t = 16; t <= 600; t += 16) light.update(t, 16, 16);
    light.fadeOrb(o, 600);
    tip = { x: 0.6, y: 0.4 };
    for (let t = 616; t <= 800; t += 16) light.update(t, 16, 16);
    expect(o.state).toBe('fading');
    expect(o.x).toBeGreaterThan(0.55);
  });
});

describe('soft glows (Section 10.6: a flash the budget refused is not a flash)', () => {
  // The brightest, widest flash a pack can ask for (prepareFlash caps it).
  const BRIGHT = prepareFlash({ use: 'light.flash', at: 'center', intensity: 1, radius: 1 }, ctx);

  it('a refused flash glows softly, rising and fading under the dimming rate', () => {
    const light = new LightLayer();
    spend(light, 5);
    expect(light.addFlash(BRIGHT, CENTRE, 10).soft).toBe(true);
    const seen: Snapshot[] = [];
    for (let t = 26; t <= 2000; t += 16) {
      light.update(t, 16, 16);
      seen.push(snapshot(light, t));
    }
    const worst = worstSoftChange(seen);
    expect(worst).toBeLessThan(0.1);
    expect(worst).toBeLessThanOrEqual(MAX_DIM_RATE_PER_MS * 96 + 1e-9);
    // It still shows, and then it is over.
    expect(Math.max(...seen.map((s) => total(s.glows)))).toBeGreaterThan(0.2);
    expect(light.flashes).toHaveLength(0);
    // A flash within the budget is still a flash: full at once, gone in its time.
    const later = light.addFlash(BRIGHT, CENTRE, 2010);
    expect(later.soft).toBe(false);
    expect(later.intensity * flashEnvelope(later, 2045)).toBeCloseTo(BRIGHT.intensity);
    expect(flashEnvelope(later, 2010 + BRIGHT.duration_ms)).toBe(0);
  });

  it('many refused at once glow no faster, and no brighter, than one', () => {
    const light = new LightLayer();
    spend(light, 5);
    const one = light.addFlash(BRIGHT, CENTRE, 10).intensity;
    for (let k = 0; k < 7; k++) expect(light.addFlash(BRIGHT, CENTRE, 10).soft).toBe(true);
    const seen: Snapshot[] = [];
    for (let t = 26; t <= 4000; t += 16) {
      light.update(t, 16, 16);
      seen.push(snapshot(light, t));
    }
    expect(worstSoftChange(seen)).toBeLessThan(0.1);
    const brightest = Math.max(...seen.map((s) => total(s.glows)));
    expect(brightest).toBeLessThanOrEqual(one + 1e-9);
    expect(brightest).toBeGreaterThan(0.2);
    expect(light.flashes).toHaveLength(0);
  });

  it('soft glows and soft orbs together change the picture under 0.1 per 100 ms', () => {
    const light = new LightLayer();
    spend(light, 5);
    const p = prepareOrb({ use: 'light.orb', at: 'center', hold: true, intensity: 0.5 }, ctx);
    const orbs = [light.addOrb('o1', 'orbs', p, CENTRE, null, 10), light.addOrb('o2', 'orbs', p, CENTRE, null, 10)];
    expect(orbs.every((o) => !o.quick)).toBe(true);
    const seen: Snapshot[] = [];
    let lit = 0;
    const glowed = [0, 0];
    for (let t = 10; t <= 20000; t += 16) {
      // Refused flashes glow while the orbs bloom, and again while they are snuffed.
      if (t === 10) for (let k = 0; k < 6; k++) expect(light.addFlash(BRIGHT, CENTRE, t).soft).toBe(true);
      if (t === 8010) {
        spend(light, t);
        light.snuff('orbs', t);
        for (let k = 0; k < 6; k++) expect(light.addFlash(BRIGHT, CENTRE, t).soft).toBe(true);
      }
      light.update(t, 16, 16);
      const s = snapshot(light, t);
      seen.push(s);
      lit = Math.max(lit, orbs[0].level);
      glowed[t < 8010 ? 0 : 1] = Math.max(glowed[t < 8010 ? 0 : 1], total(s.glows));
    }
    const worst = worstSoftChange(seen);
    expect(worst).toBeLessThan(0.1);
    // The allowance is used, not starved.
    expect(worst).toBeGreaterThan(0.5 * MAX_DIM_RATE_PER_MS * 96);
    expect(orbs.every((o) => !o.quick)).toBe(true);
    // The orbs came on and went out, and the glows showed both times and went.
    expect(lit).toBeGreaterThan(0.9);
    expect(Math.min(...glowed)).toBeGreaterThan(0.1);
    expect(light.orbs).toHaveLength(0);
    expect(light.flashes).toHaveLength(0);
  });

  it('the room’s dimming shares the allowance with them', () => {
    const light = new LightLayer();
    spend(light, 5);
    // The deepest dim, as fast as dimming may go, while refused flashes glow.
    const dim = light.addDim('d1', prepareDim({ use: 'scene.dim', amount: 0.8, hold: true, fade_ms: 300 }, ctx), 10);
    expect(dim.ratePerMs).toBe(MAX_DIM_RATE_PER_MS);
    const seen: Snapshot[] = [];
    const glowed = [0, 0];
    for (let t = 10; t <= 6000; t += 16) {
      if (t === 10) for (let k = 0; k < 3; k++) expect(light.addFlash(BRIGHT, CENTRE, t).soft).toBe(true);
      // Then the room lifts again while the next glow rises.
      if (t === 3050) {
        spend(light, t);
        light.endDim(dim);
        for (let k = 0; k < 3; k++) expect(light.addFlash(BRIGHT, CENTRE, t).soft).toBe(true);
      }
      light.update(t, 16, 16);
      const s = snapshot(light, t);
      seen.push(s);
      glowed[t < 3050 ? 0 : 1] = Math.max(glowed[t < 3050 ? 0 : 1], total(s.glows));
    }
    expect(worstSoftChange(seen)).toBeLessThan(0.1);
    // The room still darkened all the way and came back, and the glows showed both times and went.
    expect(Math.max(...seen.map((s) => s.dim))).toBeCloseTo(0.8);
    expect(light.dim).toBe(0);
    expect(Math.min(...glowed)).toBeGreaterThan(0.2);
    expect(light.flashes).toHaveLength(0);
  });

  it('a lit orb’s flicker waits while a light changes softly over it, and keeps going while the room dims', () => {
    const light = new LightLayer();
    const lamp = light.addOrb('c1', 'lumos', prepareOrb({ use: 'light.orb', at: 'center', hold: true }, ctx), CENTRE, null, 0);
    light.addDim('c1', prepareDim({ use: 'scene.dim', amount: 0.35, hold: true }, ctx), 0);
    let t = 0;
    /** Runs frames while `going` holds and says how far the lamp's flicker went meanwhile. */
    const flickered = (going: () => boolean) => {
      const from = lamp.flickerClock;
      while (going()) {
        t += 16;
        light.update(t, 16, 16);
      }
      return lamp.flickerClock - from;
    };
    // Lumos: the room darkens while its orb blooms, and a little longer, and the flicker goes on
    // all the while: the dimming cannot add up with it.
    expect(flickered(() => light.dim < 0.35)).toBe(t);
    expect(t).toBeGreaterThan(ORB_BLOOM_MS);
    expect(lamp.quick).toBe(true);
    expect(flickered(() => t < 2000)).toBeGreaterThan(0);
    // A refused flash glows over it: the flicker waits until the glow has gone, then goes on.
    spend(light, t);
    expect(light.addFlash(BRIGHT, CENTRE, t).soft).toBe(true);
    expect(flickered(() => light.flashes.length > 0)).toBe(0);
    expect(flickered(() => t < 4000)).toBeGreaterThan(0);
    // Another orb blooms softly over it: the flicker waits until that one is lit, then goes on. (The
    // new orb's own flicker waits too, as it does while an orb changes softly.)
    spend(light, t);
    const other = light.addOrb('c2', 'other', prepareOrb({ use: 'light.orb', at: 'center', hold: true }, ctx), CENTRE, null, t);
    expect(other.quick).toBe(false);
    expect(flickered(() => other.level < 1)).toBe(0);
    expect(other.flickerClock).toBe(other.born);
    expect(flickered(() => t < 9000)).toBeGreaterThan(0);
  });
});
