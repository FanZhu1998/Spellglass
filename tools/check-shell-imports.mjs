// The shell talks to the kernel, never to modules (Section 5). dependency-cruiser compiles .svelte
// files and so cannot see `import type` lines in them; this check covers that gap.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uiDir = join(root, 'src', 'ui');
const bad = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(svelte|ts)$/.test(name)) {
      const text = readFileSync(p, 'utf8');
      const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? m[2];
        if (/(^|\/)modules\//.test(spec)) bad.push(`${relative(root, p)}: imports ${spec}`);
      }
    }
  }
}

walk(uiDir);
if (bad.length) {
  console.error('The shell must not import modules (talk through the kernel instead):\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log('shell imports: ok');
