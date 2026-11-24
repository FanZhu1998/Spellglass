// npm run test:perf: the time-budget tests (*.perf.test.ts, Section 13 "Performance", before each
// release), one file at a time on a quiet machine. vite.config.ts reads SPELLGLASS_PERF.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-vitest.mjs', import.meta.url));
const result = spawnSync(process.execPath, [runner, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, SPELLGLASS_PERF: '1' },
});
process.exit(result.status ?? 1);
