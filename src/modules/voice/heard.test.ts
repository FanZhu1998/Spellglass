import { describe, expect, it } from 'vitest';
import { spellForms, type SpellForms } from './fuzzy';
import { decideIncantation, estimateSpeech, syllables, TIMING, UtteranceTracker, type ResultSnapshot, type UtteranceUpdate } from './heard';
import { SEED_PACKS } from './testing';

const SPELLS: SpellForms[] = SEED_PACKS.slice(0, 2).flatMap((p) => p.spells.map((s) => spellForms(s.id, s.incantation, s.heard_as)));

const interim = (text: string, confidence = 0): ResultSnapshot => ({ isFinal: false, alternatives: [{ transcript: text, confidence }] });
const final = (text: string, confidence = 0.9, more: { transcript: string; confidence: number }[] = []): ResultSnapshot => ({
  isFinal: true, alternatives: [{ transcript: text, confidence }, ...more],
});

function update(over: Partial<UtteranceUpdate> & Pick<UtteranceUpdate, 'alternatives'>): UtteranceUpdate {
  return { id: 's:0', final: true, firstAt: 1000, firstText: over.alternatives[0]?.transcript ?? '', firstFinal: false, at: 1500, ...over };
}

describe('utterances', () => {
  it('keeps one id across the interim results and the final of an utterance', () => {
    const t = new UtteranceTracker('s1');
    const a = t.update([interim('loo')], 0, 1000);
    const b = t.update([interim('lumos')], 0, 1200);
    const c = t.update([final('lumos')], 0, 1700);
    expect([...a, ...b, ...c].map((u) => [u.id, u.final])).toEqual([['s1:0', false], ['s1:0', false], ['s1:0', true]]);
    expect(c[0]).toMatchObject({ firstAt: 1000, firstText: 'loo', firstFinal: false, at: 1700 });
  });

  it('reports a final once, and an interim only when its words change', () => {
    const t = new UtteranceTracker('s');
    expect(t.update([interim('nox')], 0, 1)).toHaveLength(1);
    expect(t.update([interim('nox')], 0, 2)).toHaveLength(0);
    expect(t.update([final('nox')], 0, 3)).toHaveLength(1);
    expect(t.update([final('nox')], 0, 4)).toHaveLength(0);
  });

  it('gives the next utterance of a session the next index', () => {
    const t = new UtteranceTracker('s');
    t.update([final('lumos')], 0, 1);
    const next = t.update([final('lumos'), interim('nox')], 1, 2);
    expect(next.map((u) => [u.id, u.final, u.alternatives[0].transcript])).toEqual([['s:1', false, 'nox']]);
  });

  it('joins split interim results (a stable part and a tail) under the first index, where the final lands', () => {
    const t = new UtteranceTracker('s');
    const parts = t.update([interim('wingardium', 0.9), interim(' leviosa', 0.01)], 0, 100);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: 's:0', final: false, alternatives: [{ transcript: 'wingardium leviosa' }] });
    const done = t.update([final('wingardium leviosa')], 0, 600);
    expect(done[0]).toMatchObject({ id: 's:0', final: true });
  });

  it('ignores empty results until words arrive', () => {
    const t = new UtteranceTracker('s');
    expect(t.update([interim('')], 0, 1)).toEqual([]);
    expect(t.update([interim('accio')], 0, 2)[0]).toMatchObject({ firstAt: 2 });
  });
});

describe('timing', () => {
  it('counts syllables as vowel groups', () => {
    expect(syllables('lumos')).toBe(2);
    // A rough count: "iu" and "io" are one vowel group each (the spoken word has eight syllables).
    expect(syllables('Wingardium Leviosa')).toBe(6);
    expect(syllables('nox')).toBe(1);
  });

  it('estimates t0 from the first interim result, and t1 from the latest result', () => {
    const u: UtteranceUpdate = { id: 'x', final: false, alternatives: [], firstAt: 10_000, firstText: 'lumos', firstFinal: false, at: 10_400 };
    const t = estimateSpeech(u, 'lumos');
    expect(t.t0).toBe(10_000 - TIMING.interimLagMs - 2 * TIMING.syllableMs);
    expect(t.t1).toBe(10_400 - TIMING.interimLagMs);
    const f = estimateSpeech({ ...u, final: true, at: 11_000 }, 'lumos');
    expect(f.t0).toBe(t.t0); // stable across the interims and the final
    expect(f.t1).toBe(11_000 - TIMING.finalLagMs);
  });

  it('estimates from the final alone when no interim came first', () => {
    const u: UtteranceUpdate = { id: 'x', final: true, alternatives: [], firstAt: 5000, firstText: 'nox', firstFinal: true, at: 5000 };
    const t = estimateSpeech(u, 'nox');
    expect(t.t0).toBe(5000 - TIMING.finalLagMs - TIMING.syllableMs);
    expect(t.t1).toBe(5000 - TIMING.finalLagMs);
  });

  it('never starts before the session, never ends before it starts, never after the result', () => {
    const u: UtteranceUpdate = { id: 'x', final: false, alternatives: [], firstAt: 1000, firstText: 'expecto patronum', firstFinal: false, at: 1000 };
    const t = estimateSpeech(u, 'expecto patronum', { floor: 900 });
    expect(t.t0).toBe(900);
    expect(t.t1).toBeGreaterThanOrEqual(t.t0);
    expect(t.t1).toBeLessThanOrEqual(1000);
  });

  it('uses the spec timings (seconds on the session audio timeline) when they are plausible', () => {
    const u: UtteranceUpdate = { id: 'x', final: true, alternatives: [], firstAt: 9000, firstText: 'lumos', firstFinal: false, at: 9500, audio: { start: 2.1, end: 2.6 } };
    expect(estimateSpeech(u, 'lumos', { audioStartAt: 6000 })).toEqual({ t0: 8100, t1: 8600 });
    // Offsets that would put the speech after the result arrived are ignored.
    const later = estimateSpeech({ ...u, audio: { start: 9, end: 10 } }, 'lumos', { audioStartAt: 6000 });
    expect(later.t0).toBe(9000 - TIMING.interimLagMs - 2 * TIMING.syllableMs);
  });
});

