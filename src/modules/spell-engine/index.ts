// Spell engine (engine.rules): combines gesture and voice, applies the pack's rules and scores the
// cast (Section 7.7). This file is the thin module: it feeds events into the pure core (engine.ts),
// publishes what comes back in order, and sets one timer for the core's next deadline. All the
// behavior lives in the core and its helpers, which are unit-tested without a browser.
//
// Inputs:  stroke.begin (only when it started, to pair speech with strokes), stroke.end,
//          recognition.result, voice.incantation, tip.filtered; sticky spellbook.changed,
//          scene.props, practice.focus, voice.status, replay.state, stage.steering, tracker.status
//          (pen, kept per tracker); settings engine.*, playArea, recognizer.flickLinearity,
//          segmenter.minExtent, access.reducedMotion.
// Outputs: spell.cast, spell.fizzle, spell.ended, spell.pending, practice.attempt.
// Requests handled: engine.cast (replays), engine.reset.

import type { CastingMode, Kernel, Module, ModuleManifest } from '../../contracts';
import { CAST_SEQUENCE } from '../../contracts';
import { emit, isReducedMotion, lastPayload, newId, on, serve, setting, watchReducedMotion } from '../../kernel';
import { SpellEngineCore } from './engine';
import { sanePlayArea } from './measure';
import type { EngineOutput, EngineSettings } from './types';
import { DEFAULT_ENGINE_SETTINGS } from './types';

export const MANIFEST: ModuleManifest = {
  id: 'engine.rules',
  kind: 'engine',
  title: 'Spell engine',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['engine@1'],
  requires: [],
};

const MODES: readonly CastingMode[] = ['gesture', 'assisted', 'strict', 'voice'];

export function createSpellEngine(): Module {
  let kernel: Kernel | null = null;
  let core: SpellEngineCore | null = null;
  let running = false;
  let reducedMotion = false;
  let stopWatchingMotion: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt: number | null = null;

  /** Settings are read fresh for every decision (kernel.setting is a plain lookup). */
  const readSettings = (k: Kernel): EngineSettings => {
    const d = DEFAULT_ENGINE_SETTINGS;
    const mode = setting(k, 'engine.mode');
    return {
      mode: MODES.includes(mode) ? mode : d.mode,
      acceptScore: num(setting(k, 'engine.acceptScore'), d.acceptScore),
      leadMargin: num(setting(k, 'engine.leadMargin'), d.leadMargin),
      assistedScore: num(setting(k, 'engine.assistedScore'), d.assistedScore),
      voiceBeforeMs: num(setting(k, 'engine.voiceBeforeMs'), d.voiceBeforeMs),
      voiceAfterMs: num(setting(k, 'engine.voiceAfterMs'), d.voiceAfterMs),
      voiceLatencyMs: num(setting(k, 'engine.voiceLatencyMs'), d.voiceLatencyMs),
      playArea: sanePlayArea(setting(k, 'playArea')),
      flickLinearity: num(setting(k, 'recognizer.flickLinearity'), d.flickLinearity),
      minExtent: num(setting(k, 'segmenter.minExtent'), d.minExtent),
      // Watched while running; read directly before start (an engine.cast from an early replay).
      bloomDelayMs: (stopWatchingMotion ? reducedMotion : isReducedMotion(k)) ? CAST_SEQUENCE.reducedMotionBloomDelayMs : CAST_SEQUENCE.bloomDelayMs,
    };
  };

  const publish = (out: readonly EngineOutput[]): void => {
    const k = kernel;
    if (!k) return;
    for (const o of out) emit(k, MANIFEST.id, o.type, o.payload);
    schedule();
  };

  /** One timer, set for the core's next deadline. It only wakes the core: the core compares capture
   *  times with kernel.now() itself, so a late or early wake-up cannot change a decision. It does not
   *  depend on `running`: only engine.cast can add work while stopped (a replay before start), and
   *  stop() empties the core, so nothing is left to fire after it. */
  const schedule = (): void => {
    if (!kernel || !core) return;
    const next = core.nextWake();
    if (next === timerAt && (timer !== null || next === null)) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    timerAt = next;
    if (next === null) return;
    timer = setTimeout(wake, Math.max(0, Math.ceil(next - kernel.now())));
  };

  const wake = (): void => {
    timer = null;
    timerAt = null;
    if (!kernel || !core) return;
    publish(core.tick(kernel.now()));
  };

  /** Pick up the sticky state published before this module started. */
  const readSticky = (k: Kernel, c: SpellEngineCore): EngineOutput[] => {
    const out = c.setSpellbook(lastPayload(k, 'spellbook.changed') ?? null, k.now());
    c.setProps(lastPayload(k, 'scene.props') ?? null);
    c.setFocus(lastPayload(k, 'practice.focus')?.spellId ?? null);
    c.setVoiceStatus(lastPayload(k, 'voice.status') ?? null);
    out.push(...c.setReplayState(lastPayload(k, 'replay.state') ?? null, k.now()));
    c.setSteering(lastPayload(k, 'stage.steering') ?? null);
    c.setTrackerStatus(lastPayload(k, 'tracker.status') ?? null);
    const tip = lastPayload(k, 'tip.filtered');
    if (tip) c.noteTip(tip);
    return out;
  };

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      const c = new SpellEngineCore({ settings: () => readSettings(k), newId });
      core = c;

      // Pipeline inputs count only while running.
      on(k, 'stroke.begin', (stroke) => {
        if (running) c.strokeBegin(stroke);
      });
      on(k, 'stroke.end', (stroke) => {
        if (running) publish(c.stroke(stroke, k.now()));
      });
      on(k, 'recognition.result', (rec) => {
        if (running) publish(c.recognition(rec, k.now()));
      });
      on(k, 'voice.incantation', (inc) => {
        if (running) publish(c.incantation(inc, k.now()));
      });
      on(k, 'tip.filtered', (tip) => c.noteTip(tip));

      // Sticky context is always kept current.
      on(k, 'spellbook.changed', (book) => publish(c.setSpellbook(book, k.now())));
      on(k, 'scene.props', (props) => c.setProps(props));
      on(k, 'practice.focus', (focus) => c.setFocus(focus?.spellId ?? null));
      on(k, 'voice.status', (status) => c.setVoiceStatus(status));
      on(k, 'replay.state', (state) => publish(c.setReplayState(state, k.now())));
      on(k, 'stage.steering', (steering) => c.setSteering(steering));
      on(k, 'tracker.status', (status) => c.setTrackerStatus(status));

      // Requests are registered in init() so other modules can ask from their start() on.
      serve(k, 'engine.cast', (payload) => {
        const { cast, out } = c.cast(payload, k.now());
        publish(out);
        return cast;
      });
      serve(k, 'engine.reset', () => {
        publish(c.reset(k.now()));
      });
    },

    async start() {
      const k = kernel;
      const c = core;
      if (!k || !c || running) return;
      stopWatchingMotion = watchReducedMotion(k, (reduced) => {
        reducedMotion = reduced;
      });
      running = true;
      publish(readSticky(k, c));
    },

    async stop() {
      const k = kernel;
      const c = core;
      if (!k || !c || !running) return;
      // Strokes in flight are answered ('ignored') and active spells end ('stopped') before going quiet.
      const out = c.stop(k.now());
      running = false;
      publish(out);
      stopWatchingMotion?.();
      stopWatchingMotion = null;
    },
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
