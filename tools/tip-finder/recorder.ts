// "Record 10 s" on the tip-finder page: tip events in the RecordedSession fixture format
// (contracts/session.ts), so the sessions saved during Appendix A become test fixtures (Section 14, M0:
// "three short sessions are saved as fixtures"). Pure, so it is tested in Node.

import type { RecordedSession, SessionEvent } from '../../src/contracts';
import { SESSION_SCHEMA } from '../../src/contracts';

export interface RecordedTip {
  /** Capture time on the page's clock (performance.now()). */
  t: number;
  x: number;
  y: number;
  conf: number;
  size?: number;
  frame?: number;
}

export interface SessionMeta {
  id: string;
  title?: string;
  intended?: string;
  aspect: number;
  /** Only the settings that differ from the defaults. */
  settings?: Record<string, unknown>;
  camera?: RecordedSession['camera'];
  recordedAt?: Date;
}

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

export class SessionRecorder {
  private readonly events: SessionEvent[] = [];
  private open = false;
  private lastSampleT: number | null = null;

  constructor(readonly start: number) {}

  get count(): number {
    return this.events.length;
  }

  found(s: RecordedTip): void {
    if (this.open) return;
    this.open = true;
    this.events.push({ type: 'tip.found', t: this.rel(s.t), x: round(s.x, 5), y: round(s.y, 5), conf: round(s.conf, 3), frame: s.frame });
  }

  sample(s: RecordedTip): void {
    // A recording that starts while the tip is held opens with tip.found, so it plays back on its own.
    if (!this.open) this.found(s);
    this.lastSampleT = s.t;
    this.events.push({
      type: 'tip.sample', t: this.rel(s.t), x: round(s.x, 5), y: round(s.y, 5), conf: round(s.conf, 3),
      size: s.size === undefined ? undefined : round(s.size, 6), frame: s.frame,
    });
  }

  lost(t: number): void {
    if (!this.open) return;
    this.open = false;
    this.events.push({ type: 'tip.lost', t: this.rel(t), lastSeen: this.lastSampleT === null ? undefined : this.rel(this.lastSampleT) });
  }

  /** Close the recording at `end` (a tip still held is lost there) and build the fixture. */
  finish(end: number, meta: SessionMeta): RecordedSession {
    this.lost(end);
    const session: RecordedSession = {
      schema: SESSION_SCHEMA,
      id: meta.id,
      recordedAt: (meta.recordedAt ?? new Date()).toISOString(),
      tracker: 'tracker.bright-tip',
      aspect: round(meta.aspect, 6),
      pen: false,
      events: this.events.map((e) => JSON.parse(JSON.stringify(e)) as SessionEvent),
      // The tip-finder does not cast: a fixture's expected casts are added when it is labelled.
      expected: [],
    };
    if (meta.title) session.title = meta.title;
    if (meta.intended) session.intended = meta.intended;
    if (meta.settings && Object.keys(meta.settings).length) session.settings = meta.settings;
    if (meta.camera) session.camera = meta.camera;
    return session;
  }

  private rel(t: number): number {
    return round(Math.max(0, t - this.start), 2);
  }
}

// ---------------------------------------------------------------------------------------- exposure slider

/** Exposure times span four orders of magnitude, so the slider is logarithmic (0..1000). */
export function sliderToTime(v: number, min: number, max: number): number {
  const lo = Math.max(min, 1e-3), hi = Math.max(lo, max);
  const f = Math.min(1, Math.max(0, v / 1000));
  return lo * (hi / lo) ** f;
}

export function timeToSlider(time: number, min: number, max: number): number {
  const lo = Math.max(min, 1e-3), hi = Math.max(lo * 1.0001, max);
  const t = Math.min(hi, Math.max(lo, time));
  return Math.round((Math.log(t / lo) / Math.log(hi / lo)) * 1000);
}

/** 100 µs units as a readable duration: '0.4 ms', '12 ms', '1/30 s' style is not needed here. */
export function formatExposure(time: number): string {
  const ms = time / 10;
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}
