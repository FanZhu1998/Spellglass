// Template recognizer (recognizer.template): Section 7.5. A flick detector for straight strokes and
// a template matcher for everything else; stroke.end in, recognition.result out. The geometry lives
// in pure files next to this one (match, templates, recognize, details, learning); this file only
// talks to the kernel.
//
// Inputs:  'stroke.end'; the sticky 'spellbook.changed' (enabled spells are the candidates, Section
//          8) and 'practice.focus'; 'spell.cast' (learning); 'storage.changed' for 'samples'.
// Outputs: 'recognition.result' for every stroke.end, also when nothing is enabled or the stroke is
//          unusable, so the engine never waits; the 'recognizer.score' dry run; learned strokes in
//          the 'samples' store.
// The decision (0.72 and a lead of 0.04) is the spell engine's, not this module's.
//
// Strokes from 'tracker.replay' (recorded sessions) are recognized like any other, so recordings
// replay through the real pipeline; they are never learned from.

import type {
  GestureSample, Kernel, Module, ModuleManifest, Point, Recognition, SpellCast, Spellbook, SpellbookEntry, Stroke,
} from '../../../contracts';
import { DATA_VERSION, DEFAULT_SETTINGS } from '../../../contracts';
import { KernelError, ask, emit, lastPayload, logger, newId, on, serve, setting, stableHash, strokeToUnitPath } from '../../../kernel';
import { LEARN_MAX_OTHER_SCORE, activeSamples, castQualifies, isGestureSample, planSample, samplesFor } from './learning';
import { DEFAULT_ASPECT, recognize, type RecognitionCore, type RecognizerParams } from './recognize';
import { prepareGesture, prepareSample, type PreparedGesture, type PreparedSpell, type PreparedTemplate } from './templates';

export const MANIFEST: ModuleManifest = {
  id: 'recognizer.template',
  kind: 'recognizer',
  title: 'Template recognizer',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['recognition@1'],
  // Storage is optional: without it, learned strokes last for the session.
  requires: [],
};

/** Strokes remembered so a later spell.cast can be learned from. Assisted and strict modes decide up
 *  to a couple of seconds after the stroke; a handful is plenty. */
const RECENT_STROKES = 16;

const FLICK_DIRECTIONS = ['up', 'down', 'left', 'right'];

interface RecentStroke {
  points: Point[];
  aspect: number;
  src?: string;
  scores: Map<string, number>;
}

