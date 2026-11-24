// Pack lint (Section 13 "Pack lint": schema valid, ids unique, assets present, templates far enough
// apart). Pure: the CLI reads the files and prints the result; tests call lintPacks() directly.
//
// Checks, for every pack under public/packs:
//   - the file is UTF-8 JSON in the current schema of its kind, valid against the JSON Schema, within
//     the size limit, and (spell packs) its engine range accepts this engine;
//   - pack ids are unique, and spell ids are unique across all packs;
//   - ids are permanent (Section 9.1 rule 1): tools/pack-lint/ids.lock.json records every spell id with
//     its incantation and pack; a locked id may not disappear or change its incantation;
//   - index.json lists every pack with the right id, kind, version and SHA-256 ('--write-index' rewrites it);
//   - every effect step names a primitive (EFFECT_CAPABILITY) whose capability the pack needs, every
//     audio cue is one the audio module plays, every particle preset exists, anchors are known;
//     values beyond EFFECT_LIMITS (after the largest variant effect_scale) are warned about;
//   - themes reach 4.5:1 for the text pairs of Section 10.2, accent pairs included;
//   - no two non-line templates score above 0.80 against each other (Section 7.5), when the
//     gesture lab's templateSeparation() is available.

import { createHash } from 'node:crypto';
import type { EffectStep, PackIndexEntry, PackKind, Spell, SpellPack, ThemePack } from '../../src/contracts';
import {
  AUDIO_CUES, CURRENT_SPELLPACK_SCHEMA, CURRENT_THEMEPACK_SCHEMA, EFFECT_CAPABILITY, EFFECT_LIMITS, ENGINE_VERSION, FALLBACK_EFFECTS,
  GESTUREPACK_SCHEMAS, PACK_SIZE_LIMIT_BYTES, PARTICLE_PRESETS, PROP_TAGS,
} from '../../src/contracts';
import { parseCapability } from '../../src/kernel/capabilities';
import { satisfies } from '../../src/kernel/semver';
import { contrastRatio, isSaturatedRed } from './contrast';

export interface PackFile {
  /** Relative to public/packs, with forward slashes: 'core-charms/pack.json'. */
  path: string;
  bytes: Uint8Array;
}

export interface IdsLock {
  note?: string;
  packs: Record<string, { kind: PackKind; retired?: boolean }>;
  spells: Record<string, { incantation: string; pack: string; retired?: boolean }>;
}

export type Validate = (schema: string, data: unknown) => { ok: true } | { ok: false; reason: string };

export interface SeparationPair {
  a: string;
  b: string;
  score: number;
}

export interface SeparationResult {
  pairs: SeparationPair[];
  closest: SeparationPair | null;
}

export interface LintInput {
  files: PackFile[];
  /** public/packs/index.json, or null when it is missing. */
  indexText: string | null;
  lock: IdsLock | null;
  /** Rewrite index.json and record new ids in the lock instead of failing on them. */
  writeIndex: boolean;
  validate: Validate;
  /** tools/gesture-lab templateSeparation, or null when it is not available (the check is skipped). */
  separation: ((packs: SpellPack[]) => SeparationResult) | null;
}

export interface Finding {
  level: 'error' | 'warning';
  /** The pack, spell or file it is about: 'core-charms', 'core-charms/lumos', 'index.json'. */
  where: string;
  message: string;
}

export interface LintedPack {
  path: string;
  sha256: string;
  id?: string;
  kind?: PackKind;
  version?: string;
  title?: string;
  spells: number;
  /** Parsed, current schema, schema-valid. */
  valid: boolean;
  json?: unknown;
}

export interface LintResult {
  findings: Finding[];
  packs: LintedPack[];
  /** With writeIndex: the new index.json text, when it differs from the old one. */
  newIndexText?: string;
  /** With writeIndex: the new lock, when ids were added. */
  newLock?: IdsLock;
  /** What writeIndex changed, for the report. */
  changes: string[];
  separation: { closest: SeparationPair | null; overLimit: SeparationPair[]; top: SeparationPair[] } | null;
}

