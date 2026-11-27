// Building the Spellbook (contracts/packs.ts) from loaded packs, the player's drawings and progress,
// and settings. Pure and synchronous: the service calls it after every change and publishes the result
// as 'spellbook.changed'.

import type {
  EffectStep, Gesture, GestureOverride, GesturePack, Point, Spell, SpellPack, SpellProgress, Spellbook, SpellbookEntry,
  SpellbookPack, ThemePack,
} from '../../contracts';
import { parseCapability } from '../capabilities';
import { gestureKey, gesturePaths } from '../gestures';
import { resample } from '../geometry';
import { compare, parseVersion } from '../semver';
import { inheritFromPack, mirrorGesture } from './drawing';
import { advanceTier, completedTier, isLearned } from './progress';
import type { LoadedPack } from './types';

/** Templates are resampled to this many points (Section 7.5 step 1, Appendix B). */
export const TEMPLATE_POINTS = 64;

export interface BuildInput {
  /** Packs from the index, in index order (failed ones included). */
  bundled: readonly LoadedPack[];
  /** Packs the player imported (failed ones included). */
  user: readonly LoadedPack[];
  /** The player's own drawings, by spell id, stored right-handed. */
  overrides: ReadonlyMap<string, GestureOverride>;
  progress: ReadonlyMap<string, SpellProgress>;
  /** Setting 'packs.enabled'. */
  packsEnabled: Readonly<Record<string, boolean>>;
  unlockAll: boolean;
  learnAfter: number;
  leftHanded: boolean;
  themeId: string;
  /** The needs nothing provides (CapabilitySet.unmet). */
  unmet: (needs: readonly string[]) => string[];
  /** Effect step names some module implements. */
  knownEffects: ReadonlySet<string>;
  /** The stored highest tier opened. The result may be higher, never lower. */
  unlockedTier: number;
  revision: number;
  indexError?: string;
}

export interface BuildResult {
  book: Spellbook;
  /** Each spell as its pack has it (before the effective gesture, the mirror and step skipping), by id. */
  sources: Map<string, Spell>;
  /** The tier to save: input.unlockedTier moved past the tiers the player has completed
   *  (progress.ts completedTier). book.unlockedTier may be higher, because this spellbook also passes
   *  through tiers that have nothing available; that part is never saved. */
  storedTier: number;
}

/** A pack in spellbook order, with the problems found while building. */
interface Resolved {
  loaded: LoadedPack;
  shadows?: string;
  warnings: string[];
}

export function buildSpellbook(input: BuildInput): BuildResult {
  const resolved = resolvePacks(input.bundled, input.user);
  const isEnabled = (p: LoadedPack) => packEnabled(p, input.packsEnabled);

  const picks = pickSpells(resolved, isEnabled);
  const layers = gestureLayers(resolved, isEnabled);
  const sources = new Map(picks.map(({ spell }) => [spell.id, spell]));
  for (const r of resolved) {
    if (r.loaded.kind !== 'gesturepack' || !r.loaded.pack) continue;
    const unknown = Object.keys((r.loaded.pack as GesturePack).gestures).filter((id) => !sources.has(id));
    if (unknown.length) r.warnings.push(`Some gestures are for spells that are not loaded: ${unknown.join(', ')}.`);
  }

  // First pass: everything except status, which needs the unlocked tier, which needs these.
  const drafts = picks.map(({ resolved: r, spell }) => draftEntry(r.loaded, spell, input, layers, isEnabled(r.loaded)));
  const storedTier = completedTier(drafts, input.unlockedTier);
  const unlockedTier = advanceTier(drafts, storedTier);
  const spells = drafts.map((d) => finishEntry(d, unlockedTier, input.unlockAll));

  // Steps nothing plays are not an error, but the Workshop should say so.
  for (const r of resolved) {
    if (r.loaded.kind !== 'spellpack') continue;
    const skipped = new Set(spells.filter((e) => e.packId === r.loaded.id).flatMap((e) => e.skippedSteps));
    if (skipped.size) r.warnings.push(`Some effect steps are skipped because nothing here plays them: ${[...skipped].join(', ')}.`);
  }

  const book: Spellbook = {
    revision: input.revision,
    packs: resolved.map((r) => packSummary(r, isEnabled(r.loaded), input.unmet)),
    spells,
    theme: pickTheme(resolved, isEnabled, input.themeId),
    unlockedTier,
    learnAfter: input.learnAfter,
    ...(input.indexError ? { indexError: input.indexError } : {}),
  };
  return { book, sources, storedTier };
}

