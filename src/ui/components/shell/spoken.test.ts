import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../app-state.svelte';
import { spokenBanner, spokenCelebration } from './spoken';

const entry = (e: Partial<LogEntry>): LogEntry => ({ id: 'x', kind: 'cast', t: 0, name: 'Lumos', grade: 'Exceeds Expectations', quality: 0.8, ...e });

describe('what the glass says (Section 10.6)', () => {
  it('says a cast as the banner shows it: the spell, its grade, and how it was cast', () => {
    expect(spokenBanner(entry({}))).toBe('Lumos, Exceeds Expectations.');
    expect(spokenBanner(entry({ via: 'voice' }))).toBe('Lumos, Exceeds Expectations, by voice.');
    expect(spokenBanner(entry({ via: 'both', replay: true }))).toBe('Lumos, Exceeds Expectations, replay.');
  });

  it('says a fizzle with its grade and hint, and a rule’s fizzle with its reason alone', () => {
    expect(spokenBanner(entry({ kind: 'fizzle', grade: 'Troll', hint: 'Close to Alohomora. The downstroke stopped short.' }))).toBe(
      'Troll. Close to Alohomora. The downstroke stopped short.',
    );
    expect(spokenBanner(entry({ kind: 'fizzle', grade: '', hint: 'Nox needs another spell active first.' }))).toBe('Nox needs another spell active first.');
  });

  it('says a new tier with the ribbon’s title', () => {
    expect(spokenCelebration({ id: 1, tier: 2, spellIds: ['alohomora'], text: 'New spells to learn: Alohomora.' })).toBe('A new page opens. New spells to learn: Alohomora.');
  });
});
