// The committed recorded-session fixtures (tests/fixtures/sessions) are what the integrator's
// pipeline test replays through the real segmenter, recognizer and engine. These checks guard the
// fixtures themselves: their shape follows contracts/session.ts, they follow the hold-still rhythm,
// and the recognizer still classifies every stroke in them as expected (Section 9.1 rule 8).
// After a deliberate change, regenerate with `npm run fixtures:sessions` and review the diff.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RecordedSession } from '../../src/contracts';
import { SESSION_SCHEMA } from '../../src/contracts';
import { loadSeedPacks } from './packs';
import { CHECK_FILTERS, PLANS, SESSIONS_DIR, defaultSpells, generateSession, replayDecisions, serializeSession } from './sessions';

const packs = loadSeedPacks();
const { prepared } = defaultSpells(packs);
const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f: string) => JSON.parse(readFileSync(SESSIONS_DIR + f, 'utf8')) as RecordedSession;

describe('recorded-session fixtures', () => {
  it('has one file per plan', () => {
    expect(files).toEqual(PLANS.map((p) => `${p.id}.json`).sort());
  });

  it.each(files)('%s follows the session format and the hold-still rhythm', (file) => {
    const s = load(file);
    expect(s.schema).toBe(SESSION_SCHEMA);
    expect(s.tracker).toBe('tracker.bright-tip');
    expect(s.aspect).toBeCloseTo(16 / 9, 12);
    expect(s.settings).toEqual({ 'spells.unlockAll': true });
    expect(s.enabledSpells).toHaveLength(24);
    let last = -Infinity;
    s.events.forEach((e, i) => {
      expect(e.t).toBeGreaterThanOrEqual(last);
      last = e.t;
      if (e.type === 'tip.found') {
        // A state change just before the sample of the same frame, with the same t (contracts/events.ts).
        const next = s.events[i + 1];
        expect(next.type).toBe('tip.sample');
        expect(next.t).toBe(e.t);
      }
      if (e.type === 'tip.lost') expect(e.t).toBeGreaterThan(e.lastSeen!);
      if (e.type === 'tip.sample') {
        expect(e.conf).toBeGreaterThan(0);
        expect(e.conf).toBeLessThanOrEqual(1);
        expect(e.x).toBeGreaterThan(0);
        expect(e.x).toBeLessThan(1);
      }
    });
    // Samples at about 30 fps: no gap inside a run of samples is long enough to mean a lost tip.
    const samples = s.events.filter((e) => e.type !== 'voice.incantation');
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].type === 'tip.sample' && samples[i - 1].type === 'tip.sample') expect(samples[i].t - samples[i - 1].t).toBeLessThan(80);
    }
    // No spell twice in a session, so learning never changes the outcome; Nox follows Lumos.
    const casts = s.expected.map((e) => e.spellId).filter((x): x is string => x !== null);
    expect(new Set(casts).size).toBe(casts.length);
    if (casts.includes('nox')) expect(casts.indexOf('lumos')).toBeLessThan(casts.indexOf('nox'));
    expect(s.expected.some((e) => e.spellId === null)).toBe(true);
  });

  it.each(files)('%s replays to its expected decisions, raw and filtered', (file) => {
    const s = load(file);
    const want = s.expected.map((e) => e.spellId);
    for (const scale of CHECK_FILTERS) {
      const { strokes, decisions } = replayDecisions(s, prepared, scale);
      expect(decisions, `filter ${scale ?? 'none'}`).toEqual(want);
      // Decision times: about when each trace ends.
      strokes.forEach((st, i) => expect(Math.abs(st.t1 - s.expected[i].t)).toBeLessThan(400));
    }
  });

  it('covers each of the 24 spells twice', () => {
    const counts = new Map<string, number>();
    for (const f of files) for (const e of load(f).expected) if (e.spellId) counts.set(e.spellId, (counts.get(e.spellId) ?? 0) + 1);
    expect(counts.size).toBe(24);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
  });

  it('is generated deterministically', () => {
    const plan = PLANS[0];
    expect(serializeSession(generateSession(plan, packs).session)).toBe(serializeSession(generateSession(plan, packs).session));
  });
});
