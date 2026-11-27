import { describe, expect, it } from 'vitest';
import type { EffectEvent, SpellbookEntry, SpellCast, SpellEnded } from '../../../contracts';
import { CAST_SEQUENCE, EFFECT_LIMITS } from '../../../contracts';
import { resolveCue } from './cues';
import { AudioDirector, DEFAULT_MUFFLE_MS, FALLBACK_USE, type AudioDirectorEnv } from './director';
import { entryOf, seedSpell, spellWith } from './testing';

const BLOOM = CAST_SEQUENCE.bloomDelayMs;
const CUE_MS = 1000;

function harness(spells: ReturnType<typeof seedSpell>[], opts: { reduced?: boolean } = {}) {
  let now = 10_000;
  const entries = new Map<string, SpellbookEntry>(spells.map((s) => [s.id, entryOf(s)]));
  const tasks: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];
  let seq = 0;
  const events: { type: 'effect.start' | 'effect.end'; e: EffectEvent }[] = [];
  const plays: { cue: string; gain: number; detune: number; scale: number; at: number; stoppedAt?: number }[] = [];
  const muffles: boolean[] = [];
  const env: AudioDirectorEnv = {
    now: () => now,
    bloomDelayMs: () => (opts.reduced ? CAST_SEQUENCE.reducedMotionBloomDelayMs : BLOOM),
    entry: (id) => entries.get(id) ?? null,
    emit: (type, e) => events.push({ type, e }),
    schedule: (at, fn) => {
      const t = { at, seq: seq++, fn, cancelled: false };
      tasks.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    play: (cue, o) => {
      const rec: (typeof plays)[number] = { cue, ...o, at: now };
      plays.push(rec);
      return { played: resolveCue(cue), durationMs: CUE_MS, silent: false, stop: () => (rec.stoppedAt = now) };
    },
    muffle: (on) => muffles.push(on),
  };
  const director = new AudioDirector(env);
  let casts = 0;
  return {
    director, events, plays, muffles,
    get now() {
      return now;
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = tasks.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        due.cancelled = true;
        now = Math.max(now, due.at);
        due.fn();
      }
      now = until;
    },
    cast(spellId: string, over: Partial<SpellCast> = {}): SpellCast {
      const c: SpellCast = { id: `c${++casts}`, spellId, t: now, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...over };
      director.onCast(c);
      return c;
    },
    end(cast: SpellCast, by: string, byCast?: SpellCast) {
      const e: SpellEnded = { spellId: cast.spellId, castId: cast.id, t: now, by, ...(byCast ? { byCastId: byCast.id } : {}) };
      director.onEnded(e);
    },
    log: () => events.map(({ type, e }) => `${type === 'effect.start' ? 'start' : 'end'} ${e.id} ${e.use}${e.reason ? ` ${e.reason}` : ''}`),
  };
}