describe('deciding the spell', () => {
  it('names the spell, with conf = similarity × the recognizer confidence for a final', () => {
    const inc = decideIncantation(update({ alternatives: [{ transcript: 'Lumos', confidence: 0.8 }] }), SPELLS, { minConf: 0.55 });
    expect(inc).toMatchObject({ spellId: 'lumos', conf: 0.8, final: true, id: 's:0', text: 'Lumos' });
    expect(inc.t).toBe(inc.t0);
    expect(inc.t1).toBeGreaterThanOrEqual(inc.t0!);
  });

  it('uses the similarity alone for interim results, whose confidence is often 0', () => {
    const inc = decideIncantation(update({ final: false, alternatives: [{ transcript: 'knocks', confidence: 0 }] }), SPELLS, { minConf: 0.55 });
    expect(inc).toMatchObject({ spellId: 'nox', conf: 1, final: false });
    const noConf = decideIncantation(update({ alternatives: [{ transcript: 'knocks', confidence: 0 }] }), SPELLS, { minConf: 0.55 });
    expect(noConf).toMatchObject({ spellId: 'nox', conf: 1 });
  });

  it('leaves spellId out below voice.minConf, but still reports what was heard', () => {
    const inc = decideIncantation(update({ alternatives: [{ transcript: 'lumos', confidence: 0.5 }] }), SPELLS, { minConf: 0.55 });
    expect(inc.spellId).toBeUndefined();
    expect(inc).toMatchObject({ text: 'lumos', conf: 0.5, alternatives: [{ spellId: 'lumos', conf: 0.5 }] });
    const nothing = decideIncantation(update({ alternatives: [{ transcript: 'hello there', confidence: 0.9 }] }), SPELLS, { minConf: 0.55 });
    expect(nothing.spellId).toBeUndefined();
    expect(nothing.alternatives).toBeUndefined();
  });

  it('reads every alternative the recognizer offers', () => {
    const inc = decideIncantation(
      update({ alternatives: [{ transcript: 'hello moss', confidence: 0.6 }, { transcript: 'loo moss', confidence: 0.3 }] }),
      SPELLS, { minConf: 0.25 },
    );
    expect(inc).toMatchObject({ spellId: 'lumos', text: 'loo moss', conf: 0.3 });
  });

  it('refuses to choose between two spells heard in the same words when neither leads', () => {
    // Without the recognizer's confidence, both alternatives name a spell equally well.
    const u = update({ final: false, alternatives: [{ transcript: 'reducto', confidence: 0 }, { transcript: 'reducio', confidence: 0 }] });
    const inc = decideIncantation({ ...u, alternatives: [{ transcript: 'reducto', confidence: 0 }] }, SPELLS, { minConf: 0.55 });
    expect(inc.spellId).toBe('reducto');
    const tie = decideIncantation({ ...u, final: true, alternatives: [{ transcript: 'reducto', confidence: 0.7 }, { transcript: 'reducio', confidence: 0.7 }] }, SPELLS, { minConf: 0.55 });
    expect(tie.spellId).toBeUndefined();
    expect(tie.alternatives?.slice(0, 2).map((a) => a.spellId).sort()).toEqual(['reducio', 'reducto']);
  });

  it('takes the later of two spells said in one breath, and lists the other', () => {
    const inc = decideIncantation(update({ alternatives: [{ transcript: 'lumos nox', confidence: 0.9 }] }), SPELLS, { minConf: 0.55 });
    expect(inc.spellId).toBe('nox');
    expect(inc.alternatives).toEqual([{ spellId: 'lumos', conf: 0.9 }]);
  });

  it('moves t0 to where the incantation begins when other words came first', () => {
    const base = update({ final: false, firstText: 'okay then lumos', alternatives: [{ transcript: 'okay then lumos', confidence: 0 }] });
    const plain = estimateSpeech(base, 'okay then lumos');
    const inc = decideIncantation(base, SPELLS, { minConf: 0.55 });
    expect(inc.spellId).toBe('lumos');
    expect(inc.t0).toBe(Math.min(plain.t1, plain.t0 + syllables('okay then') * TIMING.syllableMs));
  });
});
