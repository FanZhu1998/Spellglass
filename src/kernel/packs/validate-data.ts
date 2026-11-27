// Schema checks for recorded sessions (session-1.json) and saved-data exports (userdata-1.json).
// They live apart from validate.ts so the app bundle carries these validators only when a module
// actually imports this file (diagnostics for sessions, storage for data imports).

// See validate.ts for why the generated import carries a ts-ignore.
// @ts-ignore TS2307 before 'npm run gen' has run
import { validateSession1, validateUserData1 } from './generated/validators.js';
import { formatSchemaErrors, type SchemaError } from './format';
import type { SchemaCheck } from './validate';

interface Validator {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}

function run(validate: Validator | undefined, data: unknown, root: string): SchemaCheck {
  if (typeof validate !== 'function') return { ok: false, reason: "This build has no data checks (run 'npm run gen').", errors: [] };
  if (validate(data)) return { ok: true };
  const errors = [...(validate.errors ?? [])];
  return { ok: false, reason: formatSchemaErrors(errors, data, { root }), errors };
}

/** Check a RecordedSession (contracts/session.ts) against session-1.json. */
export function checkSession(data: unknown): SchemaCheck {
  return run(validateSession1 as Validator | undefined, data, 'The session');
}

/** Check a UserDataExport envelope (contracts/storage.ts) against userdata-1.json. Records inside are
 *  not checked: each carries its own dataVersion and is migrated by the storage module. */
export function checkUserData(data: unknown): SchemaCheck {
  return run(validateUserData1 as Validator | undefined, data, 'The data file');
}
