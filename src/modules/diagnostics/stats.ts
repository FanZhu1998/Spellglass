// Live numbers for the diagnostics overlay (Section 13 budgets, Section 2 targets): event rates by type,
// how long the app takes to decide once a stroke ends (target: 50 ms or less), and how far the trail lags
// behind the camera (target: 150 ms or less at 30 fps). Pure: the module feeds it kernel times.

import type { DiagnosticsStats, EventType } from '../../contracts';

/** Every event type in contracts/events.ts EventMap. Typed as a full record, so a new event type in the
 *  contracts fails the type check here until it is added (and counted). diagnostics.stats itself is
 *  left out: counting the meter's own output says nothing. */
const COUNTED_TYPES: Record<EventType, boolean> = {
  'tip.sample': true,
  'tip.found': true,
  'tip.lost': true,
  'tracker.status': true,
  'tracker.debug': true,
  'camera.ready': true,
  'camera.frame': true,
  'camera.error': true,
  'camera.stopped': true,
  'camera.status': true,
  'stroke.begin': true,
  'stroke.end': true,
  'tip.filtered': true,
  'segmenter.state': true,
  'recognition.result': true,
  'voice.incantation': true,
  'voice.status': true,
  'spell.cast': true,
  'spell.fizzle': true,
  'spell.ended': true,
  'spell.pending': true,
  'practice.attempt': true,
  'practice.focus': true,
  'practice.guide': true,
  'effect.start': true,
  'effect.end': true,
  'scene.props': true,
  'stage.surface': true,
  'stage.steering': true,
  'replay.state': true,
  'audio.caption': true,
  'share.clip.state': true,
  'pack.loaded': true,
  'pack.failed': true,
  'spellbook.changed': true,
  'progress.changed': true,
  'storage.status': true,
  'storage.changed': true,
  'settings.changed': true,
  'module.status': true,
  'diagnostics.stats': false,
  'app.update-ready': true,
};

export const RATE_TYPES: readonly EventType[] = (Object.keys(COUNTED_TYPES) as EventType[]).filter((t) => COUNTED_TYPES[t]);

/** Strokes waiting for their decision are forgotten after this long (a stroke that is never decided). */
const STROKE_MEMORY_MS = 10_000;
const LATENCY_WINDOW_MS = 1000;

export class StatsMeter {
  private counts = new Map<string, number>();
  private since: number;
  private strokeEnds = new Map<string, number>();
  private lastDecisionMs: number | undefined;
  private latencies: { at: number; ms: number }[] = [];

  constructor(now: number) {
    this.since = now;
  }

  /** One event of `type` was published. */
  count(type: string): void {
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }

  /** stroke.end arrived at kernel time `at`. */
  strokeEnded(strokeId: string, at: number): void {
    this.strokeEnds.set(strokeId, at);
    if (this.strokeEnds.size > 64) this.forget(at);
  }

  /** The cast or fizzle for a stroke arrived at kernel time `at`: decisionMs (kernel clock). */
  decided(strokeId: string | undefined, at: number): void {
    if (!strokeId) return;
    const ended = this.strokeEnds.get(strokeId);
    if (ended === undefined) return;
    this.strokeEnds.delete(strokeId);
    this.lastDecisionMs = Math.max(0, at - ended);
  }

  /** A tip.filtered with capture time `captureT` was published at kernel time `at`. */
  filtered(captureT: number, at: number): void {
    if (!Number.isFinite(captureT)) return;
    this.latencies.push({ at, ms: at - captureT });
    // Keep only the last second (and never an unbounded list between snapshots).
    while (this.latencies.length && at - this.latencies[0].at > LATENCY_WINDOW_MS) this.latencies.shift();
  }

  /** The numbers for the last interval; counting starts again. */
  snapshot(now: number, recording: boolean): DiagnosticsStats {
    const seconds = Math.max(0.001, (now - this.since) / 1000);
    const rates: Record<string, number> = {};
    for (const [type, n] of this.counts) rates[type] = Math.round((n / seconds) * 10) / 10;
    this.counts.clear();
    this.since = now;
    while (this.latencies.length && now - this.latencies[0].at > LATENCY_WINDOW_MS) this.latencies.shift();
    const lat = median(this.latencies.map((l) => l.ms));
    this.forget(now);
    const out: DiagnosticsStats = { t: now, rates, recording };
    if (this.lastDecisionMs !== undefined) out.decisionMs = Math.round(this.lastDecisionMs * 10) / 10;
    if (lat !== undefined) out.trailLatencyMs = Math.round(lat * 10) / 10;
    return out;
  }

  private forget(now: number): void {
    for (const [id, at] of this.strokeEnds) if (now - at > STROKE_MEMORY_MS) this.strokeEnds.delete(id);
  }
}

export function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
