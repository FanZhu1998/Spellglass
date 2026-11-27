import { describe, expect, it } from 'vitest';
import type { Candidate, GestureVerdict, StrokeDecisionInput } from './decision';
import { decideStroke, judgeGesture, rankCandidates, withLockedSpell } from './decision';
import type { HeardIncantation } from './voice-log';
import { recognitionOf } from './test-support';

const ACCEPT = 0.72;
const LEAD = 0.04;

const cands = (...pairs: [string, number][]): Candidate[] => pairs.map(([spellId, score]) => ({ spellId, score }));

function heard(spellId: string, t = 1000, key = `h-${spellId}`): HeardIncantation {
  return { key, spellId, text: spellId, conf: 0.9, t, t0: t, t1: t + 400, receivedAt: t + 500, consumed: false };
}

function input(over: Partial<StrokeDecisionInput> & { verdict: GestureVerdict; candidates: Candidate[] }): StrokeDecisionInput {
  return {
    mode: 'gesture',
    voice: { finals: [], inProgress: false },
    assistedScore: 0.6,
    isEnabled: () => true,
    mayWait: true,
    ...over,
  };
}

describe('judgeGesture: the Section 7.5 decision rule', () => {
  it('accepts at exactly the acceptance score with exactly the lead margin', () => {
    // 0.76 - 0.72 and 0.74 - 0.70 are not exactly 0.04 in floating point; both must pass.
    expect(judgeGesture(cands(['lumos', 0.72], ['nox', 0.68]), false, ACCEPT, LEAD)).toMatchObject({ accepted: true, spellId: 'lumos' });
    expect(judgeGesture(cands(['accio', 0.74], ['protego', 0.7]), false, ACCEPT, LEAD)).toMatchObject({ accepted: true, spellId: 'accio' });
  });

  it('fizzles just under the acceptance score as low-score, naming the nearest spell', () => {
    expect(judgeGesture(cands(['accio', 0.7199], ['protego', 0.3]), false, ACCEPT, LEAD)).toEqual({
      accepted: false, reason: 'low-score', nearest: { spellId: 'accio', score: 0.7199 },
    });
  });

  it('fizzles as ambiguous when the lead is just under the margin', () => {
    expect(judgeGesture(cands(['accio', 0.8], ['protego', 0.7601]), false, ACCEPT, LEAD)).toEqual({
      accepted: false, reason: 'ambiguous', nearest: { spellId: 'accio', score: 0.8 },
    });
  });

  it('waives the lead margin for a flick but not the acceptance score', () => {
    expect(judgeGesture(cands(['lumos', 0.8], ['incendio', 0.79]), true, ACCEPT, LEAD)).toMatchObject({ accepted: true, rule: 'flick' });
    expect(judgeGesture(cands(['lumos', 0.71]), true, ACCEPT, LEAD)).toMatchObject({ accepted: false, reason: 'low-score' });
  });

  it('fizzles with no candidates', () => {
    expect(judgeGesture([], false, ACCEPT, LEAD)).toEqual({ accepted: false, reason: 'no-candidates' });
  });

  it('accepts a lone candidate that clears the threshold', () => {
    expect(judgeGesture(cands(['lumos', 0.75]), false, ACCEPT, LEAD)).toMatchObject({ accepted: true });
  });
});

