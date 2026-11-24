// npm run fixtures:sessions
//
// Writes the synthetic recorded sessions to tests/fixtures/sessions/ (see sessions.ts for how they
// are made). Deterministic: the same code writes the same files, so a diff after running it shows
// exactly what a change to the generator, the packs or the recognizer did to the fixtures.
//
// Before writing, every session is replayed through the lab's approximate segmenter (segment.ts) and
// the recognizer, raw and with two filter strengths, and must produce exactly its expected decisions.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadSeedPacks } from './packs';
import { CHECK_FILTERS, PLANS, SESSIONS_DIR, defaultSpells, generateSession, replayDecisions, serializeSession } from './sessions';

const OUT = SESSIONS_DIR;

function main(): void {
  const packs = loadSeedPacks();
  const { prepared } = defaultSpells(packs);
  mkdirSync(OUT, { recursive: true });
  let failed = false;
  for (const plan of PLANS) {
    const { session, casts } = generateSession(plan, packs);
    const want = session.expected.map((e) => e.spellId);
    for (const scale of CHECK_FILTERS) {
      const got = replayDecisions(session, prepared, scale).decisions;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failed = true;
        console.error(`${plan.id}: with filter ${scale ?? 'none'} the lab decided\n  ${JSON.stringify(got)}\nexpected\n  ${JSON.stringify(want)}`);
      }
    }
    writeFileSync(`${OUT}${plan.id}.json`, serializeSession(session));
    const seconds = (session.events[session.events.length - 1].t / 1000).toFixed(1);
    console.log(`${plan.id}.json  ${session.events.length} events, ${seconds} s`);
    for (const c of casts) {
      const what = (c.intended ?? 'scribble').padEnd(20);
      const how = c.intended ? `weakest score ${c.score.toFixed(3)}, lead ${c.lead.toFixed(3)}` : `best score at most ${c.score.toFixed(3)}`;
      console.log(`  ${what} ${how}${c.attempts > 1 ? ` (drawn ${c.attempts} times)` : ''}`);
    }
  }
  if (failed) {
    console.error('Some sessions did not replay as expected; the files were written for inspection.');
    process.exit(1);
  }
}

main();
