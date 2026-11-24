// 'tracker.autotune' as a pure planner (Section 10.4 "automatic exposure and threshold"; Appendix A
// step 5 "lower the exposure until the room is nearly black"). The module feeds it one measurement per
// exposure and applies the steps it returns through 'camera.exposure'.
//
// Exposure steps go down by halves (one photographic stop at a time). The planner stops when the room
// is nearly black, or when the tip, once seen, starts to fade (it then goes back one step), or at the
// camera's shortest exposure. Without exposure time it walks exposureCompensation down instead; with
// no exposure control at all it only chooses k and the floor.

import type { CameraExposureInfo } from '../../../contracts';

export interface Measure {
  mean: number;
  std: number;
  backgroundMax: number;
  tipLevel: number | null;
}

export type Exposure = { mode: 'manual'; time: number } | { mode: 'continuous'; compensation: number };

export type AutotuneStep =
  | { kind: 'set'; exposure: Exposure }
  | { kind: 'done'; exposure: Exposure | null; k: number; floor: number; measure: Measure; tipSeen: boolean; control: 'time' | 'compensation' | 'none' };

/** "Nearly black": the room averages under this level, and nothing outside the mask is brighter than backgroundDark. */
export const ROOM_DARK = { mean: 12, backgroundMax: 90 };
/** Below this the tip has faded too far to trust: go back one step. */
export const TIP_MIN_LEVEL = 140;
export const MAX_STEPS = 10;

/** The exposure time to start from when the camera does not report one: 1/30 s in 100 µs units. */
const DEFAULT_START_TIME = 333;

export class AutotunePlanner {
  readonly control: 'time' | 'compensation' | 'none';
  private steps = 0;
  private current: Exposure | null;
  private previous: { exposure: Exposure; measure: Measure } | null = null;
  private tipSeen = false;

  constructor(
    private info: CameraExposureInfo | null,
    start: { time?: number; compensation?: number },
    private floorNow: number,
  ) {
    if (info && info.modes.includes('manual') && info.min !== undefined && info.max !== undefined) {
      this.control = 'time';
      const t = start.time ?? info.time ?? DEFAULT_START_TIME;
      this.current = { mode: 'manual', time: clamp(t, info.min, info.max) };
    } else if (info?.compensation) {
      this.control = 'compensation';
      const c = start.compensation ?? 0;
      this.current = { mode: 'continuous', compensation: clamp(c, info.compensation.min, info.compensation.max) };
    } else {
      this.control = 'none';
      this.current = null;
    }
  }

  /** The exposure to set before the first measurement (null when there is no control). */
  first(): Exposure | null {
    return this.current;
  }

  /** Feed the measurement taken at the current exposure; returns what to do next. */
  next(m: Measure): AutotuneStep {
    this.steps++;
    const tipNow = m.tipLevel !== null && m.tipLevel >= TIP_MIN_LEVEL;
    if (tipNow) this.tipSeen = true;
    if (this.control === 'none' || !this.current) return this.done(null, m);

    // The tip was bright at the last step and has faded now: that step was the right one.
    if (this.previous && this.previous.measure.tipLevel !== null && this.previous.measure.tipLevel >= TIP_MIN_LEVEL && !tipNow) {
      return this.done(this.previous.exposure, this.previous.measure);
    }
    const dark = m.mean <= ROOM_DARK.mean && m.backgroundMax <= ROOM_DARK.backgroundMax;
    const lower = this.lower(this.current);
    if (dark || !lower || this.steps >= MAX_STEPS) return this.done(this.current, m);
    this.previous = { exposure: this.current, measure: m };
    this.current = lower;
    return { kind: 'set', exposure: lower };
  }

  /** One stop darker, or null at the end of the range. */
  private lower(e: Exposure): Exposure | null {
    const info = this.info!;
    if (e.mode === 'manual') {
      const min = info.min ?? 1;
      if (e.time <= min) return null;
      const step = info.step && info.step > 0 ? info.step : 1;
      const next = Math.max(min, Math.round(e.time / 2 / step) * step);
      return next < e.time ? { mode: 'manual', time: next } : null;
    }
    const comp = info.compensation!;
    if (e.compensation <= comp.min) return null;
    const step = Math.max(comp.step > 0 ? comp.step : 0.5, 0.5);
    return { mode: 'continuous', compensation: Math.max(comp.min, roundTo(e.compensation - step, comp.step > 0 ? comp.step : 0.01)) };
  }

  private done(exposure: Exposure | null, m: Measure): AutotuneStep {
    return { kind: 'done', exposure, ...chooseThreshold(m, this.floorNow), measure: m, tipSeen: this.tipSeen || (m.tipLevel !== null && m.tipLevel >= TIP_MIN_LEVEL), control: this.control };
  }
}

/**
 * Pick k and the floor from what the camera sees at the chosen exposure. k puts mean + k·std just above
 * the brightest background (so the adaptive part of the threshold clears it when the room brightens);
 * with the tip in view the floor sits halfway between the background and the tip, which leaves room for
 * the tip to dim with distance (Appendix A step 7).
 */
export function chooseThreshold(m: Measure, floorNow: number): { k: number; floor: number } {
  const std = Math.max(1, m.std);
  const k = clamp(Math.round(((m.backgroundMax - m.mean) / std + 1) * 2) / 2, 3, 8);
  let floor = floorNow;
  if (m.tipLevel !== null && m.tipLevel >= TIP_MIN_LEVEL) {
    floor = clamp(Math.round((m.backgroundMax + m.tipLevel) / 2), 60, 240);
  }
  return { k, floor };
}

/** The plain sentence for the Wand tuning screen (Section 10.5: instructions stay plain). */
export function autotuneMessage(step: Extract<AutotuneStep, { kind: 'done' }>, contrast: number | null): string {
  const prefix = step.control === 'none' ? 'This camera does not let Spellglass set its exposure, so only the threshold was tuned. ' : '';
  if (!step.tipSeen || contrast === null) {
    return `${prefix}The threshold is set, but the tip was not in view. Point the tip at the camera with the light on, then tune again.`;
  }
  const c = contrast.toFixed(1);
  if (contrast >= 3) return `${prefix}Tuned. The tip is ${c} times brighter than the brightest background.`;
  return `${prefix}Tuned, but the tip is only ${c} times brighter than the brightest background. Dim the room, or move the light closer to the lens.`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}