export function packEnabled(p: LoadedPack, setting: Readonly<Record<string, boolean>>): boolean {
  const v = Object.prototype.hasOwnProperty.call(setting, p.id) ? setting[p.id] : undefined;
  return typeof v === 'boolean' ? v : p.defaultEnabled;
}

/** Bundled packs first, in index order; then the player's packs, oldest import first. A player's pack
 *  with a bundled pack's id replaces it, in its place, only when it is the same kind with a higher
 *  version (it "shadows" the bundled one); otherwise the bundled pack wins and says why. */
export function resolvePacks(bundled: readonly LoadedPack[], user: readonly LoadedPack[]): Resolved[] {
  const out: Resolved[] = bundled.map((loaded) => ({ loaded, warnings: [...loaded.warnings] }));
  const users = [...user].sort((a, b) => a.importedAt - b.importedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const u of users) {
    const i = out.findIndex((r) => !r.loaded.user && r.loaded.id === u.id);
    if (i < 0) {
      if (!out.some((r) => r.loaded.id === u.id)) out.push({ loaded: u, warnings: [...u.warnings] });
      continue;
    }
    const b = out[i].loaded;
    if (u.pack && u.kind === b.kind && isHigherVersion(u.version, b.version)) {
      out[i] = { loaded: u, shadows: b.id, warnings: [...u.warnings, `Replaces version ${b.version}, which ships with Spellglass.`] };
    } else if (u.pack) {
      out[i].warnings.push(`Your imported copy (version ${u.version}) is not used, because the version that ships with Spellglass is the same or newer.`);
    } else {
      out[i].warnings.push(`Your imported copy could not be read: ${u.error ?? 'it is damaged.'}`);
    }
  }
  return out;
}

export function isHigherVersion(a: string, b: string): boolean {
  const va = parseVersion(a), vb = parseVersion(b);
  return !!va && !!vb && compare(va, vb) > 0;
}

/** One spell per id (ids are unique in the spellbook). When several packs have the same id, the first
 *  enabled pack in spellbook order keeps it; if none of them is enabled, the first pack does. So a
 *  player who turns one pack off and another with the same spell on gets the one they chose. Every
 *  dropped copy is named in its pack's warnings. */
function pickSpells(resolved: Resolved[], isEnabled: (p: LoadedPack) => boolean): { resolved: Resolved; spell: Spell }[] {
  const spellPacks = resolved.filter((r) => r.loaded.kind === 'spellpack' && r.loaded.pack);
  const owner = new Map<string, Resolved>();
  for (const pass of [true, false]) {
    for (const r of spellPacks) {
      if (isEnabled(r.loaded) !== pass) continue;
      for (const s of (r.loaded.pack as SpellPack).spells) if (!owner.has(s.id)) owner.set(s.id, r);
    }
  }
  const picks: { resolved: Resolved; spell: Spell }[] = [];
  for (const r of spellPacks) {
    const seenHere = new Set<string>();
    for (const spell of (r.loaded.pack as SpellPack).spells) {
      if (seenHere.has(spell.id)) {
        r.warnings.push(`Spell "${spell.id}" appears twice in this pack; the second one is not used.`);
        continue;
      }
      seenHere.add(spell.id);
      const winner = owner.get(spell.id);
      if (winner !== r) {
        r.warnings.push(`Spell "${spell.id}" is not used, because ${winner?.loaded.title ?? 'another pack'} also has it and comes first.`);
        continue;
      }
      picks.push({ resolved: r, spell });
    }
  }
  return picks;
}

/** Enabled gesture packs, newest import first (contracts/packs.ts GesturePack: layers). */
function gestureLayers(resolved: Resolved[], isEnabled: (p: LoadedPack) => boolean): LoadedPack[] {
  return resolved
    .map((r, order) => ({ loaded: r.loaded, order }))
    .filter(({ loaded }) => loaded.kind === 'gesturepack' && loaded.pack && isEnabled(loaded))
    .sort((a, b) => b.loaded.importedAt - a.loaded.importedAt || b.order - a.order)
    .map(({ loaded }) => loaded);
}

