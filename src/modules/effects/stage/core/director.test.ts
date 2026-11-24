import { describe, expect, it } from 'vitest';
import type { EffectEvent, EffectStep, SpellbookEntry, SpellCast } from '../../../../contracts';
import { CAST_SEQUENCE } from '../../../../contracts';
import { Director, FALLBACK_USE, type Ongoing, type StepDef } from './director';
import { Scheduler } from './scheduler';

/** A director with fake steps: every use either finishes instantly, after a duration, or holds. */
function harness(opts: { reduced?: boolean } = {}) {
  let clock = 1000;
  const scheduler = new Scheduler();
  const events: { type: string; e: EffectEvent }[] = [];
  const entries = new Map<string, SpellbookEntry>();
  const stopped: string[] = [];
  const steering: (string | null)[] = [];
  const fallbacks: string[] = [];

  const timed = (ms: number, extra: Partial<Ongoing> = {}): StepDef => ({
    prepare: (step) => ({ ...step }),
    run(c) {
      const start = c.now;
      return { held: false, durationMs: ms, finished: (t) => t - start >= ms, stop: () => stopped.push(`${c.cast.id}#${c.index}`), ...extra };
    },
  });
  const held = (extra: Partial<Ongoing> = {}): StepDef => ({
    prepare: (step) => ({ ...step }),
    run(c) {
      let out = false;
      return { held: true, finished: () => out, stop: () => { out = true; stopped.push(`${c.cast.id}#${c.index}`); }, ...extra };
    },
  });
  const instant: StepDef = { prepare: (step) => ({ ...step }), run: () => null };

  const steps: Record<string, StepDef> = {
    'light.orb': held({ acts: 'light' }),
    'scene.dim': held({ acts: 'dim' }),
    'light.snuff': instant,
    'light.flash': timed(200),
    'particles.burst': instant,
    'shield.dome': timed(5000),
    'effects.end': instant,
    'prop.levitate': held({ steering: true, propId: 'feather' }),
    'prop.ignite': held({ acts: 'fire', propId: 'candle' }),
    'prop.douse': instant,
  };

  const director = new Director({
    now: () => clock,
    reducedMotion: () => opts.reduced === true,
    entry: (id) => entries.get(id) ?? null,
    emit: (type, e) => events.push({ type, e }),
    steps,
    fallback: (cast) => {
      fallbacks.push(cast.id);
      return { preset: 'stars', at: 'tip', count: 24 };
    },
    schedule: (at, fn) => scheduler.at(at, fn),
    onSteering: (castId) => steering.push(castId),
  });

  return {
    director,
    steps,
    events,
    stopped,
    steering,
    fallbacks,
    spell(id: string, effectSteps: EffectStep[], lasts: SpellbookEntry['lasts'] = null) {
      entries.set(id, {
        spell: { id, incantation: id, gesture: { flick: 'up' }, effect: { steps: effectSteps, fallback: 'sparkle' } }, packId: 'p', packTitle: 'P',
        available: true, status: 'open', enabled: true, overridden: false, gestureSource: 'pack', gestureKey: 'k', mirrored: false,
        templates: [], lasts, skippedSteps: [], accepted: 0,
      });
    },
    cast(id: string, spellId: string, over: Partial<SpellCast> = {}): SpellCast {
      const c: SpellCast = { id, spellId, t: clock, via: 'gesture', quality: 1, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...over };
      director.onCast(c);
      return c;
    },
    advance(ms: number) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + 16);
        scheduler.poll(clock);
        director.tick(clock);
      }
    },
    now: () => clock,
    log: () => events.map(({ type, e }) => `${type === 'effect.start' ? 'start' : 'end'} ${e.id} ${e.use}${e.reason ? ` ${e.reason}` : ''}`),
  };
}

