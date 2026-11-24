// Schema checks for packs, index entries and gestures, using the validators that
// tools/gen-validators.mjs precompiles from src/contracts/schemas (the CSP forbids compiling them at
// run time). Readers are tolerant (Section 9.1 rule 3): the schemas allow unknown fields everywhere.

// The generated module is git-ignored and written by 'npm run gen', which 'npm run build' and
// 'npm test' run first. 'npm run typecheck' does not, so in a fresh checkout the import below has no
// declaration yet; the ts-ignore keeps tsc quiet then. The imports are typed through VALIDATORS
// below either way, and a missing validator gives a clear reason instead of a crash.
// @ts-ignore TS2307 before 'npm run gen' has run
import { validateGesture1, validateGesturePack1, validatePackIndex1, validatePackIndexEntry1, validateSpellPack0, validateSpellPack1, validateThemePack1 } from './generated/validators.js';
import { formatSchemaErrors, type SchemaError } from './format';

export type { SchemaError } from './format';

/** The schemas the pack service checks against, by schema id ('gesture/1' is the gesture definition). */
export type SchemaName = 'spellpack/0' | 'spellpack/1' | 'themepack/1' | 'gesturepack/1' | 'packindex/1' | 'packindex/1#entry' | 'gesture/1';

interface Validator {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}

const VALIDATORS: Record<SchemaName, Validator | undefined> = {
  'spellpack/0': validateSpellPack0 as Validator | undefined,
  'spellpack/1': validateSpellPack1 as Validator | undefined,
  'themepack/1': validateThemePack1 as Validator | undefined,
  'gesturepack/1': validateGesturePack1 as Validator | undefined,
  'packindex/1': validatePackIndex1 as Validator | undefined,
  'packindex/1#entry': validatePackIndexEntry1 as Validator | undefined,
  'gesture/1': validateGesture1 as Validator | undefined,
};

export type SchemaCheck = { ok: true } | { ok: false; reason: string; errors: SchemaError[] };

/** Check data against a schema. On failure, reason is one plain sentence naming the problems. */
export function checkSchema(name: SchemaName, data: unknown, root = 'The file'): SchemaCheck {
  const validate = VALIDATORS[name];
  if (typeof validate !== 'function') {
    return { ok: false, reason: "This build has no pack checks (run 'npm run gen').", errors: [] };
  }
  if (validate(data)) return { ok: true };
  // Ajv keeps errors on the function; copy them before the next call replaces them.
  const errors = [...(validate.errors ?? [])];
  return { ok: false, reason: formatSchemaErrors(errors, data, { root }), errors };
}

/** True when every validator is present (the generated module exists and is current enough). */
export function validatorsPresent(): boolean {
  return Object.values(VALIDATORS).every((v) => typeof v === 'function');
}