/** Section 7.5: two templates scoring above this against each other are too close. */
export const SEPARATION_LIMIT = 0.8;
/** Section 10.2: text contrast. */
export const MIN_CONTRAST = 4.5;
export const LOCK_NOTE =
  'Spell and pack ids are permanent (blueprint Section 9.1 rule 1). Pack lint fails when a spell id recorded here disappears or changes its incantation, and when a new id is not recorded yet ("npm run packs:index" records new ids; it never changes or removes one). To retire an id for good, set "retired": true; it may then never be used again.';

const ANCHORS = new Set(['tip', 'aim', 'target', 'center', 'caster']);
const TAGS = new Set<string>(Object.values(PROP_TAGS));
const CUES = new Set<string>(AUDIO_CUES);
const PRESETS = new Set<string>(PARTICLE_PRESETS);
const FALLBACKS = new Set<string>(FALLBACK_EFFECTS);
/** Primitives that happen at once and never last (screen.shake is warned about with the limits). A
 *  held step makes its spell 'until-ended' (EffectStep.hold), so holding one of these would keep the
 *  spell active in the engine with nothing left on screen. */
const NEVER_HELD = new Set<string>([
  'light.flash', 'light.snuff', 'bolt.cast', 'particles.burst', 'effects.end', 'log.fade',
  'prop.unlock', 'prop.mend', 'prop.douse', 'prop.reel',
]);
const CURRENT: Record<PackKind, string> = {
  spellpack: CURRENT_SPELLPACK_SCHEMA,
  themepack: CURRENT_THEMEPACK_SCHEMA,
  gesturepack: GESTUREPACK_SCHEMAS[GESTUREPACK_SCHEMAS.length - 1],
};
const THEME_TOKENS = ['night', 'slate', 'vellum', 'ink', 'candle', 'oxblood', 'verdigris', 'ash'] as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function lintPacks(input: LintInput): LintResult {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], where: string, message: string) => findings.push({ level, where, message });
  const changes: string[] = [];

  const packs = [...input.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => readPack(f, input.validate, add));
  const spellPacks = packs.filter((p) => p.valid && p.kind === 'spellpack').map((p) => p.json as SpellPack);
  const themes = packs.filter((p) => p.valid && p.kind === 'themepack').map((p) => p.json as ThemePack);

  checkUniqueIds(packs, spellPacks, add);
  const index = checkIndex(input, packs, add, changes);
  const lock = checkLock(input, packs, spellPacks, add, changes);

  const allSpellIds = new Set(spellPacks.flatMap((p) => p.spells.map((s) => s.id)));
  for (const pack of spellPacks) for (const spell of pack.spells) checkSpell(pack, spell, allSpellIds, add);
  for (const theme of themes) checkTheme(theme, add);

  let separation: LintResult['separation'] = null;
  if (input.separation && spellPacks.length) {
    const result = input.separation(spellPacks);
    const overLimit = result.pairs.filter((p) => p.score > SEPARATION_LIMIT);
    const owner = new Map(spellPacks.flatMap((p) => p.spells.map((s) => [s.id, p.id] as const)));
    for (const pair of overLimit) {
      add('error', `${owner.get(pair.a) ?? '?'}/${pair.a}`, `and ${pair.b} (${owner.get(pair.b) ?? '?'}) score ${pair.score.toFixed(3)} against each other; templates must stay at or under ${SEPARATION_LIMIT.toFixed(2)} (Section 7.5). Redraw one of them.`);
    }
    separation = { closest: result.closest, overLimit, top: result.pairs.slice(0, 5) };
  }

  return { findings, packs, ...(index ? { newIndexText: index } : {}), ...(lock ? { newLock: lock } : {}), changes, separation };
}

// ------------------------------------------------------------------ files

