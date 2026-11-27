import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../contracts';
import { formOf, matchTranscript, normalizeWords, phoneticKey, similarity, spellForms, weightedDistance, type SpellForms } from './fuzzy';
import { SEED_PACKS } from './testing';

/** Every seed spell, restricted section included: the matcher must keep all 27 apart. */
const SPELLS: SpellForms[] = SEED_PACKS.flatMap((p) => p.spells.map((s) => spellForms(s.id, s.incantation, s.heard_as)));
const MIN_CONF = DEFAULT_SETTINGS['voice.minConf'];

const top = (text: string) => matchTranscript(text, SPELLS)[0];
const scoreFor = (text: string, spellId: string) => matchTranscript(text, SPELLS).find((m) => m.spellId === spellId)?.score ?? 0;

describe('normalizing', () => {
  it('keeps lower-case letters only, split into words', () => {
    expect(normalizeWords('Wingardium Leviosa!')).toEqual(['wingardium', 'leviosa']);
    expect(normalizeWords("  Expecto…  PATRONUM, 2x  ")).toEqual(['expecto', 'patronum', 'x']);
    expect(normalizeWords('Protégé')).toEqual(['protege']);
    expect(normalizeWords('')).toEqual([]);
  });

  it('gives words that sound alike the same phonetic key', () => {
    expect(phoneticKey('knocks')).toBe(phoneticKey('nox'));
    expect(phoneticKey('nocks')).toBe(phoneticKey('nox'));
    expect(formOf('loo moss')!.key).toBe(formOf('lumos')!.key);
    expect(formOf('allo homora')!.key).toBe(formOf('alohomora')!.key);
    expect(phoneticKey('stupify')).toBe(phoneticKey('stupefy'));
    // A silent final e is dropped, after it has softened the c before it.
    expect(phoneticKey('reduce')).toBe('rEdOs');
    expect(phoneticKey('box')).not.toBe(phoneticKey('nox'));
  });

  it('weights edits: equal strings cost nothing, a final s little, the first sound more', () => {
    expect(weightedDistance('nOks', 'nOks')).toBe(0);
    expect(weightedDistance('nOk', 'nOks')).toBeLessThan(weightedDistance('nOk', 'nOkt'));
    expect(weightedDistance('bOks', 'nOks')).toBeGreaterThan(weightedDistance('nOkt', 'nOks'));
    expect(weightedDistance('lOmOs', 'nOks')).toBeCloseTo(weightedDistance('nOks', 'lOmOs'));
    expect(similarity(formOf('lumos')!, formOf('Lumos')!)).toBe(1);
  });
});

describe('every incantation and every heard_as entry maps to its own spell', () => {
  for (const pack of SEED_PACKS) {
    for (const spell of pack.spells) {
      it(`${spell.id}: ${[spell.incantation, ...(spell.heard_as ?? [])].join(', ')}`, () => {
        for (const phrase of [spell.incantation, ...(spell.heard_as ?? [])]) {
          const matches = matchTranscript(phrase, SPELLS);
          expect(matches[0]?.spellId, phrase).toBe(spell.id);
          expect(matches[0].score, phrase).toBe(1);
          // And clearly ahead of every other spell.
          expect(matches[1]?.score ?? 0, phrase).toBeLessThan(0.9);
        }
      });
    }
  }
});

describe('mishearings that are not listed', () => {
  // Variants a recognizer could plausibly produce: one or two sounds off, words split differently.
  const variants: [string, string][] = [
    ['noks', 'nox'], ['nocs', 'nox'], ['loomis', 'lumos'], ['lumas', 'lumos'], ['lumoss', 'lumos'], ['loo mos', 'lumos'],
    ['akkio', 'accio'], ['stoopify', 'stupefy'], ['stupe fie', 'stupefy'], ['protega', 'protego'], ['protégé', 'protego'],
    ['pro tee go', 'protego'], ['incendeo', 'incendio'], ['in sendio', 'incendio'], ['agua mendy', 'aguamenti'],
    ['expeliarmus', 'expelliarmus'], ['expelliarmous', 'expelliarmus'], ['expel ee armus', 'expelliarmus'],
    ['expecto patronam', 'expecto-patronum'], ['expected patronum', 'expecto-patronum'],
    ['wingardium leviosah', 'wingardium-leviosa'], ['wing gardium leviosa', 'wingardium-leviosa'], ['wingardiam leviosa', 'wingardium-leviosa'],
    ['alohomorra', 'alohomora'], ['aloha moira', 'alohomora'], ['allo ho mora', 'alohomora'],
    ['petrificus totales', 'petrificus-totalus'], ['impedamenta', 'impedimenta'], ['impediment ah', 'impedimenta'],
    ['riddiculus', 'riddikulus'], ['revealio', 'revelio'], ['revellio', 'revelio'], ['finite incantate', 'finite-incantatem'],
    ['oblivi eight', 'obliviate'], ['obliviated', 'obliviate'], ['reductoh', 'reducto'], ['reduct toe', 'reducto'],
    ['arresto momento', 'arresto-momentum'], ['muffle iato', 'muffliato'], ['mufliato', 'muffliato'],
    ['locomotors', 'locomotor'], ['loco motive', 'locomotor'], ['en gorgio', 'engorgio'], ['engorgeo', 'engorgio'],
    ['reduceio', 'reducio'], ['imperius', 'imperio'], ['avada kedavera', 'avada-kedavra'],
  ];
  for (const [heard, spellId] of variants) {
    it(`"${heard}" is ${spellId}`, () => {
      const m = top(heard);
      expect(m?.spellId).toBe(spellId);
      expect(m.score).toBeGreaterThanOrEqual(0.62);
    });
  }

  it('near-miss English words reach the default threshold for the spell they sound like', () => {
    const words: [string, string][] = [
      ['knock', 'nox'], ['knocks', 'nox'], ['knox', 'nox'], ['luminous', 'lumos'], ['loom', 'lumos'], ['stupid', 'stupefy'],
      ['stupefied', 'stupefy'], ['protect', 'protego'], ['repair', 'reparo'], ['revealed', 'revelio'], ['ridiculous', 'riddikulus'],
      ['engorged', 'engorgio'], ['muffled', 'muffliato'], ['oblivion', 'obliviate'], ['locomotive', 'locomotor'], ['crucial', 'crucio'],
    ];
    for (const [word, spellId] of words) {
      const m = top(word);
      expect(m?.spellId, word).toBe(spellId);
      expect(m.score, word).toBeGreaterThanOrEqual(MIN_CONF);
    }
  });
});

