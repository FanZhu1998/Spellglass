// Pure parts of the replay tracker: turn a RecordedSession (contracts/session.ts) into a playback plan,
// and decide when each step is due. The module (index.ts) only publishes what the plan says.
//
// Readers are tolerant (Section 9.1 rule 3): unknown event types and malformed events are skipped and
// counted, never fatal. A session is refused only when it is not a session at all, or when it comes from
// a newer major format this build cannot read (Section 9.1 rule 4: migrations run forward, never guess).
//
// The plan also keeps the tip event rules (contracts/events.ts) that a hand-edited or truncated file may
// break, so consumers always see a well-formed stream: a sample while no tip is held gets the tip.found
// it is missing (same t and position), a tip.found while the tip is held and a tip.lost while none is
// held are dropped, and a session that ends with the tip held ends with a tip.lost. The recorder and the
// fixtures never need these repairs, so recorded behavior replays unchanged (Section 9.1 rule 8).

import type { RecordedSession, SessionEvent } from '../../../contracts';
import { SESSION_SCHEMA } from '../../../contracts';

export const DEFAULT_ASPECT = 16 / 9;

/** Time left after the last event before the replay reports itself finished, at speed 1. It covers the
 *  segmenter's pause and the engine's decision for a stroke that ends with the recording. */
export const REPLAY_TAIL_MS = 1000;

/** Fastest pacing accepted; anything above plays at this speed. Speed 0 means "all at once". */
export const MAX_SPEED = 64;

export class ReplayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayInputError';
  }
}

export interface PlanStep {
  /** Recorded time, ms from the start of the session. */
  t: number;
  event: SessionEvent;
  /** Added by the plan to keep the tip event rules (not counted as played). */
  synthetic?: boolean;
}

export interface ReplayPlan {
  aspect: number;
  pen: boolean;
  steps: PlanStep[];
  /** Events taken from the session (steps that are not synthetic). */
  count: number;
  /** Session events left out: unknown types, malformed events, redundant tip state changes. */
  skipped: number;
  /** Recorded time of the last step, ms. */
  endT: number;
  /** Samples per second over the session, for TrackerStatus.fps. */
  sampleRate: number;
}

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read one event, or null when it is unknown or malformed. Optional fields that are malformed are
 *  dropped rather than failing the event. */
export function readEvent(raw: unknown): SessionEvent | null {
  if (!isObj(raw) || typeof raw.type !== 'string' || !num(raw.t)) return null;
  const t = raw.t;
  switch (raw.type) {
    case 'tip.sample':
    case 'tip.found': {
      if (!num(raw.x) || !num(raw.y) || !num(raw.conf)) return null;
      const out: { type: 'tip.sample' | 'tip.found'; t: number; x: number; y: number; conf: number; size?: number; frame?: number } = {
        type: raw.type, t, x: raw.x, y: raw.y, conf: raw.conf,
      };
      if (raw.type === 'tip.sample' && num(raw.size)) out.size = raw.size;
      if (num(raw.frame)) out.frame = raw.frame;
      return out as SessionEvent;
    }
    case 'tip.lost':
      return num(raw.lastSeen) ? { type: 'tip.lost', t, lastSeen: raw.lastSeen } : { type: 'tip.lost', t };
    case 'voice.incantation': {
      if (typeof raw.text !== 'string' || !num(raw.conf) || typeof raw.final !== 'boolean') return null;
      const out: Extract<SessionEvent, { type: 'voice.incantation' }> = { type: 'voice.incantation', t, text: raw.text, conf: raw.conf, final: raw.final };
      if (typeof raw.spellId === 'string') out.spellId = raw.spellId;
      if (typeof raw.id === 'string') out.id = raw.id;
      if (num(raw.t0)) out.t0 = raw.t0;
      if (num(raw.t1)) out.t1 = raw.t1;
      return out;
    }
    default:
      return null;
  }
}

/** Build the playback plan for a session. Throws ReplayInputError with a plain sentence when the input
 *  cannot be played at all. */
