import { describe, expect, it } from 'vitest';
import type { Incantation } from '../../contracts';
import { UTTERANCE_STALE_MS, VoiceLog, voiceWindow } from './voice-log';

const known = () => true;
const inc = (over: Partial<Incantation>): Incantation => ({ t: 1000, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true, ...over });

describe('VoiceLog', () => {
  it('finds finals whose speech overlaps the window, and only unconsumed ones', () => {
    const log = new VoiceLog();
    const h = log.final(inc({ id: 'u1', t: 1000, t0: 1000, t1: 1500 }), 1600, known)!;
    expect(log.finalsIn(1400, 3000)).toEqual([h]); // overlaps at the end of the speech
    expect(log.finalsIn(1501, 3000)).toEqual([]);
    expect(log.finalsIn(0, 999)).toEqual([]);
    log.consume(h);
    expect(log.finalsIn(0, 3000)).toEqual([]);
  });

  it('serves each id once: a repeated final is not heard again', () => {
    const log = new VoiceLog();
    expect(log.final(inc({ id: 'u1' }), 1100, known)).not.toBeNull();
    expect(log.final(inc({ id: 'u1' }), 1200, known)).toBeNull();
    expect(log.finalsIn(0, 5000)).toHaveLength(1);
  });

  it('drops spell ids the spellbook does not know', () => {
    const log = new VoiceLog();
    const h = log.final(inc({ id: 'u1', spellId: 'nonsense' }), 1100, (id) => id === 'lumos')!;
    expect(h.spellId).toBeUndefined();
    expect(log.finalsIn(0, 5000)).toEqual([]);
  });

  it('marks an utterance under way from its interims until its final, or until it goes stale', () => {
    const log = new VoiceLog();
    log.interim(inc({ id: 'u1', final: false, t: 2000 }), 2100);
    expect(log.inProgress(3000, 2200)).toBe(true);
    expect(log.inProgress(1500, 2200)).toBe(false); // began after the window ends
    expect(log.inProgress(3000, 2100 + UTTERANCE_STALE_MS)).toBe(false);
    log.final(inc({ id: 'u1', t: 2000 }), 2500, known);
    expect(log.inProgress(3000, 2600)).toBe(false);
  });

  it('forgets old finals', () => {
    const log = new VoiceLog();
    log.final(inc({ id: 'u1' }), 1000, known);
    log.prune(5000, 10000);
    expect(log.finalsIn(0, 99999)).toHaveLength(1);
    log.prune(12000, 10000);
    expect(log.finalsIn(0, 99999)).toHaveLength(0);
  });
});

