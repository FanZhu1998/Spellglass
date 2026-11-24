// Pack lint (Section 13): 'npm run lint:packs' checks every pack under public/packs and exits non-zero
// on any error. 'npm run packs:index' (--write-index) also rewrites public/packs/index.json with the
// current hashes and records new ids in tools/pack-lint/ids.lock.json; it never changes or removes a
// recorded id. The checks themselves are in lint.ts.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpellPack } from '../../src/contracts';
import { lintPacks, SEPARATION_LIMIT, type Finding, type IdsLock, type LintInput, type PackFile, type SeparationResult } from './lint';
import { schemaValidator } from './schemas';

const PACKS_DIR = fileURLToPath(new URL('../../public/packs/', import.meta.url));
const INDEX_FILE = join(PACKS_DIR, 'index.json');
const LOCK_FILE = fileURLToPath(new URL('./ids.lock.json', import.meta.url));
const SEPARATION_MODULE = new URL('../gesture-lab/separation.ts', import.meta.url);

function packFiles(): PackFile[] {
  const out: PackFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json') && p !== INDEX_FILE) out.push({ path: relative(PACKS_DIR, p).replace(/\\/g, '/'), bytes: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(PACKS_DIR);
  return out;
}

/** The gesture lab's separation check, imported only if it exists (it is a separate tool). */
async function loadSeparation(notes: string[]): Promise<{ fn: ((packs: SpellPack[]) => SeparationResult) | null; error?: string }> {
  if (!existsSync(fileURLToPath(SEPARATION_MODULE))) {
    notes.push('Template separation skipped: tools/gesture-lab/separation.ts is not there yet.');
    return { fn: null };
  }
  try {
    const mod = (await import(SEPARATION_MODULE.href)) as { templateSeparation?: unknown };
    if (typeof mod.templateSeparation !== 'function') return { fn: null, error: 'tools/gesture-lab/separation.ts does not export templateSeparation().' };
    return { fn: mod.templateSeparation as (packs: SpellPack[]) => SeparationResult };
  } catch (err) {
    return { fn: null, error: `tools/gesture-lab/separation.ts could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function readLock(): IdsLock | null {
  if (!existsSync(LOCK_FILE)) return null;
  return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as IdsLock;
}

function printFindings(title: string, list: Finding[]): void {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const f of list) console.log(`  ${f.where}: ${f.message}`);
}

async function main(argv: string[]): Promise<number> {
  const writeIndex = argv.includes('--write-index');
  const notes: string[] = [];
  const separation = await loadSeparation(notes);
  const input: LintInput = {
    files: packFiles(),
    indexText: existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : null,
    lock: readLock(),
    writeIndex,
    validate: schemaValidator(),
    separation: separation.fn,
  };
  const result = lintPacks(input);
  if (separation.error) result.findings.push({ level: 'error', where: 'gesture-lab', message: separation.error });

  const spells = result.packs.reduce((n, p) => n + (p.kind === 'spellpack' ? p.spells : 0), 0);
  console.log(`Pack lint: ${result.packs.length} packs, ${spells} spells.\n`);
  for (const p of result.packs) {
    const label = p.kind === 'spellpack' ? `${p.spells} spells` : p.kind ?? 'unreadable';
    console.log(`  ${(p.id ?? '?').padEnd(20)} ${(p.kind ?? '').padEnd(11)} ${(p.version ?? '').padEnd(8)} ${label.padEnd(10)} ${p.path}`);
  }

  if (result.separation?.closest) {
    const c = result.separation.closest;
    console.log(`\nTemplate separation: the closest pair is ${c.a} and ${c.b} at ${c.score.toFixed(3)} (limit ${SEPARATION_LIMIT.toFixed(2)}).`);
  }
  for (const n of notes) console.log(`\n${n}`);

  if (writeIndex) {
    if (result.newIndexText !== undefined) writeFileSync(INDEX_FILE, result.newIndexText);
    if (result.newLock) writeFileSync(LOCK_FILE, `${JSON.stringify(result.newLock, null, 2)}\n`);
    console.log(result.changes.length ? `\n${result.changes.join('\n')}` : '\nindex.json and ids.lock.json are up to date.');
  }

  const errors = result.findings.filter((f) => f.level === 'error');
  const warnings = result.findings.filter((f) => f.level === 'warning');
  printFindings('Warnings', warnings);
  printFindings('Errors', errors);
  const w = `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`;
  console.log(errors.length ? `\nPack lint failed: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}, ${w}.` : `\nPack lint passed with ${w}.`);
  return errors.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error('Pack lint could not run:', err);
    process.exit(2);
  },
);
