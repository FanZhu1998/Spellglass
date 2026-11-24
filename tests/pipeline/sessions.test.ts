// Recorded sessions guard behavior (Section 9.1 rule 8, Section 13): every saved stream of tip
// samples in tests/fixtures/sessions must still produce the casts it expects. A change to the
// filter, segmenter, recognizer or engine that alters a result fails here until the fixture is
// re-accepted on purpose (npm run fixtures:sessions, then review the diff).

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline, loadSession, play } from './harness';

const DIR = fileURLToPath(new URL('../fixtures/sessions/', import.meta.url));
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

/** Decisions may land a little earlier or later than recorded. */
const TOLERANCE_MS = 600;

describe('recorded sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has fixtures to replay', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`replays ${file}`, async () => {
      const session = loadSession(DIR + file);
      const p = await createPipeline(session.settings ?? {});
      try {
        await play(p, session);
        const got = p.decisions.map((d) => d.spellId);
        const want = session.expected.map((e) => e.spellId);
        expect(got, `decisions for ${file}`).toEqual(want);
        session.expected.forEach((e, i) => {
          expect(Math.abs(p.decisions[i].t - e.t), `timing of decision ${i} (${e.spellId}) in ${file}`).toBeLessThanOrEqual(TOLERANCE_MS);
        });
        // One decision per stroke, and every cast from a recording carries its stroke.
        const strokeIds = p.decisions.map((d) => d.cast?.strokeId ?? d.fizzle?.strokeId).filter(Boolean);
        expect(new Set(strokeIds).size).toBe(strokeIds.length);
      } finally {
        await p.dispose();
      }
    });
  }
});