function readPack(file: PackFile, validate: Validate, add: (l: Finding['level'], w: string, m: string) => void): LintedPack {
  const out: LintedPack = { path: file.path, sha256: sha256Hex(file.bytes), spells: 0, valid: false };
  if (file.bytes.byteLength > PACK_SIZE_LIMIT_BYTES) {
    add('error', file.path, `is ${Math.ceil(file.bytes.byteLength / 1024)} KB; packs may be at most ${PACK_SIZE_LIMIT_BYTES / 1024} KB.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  } catch (err) {
    add('error', file.path, err instanceof TypeError ? 'is not UTF-8 text.' : `is not valid JSON: ${(err as Error).message}`);
    return out;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    add('error', file.path, 'is not a pack (a pack is a JSON object).');
    return out;
  }
  const j = json as Record<string, unknown>;
  const schema = typeof j.schema === 'string' ? j.schema : '';
  const kind = (/^(spellpack|themepack|gesturepack)\//.exec(schema)?.[1] ?? null) as PackKind | null;
  out.json = json;
  if (typeof j.id === 'string') out.id = j.id;
  if (typeof j.version === 'string') out.version = j.version;
  if (typeof j.title === 'string') out.title = j.title;
  if (Array.isArray(j.spells)) out.spells = j.spells.length;
  const where = out.id ?? file.path;
  if (!kind) {
    add('error', where, `has no known "schema" (${schema || 'none'}).`);
    return out;
  }
  out.kind = kind;
  if (schema !== CURRENT[kind]) {
    add('error', where, `uses ${schema}; packs that ship with Spellglass must use ${CURRENT[kind]}.`);
    return out;
  }
  const check = validate(schema, json);
  if (!check.ok) {
    add('error', where, check.reason);
    return out;
  }
  if (kind === 'spellpack' && !satisfies(ENGINE_VERSION, (json as SpellPack).engine)) {
    add('error', where, `needs engine ${(json as SpellPack).engine}, which this engine (${ENGINE_VERSION}) does not satisfy.`);
    return out;
  }
  out.valid = true;
  return out;
}

function checkUniqueIds(packs: LintedPack[], spellPacks: SpellPack[], add: (l: Finding['level'], w: string, m: string) => void): void {
  const byId = new Map<string, string>();
  for (const p of packs) {
    if (!p.id) continue;
    const other = byId.get(p.id);
    if (other) add('error', p.id, `is used by two packs: ${other} and ${p.path}.`);
    else byId.set(p.id, p.path);
  }
  const owner = new Map<string, string>();
  for (const pack of spellPacks) {
    for (const s of pack.spells) {
      const first = owner.get(s.id);
      if (first === pack.id) add('error', `${pack.id}/${s.id}`, 'appears twice in this pack.');
      else if (first) add('error', `${pack.id}/${s.id}`, `is also in ${first}; spell ids must be unique across all packs.`);
      else owner.set(s.id, pack.id);
    }
  }
}

// ------------------------------------------------------------------ index

function checkIndex(input: LintInput, packs: LintedPack[], add: (l: Finding['level'], w: string, m: string) => void, changes: string[]): string | undefined {
  let entries: PackIndexEntry[] = [];
  let parsed: unknown = null;
  if (input.indexText === null) {
    if (!input.writeIndex) add('error', 'index.json', "is missing. Run 'npm run packs:index' to write it.");
  } else {
    try {
      parsed = JSON.parse(input.indexText);
      const check = input.validate('packindex/1', parsed);
      if (!check.ok) add('error', 'index.json', check.reason);
      entries = Array.isArray((parsed as { packs?: unknown })?.packs) ? ((parsed as { packs: PackIndexEntry[] }).packs) : [];
    } catch (err) {
      add('error', 'index.json', `is not valid JSON: ${(err as Error).message}`);
    }
  }

  const listed = packs.filter((p) => p.id && p.kind && p.version);
  const byPath = new Map(listed.map((p) => [p.path, p]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`lists ${e.id} twice.`);
    seen.add(e.id);
    const p = byPath.get(e.path);
    if (!p) {
      problems.push(`lists ${e.path}, which is not a readable pack.`);
      continue;
    }
    if (e.id !== p.id || e.kind !== p.kind || e.version !== p.version) {
      problems.push(`says ${e.path} is ${e.kind} ${e.id} ${e.version}, but the file is ${p.kind} ${p.id} ${p.version}.`);
    }
    if (String(e.sha256).toLowerCase() !== p.sha256) problems.push(`has an out-of-date SHA-256 for ${e.path}.`);
  }
  for (const p of listed) if (!entries.some((e) => e.path === p.path)) problems.push(`does not list ${p.path}.`);

  if (!input.writeIndex) {
    for (const m of problems) add('error', 'index.json', `${m} Run 'npm run packs:index' to update it.`);
    return undefined;
  }
  // Rewrite: keep the order of entries that still point at packs, then add new packs by path.
  const kept = entries.filter((e) => byPath.has(e.path)).map((e) => e.path);
  const order = [...new Set([...kept, ...listed.map((p) => p.path).filter((path) => !kept.includes(path))])];
  const next = {
    ...(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}),
    schema: 'packindex/1',
    packs: order.map((path) => {
      const p = byPath.get(path)!;
      return { id: p.id!, kind: p.kind!, version: p.version!, path, sha256: p.sha256 };
    }),
  };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === input.indexText) return undefined;
  changes.push(...problems.map((m) => `index.json ${m.replace(/\.$/, '')}: fixed.`));
  if (!problems.length) changes.push('index.json rewritten.');
  return text;
}

// ------------------------------------------------------------------ permanent ids

function checkLock(input: LintInput, packs: LintedPack[], spellPacks: SpellPack[], add: (l: Finding['level'], w: string, m: string) => void, changes: string[]): IdsLock | undefined {
  const lockName = 'ids.lock.json';
  if (!input.lock && !input.writeIndex) {
    add('error', lockName, "is missing. Run 'npm run packs:index' to create it from the current packs.");
    return undefined;
  }
  const lock: IdsLock = input.lock ? structuredClone(input.lock) : { note: LOCK_NOTE, packs: {}, spells: {} };
  lock.packs ??= {};
  lock.spells ??= {};
  let changed = !input.lock;

  const current = new Map<string, { spell: Spell; pack: string }>();
  for (const pack of spellPacks) for (const spell of pack.spells) if (!current.has(spell.id)) current.set(spell.id, { spell, pack: pack.id });

  for (const [id, locked] of Object.entries(lock.spells)) {
    const now = current.get(id);
    if (locked.retired) {
      if (now) add('error', `${now.pack}/${id}`, `uses a retired spell id; retired ids are never used again (${lockName}).`);
      continue;
    }
    if (!now) {
      add('error', id, `is a permanent spell id ("${locked.incantation}", ${locked.pack}) and has disappeared. Restore it, or mark it retired in ${lockName}.`);
      continue;
    }
    if (now.spell.incantation !== locked.incantation) {
      add('error', `${now.pack}/${id}`, `was "${locked.incantation}" and is now "${now.spell.incantation}"; an id never changes its meaning. Use a new id for a new spell.`);
    }
    if (now.pack !== locked.pack) add('warning', `${now.pack}/${id}`, `moved from ${locked.pack} to ${now.pack}.`);
  }
  for (const [id, { spell, pack }] of current) {
    if (lock.spells[id]) continue;
    if (input.writeIndex) {
      lock.spells[id] = { incantation: spell.incantation, pack };
      changes.push(`${lockName}: recorded spell ${id} ("${spell.incantation}").`);
      changed = true;
    } else {
      add('error', `${pack}/${id}`, `is a new spell id. Run 'npm run packs:index' to record it in ${lockName}.`);
    }
  }

  for (const p of packs) {
    if (!p.valid || !p.id || !p.kind) continue;
    const locked = lock.packs[p.id];
    if (locked?.retired) add('error', p.id, `is a retired pack id (${lockName}).`);
    else if (locked && locked.kind !== p.kind) add('error', p.id, `was a ${locked.kind} and is now a ${p.kind}; a pack id never changes its meaning.`);
    else if (!locked) {
      if (input.writeIndex) {
        lock.packs[p.id] = { kind: p.kind };
        changes.push(`${lockName}: recorded pack ${p.id}.`);
        changed = true;
      } else {
        add('error', p.id, `is a new pack id. Run 'npm run packs:index' to record it in ${lockName}.`);
      }
    }
  }
  for (const [id, locked] of Object.entries(lock.packs)) {
    if (!locked.retired && !packs.some((p) => p.id === id)) add('warning', id, `is recorded in ${lockName} but no longer ships. Mark it retired if it is gone for good.`);
  }
  if (!changed) return undefined;
  return { note: lock.note ?? LOCK_NOTE, packs: sortKeys(lock.packs), spells: sortKeys(lock.spells) };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ------------------------------------------------------------------ spells and effects

function checkSpell(pack: SpellPack, spell: Spell, allSpellIds: Set<string>, add: (l: Finding['level'], w: string, m: string) => void): void {
  const where = `${pack.id}/${spell.id}`;
  const needs = [...pack.needs, ...(Array.isArray(spell.needs) ? spell.needs : [])];
  const scale = Math.max(1, ...(spell.variants ?? []).map((v) => (typeof v.effect_scale === 'number' ? v.effect_scale : 1)));
  const scaleNote = scale > 1 ? ` (after effect_scale ${scale})` : '';

  if (spell.incantation.length > EFFECT_LIMITS.maxTextChars) {
    add('warning', where, `the incantation has ${spell.incantation.length} characters; text on the glass is limited to ${EFFECT_LIMITS.maxTextChars}.`);
  }
  for (const v of spell.variants ?? []) {
    if (v.label.length > EFFECT_LIMITS.maxTextChars) add('warning', where, `variant label "${v.label}" is longer than ${EFFECT_LIMITS.maxTextChars} characters.`);
  }
  if (!spell.gesture_text) add('warning', where, 'has no gesture_text, so the spellbook cannot describe the gesture in words.');
  if (spell.effect.fallback !== undefined && !FALLBACKS.has(spell.effect.fallback)) {
    add('error', where, `fallback "${spell.effect.fallback}" is not a built-in fallback (${[...FALLBACKS].join(', ')}).`);
  }
  for (const key of ['needs_active', 'ended_by'] as const) {
    for (const ref of spell[key] ?? []) if (!allSpellIds.has(ref)) add('warning', where, `${key} names "${ref}", which no pack has.`);
  }
  for (const ref of spell.ends ?? []) if (ref !== '*' && !allSpellIds.has(ref)) add('warning', where, `ends names "${ref}", which no pack has.`);
  for (const tag of spell.targets ?? []) if (!TAGS.has(tag)) add('warning', where, `target "${tag}" is not a prop tag (contracts/scene.ts PROP_TAGS).`);
  const parts = spell.gesture.parts ?? [];
  if (parts.length) {
    if (parts.some((p, i) => i > 0 && p.until <= parts[i - 1].until)) add('warning', where, 'gesture parts must end in increasing order.');
    if (parts[parts.length - 1].until !== 1) add('warning', where, 'the last gesture part should end at 1 (the end of the path).');
  }

  const flashes: number[] = [];
  spell.effect.steps.forEach((step, i) => {
    const at = `${where} step ${i + 1} (${step.use})`;
    const cap = Object.prototype.hasOwnProperty.call(EFFECT_CAPABILITY, step.use) ? EFFECT_CAPABILITY[step.use as keyof typeof EFFECT_CAPABILITY] : undefined;
    if (!cap) {
      add('error', at, 'is not an effect primitive (contracts/effects.ts), so the app would skip it.');
      return;
    }
    if (!meets(needs, cap)) add('error', at, `uses ${cap}, which the pack's needs (or the spell's) do not list.`);
    for (const key of ['at', 'from', 'to'] as const) {
      const v = step[key];
      if (v !== undefined && !ANCHORS.has(String(v))) add('error', at, `${key} "${String(v)}" is not an anchor (${[...ANCHORS].join(', ')}).`);
    }
    if (step.use === 'audio.cue') {
      if (typeof step.cue !== 'string') add('error', at, 'has no cue.');
      else if (!CUES.has(step.cue)) add('error', at, `cue "${step.cue}" is not one the audio module plays (AUDIO_CUES); it would play "chime" instead.`);
    }
    if (step.use === 'particles.burst' || step.use === 'particles.stream') {
      if (typeof step.preset !== 'string') add('error', at, 'has no preset.');
      else if (!PRESETS.has(step.preset)) add('error', at, `preset "${step.preset}" is not a particle preset (${PARTICLE_PRESETS.join(', ')}).`);
    }
    if (step.use === 'light.snuff' && typeof step.spell === 'string' && !allSpellIds.has(step.spell)) add('warning', at, `spell "${step.spell}" is not in any pack.`);
    if (step.use === 'light.flash' || step.use === 'bolt.cast') flashes.push(num(step.delay_ms) ?? 0);
    if (step.hold === true && NEVER_HELD.has(step.use)) {
      add('warning', at, 'sets hold, but this effect happens at once and never lasts: the spell would stay active until it is ended, with nothing on screen.');
    }
    for (const m of limitWarnings(step, scale)) add('warning', at, `${m}${scaleNote}; the app will cap it.`);
  });

  // The flash budget (EFFECT_LIMITS.flashesPerSecond, maxConcurrentFlashes) covers flashes and bolts.
  flashes.sort((a, b) => a - b);
  for (let i = 0; i < flashes.length; i++) {
    const inWindow = flashes.filter((t) => t >= flashes[i] && t < flashes[i] + EFFECT_LIMITS.flashWindowMs).length;
    if (inWindow > EFFECT_LIMITS.flashesPerSecond) {
      add('warning', where, `has ${inWindow} flashes and bolts within ${EFFECT_LIMITS.flashWindowMs} ms; at most ${EFFECT_LIMITS.flashesPerSecond} play.`);
      break;
    }
  }
}

function meets(needs: readonly string[], cap: string): boolean {
  const want = parseCapability(cap);
  return needs.some((n) => {
    const have = parseCapability(n);
    return have.name === want.name && have.version >= want.version;
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Values over EFFECT_LIMITS, which apply after effect_scale (contracts/effects.ts). */
export function limitWarnings(step: EffectStep, scale = 1): string[] {
  const L = EFFECT_LIMITS;
  const out: string[] = [];
  const over = (name: string, value: number | undefined, limit: number, scaled = true) => {
    if (value === undefined) return;
    const v = scaled ? value * scale : value;
    if (v > limit + 1e-9) out.push(`${name} ${round(v)} is over the limit of ${limit}`);
  };
  switch (step.use) {
    case 'light.flash': {
      over('radius', num(step.radius), L.flashMaxRadius);
      const red = typeof step.color === 'string' && isSaturatedRed(step.color);
      over(red ? 'intensity (saturated red)' : 'intensity', num(step.intensity), red ? L.redFlashMaxIntensity : L.flashMaxIntensity);
      break;
    }
    case 'scene.dim': {
      over('amount', num(step.amount), L.dimMax);
      const fade = num(step.fade_ms);
      if (fade !== undefined && fade < L.dimMinFadeMs) out.push(`fade_ms ${fade} is under the minimum of ${L.dimMinFadeMs}`);
      break;
    }
    case 'screen.shake':
      over('intensity', num(step.intensity), 1);
      over('duration_ms', num(step.duration_ms), L.shakeMaxMs, false);
      if (step.hold === true) out.push('a shake is never held');
      break;
    case 'particles.burst':
      over('count', num(step.count), L.particlesMax);
      break;
    case 'particles.stream': {
      const rate = num(step.rate), duration = num(step.duration_ms) ?? 1000;
      if (rate !== undefined) over('particles (rate × duration)', (rate * duration) / 1000, L.particlesMax);
      break;
    }
    case 'bolt.cast': {
      const width = num(step.width);
      if (width !== undefined && (width * scale < 0.25 || width * scale > 2)) out.push(`width ${round(width * scale)} is outside 0.25 to 2`);
      break;
    }
    case 'text.inscribe':
      if (typeof step.text === 'string' && step.text.length > L.maxTextChars) out.push(`text has ${step.text.length} characters, over the limit of ${L.maxTextChars}`);
      break;
  }
  if (step.hold !== true) over('duration_ms', num(step.duration_ms), L.maxStepMs, false);
  return out;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ------------------------------------------------------------------ themes

function checkTheme(theme: ThemePack, add: (l: Finding['level'], w: string, m: string) => void): void {
  const where = theme.id;
  const t = theme.tokens;
  const missing = THEME_TOKENS.filter((k) => typeof t[k] !== 'string');
  if (missing.length) add('error', where, `is missing the tokens ${missing.join(', ')} (Section 10.2).`);
  const pair = (fgName: string, fg: string | undefined, bgName: string, bg: string | undefined) => {
    if (!fg || !bg) return;
    const ratio = contrastRatio(fg, bg);
    if (ratio === null) add('error', where, `${fgName} or ${bgName} is not a hex color.`);
    else if (ratio < MIN_CONTRAST) add('error', where, `${fgName} (${fg}) on ${bgName} (${bg}) has a contrast of ${ratio.toFixed(2)}:1; Section 10.2 needs ${MIN_CONTRAST}:1.`);
  };
  // Section 10.2: Vellum, Candle, Verdigris and Ash on Night or Slate, Ink on Vellum, Vellum on Oxblood.
  for (const fg of ['vellum', 'candle', 'verdigris', 'ash']) for (const bg of ['night', 'slate']) pair(cap(fg), t[fg], cap(bg), t[bg]);
  pair('Ink', t.ink, 'Vellum', t.vellum);
  pair('Vellum', t.vellum, 'Oxblood', t.oxblood);
  // Accent pairs restyle Candle and Oxblood, so they must pass the same pairs.
  for (const [key, accent] of Object.entries(theme.accents ?? {})) {
    for (const bg of ['night', 'slate']) pair(`Accent ${key} candle`, accent.candle, cap(bg), t[bg]);
    pair('Vellum', t.vellum, `accent ${key} oxblood`, accent.oxblood);
  }

  const captions = theme.captions ?? {};
  const uncaptioned = AUDIO_CUES.filter((c) => typeof captions[c] !== 'string');
  if (uncaptioned.length) add('warning', where, `has no caption for ${uncaptioned.join(', ')}; every sound cue has a caption (Section 10.6).`);
  const unknown = Object.keys(captions).filter((c) => !CUES.has(c));
  if (unknown.length) add('warning', where, `has captions for cues the audio module does not play: ${unknown.join(', ')}.`);
  for (const line of theme.hidden_ink ?? []) {
    if (line.length > EFFECT_LIMITS.maxTextChars) add('warning', where, `hidden ink "${line}" has ${line.length} characters; text on the glass is limited to ${EFFECT_LIMITS.maxTextChars}.`);
  }
  for (const kind of ['cast', 'fizzle'] as const) {
    if (!theme.grades[kind].some((g) => g.min === 0)) add('warning', where, `${kind} grades have no entry with min 0, so the lowest qualities get the last label.`);
  }
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