export function createTemplateRecognizer(): Module {
  const log = logger('recognizer.template');
  let kernel: Kernel | null = null;
  let running = false;
  let book: Spellbook | null = null;

  /** Normalized templates by gesture content. spellbook.changed fires on every accepted cast (the
   *  counts change), so caching by revision would redo this work after every cast. */
  const gestures = new Map<string, PreparedGesture>();
  /** Normalized learned samples by sample id. */
  const sampleTemplates = new Map<string, PreparedTemplate>();
  let entries = new Map<string, SpellbookEntry>();
  /** Candidates for live strokes: available and not locked (SpellbookEntry.enabled). */
  let enabled: PreparedSpell[] = [];
  /** Every available spell, locked ones included: the dry run and the learning drift guard. */
  let available: PreparedSpell[] = [];
  /** Available spells that are not candidates (later tiers): scored only to name them on a fizzle. */
  let locked: PreparedSpell[] = [];

  /** Learned samples as loaded from storage, plus this session's when there is no storage. */
  let samples: GestureSample[] = [];
  let loadGeneration = 0;
  const recent = new Map<string, RecentStroke>();

  const params = (k: Kernel): RecognizerParams => ({
    flickLinearity: num(setting(k, 'recognizer.flickLinearity'), DEFAULT_SETTINGS['recognizer.flickLinearity']),
    flickAngleDeg: num(setting(k, 'recognizer.flickAngleDeg'), DEFAULT_SETTINGS['recognizer.flickAngleDeg']),
    lineTemplateLinearity: num(setting(k, 'recognizer.lineTemplateLinearity'), DEFAULT_SETTINGS['recognizer.lineTemplateLinearity']),
    rotationDeg: num(setting(k, 'recognizer.rotationDeg'), DEFAULT_SETTINGS['recognizer.rotationDeg']),
    rotationStepDeg: num(setting(k, 'recognizer.rotationStepDeg'), DEFAULT_SETTINGS['recognizer.rotationStepDeg']),
  });

  /** Details for every candidate at or above the lower of the two engine thresholds (contract). */
  const detailScore = (k: Kernel) =>
    Math.min(num(setting(k, 'engine.acceptScore'), DEFAULT_SETTINGS['engine.acceptScore']), num(setting(k, 'engine.assistedScore'), DEFAULT_SETTINGS['engine.assistedScore']));

  function rebuild(): void {
    const k = kernel;
    if (!k) return;
    const learnAfter = num(setting(k, 'spells.learnAfter'), DEFAULT_SETTINGS['spells.learnAfter']);
    const cap = num(setting(k, 'recognizer.userTemplatesPerSpell'), DEFAULT_SETTINGS['recognizer.userTemplatesPerSpell']);
    const usedKeys = new Set<string>();
    const usedSamples = new Set<string>();
    const nextEntries = new Map<string, SpellbookEntry>();
    const nextAvailable: PreparedSpell[] = [];
    const nextEnabled: PreparedSpell[] = [];
    for (const entry of book?.spells ?? []) {
      if (!entry?.spell || typeof entry.spell.id !== 'string' || !entry.available || nextEntries.has(entry.spell.id)) continue;
      const key = cacheKey(entry);
      let g = gestures.get(key);
      if (!g) {
        const prepared = prepare(entry);
        if (!prepared) continue;
        gestures.set(key, (g = prepared));
      }
      usedKeys.add(key);
      const user = activeSamples(samples, entry.spell.id, entry.gestureKey, learnAfter, cap).map((s, i) => {
        usedSamples.add(s.id);
        let t = sampleTemplates.get(s.id);
        if (!t) sampleTemplates.set(s.id, (t = prepareSample(s, 0)));
        // 'user:N', best scoring first (RecognitionDetail.template).
        return { ...t, id: `user:${i}` };
      });
      const spell: PreparedSpell = { spellId: entry.spell.id, gesture: g, user };
      nextEntries.set(entry.spell.id, entry);
      nextAvailable.push(spell);
      if (entry.enabled) nextEnabled.push(spell);
    }
    for (const key of [...gestures.keys()]) if (!usedKeys.has(key)) gestures.delete(key);
    for (const id of [...sampleTemplates.keys()]) if (!usedSamples.has(id)) sampleTemplates.delete(id);
    entries = nextEntries;
    available = nextAvailable;
    enabled = nextEnabled;
    const enabledIds = new Set(nextEnabled.map((sp) => sp.spellId));
    locked = nextAvailable.filter((sp) => !enabledIds.has(sp.spellId));
  }

  function prepare(entry: SpellbookEntry): PreparedGesture | null {
    const g = entry.spell.gesture;
    try {
      if (!g || typeof g !== 'object') throw new Error('no gesture');
      if ('flick' in g && !FLICK_DIRECTIONS.includes(g.flick)) throw new Error(`unknown flick direction '${String(g.flick)}'`);
      return prepareGesture(g, entry.templates);
    } catch (err) {
      log.once(`bad-gesture:${entry.spell.id}`, `Spell ${entry.spell.id} has a gesture the recognizer cannot use; it is left out.`, err);
      return null;
    }
  }

  function handleStroke(k: Kernel, stroke: Stroke): void {
    const points: Point[] = (Array.isArray(stroke?.points) ? stroke.points : []).map((p) => [p?.x, p?.y] as Point);
    const aspect = validAspect(stroke?.aspect);
    let core: RecognitionCore;
    try {
      const focus = lastPayload(k, 'practice.focus')?.spellId ?? null;
      core = recognize(points, aspect, enabled, params(k), { details: true, focus, detailScore: detailScore(k) });
    } catch (err) {
      // Never leave the engine without an answer: a stroke the recognizer cannot read scores 0.
      log.error('could not recognize a stroke', err);
      core = { candidates: enabled.map((s) => ({ spellId: s.spellId, score: 0 })), linearity: 1, stage: 'template', details: [], matches: [] };
    }
    const usable = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    // Stroke.src is always set by the segmenter; the samples' own src is a fallback, so a recording
    // played back can never be learned from by accident.
    const src = stroke?.src ?? stroke?.points?.[0]?.src;
    remember(stroke.id, { points: usable, aspect, src, scores: new Map(core.candidates.map((c) => [c.spellId, c.score])) });
    const result = toRecognition(stroke.id, core);
    if (locked.length && usable.length) {
      try {
        result.locked = recognize(points, aspect, locked, params(k)).candidates.slice(0, LOCKED_REPORTED);
      } catch (err) {
        log.warn('could not score locked spells', err);
      }
    }
    emit(k, MANIFEST.id, 'recognition.result', result);
  }

  function remember(strokeId: string, rec: RecentStroke): void {
    if (typeof strokeId !== 'string') return;
    recent.delete(strokeId);
    recent.set(strokeId, rec);
    while (recent.size > RECENT_STROKES) recent.delete(recent.keys().next().value!);
  }

  function learn(k: Kernel, cast: SpellCast): void {
    if (!cast?.strokeId) return;
    const rec = recent.get(cast.strokeId);
    // Only strokes this recognizer recognized (replays through 'engine.cast' have none).
    if (!rec) return;
    const accept = num(setting(k, 'engine.acceptScore'), DEFAULT_SETTINGS['engine.acceptScore']);
    if (!castQualifies(cast, rec.src, accept, rec.scores.get(cast.spellId))) return;
    const entry = entries.get(cast.spellId);
    if (!entry?.gestureKey) return;
    const cap = num(setting(k, 'recognizer.userTemplatesPerSpell'), DEFAULT_SETTINGS['recognizer.userTemplatesPerSpell']);
    if (!(cap > 0)) return;
    // One sample per stroke, whatever happens next.
    recent.delete(cast.strokeId);
    if (rec.points.length < 2) return;

    const check = recognize(rec.points, rec.aspect, available, params(k));
    const own = check.matches.find((m) => m.spellId === cast.spellId);
    if (!own) return;
    const rival = check.matches.find((m) => m.spellId !== cast.spellId);
    if (rival && rival.score > LEARN_MAX_OTHER_SCORE) {
      log.debug(`not learning a ${cast.spellId} stroke: it scores ${rival.score.toFixed(2)} as ${rival.spellId}`);
      return;
    }
    const sample: GestureSample = {
      dataVersion: DATA_VERSION,
      id: newId('sample'),
      spellId: cast.spellId,
      points: strokeToUnitPath(rec.points, rec.aspect, 64),
      score: Math.round(own.seedScore * 1000) / 1000,
      gestureKey: entry.gestureKey,
      savedAt: Date.now(),
    };
    const plan = planSample(samplesFor(samples, cast.spellId, entry.gestureKey), sample, cap);
    if (!plan.keep && !plan.drop.length) return;
    const drop = new Set(plan.drop);
    samples = samples.filter((s) => !drop.has(s.id));
    if (plan.keep) samples.push(sample);
    rebuild();
    void persist(k, plan.keep ? sample : null, plan.drop);
  }

  async function persist(k: Kernel, sample: GestureSample | null, drop: string[]): Promise<void> {
    try {
      if (sample) await ask(k, 'storage.put', { store: 'samples', key: sample.id, value: sample });
      for (const key of drop) await ask(k, 'storage.delete', { store: 'samples', key });
    } catch (err) {
      if (isNoHandler(err)) {
        log.once('recognizer.no-storage', 'No storage module: learned strokes are kept for this session only.');
        return;
      }
      log.warn('could not save a learned stroke', err);
    }
  }

  async function loadSamples(): Promise<void> {
    const k = kernel;
    if (!k) return;
    const generation = ++loadGeneration;
    try {
      const rows = await ask(k, 'storage.list', { store: 'samples' });
      if (generation !== loadGeneration) return;
      samples = (Array.isArray(rows) ? rows : []).map((r) => r?.value).filter(isGestureSample);
      rebuild();
    } catch (err) {
      // Without storage the session's own samples stay in effect.
      if (!isNoHandler(err)) log.warn('could not load learned strokes', err);
    }
  }

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      book = lastPayload(k, 'spellbook.changed') ?? null;
      rebuild();
      on(k, 'spellbook.changed', (b) => {
        book = b;
        rebuild();
      });
      on(k, 'settings.changed', ({ key }) => {
        if (key === 'spells.learnAfter' || key === 'recognizer.userTemplatesPerSpell') rebuild();
      });
      on(k, 'stroke.end', (stroke) => {
        if (running) handleStroke(k, stroke);
      });
      on(k, 'spell.cast', (cast) => {
        if (running) learn(k, cast);
      });
      on(k, 'storage.changed', (c) => {
        if (running && Array.isArray(c?.stores) && c.stores.includes('samples')) void loadSamples();
      });

      // Dry run for the Workshop: score caster-space points against every available spell (locked ones
      // included), optionally only some, and publish nothing.
      serve(k, 'recognizer.score', (p) => {
        if (!p || !Array.isArray(p.points)) throw new KernelError('invalid-payload', 'recognizer.score needs { points }');
        const points: Point[] = [];
        for (const q of p.points) if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) points.push([q[0], q[1]]);
        if (points.length < 2) throw new KernelError('invalid-payload', 'recognizer.score needs at least two points');
        // An empty list means no spells, as written; leave spellIds out to score them all.
        const ids = Array.isArray(p.spellIds) ? new Set(p.spellIds) : null;
        const spells = ids ? available.filter((s) => ids.has(s.spellId)) : available;
        const core = recognize(points, validAspect(p.aspect), spells, params(k), { details: true, detailScore: detailScore(k) });
        // No stroke behind a dry run; the id says so.
        return toRecognition('dry-run', core);
      });
    },

    async start() {
      running = true;
      // Storage answers from start() on. Never awaited here: start() resolves promptly whatever
      // IndexedDB is doing (contracts/module.ts).
      void loadSamples();
    },

    async stop() {
      running = false;
      loadGeneration++;
      recent.clear();
    },
  };
}

/** How many locked spells a recognition names (best first). */
const LOCKED_REPORTED = 3;

function toRecognition(strokeId: string, core: RecognitionCore): Recognition {
  return {
    strokeId,
    recognizer: MANIFEST.id,
    candidates: core.candidates,
    linearity: Math.round(core.linearity * 10000) / 10000,
    stage: core.stage,
    details: core.details,
  };
}

/** The cache key of a gesture: its gestureKey (which changes with the shape, the start points and
 *  the left-handed mirror), or a hash of it when a spellbook entry lacks one. */
function cacheKey(entry: SpellbookEntry): string {
  return entry.gestureKey ? `k:${entry.gestureKey}` : `h:${stableHash(entry.spell.gesture)}`;
}

function validAspect(a: unknown): number {
  return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : DEFAULT_ASPECT;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function isNoHandler(err: unknown): boolean {
  return (err instanceof KernelError && err.code === 'no-handler') || (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'no-handler');
}