describe('withLockedSpell: naming a spell the player has not unlocked', () => {
  const isLocked = (id: string) => id === 'protego';
  const rec = (locked: { spellId: string; score: number }[]) => ({ strokeId: 's', recognizer: 'r', candidates: [], locked });

  it('names a locked spell that clearly matches when no open spell passes', () => {
    const v = judgeGesture([{ spellId: 'incendio', score: 0.61 }], false, 0.72, 0.04);
    expect(withLockedSpell(v, rec([{ spellId: 'protego', score: 0.93 }]), isLocked, 0.72, 0.04)).toEqual({ accepted: false, reason: 'unavailable', nearest: { spellId: 'protego', score: 0.93 } });
  });

  it('keeps the original fizzle when the locked spell does not clearly lead or pass', () => {
    const v = judgeGesture([{ spellId: 'incendio', score: 0.7 }], false, 0.72, 0.04);
    expect(withLockedSpell(v, rec([{ spellId: 'protego', score: 0.72 }]), isLocked, 0.72, 0.04)).toBe(v);
    expect(withLockedSpell(v, rec([{ spellId: 'protego', score: 0.7 }]), isLocked, 0.72, 0.04)).toBe(v);
    expect(withLockedSpell(v, rec([{ spellId: 'accio', score: 0.95 }]), isLocked, 0.72, 0.04)).toBe(v);
  });

  it('never overrides an accepted cast', () => {
    const v = judgeGesture([{ spellId: 'incendio', score: 0.9 }], false, 0.72, 0.04);
    expect(withLockedSpell(v, rec([{ spellId: 'protego', score: 0.99 }]), isLocked, 0.72, 0.04)).toBe(v);
  });
});

describe('rankCandidates', () => {
  it('keeps enabled spells only, one per spell, best first', () => {
    const rec = recognitionOf('s', {});
    rec.candidates = [
      { spellId: 'nox', score: 0.5 },
      { spellId: 'lumos', score: 0.9 },
      { spellId: 'nox', score: 0.6 },
      { spellId: 'crucio', score: 0.95 },
    ];
    expect(rankCandidates(rec, (id) => id !== 'crucio')).toEqual(cands(['lumos', 0.9], ['nox', 0.6]));
  });
});