describe('unrelated words', () => {
  const words = `hello hi hey okay ok yes no yeah nope what why how where when who the a an and or but so is it this that there here
    go stop start again wait look see nice cool wow oops sorry thanks please good great awesome magic wand spell camera mirror
    light lights dark fire water shield open close unlock box fox socks rocks clocks mocks lunch lemon music radio computer
    keyboard window table chair door floor coffee tea cup candle feather teacup plant dummy book page practice spellbook tune
    share settings voice microphone volume sound mute banana apple orange yellow green blue red purple black white seven eight
    nine ten twenty hundred mother father brother sister friend family dog cat bird fish horse cow pig mouse running walking
    talking reading writing singing dancing playing working sleeping because before after maybe really actually probably
    definitely quick brown jumps over lazy`.split(/\s+/).filter(Boolean);
  const phrases = [
    'come on', 'lets go', 'try again', 'one more time', 'hold on', 'watch this', 'thank you', 'good morning', 'good night',
    'hello there', 'what is this', 'is it working', 'i think so', 'not sure', 'let me see', 'okay here we go', 'can you hear me',
    'turn it off', 'turn it on', 'the quick brown fox jumps over the lazy dog', 'pass the salt please', 'where are my keys',
    'it is raining today', 'i love pizza', 'see you later', 'the candle is lit', 'open the box', 'make it float', 'it worked',
    'that was cool', 'again please', 'what spell was that', 'show me slowly', 'practice this spell', 'open spellbook', 'share this cast',
  ];

  it('stay below 0.5 for every spell', () => {
    for (const text of [...words, ...phrases]) {
      const m = top(text);
      expect(m?.score ?? 0, `${text} → ${m?.spellId}`).toBeLessThan(0.5);
    }
  });

  it('a near miss of a listed mishearing stays below the default threshold', () => {
    // "locks" is listed for Nox; "lock" and "look" are a step further away and must not cast it.
    for (const text of ['lock', 'look']) expect(scoreFor(text, 'nox'), text).toBeLessThan(MIN_CONF);
  });
});

describe('transcripts', () => {
  it('finds a spell among extra words, and says where', () => {
    expect(top('okay lumos now')).toMatchObject({ spellId: 'lumos', score: 1, from: 1, to: 2 });
    expect(top('I said expecto patronum please')).toMatchObject({ spellId: 'expecto-patronum', score: 1, from: 2, to: 4 });
    expect(top('accio the feather please')).toMatchObject({ spellId: 'accio', score: 1, from: 0 });
  });

  it('matches multi-word spells as a whole, and across split words', () => {
    expect(top('wingardium leviosa')).toMatchObject({ spellId: 'wingardium-leviosa', score: 1 });
    expect(top('finite incantatem')).toMatchObject({ spellId: 'finite-incantatem', score: 1 });
    expect(top('avada kedavra')).toMatchObject({ spellId: 'avada-kedavra', score: 1 });
    expect(top('a rest o momentum')).toMatchObject({ spellId: 'arresto-momentum', score: 1 });
    // Half of a two-word incantation that the pack does not list is not enough.
    expect(scoreFor('leviosa', 'wingardium-leviosa')).toBeLessThan(MIN_CONF);
    expect(scoreFor('patronum', 'expecto-patronum')).toBeLessThan(MIN_CONF);
  });

  it('prefers the later of two equal matches', () => {
    expect(top('lumos lumos')).toMatchObject({ spellId: 'lumos', from: 1 });
    const two = matchTranscript('lumos nox', SPELLS);
    expect(two.map((m) => m.spellId)).toEqual(['nox', 'lumos']);
  });

  it('only reads the last words of a long transcript', () => {
    const long = `${'blah '.repeat(40)}lumos`;
    expect(top(long)).toMatchObject({ spellId: 'lumos', score: 1 });
    expect(matchTranscript(`lumos ${'blah '.repeat(40)}`, SPELLS).find((m) => m.spellId === 'lumos')).toBeUndefined();
  });

  it('returns nothing for empty input or no spells', () => {
    expect(matchTranscript('', SPELLS)).toEqual([]);
    expect(matchTranscript('lumos', [])).toEqual([]);
  });
});