describe('pairing finals with strokes (Section 7.7)', () => {
  const BEFORE = 2500;
  const AFTER = 1000;

  it('offers a stroke only speech begun after the last decided stroke ended', () => {
    const log = new VoiceLog();
    const during = log.final(inc({ id: 'u1', spellId: 'nox', t: 1100, t0: 1100, t1: 1500 }), 2000, known)!;
    const after = log.final(inc({ id: 'u2', spellId: 'protego', t: 1400, t0: 1400, t1: 1900 }), 2400, known)!;
    expect(log.finalsFor({ t0: 2600, t1: 2900 }, BEFORE, AFTER)).toEqual([during, after]);
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    expect(log.finalsFor({ t0: 2600, t1: 2900 }, BEFORE, AFTER)).toEqual([after]);
  });

  it('consumes a late final that names the decided stroke’s spell inside its window, once', () => {
    const log = new VoiceLog();
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    // Another spell, begun after the stroke: it may be meant for the next stroke.
    const other = log.final(inc({ id: 'u0', spellId: 'nox', t: 1400, t0: 1400, t1: 1800 }), 2300, known)!;
    expect(log.pairLate(other, BEFORE, AFTER)).toBe(false);
    const late = log.final(inc({ id: 'u1', spellId: 'lumos', t: 1400, t0: 1400, t1: 1800 }), 2400, known)!;
    expect(log.pairLate(late, BEFORE, AFTER)).toBe(true);
    expect(late.consumed).toBe(true);
    // The stroke has heard its incantation now: another Lumos is left for the next stroke.
    const again = log.final(inc({ id: 'u2', spellId: 'lumos', t: 2000, t0: 2000, t1: 2400 }), 2900, known)!;
    expect(log.pairLate(again, BEFORE, AFTER)).toBe(false);
    expect(log.finalsFor({ t0: 3000, t1: 3300 }, BEFORE, AFTER)).toEqual([other, again]);
  });

  it('leaves a final begun after the stroke’s window, and one for a stroke that heard its own', () => {
    const log = new VoiceLog();
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    const beyond = log.final(inc({ id: 'u1', t: 2301, t0: 2301, t1: 2700 }), 3300, known)!; // the window ends at 2300
    expect(log.pairLate(beyond, BEFORE, AFTER)).toBe(false);

    const voiced = new VoiceLog();
    const used = voiced.final(inc({ id: 'u1', t: 500, t0: 500, t1: 900 }), 1000, known)!;
    voiced.consume(used);
    voiced.decided({ t0: 1000, t1: 1300 }, 'lumos', used);
    const second = voiced.final(inc({ id: 'u2', t: 1500, t0: 1500, t1: 1900 }), 2500, known)!;
    expect(voiced.pairLate(second, BEFORE, AFTER)).toBe(false);
  });

  it('pairs late only a final the decided stroke could have used', () => {
    const log = new VoiceLog();
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    log.decided({ t0: 1800, t1: 2100 }, 'lumos', undefined);
    // Spoken while the first Lumos was flicked: it belongs there, and is never the second stroke's.
    const first = log.final(inc({ id: 'u1', t: 1100, t0: 1100, t1: 1500 }), 2300, known)!;
    expect(log.pairLate(first, BEFORE, AFTER)).toBe(false);
    // So the second stroke still pairs its own late final, and the next stroke gets neither.
    const second = log.final(inc({ id: 'u2', t: 2200, t0: 2200, t1: 2600 }), 3000, known)!;
    expect(log.pairLate(second, BEFORE, AFTER)).toBe(true);
    expect(log.finalsFor({ t0: 3200, t1: 3500 }, BEFORE, AFTER)).toEqual([]);
  });

  it('counts any incantation a decision used as the stroke’s own, also one that disagreed', () => {
    const log = new VoiceLog();
    const nox = log.final(inc({ id: 'u1', spellId: 'nox', t: 1050, t0: 1050, t1: 1250 }), 1290, known)!;
    log.consume(nox);
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', nox); // strict: a Lumos flick fizzled on "Nox"
    // "Lumos" for the retry names the spell the stroke came nearest to, but the stroke has had its word.
    const retry = log.final(inc({ id: 'u2', t: 1750, t0: 1750, t1: 2150 }), 2300, known)!;
    expect(log.pairLate(retry, BEFORE, AFTER)).toBe(false);
    expect(log.finalsFor({ t0: 1700, t1: 2600 }, BEFORE, AFTER)).toEqual([retry]);
  });

  it('never pairs speech begun once the next stroke had begun, also when it names the same spell', () => {
    const pairs = (speechAt: number) => {
      const log = new VoiceLog();
      log.began(1000); // the decided stroke's own start: behind it once it is decided
      log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined); // cast at once, nothing heard yet
      log.began(1200); // not after the decided stroke: no next stroke
      log.began(1700); // the pen goes down for the next stroke
      log.began(2000); // the first start after the decided stroke is the one that counts
      return log.pairLate(log.final(inc({ id: 'u1', t: speechAt, t0: speechAt, t1: speechAt + 400 }), 2400, known)!, BEFORE, AFTER);
    };
    expect(pairs(1750)).toBe(false); // said while the next stroke is traced
    expect(pairs(1700)).toBe(false); // from the press itself
    expect(pairs(1650)).toBe(true); // begun before the press: the decided stroke's own, arriving late
  });

  it('holds back speech begun before the last stroke ended only while that stroke lacks its own word', () => {
    // "Nox" for the next stroke, said as soon as the first one ended, its start estimated a little early.
    const early = (log: VoiceLog) => log.final(inc({ id: 'u2', spellId: 'nox', t: 1200, t0: 1200, t1: 1600 }), 2300, known)!;
    const next = { t0: 1350, t1: 1650 };

    const silent = new VoiceLog();
    silent.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    early(silent);
    expect(silent.finalsFor(next, BEFORE, AFTER)).toEqual([]); // it may be that stroke's word, misheard

    const voiced = new VoiceLog();
    const own = voiced.final(inc({ id: 'u1', t: 600, t0: 600, t1: 1100 }), 1200, known)!;
    voiced.consume(own);
    voiced.decided({ t0: 1000, t1: 1300 }, 'lumos', own);
    const h = early(voiced);
    expect(voiced.finalsFor(next, BEFORE, AFTER)).toEqual([h]); // that stroke has nothing left to claim
  });

  it('forgets the decided stroke when cleared', () => {
    const log = new VoiceLog();
    log.decided({ t0: 1000, t1: 1300 }, 'lumos', undefined);
    log.clear();
    const h = log.final(inc({ id: 'u1', t: 1100, t0: 1100, t1: 1500 }), 2000, known)!;
    expect(log.pairLate(h, BEFORE, AFTER)).toBe(false);
    expect(log.finalsFor({ t0: 2600, t1: 2900 }, BEFORE, AFTER)).toEqual([h]);
  });
});

describe('voiceWindow', () => {
  it('runs from before ms ahead of t0 to after ms past t1', () => {
    expect(voiceWindow({ t0: 5000, t1: 6000 }, 2500, 1000)).toEqual([2500, 7000]);
  });
});
