// Runs Vitest with a normalized working directory. On Windows a shell can report the drive letter
// in lower case (c:\...), and Vitest then loads two copies of itself (one per spelling of the path)
// and every suite fails with "Cannot read properties of undefined (reading 'config')". Starting it
// from the upper-case spelling avoids that; elsewhere this is a plain pass-through.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const cwd = process.cwd().replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
const cli = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(result.status ?? 1);