describe('step scheduling (CAST_SEQUENCE and delay_ms)', () => {
  it('runs steps in pack order at bloom + delay, skipping audio steps', () => {
    const h = harness();
    h.spell('stupefy', [
      { use: 'light.flash', delay_ms: 160 },
      { use: 'audio.cue', cue: 'stun' },
      { use: 'particles.burst', preset: 'sparks' },
    ]);
    const t0 = h.now();
    h.cast('c1', 'stupefy');
    h.advance(CAST_SEQUENCE.bloomDelayMs - 20);
    expect(h.events).toHaveLength(0);
    h.advance(40);
    // The burst blooms first (no delay); the flash waits its 160 ms; audio is never ours.
    expect(h.log()).toEqual(['start c1#2 particles.burst', 'end c1#2 particles.burst done']);
    const burst = h.events[0].e;
    expect(burst.t - t0).toBeGreaterThanOrEqual(CAST_SEQUENCE.bloomDelayMs);
    expect(burst).toMatchObject({ spellId: 'stupefy', castId: 'c1', step: 2, durationMs: 0 });
    h.advance(200);
    expect(h.log()).toContain('start c1#0 light.flash');
    const flash = h.events.find((x) => x.e.use === 'light.flash')!.e;
    expect(flash.t - t0).toBeGreaterThanOrEqual(CAST_SEQUENCE.bloomDelayMs + 160);
    expect(flash.durationMs).toBe(200);
    h.advance(300);
    expect(h.log()).toContain('end c1#0 light.flash done');
    expect(h.events.some((x) => x.e.use.startsWith('audio.'))).toBe(false);
  });

  it('blooms at once under reduced motion', () => {
    const h = harness({ reduced: true });
    h.spell('alohomora', [{ use: 'particles.burst', preset: 'sparks' }]);
    h.cast('c1', 'alohomora');
    h.advance(16);
    expect(h.log()).toEqual(['start c1#0 particles.burst', 'end c1#0 particles.burst done']);
  });

  it('plays the built-in sparkle when a spell has no steps left, or is unknown', () => {
    const h = harness();
    h.spell('empty', []);
    h.cast('c1', 'empty');
    h.cast('c2', 'not-in-the-book');
    h.advance(300);
    expect(h.fallbacks).toEqual(['c1', 'c2']);
    expect(h.log()).toEqual([
      `start c1#-1 ${FALLBACK_USE}`, `end c1#-1 ${FALLBACK_USE} done`, `start c2#-1 ${FALLBACK_USE}`, `end c2#-1 ${FALLBACK_USE} done`,
    ]);
    expect(h.events[0].e.step).toBe(-1);
  });

  it('a spell of only sound steps leaves the stage alone (the audio module plays it)', () => {
    const h = harness();
    h.spell('muffliato', [{ use: 'audio.muffle', hold: true }]);
    h.cast('c1', 'muffliato');
    h.advance(400);
    expect(h.events).toHaveLength(0);
    expect(h.fallbacks).toHaveLength(0);
  });

  it('ends timed steps when they finish, and caps a step that never says so', () => {
    const h = harness();
    h.spell('protego', [{ use: 'shield.dome', duration_ms: 5000 }]);
    h.cast('c1', 'protego');
    h.advance(300);
    expect(h.log()).toEqual(['start c1#0 shield.dome']);
    h.advance(5000);
    expect(h.log()).toEqual(['start c1#0 shield.dome', 'end c1#0 shield.dome done']);
  });
});

