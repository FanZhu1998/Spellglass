// The One Euro filter (Casiez, Roussel and Vogel, CHI 2012; https://gery.casiez.net/1euro/), the
// adaptive low-pass of Section 7.4: it smooths hard while the tip is slow (no jitter at rest) and
// backs off as the tip speeds up (little lag while tracing).
//
// Two pieces:
//  - OneEuroFilter: the textbook filter for one axis, exactly as the paper writes it.
//  - TipFilter: filters a TipSample in isotropic frame-width units, with one cutoff for both axes.
//
// UNITS. Caster space is normalized per axis (x in frame widths, y in frame heights), so a speed in
// caster units means different things along x and y. TipFilter works in frame widths on both axes
// (x, y ÷ aspect), the units of the segmenter's radii, so `beta` multiplies the tip's speed in frame
// widths per second and a circle in the air is smoothed like a circle. The cutoffs are in Hz. (The
// contract review suggested x × aspect, frame heights on both axes: the same filter, with beta
// divided by the aspect, so beta 20 here is 11.25 there at 16:9.)
//
// ONE CUTOFF FOR BOTH AXES. Run separately, each axis would take its cutoff from its own speed: an
// axis that momentarily stands still (the top of an arch, the sides of a circle, any stroke along
// the other axis) would be smoothed hard while the other is not, which rounds corners and squashes
// curves. TipFilter keeps each axis's own state, as the paper does, but takes the cutoff from the
// speed of the 2D motion, so both axes are smoothed alike at every instant. For motion along one
// axis it is exactly the per-axis filter (filter.test.ts checks this). On the synthetic data in
// filter.test.ts it lags less on diagonals (16 ms against 20 ms at 0.3 frame widths per second) and
// keeps circles round.

import type { TipSample } from '../../contracts';

/** The filter's parameters (settings 'filter.minCutoff', 'filter.beta', 'filter.dCutoff'). */
export interface OneEuroParams {
  /** Hz. The cutoff while the tip is still: lower is steadier at rest, but slow motion lags more. */
  minCutoff: number;
  /** How much the cutoff rises with speed, Hz per (unit per second). Higher means less lag at speed. */
  beta: number;
  /** Hz. Cutoff of the low-pass on the speed estimate (the paper uses 1 Hz). */
  dCutoff: number;
}

/** A smaller step than this (duplicate or reordered timestamps) is treated as this, so the speed
 *  estimate stays finite. Pointer events can share a timestamp. */
export const MIN_DT_MS = 1;

/** Smoothing factor α of a first-order low-pass with this cutoff, for a step of dtSec seconds:
 *  α = 1 / (1 + τ / Te) with τ = 1 / (2π · cutoff), as in the paper. */
export function smoothingFactor(dtSec: number, cutoffHz: number): number {
  const r = 2 * Math.PI * Math.max(0, cutoffHz) * dtSec;
  return r / (r + 1);
}

/** The textbook One Euro filter for one axis, driven by sample timestamps (ms). */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(private params: OneEuroParams) {}

  setParams(params: OneEuroParams): void {
    this.params = params;
  }

  /** The filtered speed estimate (units per second) that `value` at `tMs` would give, without
   *  changing the filter. TipFilter combines the two axes' estimates into one speed. */
  derivativeOf(value: number, tMs: number): number {
    if (this.x === null) return 0;
    const dt = stepSeconds(tMs - this.t);
    // The paper's derivative: the new value against the previous *filtered* value, low-passed.
    const raw = (value - this.x) / dt;
    const a = smoothingFactor(dt, this.params.dCutoff);
    return a * raw + (1 - a) * this.dx;
  }

  /**
   * Filter one value captured at tMs. The cutoff is minCutoff + beta · speed, where speed is this
   * axis's own filtered speed (the textbook filter) unless the caller passes one: TipFilter passes
   * the speed of the 2D motion.
   */
  filter(value: number, tMs: number, speed?: number): number {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = tMs;
      return value;
    }
    const dt = stepSeconds(tMs - this.t);
    const dx = this.derivativeOf(value, tMs);
    const cutoff = this.params.minCutoff + this.params.beta * (speed ?? Math.abs(dx));
    const a = smoothingFactor(dt, cutoff);
    this.x = a * value + (1 - a) * this.x;
    this.dx = dx;
    // Never step the clock backwards: a reordered sample is filtered as if it came 1 ms later.
    this.t = Math.max(tMs, this.t + MIN_DT_MS);
    return this.x;
  }

  /** Forget the history: the next value passes through unchanged. */
  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  /** No value has been filtered since the last reset. */
  get empty(): boolean {
    return this.x === null;
  }
}

/** A TipSample's position filtered in isotropic frame-width units, with one cutoff for both axes. */
export class TipFilter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(params: OneEuroParams) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
  }

  setParams(params: OneEuroParams): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
  }

  /** The filtered sample: same t, src and every other field; only x and y change. `aspect` is the
   *  width ÷ height of the sample's caster space. */
  filter(sample: TipSample, aspect: number): TipSample {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
    const u = sample.x;          // frame widths
    const v = sample.y / a;      // frame heights → frame widths
    const speed = Math.hypot(this.fx.derivativeOf(u, sample.t), this.fy.derivativeOf(v, sample.t));
    const fu = this.fx.filter(u, sample.t, speed);
    const fv = this.fy.filter(v, sample.t, speed);
    return { ...sample, x: fu, y: fv * a };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  get empty(): boolean {
    return this.fx.empty;
  }
}

function stepSeconds(dtMs: number): number {
  return Math.max(MIN_DT_MS, dtMs) / 1000;
}
