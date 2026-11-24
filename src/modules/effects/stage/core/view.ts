// Mapping between caster space and the stage's canvases (types.ts StageView).
//
// Caster space is the whole camera frame as shown in the mirror (contracts/v1.ts, 1.1 rules).
// The canvases cover the whole mirror element; caster space maps onto `caster`, the rectangle the
// video occupies with object-fit: contain. Normally the shell gives the mirror the camera's aspect,
// so `caster` is the whole mirror; otherwise it is letterboxed, and so is the video, so the trail
// always sits on the reflection (StageSurface.caster).

import type { StageView } from '../types';

export interface CasterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle a frame of `aspect` (width ÷ height) occupies inside a box, as object-fit: contain. */
export function fitCaster(boxWidth: number, boxHeight: number, aspect: number): CasterRect {
  const w = Math.max(0, boxWidth), h = Math.max(0, boxHeight);
  if (!(aspect > 0) || w === 0 || h === 0) return { x: 0, y: 0, width: w, height: h };
  if (w / h > aspect) {
    const width = h * aspect;
    return { x: (w - width) / 2, y: 0, width, height: h };
  }
  const height = w / aspect;
  return { x: 0, y: (h - height) / 2, width: w, height };
}

export type StageQuality = 'auto' | 'high' | 'low';

/** Canvas pixels per CSS pixel for setting 'stage.quality': high 2, low 1, auto min(devicePixelRatio, 1.5). */
export function pixelRatioFor(quality: StageQuality | string, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (quality === 'high') return 2;
  if (quality === 'low') return 1;
  return Math.min(dpr, 1.5);
}

/** The stage's StageView. Mutable so the core can update it on resize without reallocating. */
export class View implements StageView {
  width = 0;
  height = 0;
  dpr = 1;
  /** Caster rectangle in CSS px relative to the mirror. */
  caster: CasterRect = { x: 0, y: 0, width: 0, height: 0 };
  /** Width ÷ height of caster space (the camera frame, or the mirror when there is no camera). */
  casterAspect = 16 / 9;

  get aspect(): number {
    return this.height > 0 ? this.width / this.height : 16 / 9;
  }

  /** Returns true when anything changed. */
  update(width: number, height: number, dpr: number, casterAspect: number | null): boolean {
    const aspect = casterAspect && casterAspect > 0 ? casterAspect : height > 0 ? width / height : 16 / 9;
    const caster = fitCaster(width, height, aspect);
    const changed =
      width !== this.width || height !== this.height || dpr !== this.dpr || Math.abs(aspect - this.casterAspect) > 1e-6 ||
      caster.x !== this.caster.x || caster.y !== this.caster.y || caster.width !== this.caster.width || caster.height !== this.caster.height;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.casterAspect = aspect;
    this.caster = caster;
    return changed;
  }

  /** Canvas x pixel for a caster-space x. Allocation-free twin of toPx for hot paths. */
  px(x: number): number {
    return (this.caster.x + x * this.caster.width) * this.dpr;
  }

  /** Canvas y pixel for a caster-space y. */
  py(y: number): number {
    return (this.caster.y + y * this.caster.height) * this.dpr;
  }

  toPx(x: number, y: number): [number, number] {
    return [this.px(x), this.py(y)];
  }

  fromPx(px: number, py: number): [number, number] {
    const cw = this.caster.width || 1, ch = this.caster.height || 1;
    return [(px / this.dpr - this.caster.x) / cw, (py / this.dpr - this.caster.y) / ch];
  }

  /** A fraction of the mirror's height, in canvas pixels (contracts/effects.ts UNITS). */
  size(fraction: number): number {
    return fraction * this.height * this.dpr;
  }

  /** Canvas size in device pixels. */
  get pixelWidth(): number {
    return Math.max(1, Math.round(this.width * this.dpr));
  }

  get pixelHeight(): number {
    return Math.max(1, Math.round(this.height * this.dpr));
  }
}

/** Caster x to isotropic units (multiples of the caster height), and back: shapes and physics use
 *  these so a circle stays round (contracts/v1.ts Stroke.aspect). */
export const isoX = (x: number, aspect: number): number => x * aspect;
export const casterX = (ix: number, aspect: number): number => ix / aspect;