interface Draft {
  pack: LoadedPack;
  spell: Spell;
  tier: number;
  available: boolean;
  unavailableReason?: string;
  learned: boolean;
  accepted: number;
  /** The effective gesture, mirrored when the left-handed switch is on. */
  gesture: Gesture;
  gestureSource: string;
  mirrored: boolean;
  steps: EffectStep[];
  skipped: string[];
  lasts: 'until-ended' | number | null;
}

function draftEntry(pack: LoadedPack, spell: Spell, input: BuildInput, layers: LoadedPack[], enabled: boolean): Draft {
  const p = pack.pack as SpellPack;
  const unmet = dedupe(input.unmet([...(Array.isArray(p.needs) ? p.needs : []), ...(Array.isArray(spell.needs) ? spell.needs : [])]));
  const unavailableReason = !enabled ? `${pack.title} is turned off.` : unmet.length ? needsSentence(unmet) : undefined;
  const progress = input.progress.get(spell.id);
  const { gesture, source } = effectiveGesture(spell, input.overrides, layers);
  const steps = Array.isArray(spell.effect?.steps) ? spell.effect.steps : [];
  return {
    pack,
    spell,
    tier: typeof spell.tier === 'number' && spell.tier >= 1 ? Math.floor(spell.tier) : 1,
    available: enabled && unmet.length === 0,
    ...(unavailableReason ? { unavailableReason } : {}),
    learned: isLearned(progress, input.learnAfter),
    accepted: progress?.casts ?? 0,
    gesture: input.leftHanded ? mirrorGesture(gesture) : gesture,
    gestureSource: source,
    mirrored: input.leftHanded,
    steps: steps.filter((s) => input.knownEffects.has(s.use)),
    skipped: steps.filter((s) => !input.knownEffects.has(s.use)).map((s) => s.use),
    lasts: spellLasts(spell),
  };
}

function finishEntry(d: Draft, unlockedTier: number, unlockAll: boolean): SpellbookEntry {
  // A learned spell is never locked again: it stays learned (contracts/storage.ts), also when the tier
  // comes back down because a pack was turned on again, and after 'spells.unlockAll' is turned off.
  const locked = d.tier > unlockedTier && !unlockAll && !d.learned;
  const spell: Spell = { ...d.spell, gesture: d.gesture, effect: { ...d.spell.effect, steps: d.steps } };
  return {
    spell,
    packId: d.pack.id,
    packTitle: d.pack.title,
    available: d.available,
    ...(d.unavailableReason ? { unavailableReason: d.unavailableReason } : {}),
    status: locked ? 'locked' : d.learned ? 'learned' : 'open',
    enabled: d.available && !locked,
    overridden: d.gestureSource === 'override',
    gestureSource: d.gestureSource,
    // The key is taken after the mirror, so the left-handed switch changes it (learned samples made
    // under the other hand go stale, contracts/storage.ts GestureSample.gestureKey).
    gestureKey: gestureKey(d.gesture),
    mirrored: d.mirrored,
    templates: templatesOf(d.gesture),
    lasts: d.lasts,
    skippedSteps: d.skipped,
    accepted: d.accepted,
  };
}

/** The player's drawing wins, then enabled gesture packs (newest first), then the pack's gesture. A
 *  redrawn gesture keeps the pack gesture's parts, any_start and start_points unless it has its own. */
export function effectiveGesture(spell: Spell, overrides: ReadonlyMap<string, GestureOverride>, layers: readonly LoadedPack[]): { gesture: Gesture; source: string } {
  const own = overrides.get(spell.id);
  if (own) return { gesture: inheritFromPack(own.gesture, spell.gesture), source: 'override' };
  for (const layer of layers) {
    const gestures = (layer.pack as GesturePack).gestures;
    if (Object.prototype.hasOwnProperty.call(gestures, spell.id)) return { gesture: inheritFromPack(gestures[spell.id], spell.gesture), source: layer.id };
  }
  return { gesture: spell.gesture, source: 'pack' };
}

/** Every path resampled to TEMPLATE_POINTS, kept in its unit square (not centred): the recognizer
 *  normalizes, the stage and practice guide draw them as they are. Flicks have none. */
export function templatesOf(g: Gesture): Point[][] {
  return gesturePaths(g).map((p) => resample(p, TEMPLATE_POINTS));
}

