// Diagnostics (diagnostics.recorder): records sessions in the fixture format and publishes live numbers
// for the Workshop's diagnostics overlay (Section 10.4 Workshop; Section 13: "The diagnostics overlay in the
// Workshop screen records sessions in the fixture format").
//
// Requests (registered in init()):
//   'session.record.start' {title?, intended?}  begin recording now (t0 = kernel.now()).
//   'session.record.label' {spellId}            change the intended spell mid-recording.
//   'session.record.stop'                       finish: waits briefly for strokes still being decided,
//                                               returns the RecordedSession and stores it in the
//                                               'sessions' store when storage is present.
// A recording also stops on its own when the recorded tracker stops or another takes over (a session is
// one tracker); the next 'session.record.stop' then returns what was recorded up to that moment.
//
// Events: 'diagnostics.stats' once a second (stats.ts): rates by type, decisionMs, trailLatencyMs and
// whether a recording runs. The module subscribes to specific event types, never '*'.

import type { CameraStatus, FizzleReason, Kernel, Module, ModuleManifest, RecordedSession, TrackerStatus } from '../../contracts';
import { DEFAULT_SETTINGS } from '../../contracts';
import { ask, checkSession, emit, KernelError, lastPayload, logger, newId, on, serve, setting, stableHash } from '../../kernel';
import { REPLAY_TRACKER, SessionRecorder, type StopReason } from './recorder';
import { RATE_TYPES, StatsMeter } from './stats';

export const MANIFEST: ModuleManifest = {
  id: 'diagnostics.recorder',
  kind: 'diagnostics',
  title: 'Diagnostics',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['diagnostics@1'],
  requires: [],
};

const ID = MANIFEST.id;
const log = logger(ID);

const STATS_EVERY_MS = 1000;
/** On stop, strokes still being decided get this long (the engine's evaluate timeout is 1.5 s). */
const DECISION_WAIT_MS = 2000;

/** Settings that shape what the pipeline decides (contracts/session.ts RecordedSession.settings). Others
 *  (theme, sound, the camera's device id) say nothing about a recording and stay out of shared files. */
export function isPipelineSetting(key: string): boolean {
  return /^(filter|segmenter|recognizer|engine|spells|hand|brightTip)\./.test(key) ||
    key === 'playArea' || key === 'capture.flipX' || key === 'access.leftHanded' || key === 'packs.enabled' || key === 'voice.minConf';
}

/** The pipeline settings whose values differ from the defaults. */
export function pipelineSettings(all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const key of Object.keys(all).sort()) {
    if (!isPipelineSetting(key)) continue;
    const value = all[key];
    if (value === undefined) continue;
    if (key in defaults && stableHash(value) === stableHash(defaults[key])) continue;
    out[key] = value;
  }
  return out;
}

/** The camera, as a session records it (contracts/session.ts RecordedSession.camera). */
export function cameraOf(c: CameraStatus | undefined): RecordedSession['camera'] | undefined {
  if (!c || c.state !== 'on' || !c.width || !c.height) return undefined;
  const cam: NonNullable<RecordedSession['camera']> = {
    label: (c.label ?? '').slice(0, 200),
    width: c.width,
    height: c.height,
    fps: Math.round((c.fps ?? 0) * 10) / 10,
  };
  if (c.exposure?.mode) cam.exposure = c.exposure.time !== undefined ? { mode: c.exposure.mode, time: c.exposure.time } : { mode: c.exposure.mode };
  return cam;
}

function stateError(message: string): Error {
  const err = new Error(message);
  err.name = 'InvalidStateError';
  return err;
}

