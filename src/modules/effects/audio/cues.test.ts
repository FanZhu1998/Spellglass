import { describe, expect, it } from 'vitest';
import { AUDIO_CUES } from '../../../contracts';
import type { AudioCue, ThemePack } from '../../../contracts';
import { buildRecipe, captionFor, DEFAULT_CAPTIONS, envelopeLength, MAX_HZ, readableCue, recipeLength, RECIPES, resolveCue, type Recipe } from './cues';
import { SEED_THEME } from './testing';

const INTERFACE: AudioCue[] = ['fizzle', 'arm-tick', 'page-turn', 'unlock-tier', 'shutter'];

/** Rough loudest moment: sum of the gains of voices at their peak at once (an upper bound). */
function peakSum(r: Recipe): number {
  let peak = 0;
  for (const v of r.voices) {
    const t = v.at + v.env.attack;
    let sum = 0;
    for (const w of r.voices) if (w.at <= t && t < w.at + w.env.attack + (w.env.hold ?? 0) + Math.min(w.env.decay, 0.05) + 1e-4) sum += w.gain;
    peak = Math.max(peak, sum);
  }
  return peak;
}

describe('cue recipes', () => {
  it('has a recipe for every cue in AUDIO_CUES, and nothing else', () => {
    expect(Object.keys(RECIPES).sort()).toEqual([...AUDIO_CUES].sort());
  });

  for (const cue of AUDIO_CUES) {
    it(`${cue}: voices in range`, () => {
      const r = buildRecipe(cue, 1);
      expect(r.voices.length).toBeGreaterThan(0);
      expect(r.reverb).toBeGreaterThanOrEqual(0);
      expect(r.reverb).toBeLessThanOrEqual(1);
      for (const v of r.voices) {
        expect(v.at).toBeGreaterThanOrEqual(0);
        expect(v.dur).toBeGreaterThan(0);
        expect(v.dur).toBeGreaterThanOrEqual(envelopeLength(v.env) - 1e-9);
        expect(v.gain).toBeGreaterThan(0);
        expect(v.gain).toBeLessThanOrEqual(1);
        for (const t of [v.env.attack, v.env.decay, v.env.hold ?? 0, v.env.release ?? 0]) expect(t).toBeGreaterThanOrEqual(0);
        if (v.kind === 'tone') {
          for (const f of [v.freq, v.to ?? v.freq]) {
            expect(f).toBeGreaterThanOrEqual(20);
            expect(f).toBeLessThanOrEqual(MAX_HZ);
          }
        }
        if (v.filter) {
          for (const f of [v.filter.freq, v.filter.to ?? v.filter.freq]) {
            expect(f).toBeGreaterThanOrEqual(20);
            expect(f).toBeLessThanOrEqual(18000);
          }
        }
        if (v.pan !== undefined) expect(Math.abs(v.pan)).toBeLessThanOrEqual(1);
        if (v.tremolo) expect(v.tremolo.depth).toBeLessThanOrEqual(1);
      }
      // Pleasant at moderate volume: no cue piles up more than this before the master level.
      expect(peakSum(r)).toBeLessThanOrEqual(1.6);
      expect(recipeLength(r)).toBeLessThanOrEqual(3);
    });
  }

  it('keeps interface cues short and soft', () => {
    for (const cue of INTERFACE) {
      const r = buildRecipe(cue, 1);
      expect(peakSum(r), cue).toBeLessThanOrEqual(0.6);
      if (cue !== 'unlock-tier') expect(recipeLength(r), cue).toBeLessThanOrEqual(0.6);
    }
    expect(peakSum(buildRecipe('arm-tick', 1))).toBeLessThanOrEqual(0.2);
    expect(recipeLength(buildRecipe('arm-tick', 1))).toBeLessThanOrEqual(0.1);
  });

  it('is repeatable for a seed, and scatters grains differently for another', () => {
    expect(buildRecipe('crackle', 7)).toEqual(buildRecipe('crackle', 7));
    expect(buildRecipe('crackle', 7)).not.toEqual(buildRecipe('crackle', 8));
    // Recipes without grains do not depend on the seed at all.
    expect(buildRecipe('chime', 1)).toEqual(buildRecipe('chime', 2));
  });
});

describe('cue names', () => {
  it('plays unknown names as chime', () => {
    expect(resolveCue('chime-rise')).toBe('chime-rise');
    expect(resolveCue('thunder')).toBe('chime');
    expect(resolveCue(undefined)).toBe('chime');
    expect(resolveCue(42)).toBe('chime');
  });
});

describe('captions', () => {
  it('has a built-in caption for every cue', () => {
    for (const cue of AUDIO_CUES) expect(DEFAULT_CAPTIONS[cue], cue).toMatch(/^[A-Z]/);
  });

  it('the seed theme captions every cue (Section 10.6)', () => {
    for (const cue of AUDIO_CUES) expect(typeof SEED_THEME.captions?.[cue], cue).toBe('string');
  });

  it("uses the theme's caption, cleaned, and falls back to the built-in one", () => {
    const theme = { ...SEED_THEME, captions: { latch: '  The   latch\nclicks ', fire: '', chime: 'x'.repeat(200) } } as ThemePack;
    expect(captionFor('latch', theme)).toBe('The latch clicks');
    expect(captionFor('fire', theme)).toBe(DEFAULT_CAPTIONS.fire);
    expect(captionFor('water', theme)).toBe(DEFAULT_CAPTIONS.water);
    expect(captionFor('chime', theme)).toHaveLength(80);
    expect(captionFor('honk', null)).toBe('Silly honk');
    expect(captionFor('honk', SEED_THEME)).toBe(SEED_THEME.captions!.honk);
  });

  it('makes a readable name for anything uncaptioned', () => {
    expect(readableCue('chime-rise')).toBe('Chime rise');
    expect(readableCue('UNLOCK_tier')).toBe('Unlock tier');
    expect(readableCue('--')).toBe('Sound');
  });
});