describe('spell.ended and effects.end bookkeeping', () => {
  it('ends held steps when their spell ends, and cancels steps not yet started', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }, { use: 'scene.dim', amount: 0.35, hold: true }, { use: 'particles.burst', delay_ms: 2000 }], 'until-ended');
    h.cast('c1', 'lumos');
    h.advance(300);
    expect(h.director.ongoing('c1')).toHaveLength(2);
    h.director.onEnded({ spellId: 'lumos', castId: 'c1', t: h.now(), by: 'timeout' });
    expect(h.log()).toEqual([
      'start c1#0 light.orb', 'start c1#1 scene.dim', 'end c1#0 light.orb spell-ended', 'end c1#1 scene.dim spell-ended',
    ]);
    expect(h.stopped).toEqual(['c1#0', 'c1#1']);
    h.advance(3000);
    expect(h.events.some((x) => x.e.use === 'particles.burst')).toBe(false);
    expect(h.director.busy('c1')).toBe(false);
  });

  it('Nox: the held orb and dim are released by Nox’s snuff at its delay, not at once', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }, { use: 'scene.dim', amount: 0.35, hold: true }], 'until-ended');
    h.spell('nox', [{ use: 'light.snuff', spell: 'lumos', smoke: true, delay_ms: 100 }]);
    h.cast('c1', 'lumos');
    h.advance(300);
    // The engine publishes Nox's cast first, then Lumos's spell.ended, in the same task.
    h.cast('c2', 'nox');
    h.director.onEnded({ spellId: 'lumos', castId: 'c1', t: h.now(), by: 'nox', byCastId: 'c2' });
    expect(h.log().filter((l) => l.startsWith('end c1'))).toEqual([]);
    h.advance(CAST_SEQUENCE.bloomDelayMs + 120);
    const log = h.log();
    const snuff = log.indexOf('start c2#0 light.snuff');
    expect(snuff).toBeGreaterThan(-1);
    expect(log.indexOf('end c1#0 light.orb spell-ended')).toBeGreaterThan(snuff);
    expect(log.indexOf('end c1#1 scene.dim spell-ended')).toBeGreaterThan(snuff);
  });

  it('a snuff for another spell does not release this one; it ends at once', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }], 'until-ended');
    h.spell('other', [{ use: 'light.snuff', spell: 'something-else' }]);
    h.cast('c1', 'lumos');
    h.advance(300);
    h.cast('c2', 'other');
    h.director.onEnded({ spellId: 'lumos', castId: 'c1', t: h.now(), by: 'other', byCastId: 'c2' });
    expect(h.log()).toContain('end c1#0 light.orb spell-ended');
  });

  it('Aguamenti releases a held fire by its douse at the douse’s delay', () => {
    const h = harness();
    h.spell('incendio', [{ use: 'prop.ignite', hold: true }], 'until-ended');
    h.spell('aguamenti', [{ use: 'prop.douse', all: true, delay_ms: 500 }]);
    h.cast('c1', 'incendio', { targetId: 'candle' });
    h.advance(300);
    h.cast('c2', 'aguamenti', { targetId: 'candle' });
    h.director.onEnded({ spellId: 'incendio', castId: 'c1', t: h.now(), by: 'aguamenti', byCastId: 'c2' });
    h.advance(CAST_SEQUENCE.bloomDelayMs + 400);
    expect(h.log()).not.toContain('end c1#0 prop.ignite spell-ended');
    h.advance(200);
    expect(h.log()).toContain('end c1#0 prop.ignite spell-ended');
  });

  it('a recast hands held effects over: the old ends only once the new cast’s matching step has run', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }, { use: 'scene.dim', amount: 0.35, hold: true }], 'until-ended');
    h.cast('c1', 'lumos');
    h.advance(400);
    // The engine ends the earlier Lumos with by = the same spell when it is cast again.
    h.cast('c2', 'lumos');
    h.director.onEnded({ spellId: 'lumos', castId: 'c1', t: h.now(), by: 'lumos', byCastId: 'c2' });
    expect(h.log().filter((l) => l.startsWith('end c1'))).toEqual([]);
    h.advance(CAST_SEQUENCE.bloomDelayMs + 20);
    const log = h.log();
    expect(log.indexOf('end c1#0 light.orb spell-ended')).toBeGreaterThan(log.indexOf('start c2#0 light.orb'));
    expect(log.indexOf('end c1#1 scene.dim spell-ended')).toBeGreaterThan(log.indexOf('start c2#1 scene.dim'));
  });

  it('a recast on another prop does not hand over: the old prop action ends at once', () => {
    const h = harness();
    h.spell('incendio', [{ use: 'prop.ignite', hold: true }], 'until-ended');
    h.cast('c1', 'incendio', { targetId: 'candle' });
    h.advance(300);
    h.cast('c2', 'incendio', { targetId: 'plant' });
    h.director.onEnded({ spellId: 'incendio', castId: 'c1', t: h.now(), by: 'incendio', byCastId: 'c2' });
    expect(h.log()).toContain('end c1#0 prop.ignite spell-ended');
  });

  it('effects.end (all) ends every earlier cast’s effects, but not the current cast’s', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }], 'until-ended');
    h.spell('protego', [{ use: 'shield.dome', duration_ms: 5000 }], 5000);
    h.spell('finite', [{ use: 'shield.dome', duration_ms: 5000 }, { use: 'effects.end', scope: 'all', delay_ms: 10 }]);
    // effects.end does what the stage's runner does: ask the director to end the rest.
    h.steps['effects.end'] = { prepare: (s) => ({ ...s }), run: (c) => { h.director.endAll(c.cast.id, 'effects-end'); return null; } };
    h.cast('c1', 'lumos');
    h.cast('c2', 'protego');
    h.advance(300);
    h.cast('c3', 'finite');
    h.advance(300);
    const log = h.log();
    expect(log).toContain('end c1#0 light.orb effects-end');
    expect(log).toContain('end c2#0 shield.dome effects-end');
    expect(log).not.toContain('end c3#0 shield.dome effects-end');
    expect(h.director.ongoing('c3')).toHaveLength(1);
  });

  it('a cast made after Finite is not cancelled by Finite’s effects.end', () => {
    const h = harness();
    h.spell('finite', [{ use: 'effects.end', scope: 'all' }]);
    h.spell('stupefy', [{ use: 'light.flash', delay_ms: 50 }]);
    h.steps['effects.end'] = { prepare: (s) => ({ ...s }), run: (c) => { h.director.endAll(c.cast.id, 'effects-end'); return null; } };
    h.cast('c1', 'finite');
    h.advance(100);
    h.cast('c2', 'stupefy');
    h.advance(600);
    expect(h.log()).toContain('start c2#0 light.flash');
  });

  it('reports steering while a follow-the-tip action runs, and clears it when it ends', () => {
    const h = harness();
    h.spell('leviosa', [{ use: 'prop.levitate', follow_tip: true }], 8000);
    h.cast('c1', 'leviosa', { targetId: 'feather' });
    h.advance(300);
    expect(h.steering).toEqual(['c1']);
    h.director.onEnded({ spellId: 'leviosa', castId: 'c1', t: h.now(), by: 'finite-incantatem' });
    expect(h.steering).toEqual(['c1', null]);
  });

  it('pairs every effect.start with exactly one effect.end', () => {
    const h = harness();
    h.spell('lumos', [{ use: 'light.orb', hold: true }, { use: 'light.flash' }, { use: 'particles.burst' }], 'until-ended');
    h.cast('c1', 'lumos');
    h.advance(600);
    h.director.onEnded({ spellId: 'lumos', castId: 'c1', t: h.now(), by: 'reset' });
    h.director.clear('reset');
    const starts = h.events.filter((x) => x.type === 'effect.start').map((x) => x.e.id);
    const ends = h.events.filter((x) => x.type === 'effect.end').map((x) => x.e.id);
    expect(ends.sort()).toEqual(starts.sort());
  });
});