describe('decideStroke: combining gesture and voice (Section 7.7)', () => {
  const pass = judgeGesture(cands(['lumos', 0.9], ['nox', 0.3]), true, ACCEPT, LEAD);
  const weak = judgeGesture(cands(['alohomora', 0.65], ['protego', 0.5]), false, ACCEPT, LEAD);
  const weakCands = cands(['alohomora', 0.65], ['protego', 0.5]);
  const passCands = cands(['lumos', 0.9], ['nox', 0.3]);

  describe('gesture', () => {
    it('casts on the gesture alone and never waits', () => {
      expect(decideStroke(input({ verdict: pass, candidates: passCands }))).toMatchObject({ kind: 'cast', spellId: 'lumos', via: 'gesture' });
      expect(decideStroke(input({ verdict: weak, candidates: weakCands, voice: { finals: [], inProgress: true } }))).toMatchObject({ kind: 'fizzle', reason: 'low-score' });
    });

    it('marks the cast both when an agreeing incantation is in the window, and ignores a disagreeing one', () => {
      const agree = heard('lumos');
      expect(decideStroke(input({ verdict: pass, candidates: passCands, voice: { finals: [agree], inProgress: false } }))).toMatchObject({
        kind: 'cast', via: 'both', incantation: agree, voiceDecided: false,
      });
      const other = decideStroke(input({ verdict: pass, candidates: passCands, voice: { finals: [heard('nox')], inProgress: false } }));
      expect(other).toMatchObject({ kind: 'cast', spellId: 'lumos', via: 'gesture' });
      expect(other).not.toHaveProperty('incantation.key');
    });
  });

  describe('assisted', () => {
    it('accepts the spoken spell at the assisted score, ignoring other spells', () => {
      const d = decideStroke(input({ mode: 'assisted', verdict: weak, candidates: weakCands, voice: { finals: [heard('alohomora')], inProgress: false } }));
      expect(d).toMatchObject({ kind: 'cast', spellId: 'alohomora', score: 0.65, via: 'both', voiceDecided: true });
      // The gesture clearly says Lumos, but the voice picks Nox, which scores under 0.60: fizzle on Nox.
      const ignored = decideStroke(input({ mode: 'assisted', verdict: pass, candidates: passCands, voice: { finals: [heard('nox')], inProgress: false } }));
      expect(ignored).toMatchObject({ kind: 'fizzle', reason: 'low-score', nearest: { spellId: 'nox', score: 0.3 } });
    });

    it('accepts exactly at the assisted score', () => {
      const c = cands(['alohomora', 0.6]);
      const v = judgeGesture(c, false, ACCEPT, LEAD);
      expect(decideStroke(input({ mode: 'assisted', verdict: v, candidates: c, voice: { finals: [heard('alohomora')], inProgress: false } }))).toMatchObject({ kind: 'cast' });
    });

    it('fizzles unavailable when the spoken spell is locked', () => {
      const d = decideStroke(input({ mode: 'assisted', verdict: weak, candidates: weakCands, isEnabled: (id) => id !== 'crucio', voice: { finals: [heard('crucio')], inProgress: false } }));
      expect(d).toMatchObject({ kind: 'fizzle', reason: 'unavailable', nearest: { spellId: 'crucio', score: 0 } });
    });

    it('casts at once when the gesture passes and nobody is speaking', () => {
      expect(decideStroke(input({ mode: 'assisted', verdict: pass, candidates: passCands }))).toMatchObject({ kind: 'cast', via: 'gesture' });
    });

    it('waits when the gesture passes but an utterance is under way, or when the gesture fails', () => {
      expect(decideStroke(input({ mode: 'assisted', verdict: pass, candidates: passCands, voice: { finals: [], inProgress: true } }))).toEqual({ kind: 'wait' });
      expect(decideStroke(input({ mode: 'assisted', verdict: weak, candidates: weakCands }))).toEqual({ kind: 'wait' });
    });

    it('after the deadline, the gesture decides alone', () => {
      expect(decideStroke(input({ mode: 'assisted', verdict: weak, candidates: weakCands, mayWait: false }))).toMatchObject({ kind: 'fizzle', reason: 'low-score' });
      expect(decideStroke(input({ mode: 'assisted', verdict: pass, candidates: passCands, mayWait: false, voice: { finals: [], inProgress: true } }))).toMatchObject({ kind: 'cast', via: 'gesture' });
    });

    it('picks, of several incantations, the one the gesture resembles most', () => {
      const c = cands(['alohomora', 0.65], ['protego', 0.62]);
      const v = judgeGesture(c, false, ACCEPT, LEAD);
      const d = decideStroke(input({ mode: 'assisted', verdict: v, candidates: c, voice: { finals: [heard('protego', 900), heard('alohomora', 1000)], inProgress: false } }));
      expect(d).toMatchObject({ kind: 'cast', spellId: 'alohomora' });
    });
  });

  describe('strict', () => {
    it('casts when stroke and incantation agree', () => {
      expect(decideStroke(input({ mode: 'strict', verdict: pass, candidates: passCands, voice: { finals: [heard('lumos')], inProgress: false } }))).toMatchObject({
        kind: 'cast', via: 'both', voiceDecided: true,
      });
    });

    it('waits for speech, then fizzles strict-mismatch when none came', () => {
      expect(decideStroke(input({ mode: 'strict', verdict: pass, candidates: passCands }))).toEqual({ kind: 'wait' });
      expect(decideStroke(input({ mode: 'strict', verdict: pass, candidates: passCands, mayWait: false }))).toMatchObject({
        kind: 'fizzle', reason: 'strict-mismatch', nearest: { spellId: 'lumos' }, voiceIssue: 'none-heard',
      });
    });

    it('fizzles strict-mismatch at once on a disagreeing incantation, unless someone is still speaking', () => {
      const nox = heard('nox');
      expect(decideStroke(input({ mode: 'strict', verdict: pass, candidates: passCands, voice: { finals: [nox], inProgress: false } }))).toMatchObject({
        kind: 'fizzle', reason: 'strict-mismatch', voiceIssue: 'disagreed', incantation: nox,
      });
      expect(decideStroke(input({ mode: 'strict', verdict: pass, candidates: passCands, voice: { finals: [nox], inProgress: true } }))).toEqual({ kind: 'wait' });
    });

    it('a failing gesture fizzles on its own terms, without waiting', () => {
      expect(decideStroke(input({ mode: 'strict', verdict: weak, candidates: weakCands, voice: { finals: [heard('alohomora')], inProgress: false } }))).toMatchObject({
        kind: 'fizzle', reason: 'low-score',
      });
    });
  });
});
