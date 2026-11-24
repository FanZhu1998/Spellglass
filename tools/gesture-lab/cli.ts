// npm run lab [-- --casts 400 --seed 1 --start stored|anywhere]
//
// Prints the closest template pairs (pack lint's separation check, Section 7.5) and the simulated
// check of the seed set, in the layout of the blueprint's table. See synth.ts for the noise model.

import { loadSeedPacks } from './packs';
import { SEPARATION_LIMIT, templateSeparation } from './separation';
import { simulate, weakest, type Counts, type SimulationRow } from './simulate';
import type { StartMode } from './synth';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pct = (n: number, c: Counts) => (c.total ? `${((100 * n) / c.total).toFixed(2)}%` : '-');

function table(rows: SimulationRow[]): string[] {
  const out = ['| Set | Rule | Correct | Wrong | Fizzled |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const set = r.noise === 1 ? r.set : `${r.set}, noise × ${r.noise}`;
    const rule = r.rule === 'best' ? 'Best match wins' : 'Thresholds';
    out.push(`| ${set} | ${rule} | ${pct(r.counts.correct, r.counts)} | ${pct(r.counts.wrong, r.counts)} | ${r.counts.fizzled ? pct(r.counts.fizzled, r.counts) : 'none'} |`);
  }
  return out;
}

function main(): void {
  const casts = Number(arg('casts', '400'));
  const seed = Number(arg('seed', '1'));
  const start = arg('start', 'stored') as StartMode;
  const packs = loadSeedPacks();

  const sep = templateSeparation(packs);
  console.log(`Closest template pairs (pack lint fails above ${SEPARATION_LIMIT.toFixed(2)}):`);
  for (const p of sep.pairs.slice(0, 10)) console.log(`  ${p.score.toFixed(3)}  ${p.a} / ${p.b}${p.score > SEPARATION_LIMIT ? '  TOO CLOSE' : ''}`);

  console.log(`\nSimulated check: ${casts} casts per spell, seed ${seed}, any_start casts begin ${start === 'anywhere' ? 'anywhere on the loop' : 'at a stored start point'}.\n`);
  const result = simulate(packs, { casts, seed, start });
  // The blueprint's order: by noise, then set, best match first.
  const rows = [...result.rows].sort((a, b) => a.noise - b.noise);
  for (const line of table(rows)) console.log(line);
  const heavy = Math.max(...rows.map((r) => r.noise));
  console.log(`\nWeakest under noise × ${heavy} (thresholds): ${weakest(result, heavy).map((w) => `${w.spellId} ${(100 * w.correct).toFixed(1)}%`).join(', ')}`);
  console.log(`Mean recognition time without details: ${result.msPerStroke.toFixed(3)} ms per stroke`);

  if (start === 'stored') {
    // Section 7.5 promises "people start a circle anywhere"; show what four start points deliver.
    const anyStart = packs.flatMap((p) => p.spells).filter((s) => !('flick' in s.gesture) && s.gesture.any_start).map((s) => s.id);
    if (anyStart.length) {
      const anywhere = simulate(packs, { casts, seed, start: 'anywhere', only: anyStart, noise: [1] });
      const row = anywhere.rows.find((r) => r.set === '24' && r.rule === 'thresholds' && r.counts.total) ?? anywhere.rows.find((r) => r.rule === 'thresholds' && r.counts.total);
      if (row) {
        console.log(`\nStarted anywhere on the loop (${anyStart.join(', ')}; set ${row.set}, thresholds): correct ${pct(row.counts.correct, row.counts)}, wrong ${pct(row.counts.wrong, row.counts)}, fizzled ${pct(row.counts.fizzled, row.counts)}`);
        const conf = Object.entries(anywhere.confusions).flatMap(([from, to]) => Object.entries(to).map(([spell, n]) => `${from} as ${spell} ${n}`));
        if (conf.length) console.log(`  read instead as (best match wins): ${conf.join(', ')}`);
      }
    }
  }
}

main();