/** How long the spell stays active once cast, from the pack's own data (contracts SpellbookEntry.lasts):
 *  duration_ms when set (a duration ends the spell even if steps hold), else 'until-ended' when a step
 *  holds, else null (instant). Computed from the original steps, so it never depends on which effect
 *  modules happen to be installed. */
export function spellLasts(spell: Spell): 'until-ended' | number | null {
  if (typeof spell.duration_ms === 'number' && spell.duration_ms > 0) return spell.duration_ms;
  const steps = Array.isArray(spell.effect?.steps) ? spell.effect.steps : [];
  return steps.some((s) => s.hold === true) ? 'until-ended' : null;
}

function packSummary(r: Resolved, enabled: boolean, unmetOf: (needs: readonly string[]) => string[]): SpellbookPack {
  const l = r.loaded;
  const needs = l.pack && Array.isArray((l.pack as { needs?: unknown }).needs) ? ((l.pack as { needs: string[] }).needs) : [];
  return {
    id: l.id,
    kind: l.kind,
    title: l.title,
    version: l.version,
    ...(l.description ? { description: l.description } : {}),
    enabled,
    user: l.user,
    ...(l.notice ? { notice: l.notice } : {}),
    unmet: l.pack ? dedupe(unmetOf(needs)) : [],
    ...(l.error ? { error: l.error } : {}),
    ...(r.warnings.length ? { warnings: dedupe(r.warnings) } : {}),
    ...(r.shadows ? { shadows: r.shadows } : {}),
  };
}

/** The theme pack setting 'theme.id' names, else the first; only enabled theme packs count. */
function pickTheme(resolved: Resolved[], isEnabled: (p: LoadedPack) => boolean, themeId: string): ThemePack | null {
  const themes = resolved.map((r) => r.loaded).filter((l) => l.kind === 'themepack' && l.pack && isEnabled(l));
  return ((themes.find((t) => t.id === themeId) ?? themes[0])?.pack as ThemePack | undefined) ?? null;
}

type CapabilityWords = { name: string; plural: boolean };

/** Plain names for capabilities in reasons (Section 10.5: instructions stay plain), each with whether
 *  it is plural, so the sentence agrees with it: "scene effects, which are". */
const CAPABILITY_NAMES: Record<string, CapabilityWords> = {
  'fx.light': { name: 'light effects', plural: true },
  'fx.particles': { name: 'particle effects', plural: true },
  'fx.props': { name: 'the prop shelf', plural: false },
  'fx.shapes': { name: 'shape effects', plural: true },
  'fx.scene': { name: 'scene effects', plural: true },
  'fx.text': { name: 'writing on the glass', plural: false },
  audio: { name: 'sound', plural: false },
  voice: { name: 'voice recognition', plural: false },
  recognition: { name: 'gesture recognition', plural: false },
  engine: { name: 'the spell engine', plural: false },
};

/** 'Needs sound, which is not available here.' 'Needs scene effects, which are not available here.' */
export function needsSentence(unmet: readonly string[]): string {
  const seen = new Set<string>();
  const names = unmet.map(capabilityWords).filter((w) => !seen.has(w.name) && !!seen.add(w.name));
  const list = names.length <= 1 ? names.map((w) => w.name).join('') : `${names.slice(0, -1).map((w) => w.name).join(', ')} and ${names[names.length - 1].name}`;
  const plural = names.length > 1 || names[0]?.plural === true;
  return `Needs ${list}, which ${plural ? 'are' : 'is'} not available here.`;
}

function capabilityWords(cap: string): CapabilityWords {
  const { name, version } = parseCapability(cap);
  const words = Object.prototype.hasOwnProperty.call(CAPABILITY_NAMES, name) ? CAPABILITY_NAMES[name] : unknownCapability(name);
  return version > 1 ? { ...words, name: `${words.name} (version ${version})` } : words;
}

/** A capability Spellglass has no name for (a newer pack's, or another module's), put into words
 *  from its id rather than shown as one: 'fx.weather' is a family of effects ('weather effects'),
 *  anything else a feature ('quantum.glow' is 'the quantum glow feature'). */
function unknownCapability(name: string): CapabilityWords {
  const [family, ...rest] = name.split('.');
  const words = (parts: string[]) => parts.join(' ').replace(/-/g, ' ');
  if (family === 'fx' && rest.length) return { name: `${words(rest)} effects`, plural: true };
  return { name: `the ${words([family, ...rest])} feature`, plural: false };
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