export function createDiagnosticsModule(): Module {
  let kernel: Kernel;
  let running = false;
  let offs: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stats: StatsMeter;

  let recorder: SessionRecorder | null = null;
  /** Recordings that stopped and wait for the decisions of their last strokes. */
  const closing = new Map<SessionRecorder, () => void>();
  /** A recording that stopped on its own, kept for the next 'session.record.stop'. */
  let stoppedOnItsOwn: Promise<RecordedSession> | null = null;

  /** The tracker that is running now: the latest status that is not 'stopped'. */
  let activeStatus: TrackerStatus | null = null;
  /** Where each tracker's tip is while it holds one, for the tip.found at t = 0. */
  const held = new Map<string, { x: number; y: number; conf: number }>();

  const now = () => kernel.now();

  function publishStats(): void {
    if (!running) return;
    emit(kernel, ID, 'diagnostics.stats', stats.snapshot(now(), recorder !== null));
  }

  // ---------------------------------------------------------------------------------- recording

  function enabledSpells(): string[] | undefined {
    const book = lastPayload(kernel, 'spellbook.changed');
    return book ? book.spells.filter((e) => e.enabled).map((e) => e.spell.id) : undefined;
  }

  async function start(p: { title?: string; intended?: string } | undefined): Promise<void> {
    if (!running) throw stateError('Diagnostics is not running.');
    if (recorder) throw stateError('A recording is already running. Stop it first.');
    stoppedOnItsOwn = null;
    const status = activeStatus && activeStatus.tracker !== REPLAY_TRACKER ? activeStatus : null;
    // Created before anything is awaited, so every event from this moment on is captured.
    const rec = new SessionRecorder({
      id: newId('session'),
      t0: now(),
      recordedAt: new Date().toISOString(),
      title: typeof p?.title === 'string' ? p.title : undefined,
      intended: typeof p?.intended === 'string' && p.intended ? p.intended : null,
      status,
      heldTip: status ? held.get(status.tracker) ?? null : null,
      enabledSpells: enabledSpells(),
      camera: cameraOf(lastPayload(kernel, 'camera.status')),
    });
    recorder = rec;
    publishStats();
    try {
      rec.setSettings(pipelineSettings(await ask(kernel, 'settings.all')));
    } catch (err) {
      log.warn('could not read the settings for the recording', err);
    }
  }

  /** Stop taking events, wait for the strokes still being decided, then build and store the session. */
  async function finish(rec: SessionRecorder, why: StopReason | 'requested' | 'stopped'): Promise<RecordedSession> {
    rec.close();
    if (recorder === rec) recorder = null;
    publishStats();
    if (why !== 'requested') log.info(`recording stopped (${why})`);
    if (rec.pending > 0 && running) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(done, DECISION_WAIT_MS);
        function done(): void {
          clearTimeout(timeout);
          closing.delete(rec);
          resolve();
        }
        closing.set(rec, done);
      });
    }
    const session = rec.finish(String(setting(kernel, 'tracker.active') || 'unknown'));
    const check = checkSession(session);
    if (!check.ok) log.warn('the recording does not match the session format', check.reason);
    try {
      await ask(kernel, 'storage.put', { store: 'sessions', key: session.id, value: session });
    } catch (err) {
      // Storage is optional (Section 7.9: runs without saving and says so; the storage module reports it).
      if (!(err instanceof KernelError && err.code === 'no-handler')) log.warn('could not store the recording', err);
    }
    return session;
  }

  async function stopRequest(): Promise<RecordedSession> {
    if (recorder) return finish(recorder, 'requested');
    if (stoppedOnItsOwn) {
      const s = stoppedOnItsOwn;
      stoppedOnItsOwn = null;
      return s;
    }
    throw stateError('Nothing is being recorded.');
  }

  /** A decision arrived: closing recordings may now be complete. */
  function decided(d: { strokeId?: string; spellId: string | null; t: number; replay?: boolean; reason?: FizzleReason }): void {
    recorder?.decision(d);
    for (const [rec, done] of closing) {
      rec.decision(d);
      if (rec.pending === 0) done();
    }
  }

  function onStatus(s: TrackerStatus): void {
    if (s.state === 'stopped') {
      if (activeStatus?.tracker === s.tracker) activeStatus = null;
      held.delete(s.tracker);
    } else {
      activeStatus = s;
    }
    const rec = recorder;
    if (!rec) return;
    const reason = rec.status(s);
    if (reason) {
      // Keep the finished session for the next 'session.record.stop'.
      const done = finish(rec, reason);
      stoppedOnItsOwn = done;
      done.catch((err) => log.warn('could not finish the recording', err));
    }
  }

  // ---------------------------------------------------------------------------------- lifecycle

  function subscribe(): void {
    const k = kernel;
    offs = [
      ...RATE_TYPES.map((type) => on(k, type, () => stats.count(type))),
      on(k, 'tracker.status', onStatus),
      on(k, 'tip.found', (s, e) => {
        held.set(s.src, { x: s.x, y: s.y, conf: s.conf });
        recorder?.tip('tip.found', s, e.source);
      }),
      on(k, 'tip.sample', (s, e) => {
        held.set(s.src, { x: s.x, y: s.y, conf: s.conf });
        recorder?.tip('tip.sample', s, e.source);
      }),
      on(k, 'tip.lost', (p, e) => {
        held.delete(p.src);
        recorder?.lost(p, e.source);
      }),
      on(k, 'voice.incantation', (inc, e) => recorder?.voice(inc, e.source)),
      on(k, 'stroke.end', (stroke) => {
        stats.strokeEnded(stroke.id, now());
        recorder?.strokeEnd(stroke);
      }),
      on(k, 'spell.cast', (c) => {
        stats.decided(c.strokeId, now());
        decided({ strokeId: c.strokeId, spellId: c.spellId, t: c.t, replay: c.replay });
      }),
      on(k, 'spell.fizzle', (f) => {
        stats.decided(f.strokeId, now());
        decided({ strokeId: f.strokeId, spellId: null, t: f.t, reason: f.reason });
      }),
      on(k, 'tip.filtered', (s) => stats.filtered(s.t, now())),
      on(k, 'camera.status', (c) => recorder?.setCamera(cameraOf(c))),
    ];
  }

  /** Pick up what happened before this module started (a restart, say). */
  function readSticky(): void {
    const s = lastPayload(kernel, 'tracker.status');
    activeStatus = s && s.state !== 'stopped' ? s : null;
    const sample = lastPayload(kernel, 'tip.sample');
    const lost = lastPayload(kernel, 'tip.lost');
    if (sample && !(lost && lost.src === sample.src && lost.t >= sample.t)) held.set(sample.src, { x: sample.x, y: sample.y, conf: sample.conf });
  }

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      stats = new StatsMeter(k.now());
      serve(k, 'session.record.start', (p) => start(p));
      serve(k, 'session.record.label', (p) => {
        recorder?.label(typeof p?.spellId === 'string' && p.spellId ? p.spellId : null);
      });
      serve(k, 'session.record.stop', () => stopRequest());
    },

    async start() {
      if (running) return;
      running = true;
      stats = new StatsMeter(now());
      readSticky();
      subscribe();
      timer = setInterval(publishStats, STATS_EVERY_MS);
    },

    async stop() {
      if (!running) return;
      // A recording in progress is finished and stored rather than lost.
      const rec = recorder;
      running = false;
      if (rec) {
        const done = finish(rec, 'stopped');
        stoppedOnItsOwn = done;
        done.catch((err) => log.warn('could not finish the recording', err));
      }
      // Waiting recordings finish with what they have.
      for (const done of [...closing.values()]) done();
      for (const off of offs) off();
      offs = [];
      if (timer) clearInterval(timer);
      timer = null;
      held.clear();
      activeStatus = null;
    },
  };
}