describe('cue steps', () => {
  it('play at the bloom, with effect.start then effect.end when the sound is over', () => {
    const h = harness([seedSpell('lumos')]);
    const c = h.cast('lumos');
    h.advance(BLOOM - 1);
    expect(h.plays).toHaveLength(0);
    h.advance(1);
    expect(h.plays).toMatchObject([{ cue: 'chime-rise', gain: 1, detune: 0, scale: 1 }]);
    expect(h.events[0]).toEqual({
      type: 'effect.start',
      e: { spellId: 'lumos', castId: c.id, use: 'audio.cue', t: h.now, id: `${c.id}#2`, step: 2, params: { cue: 'chime-rise', gain: 1, detune: 0 }, durationMs: CUE_MS },
    });
    h.advance(CUE_MS);
    expect(h.log()).toEqual([`start ${c.id}#2 audio.cue`, `end ${c.id}#2 audio.cue done`]);
  });

  it('bloom at once under reduced motion, and honor delay_ms', () => {
    const r = harness([seedSpell('nox')], { reduced: true });
    r.cast('nox');
    r.advance(0);
    expect(r.plays.map((p) => p.cue)).toEqual(['snuff']);
    const d = harness([spellWith('late', [{ use: 'audio.cue', cue: 'latch', delay_ms: 400 }, { use: 'audio.cue', cue: 'latch', delay_ms: 99_999 }])]);
    d.cast('late');
    d.advance(BLOOM + 399);
    expect(d.plays).toHaveLength(0);
    d.advance(1);
    expect(d.plays).toHaveLength(1);
    // Delays are capped at EFFECT_LIMITS.maxStepMs.
    d.advance(EFFECT_LIMITS.maxStepMs);
    expect(d.plays).toHaveLength(2);
  });

  it("scale gain with the cast's effectScale and clamp gain and detune", () => {
    const h = harness([spellWith('loud', [{ use: 'audio.cue', cue: 'bolt', gain: 3, detune: 5000 }])]);
    h.cast('loud', { effectScale: 1.6 });
    h.advance(BLOOM);
    expect(h.plays[0]).toMatchObject({ cue: 'bolt', detune: 1200, scale: 1.6 });
    expect(h.plays[0].gain).toBeCloseTo(2 * Math.sqrt(1.6), 2);
    expect(h.events[0].e.params).toMatchObject({ cue: 'bolt', detune: 1200 });
  });

  it('play an unknown cue as chime and say which was asked for', () => {
    const h = harness([spellWith('odd', [{ use: 'audio.cue', cue: 'thunder' }])]);
    h.cast('odd');
    h.advance(BLOOM);
    expect(h.events[0].e.params).toMatchObject({ cue: 'chime', requested: 'thunder' });
  });

  it("leave other modules' steps alone, and play nothing for a spell without sound", () => {
    const h = harness([spellWith('quiet', [{ use: 'light.flash' }, { use: 'particles.burst', preset: 'stars' }])]);
    h.cast('quiet');
    h.advance(5000);
    expect(h.plays).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('play the fallback chime for a spell with no steps left, or one the spellbook does not know', () => {
    const h = harness([spellWith('bare', [])]);
    const c = h.cast('bare');
    const u = h.cast('nobody-knows');
    h.advance(BLOOM);
    expect(h.plays.map((p) => p.cue)).toEqual(['chime', 'chime']);
    expect(h.events.map((x) => [x.e.use, x.e.step, x.e.id])).toEqual([[FALLBACK_USE, -1, `${c.id}#-1`], [FALLBACK_USE, -1, `${u.id}#-1`]]);
  });

  it('are cancelled, or faded, when their spell ends', () => {
    const h = harness([seedSpell('lumos')]);
    const before = h.cast('lumos');
    h.end(before, 'nox');
    h.advance(BLOOM);
    expect(h.plays).toHaveLength(0);

    const c = h.cast('lumos');
    h.advance(BLOOM + 100);
    h.end(c, 'nox');
    expect(h.plays[0].stoppedAt).toBe(h.now);
    expect(h.log().slice(-1)).toEqual([`end ${c.id}#2 audio.cue spell-ended`]);
  });

  it('repeat while held, until the spell ends', () => {
    const h = harness([spellWith('hum', [{ use: 'audio.cue', cue: 'shield', hold: true }])]);
    const c = h.cast('hum');
    h.advance(BLOOM);
    expect(h.events[0].e.durationMs).toBeUndefined();
    h.advance(CUE_MS * 2);
    expect(h.plays).toHaveLength(3);
    h.end(c, 'finite-incantatem');
    expect(h.plays[2].stoppedAt).toBe(h.now);
    h.advance(CUE_MS * 3);
    expect(h.plays).toHaveLength(3);
    expect(h.log()).toEqual([`start ${c.id}#0 audio.cue`, `end ${c.id}#0 audio.cue spell-ended`]);
  });

  it('are handed over, when held, to the same cue of their spell cast again, so the sound never drops out', () => {
    const h = harness([spellWith('hum', [{ use: 'audio.cue', cue: 'curse-hum', hold: true }, { use: 'audio.muffle', hold: true }])]);
    const first = h.cast('hum');
    h.advance(BLOOM + 1250);
    // The engine's order for a recast: the new spell.cast, then the earlier cast's spell.ended.
    const again = h.cast('hum');
    h.end(first, 'hum', again);
    const hums = () => h.plays.filter((p) => p.cue === 'curse-hum');
    expect(hums().every((p) => p.stoppedAt === undefined)).toBe(true);
    h.advance(BLOOM);
    const all = hums();
    const fresh = all[all.length - 1];
    const old = all[all.length - 2];
    // The old hum fades only as the new one starts.
    expect(old.stoppedAt).toBe(fresh.at);
    const log = h.log();
    expect(log.indexOf(`end ${first.id}#0 audio.cue spell-ended`)).toBeGreaterThan(log.indexOf(`start ${again.id}#0 audio.cue`));
    expect(h.director.muffleCount).toBe(1);
    // Cast again with another cue, or as another spell, it is not a hand-over: it ends at once.
    const other = harness([spellWith('hum', [{ use: 'audio.cue', cue: 'curse-hum', hold: true }]), spellWith('drone', [{ use: 'audio.cue', cue: 'curse-hum', hold: true }])]);
    const a = other.cast('hum');
    other.advance(BLOOM + 100);
    other.end(a, 'drone', other.cast('drone'));
    expect(other.plays[0].stoppedAt).toBe(other.now);
  });

  it('repeat for duration_ms when timed, then end', () => {
    const h = harness([spellWith('drone', [{ use: 'audio.cue', cue: 'buzz', duration_ms: 2500 }])]);
    const c = h.cast('drone');
    h.advance(BLOOM);
    expect(h.events[0].e).toMatchObject({ durationMs: 2500, params: { duration_ms: 2500 } });
    h.advance(2500);
    expect(h.plays).toHaveLength(3);
    expect(h.plays[2].stoppedAt).toBe(h.now);
    expect(h.log().slice(-1)).toEqual([`end ${c.id}#0 audio.cue done`]);
  });
});

describe('muffle', () => {
  it('closes at the bloom and opens when the spell ends ("until Finite")', () => {
    const h = harness([seedSpell('muffliato')]);
    const c = h.cast('muffliato');
    h.advance(BLOOM);
    expect(h.muffles).toEqual([true]);
    expect(h.director.muffleCount).toBe(1);
    const start = h.events.find((x) => x.e.use === 'audio.muffle')!.e;
    expect(start).toMatchObject({ id: `${c.id}#0`, step: 0, params: { hold: true } });
    expect(start.durationMs).toBeUndefined();
    h.advance(60_000);
    expect(h.muffles).toEqual([true]);
    h.end(c, 'finite-incantatem');
    expect(h.muffles).toEqual([true, false]);
    expect(h.log()).toContain(`end ${c.id}#0 audio.muffle spell-ended`);
  });

  it('counts overlapping muffles, opening only when the last one ends', () => {
    const h = harness([seedSpell('muffliato'), spellWith('hush', [{ use: 'audio.muffle', hold: true }])]);
    const a = h.cast('muffliato');
    const b = h.cast('hush');
    h.advance(BLOOM);
    expect(h.muffles).toEqual([true]);
    h.end(a, 'finite-incantatem');
    expect(h.muffles).toEqual([true]);
    h.end(b, 'finite-incantatem');
    expect(h.muffles).toEqual([true, false]);
  });

  it('is handed over when Muffliato is cast again, so the sound never opens in between', () => {
    const h = harness([seedSpell('muffliato')]);
    const first = h.cast('muffliato');
    h.advance(BLOOM + 1000);
    const again = h.cast('muffliato');
    h.end(first, 'muffliato', again);
    expect(h.muffles).toEqual([true]);
    h.advance(BLOOM);
    expect(h.muffles).toEqual([true]);
    expect(h.director.muffleCount).toBe(1);
    expect(h.log()).toContain(`end ${first.id}#0 audio.muffle spell-ended`);
  });

  it('ends at once when the cast that was to take it over ends first', () => {
    const h = harness([seedSpell('muffliato')]);
    const first = h.cast('muffliato');
    h.advance(BLOOM);
    const again = h.cast('muffliato');
    h.end(first, 'muffliato', again);
    h.end(again, 'finite-incantatem');
    expect(h.muffles).toEqual([true, false]);
    h.advance(BLOOM);
    expect(h.director.muffleCount).toBe(0);
  });

  it('lasts for its duration, the spell duration, or a default when nothing holds it', () => {
    const h = harness([
      spellWith('timed', [{ use: 'audio.muffle', duration_ms: 2000 }]),
      spellWith('spell-long', [{ use: 'audio.muffle' }], { duration_ms: 3000 }),
      spellWith('instant', [{ use: 'audio.muffle' }]),
    ]);
    h.cast('timed');
    h.cast('spell-long');
    h.cast('instant');
    h.advance(BLOOM);
    const durations = h.events.filter((x) => x.type === 'effect.start').map((x) => x.e.durationMs);
    expect(durations).toEqual([2000, 3000, DEFAULT_MUFFLE_MS]);
    h.advance(DEFAULT_MUFFLE_MS);
    expect(h.muffles).toEqual([true, false]);
    expect(h.events.filter((x) => x.type === 'effect.end').every((x) => x.e.reason === 'done')).toBe(true);
  });
});

describe('effects.end and stopping', () => {
  it("ends every earlier cast's sound, but not the current cast's or later ones", () => {
    const h = harness([seedSpell('lumos'), seedSpell('muffliato'), seedSpell('finite-incantatem')]);
    const lumos = h.cast('lumos');
    const muff = h.cast('muffliato');
    h.advance(BLOOM + 10);
    const finite = h.cast('finite-incantatem');
    const later = h.cast('lumos');
    h.director.endAll(finite.id, 'effects-end');
    expect(h.muffles).toEqual([true, false]);
    expect(h.log()).toEqual(expect.arrayContaining([`end ${lumos.id}#2 audio.cue effects-end`, `end ${muff.id}#0 audio.muffle effects-end`]));
    h.advance(BLOOM);
    expect(h.plays.map((p) => p.cue)).toEqual(['chime-rise', 'buzz', 'dispel', 'chime-rise']);
    expect(h.log()).toContain(`start ${later.id}#2 audio.cue`);
  });

  it('clear() ends everything with reason reset and opens the muffle', () => {
    const h = harness([seedSpell('muffliato'), seedSpell('lumos')]);
    const m = h.cast('muffliato');
    h.advance(BLOOM);
    h.cast('lumos');
    h.director.clear('reset');
    expect(h.muffles).toEqual([true, false]);
    expect(h.log()).toEqual(expect.arrayContaining([`end ${m.id}#0 audio.muffle reset`, `end ${m.id}#2 audio.cue reset`]));
    h.advance(BLOOM);
    expect(h.plays.map((p) => p.cue)).toEqual(['buzz']);
  });
});
