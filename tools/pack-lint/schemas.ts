// The JSON Schemas compiled in Node for pack lint. Node has no content security policy, so Ajv may
// compile here at run time, straight from src/contracts/schemas: the lint never depends on the
// generated validators (it runs before 'npm run gen' in 'npm run check'). The Ajv options come from
// the generator itself, so both see the schemas the same way.

import { createAjv, readSchemas } from '../gen-validators.mjs';
import { formatSchemaErrors, type SchemaError } from '../../src/kernel/packs/format';
import type { Validate } from './lint';

/** A validator by schema id: 'spellpack/1' uses spellpack-1.json. */
export function schemaValidator(): Validate {
  const ajv = createAjv();
  for (const { bytes } of readSchemas()) ajv.addSchema(JSON.parse(bytes.toString('utf8')));
  return (schema, data) => {
    const validate = ajv.getSchema(`${schema.replace('/', '-')}.json`);
    if (!validate) return { ok: false, reason: `There is no schema for ${schema}.` };
    if (validate(data)) return { ok: true };
    return { ok: false, reason: formatSchemaErrors((validate.errors ?? []) as SchemaError[], data, { root: 'The file' }) };
  };
}
