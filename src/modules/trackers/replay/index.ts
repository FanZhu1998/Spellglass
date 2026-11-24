// Replay tracker (tracker.replay): plays a recorded session (contracts/session.ts) through the pipeline as
// if a tracker were producing it live. Recorded sessions guard behavior (Section 9.1 rule 8, Section 13):
// the Workshop plays them back to check a change, and tests play the fixtures in tests/fixtures/sessions.
//
// 'replay.play' {session, speed} (registered in init()):
//   1. activates this tracker transiently ('modules.activate' with transient: true), so the persisted
//      'tracker.active' setting is untouched and the player's tracker comes back afterwards;
//   2. publishes tracker.status with the session's aspect and pen flag (rule 1 of the tip event rules),
//      and its segmentation needs when it has some (contracts 1.2 RecordedSession.segmentation), so the
//      segmenter, and the stage's tip, treat the samples as they treated them live;
//   3. publishes the session's tip.sample, tip.found, tip.lost and voice.incantation events at their
//      recorded times re-based onto kernel.now(): published t = start + recorded t, in the envelope and
//      in the payload. speed changes only when they go out; speed 0 publishes everything at once (tests);
//   4. waits a short tail so the last stroke is decided, publishes tracker.status (pen false), resolves
//      with the number of session events played, and then releases the transient activation.
// 'replay.stop' cancels a playback; the play request still resolves, with the events played so far.
//
// Everything is published with source and src 'tracker.replay': the segmenter copies src into the stroke,
// and the engine marks casts from it as replays, which never count toward progress, never become learned
// templates and never become keepsakes (contracts/v1.ts SpellCast.replay). Session settings are never
// applied to the player's settings: only test harnesses apply them.

import type { Kernel, Module, ModuleManifest, SessionEvent, TrackerStatus } from '../../../contracts';
import { ask, emit, logger, serve } from '../../../kernel';
import { DEFAULT_ASPECT, dueAt, normalizeSpeed, planSession, ReplayInputError, tailMs, type ReplayPlan } from './plan';

export const MANIFEST: ModuleManifest = {
  id: 'tracker.replay',
  kind: 'tracker',
  title: 'Recorded session',
  version: '1.0.0',
  // 1.2: tracker.status carries the session's `segmentation`.
  contract: '^1.2',
  provides: ['tip.source', 'replay@1'],
  requires: [],
  // Not a way to see the wand: the Threshold screen does not offer it (contracts/module.ts).
  selectable: false,
};

const ID = MANIFEST.id;
const log = logger(ID);

/** One playback in progress. */
interface Playback {
  plan: ReplayPlan;
  speed: number;
  /** Distinguishes incantation ids between playbacks: each id serves one decision (contracts/v1.ts). */
  prefix: string;
  /** Kernel time the recording's t = 0 is mapped to. */
  start: number;
  /** Index of the next step to publish. */
  next: number;
  /** Session events published so far (synthetic repairs not counted). */
  played: number;
  holding: boolean;
  /** Published t of the last sample, for tip.lost.lastSeen. */
  lastSample: number | null;
  cancelled: boolean;
  /** Ends the current wait early (set while the playback sleeps). */
  wake: (() => void) | null;
}

