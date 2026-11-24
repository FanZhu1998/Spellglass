// Turns JSON Schema validation errors (Ajv error objects) into one plain sentence for the Workshop
// screen and for pack lint (Section 7.9: "gives the reason"). Pure: no generated code is imported here,
// so tools can use it before 'npm run gen' has run.

/** The shape of an Ajv error object (the generated validators.d.ts declares the same). */
export interface SchemaError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  propertyName?: string;
  message?: string;
}

/** What a pattern means, by the name of the schema definition or property that holds it. */
const PATTERN_MEANINGS: Record<string, string> = {
  id: 'lower-case letters and digits in words joined by hyphens, like core-charms',
  version: 'a version like 1.0.0',
  range: 'a version range like >=1.0 <2.0',
  capability: 'a capability like fx.light@1',
  token: 'a short lower-case name, like chime-rise',
  tag: 'a dotted lower-case tag, like prop.lockable',
  color: 'a color like #F2B84B',
  fontName: 'a font name of letters, digits, spaces and hyphens',
  use: 'an effect name like light.orb',
  path: 'a relative path to a .json file inside the pack folder',
  sha256: 'a SHA-256 digest of 64 hexadecimal digits',
  spellRefs: 'a spell id, or * for every active spell',
};

const GESTURE_KEYS = ['flick', 'path', 'paths'];

export interface FormatOptions {
  /** How to name the whole document when the problem is at its root: 'The pack', 'The gesture'. */
  root?: string;
  /** At most this many problems are named; the rest are counted. */
  max?: number;
}

/** One sentence naming the first few problems, e.g.
 *  'spells[3] (alohomora).gesture must have exactly one of "flick", "path" or "paths".' */
export function formatSchemaErrors(errors: readonly SchemaError[], data: unknown, options: FormatOptions = {}): string {
  const root = options.root ?? 'The file';
  const max = options.max ?? 3;
  const relevant = relevantErrors(errors);
  if (relevant.length === 0) return `${root} does not match its format.`;
  const lines: string[] = [];
  for (const e of relevant) {
    const line = describe(e, data, root);
    if (!lines.includes(line)) lines.push(line);
  }
  const shown = lines.slice(0, max).join('; ');
  const more = lines.length - max;
  return more > 0 ? `${shown}; and ${more} more ${more === 1 ? 'problem' : 'problems'}.` : `${shown}.`;
}

/** Drop the noise Ajv reports alongside a real problem: the 'if' wrapper error, the branch errors of a
 *  failed oneOf or anyOf (the oneOf itself is described instead), and the generic propertyNames error
 *  that follows the specific one. */
function relevantErrors(errors: readonly SchemaError[]): SchemaError[] {
  const combinators = errors.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf');
  return errors.filter((e) => {
    if (e.keyword === 'if') return false;
    if (e.keyword === 'propertyNames' && errors.some((o) => o !== e && o.propertyName !== undefined && o.instancePath === e.instancePath)) return false;
    return !combinators.some(
      (c) => c !== e && e.schemaPath.startsWith(`${c.schemaPath}/`) && (e.instancePath === c.instancePath || e.instancePath.startsWith(`${c.instancePath}/`)),
    );
  });
}