export function planSession(input: unknown): ReplayPlan {
  if (!isObj(input)) throw new ReplayInputError('That is not a recorded session.');
  const schema = input.schema;
  if (schema !== undefined && schema !== SESSION_SCHEMA) {
    throw new ReplayInputError(
      typeof schema === 'string' && /^session\/\d+$/.test(schema)
        ? 'This recording comes from a newer version of Spellglass and cannot be played here.'
        : 'That is not a recorded session.',
    );
  }
  if (!Array.isArray(input.events)) throw new ReplayInputError('The recording has no events to play.');

  const aspect = num(input.aspect) && input.aspect > 0 && input.aspect <= 10 ? input.aspect : DEFAULT_ASPECT;
  const pen = input.pen === true;

  // Keep the order of events with equal times (tip.found before the sample of the same frame).
  const events: { e: SessionEvent; i: number }[] = [];
  let skipped = 0;
  input.events.forEach((raw, i) => {
    const e = readEvent(raw);
    if (e) events.push({ e, i });
    else skipped++;
  });
  events.sort((a, b) => a.e.t - b.e.t || a.i - b.i);

  const steps: PlanStep[] = [];
  let holding = false;
  let lastSample: number | null = null;
  let samples = 0;
  for (const { e } of events) {
    switch (e.type) {
      case 'tip.found':
        if (holding) {
          skipped++;
          continue;
        }
        holding = true;
        steps.push({ t: e.t, event: e });
        continue;
      case 'tip.sample':
        if (!holding) {
          holding = true;
          steps.push({ t: e.t, event: { type: 'tip.found', t: e.t, x: e.x, y: e.y, conf: e.conf, ...(e.frame !== undefined ? { frame: e.frame } : {}) }, synthetic: true });
        }
        lastSample = e.t;
        samples++;
        steps.push({ t: e.t, event: e });
        continue;
      case 'tip.lost':
        if (!holding) {
          skipped++;
          continue;
        }
        holding = false;
        steps.push({ t: e.t, event: e });
        continue;
      case 'voice.incantation':
        steps.push({ t: e.t, event: e });
        continue;
    }
  }
  const lastT = steps.length ? steps[steps.length - 1].t : 0;
  if (holding) steps.push({ t: lastT, event: { type: 'tip.lost', t: lastT, ...(lastSample !== null ? { lastSeen: lastSample } : {}) }, synthetic: true });

  const count = steps.filter((s) => !s.synthetic).length;
  const first = steps.length ? steps[0].t : 0;
  const span = (lastT - first) / 1000;
  return {
    aspect,
    pen,
    steps,
    count,
    skipped,
    endT: lastT,
    sampleRate: span > 0 ? Math.round(samples / span) : 0,
  };
}

/** Pacing: 1 by default; 0 publishes everything at once; anything else is clamped to (0, MAX_SPEED]. */
export function normalizeSpeed(speed: unknown): number {
  if (speed === 0) return 0;
  if (!num(speed) || speed < 0) return 1;
  return Math.min(MAX_SPEED, speed);
}

/** Kernel time at which a step recorded at `t` is published. The published capture time is always
 *  start + t (spacing kept); speed changes only when it goes out (contracts/requests.ts 'replay.play'). */
export function dueAt(start: number, t: number, speed: number): number {
  if (speed === 0) return start;
  return start + Math.max(0, t) / speed;
}

/** Wait after the last step before the replay is finished. */
export function tailMs(speed: number): number {
  return speed === 0 ? 0 : REPLAY_TAIL_MS / speed;
}

/** The session's aspect and pen flag, read leniently (for the status before the plan exists). */
export function sessionShape(session: Partial<RecordedSession> | null | undefined): { aspect: number; pen: boolean } {
  const aspect = session && num(session.aspect) && session.aspect > 0 && session.aspect <= 10 ? session.aspect : DEFAULT_ASPECT;
  return { aspect, pen: session?.pen === true };
}