export function createReplayTracker(): Module {
  let kernel: Kernel;
  let active = false;
  let playback: Playback | null = null;
  /** The plan waiting for activation, so start() can announce the session's aspect and pen. */
  let pending: ReplayPlan | null = null;
  let plays = 0;

  const now = () => kernel.now();

  function publishStatus(state: TrackerStatus['state'], plan: ReplayPlan | null, pen: boolean, message?: string): void {
    emit(kernel, ID, 'tracker.status', {
      tracker: ID,
      state,
      lock: state === 'tracking' ? 1 : 0,
      // Not camera frames: the session's sample rate, for the status area.
      fps: plan?.sampleRate ?? 0,
      aspect: plan?.aspect ?? DEFAULT_ASPECT,
      pen,
      hint: null,
      message,
      // Every status about a session carries its needs (a status without them means none).
      ...(plan?.segmentation ? { segmentation: { ...plan.segmentation } } : {}),
    });
  }

  /** Publish one step of the plan, re-based onto the playback's start. */
  function publishStep(p: Playback, event: SessionEvent, synthetic: boolean): void {
    const t = p.start + event.t;
    switch (event.type) {
      case 'tip.found':
        p.holding = true;
        emit(kernel, ID, 'tip.found', { t, x: event.x, y: event.y, conf: event.conf, src: ID, ...(event.frame !== undefined ? { frame: event.frame } : {}) }, t);
        break;
      case 'tip.sample':
        p.lastSample = t;
        emit(kernel, ID, 'tip.sample', {
          t, x: event.x, y: event.y, conf: event.conf, src: ID,
          ...(event.size !== undefined ? { size: event.size } : {}),
          ...(event.frame !== undefined ? { frame: event.frame } : {}),
        }, t);
        break;
      case 'tip.lost':
        p.holding = false;
        emit(kernel, ID, 'tip.lost', { t, src: ID, lastSeen: event.lastSeen !== undefined ? p.start + event.lastSeen : (p.lastSample ?? undefined) }, t);
        break;
      case 'voice.incantation':
        emit(kernel, ID, 'voice.incantation', {
          t,
          text: event.text,
          conf: event.conf,
          final: event.final,
          ...(event.spellId !== undefined ? { spellId: event.spellId } : {}),
          ...(event.id !== undefined ? { id: `${p.prefix}${event.id}` } : {}),
          ...(event.t0 !== undefined ? { t0: p.start + event.t0 } : {}),
          ...(event.t1 !== undefined ? { t1: p.start + event.t1 } : {}),
        }, t);
        break;
    }
    if (!synthetic) p.played++;
  }

  /** Sleep, unless the playback is cancelled first. Timers only wake the loop (contracts/module.ts). */
  function wait(p: Playback, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (p.cancelled || ms <= 0) return resolve();
      const timer = setTimeout(() => {
        p.wake = null;
        resolve();
      }, ms);
      p.wake = () => {
        clearTimeout(timer);
        p.wake = null;
        resolve();
      };
    });
  }

  /** Publish every step when it is due. What goes out is decided by comparing due times with
   *  kernel.now(), so a timer that fires late never reorders or drops anything. */
  async function run(p: Playback): Promise<void> {
    const steps = p.plan.steps;
    while (p.next < steps.length && !p.cancelled) {
      const ahead = dueAt(p.start, steps[p.next].t, p.speed) - now();
      if (ahead > 0) {
        await wait(p, Math.ceil(ahead));
        continue;
      }
      while (p.next < steps.length && !p.cancelled && dueAt(p.start, steps[p.next].t, p.speed) <= now()) {
        const step = steps[p.next++];
        publishStep(p, step.event, !!step.synthetic);
      }
    }
    // The tail: the segmenter and the engine finish the last stroke while this tracker is still the source.
    if (!p.cancelled) await wait(p, tailMs(p.speed));
  }

  /** Stop publishing; the tip is let go if it is held (rule 3). */
  function cancel(p: Playback): void {
    if (p.cancelled) return;
    p.cancelled = true;
    if (p.holding) {
      p.holding = false;
      const t = p.lastSample !== null ? Math.max(now(), p.lastSample) : now();
      emit(kernel, ID, 'tip.lost', { t, src: ID, lastSeen: p.lastSample ?? undefined }, t);
    }
    p.wake?.();
  }

  async function play(payload: { session: unknown; speed?: number } | undefined): Promise<{ played: number }> {
    let plan: ReplayPlan;
    try {
      plan = planSession(payload?.session);
    } catch (err) {
      if (err instanceof ReplayInputError) throw err;
      throw new ReplayInputError('That recording could not be read.');
    }
    if (playback || pending) {
      const busy = new Error('A recorded session is already playing. Stop it first.');
      busy.name = 'InvalidStateError';
      throw busy;
    }
    const speed = normalizeSpeed(payload?.speed);
    if (plan.skipped) log.info(`skipping ${plan.skipped} events the replay cannot use`);

    // Step 1. The kernel stops the player's tracker (which publishes its tip.lost) and starts this one.
    pending = plan;
    try {
      await ask(kernel, 'modules.activate', { kind: 'tracker', id: ID, transient: true });
    } finally {
      pending = null;
    }

    const p: Playback = {
      plan, speed, prefix: `replay${++plays}:`, start: now(), next: 0, played: 0,
      holding: false, lastSample: null, cancelled: false, wake: null,
    };
    playback = p;
    try {
      // Step 2: the session's aspect and pen before any tip event. (When the kernel itself is not running,
      // activation cannot start this module; the session still plays, status first.)
      publishStatus('tracking', plan, plan.pen, 'Playing a recorded session');
      await run(p);
      // Step 4: back to pen false, so a consumer keeping this status does not expect more pen strokes.
      if (active) publishStatus('searching', plan, false);
      return { played: p.played };
    } finally {
      playback = null;
      // Resolve first, then hand the tracker slot back (contracts/requests.ts 'replay.play'): starting the
      // player's tracker may take a while (a camera opening), and the caller need not wait for it.
      void Promise.resolve().then(() =>
        ask(kernel, 'modules.release', { kind: 'tracker', id: ID }).catch((err) => log.warn('could not hand the tracker back', err)),
      );
    }
  }

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      // Requests from init(), so the Workshop and tests can play a session from their start() on.
      serve(kernel, 'replay.play', (payload) => play(payload));
      serve(kernel, 'replay.stop', () => {
        if (playback) cancel(playback);
      });
    },

    async start() {
      if (active) return;
      active = true;
      // Rule 1: a status (aspect and pen) after start() and before any tip event. While a playback waits
      // for this activation, the status already carries the session's shape.
      if (pending) publishStatus('starting', pending, pending.pen, 'Playing a recorded session');
      else publishStatus('searching', null, false, 'Nothing to replay');
    },

    async stop() {
      if (!active) return;
      // Another tracker took over, or the app is stopping: the playback ends here, tip.lost first (rule 3).
      const p = playback;
      if (p) cancel(p);
      active = false;
      publishStatus('stopped', p?.plan ?? null, false);
    },
  };
}