function describe(e: SchemaError, data: unknown, root: string): string {
  const where = locate(e.instancePath, data) || root;
  const p = e.params;
  switch (e.keyword) {
    case 'required':
      return `${where} is missing "${String(p.missingProperty)}"`;
    case 'type':
      return `${where} must be ${typeName(String(p.type))}`;
    case 'const':
      return `${where} must be ${JSON.stringify(p.allowedValue)}`;
    case 'enum':
      return `${where} must be one of ${(p.allowedValues as unknown[] | undefined)?.map((v) => JSON.stringify(v)).join(', ') ?? 'the allowed values'}`;
    case 'pattern': {
      const meaning = patternMeaning(e.schemaPath);
      if (e.propertyName !== undefined) return `${where} has the key "${e.propertyName}", which must be ${meaning ?? 'in the expected form'}`;
      return `${where} must be ${meaning ?? 'in the expected form'}`;
    }
    case 'minLength':
      return Number(p.limit) <= 1 ? `${where} must not be empty` : `${where} must have at least ${String(p.limit)} characters`;
    case 'maxLength':
      return `${where} must have at most ${String(p.limit)} characters`;
    case 'minItems':
      return `${where} must have at least ${String(p.limit)} ${Number(p.limit) === 1 ? 'item' : 'items'}`;
    case 'maxItems':
      return `${where} must have at most ${String(p.limit)} items`;
    case 'additionalItems':
      // The point [x, y] is the only tuple in the schemas. Ajv compiles it into its own function, so
      // the schema path says only '#/additionalItems'; the limit of 2 is what identifies it.
      return Number(p.limit) === 2 ? `${where} must be a point of exactly two numbers [x, y]` : `${where} must have at most ${String(p.limit)} items`;
    case 'minProperties':
      return `${where} must have at least ${String(p.limit)} entries`;
    case 'maxProperties':
      return `${where} must have at most ${String(p.limit)} entries`;
    case 'minimum':
      return `${where} must be at least ${String(p.limit)}`;
    case 'maximum':
      return `${where} must be at most ${String(p.limit)}`;
    case 'exclusiveMinimum':
      return `${where} must be more than ${String(p.limit)}`;
    case 'exclusiveMaximum':
      return `${where} must be less than ${String(p.limit)}`;
    case 'oneOf':
    case 'anyOf':
      if (looksLikeGesture(valueAt(e.instancePath, data))) return `${where} must have exactly one of "flick", "path" or "paths"`;
      return `${where} does not match any allowed form`;
    case 'propertyNames':
      return `${where} has a key that is not allowed`;
    default:
      return `${where} ${e.message ?? 'is not valid'}`;
  }
}

function typeName(t: string): string {
  switch (t) {
    case 'integer': return 'a whole number';
    case 'number': return 'a number';
    case 'string': return 'text';
    case 'boolean': return 'true or false';
    case 'array': return 'a list';
    case 'object': return 'an object';
    case 'null': return 'null';
    default: return t.split(',').map(typeName).join(' or ');
  }
}

/** The definition or property name that holds a failing pattern: '.../definitions/color/pattern' or
 *  '.../properties/path/pattern'. Ajv reports schema paths relative to whichever schema it compiled
 *  the check into, so the file prefix varies; the last named segment does not. */
function patternMeaning(schemaPath: string): string | undefined {
  const m = /\/(?:definitions|properties)\/([A-Za-z0-9_]+)\/(?:items\/)?pattern$/.exec(schemaPath);
  return m ? PATTERN_MEANINGS[m[1]] : undefined;
}

/** The gesture's oneOf (common-1.json) is the only oneOf in the schemas: it fails exactly when the
 *  object has none, or more than one, of flick, path and paths. */
function looksLikeGesture(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const present = GESTURE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(value, k)).length;
  return present !== 1;
}

function segments(instancePath: string): string[] {
  if (!instancePath) return [];
  return instancePath
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function valueAt(instancePath: string, data: unknown): unknown {
  let cur: unknown = data;
  for (const seg of segments(instancePath)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** '/spells/3/gesture/path/5' → 'spells[3] (alohomora).gesture.path[5]'. Spells are named by id. */
function locate(instancePath: string, data: unknown): string {
  let out = '';
  let cur: unknown = data;
  let parentKey = '';
  for (const seg of segments(instancePath)) {
    const isIndex = Array.isArray(cur) && /^\d+$/.test(seg);
    const next = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
    if (isIndex) {
      out += `[${seg}]`;
      if (parentKey === 'spells' && next && typeof next === 'object' && typeof (next as { id?: unknown }).id === 'string') {
        out += ` (${(next as { id: string }).id})`;
      }
    } else {
      out += out ? `.${seg}` : seg;
    }
    parentKey = seg;
    cur = next;
  }
  return out;
}
