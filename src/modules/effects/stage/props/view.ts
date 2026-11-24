// A per-frame snapshot of the mapping from caster space to canvas pixels, shared by the shelf and every
// prop. StageView.toPx returns a fresh array per call; reading the mapping once per frame and keeping
// it as plain numbers keeps the drawing hot path free of allocations (task brief: "no allocations per
// frame in hot paths").

import type { StageView } from '../types';

export class ViewCache {
  /** Canvas pixels per mirror height, and per mH (a thousandth of it). */
  pxPerH = 1000;
  pxPerMh = 1;
  /** Caster space to canvas pixels: px = ox + sx·x, py = oy + sy·y (the core letterboxes caster space). */
  ox = 0;
  oy = 0;
  sx = 1778;
  sy = 1000;
  /** Caster units per mirror height, along x and along y: turns sizes into caster distances.
   *  Defaults assume a 16:9 camera filling the mirror until a real view is read. */
  hToX = 9 / 16;
  hToY = 1;
  /** Canvas size in pixels (mirror size × dpr). */
  canvasW = 1778;
  canvasH = 1000;
  /** False until a usable view has been read. */
  ready = false;
  /** Bumps whenever the mapping changes, so drawers can tell when to rebuild what depends on it. */
  revision = 0;
  private stamp = Number.NaN;

  /** Read the view once per frame; `stamp` is the frame's clock, so repeated calls are free. */
  sync(view: StageView, stamp: number): void {
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const [x0, y0] = view.toPx(0, 0);
    const [x1, y1] = view.toPx(1, 1);
    const sx = x1 - x0;
    const sy = y1 - y0;
    const pxPerH = view.size(1);
    // A mirror that is not laid out yet reports zero sizes: keep the last good mapping.
    if (!(sx > 1 && sy > 1 && pxPerH > 1) || !Number.isFinite(sx + sy + pxPerH + x0 + y0)) return;
    const canvasW = view.width * view.dpr;
    const canvasH = view.height * view.dpr;
    if (x0 !== this.ox || y0 !== this.oy || sx !== this.sx || sy !== this.sy || pxPerH !== this.pxPerH ||
      canvasW !== this.canvasW || canvasH !== this.canvasH) this.revision++;
    this.ox = x0;
    this.oy = y0;
    this.sx = sx;
    this.sy = sy;
    this.pxPerH = pxPerH;
    this.pxPerMh = pxPerH / 1000;
    this.hToX = pxPerH / sx;
    this.hToY = pxPerH / sy;
    this.canvasW = canvasW > 0 ? canvasW : this.canvasW;
    this.canvasH = canvasH > 0 ? canvasH : this.canvasH;
    this.ready = true;
  }

  /** Caster x to canvas pixels. */
  px(x: number): number {
    return this.ox + this.sx * x;
  }

  /** Caster y to canvas pixels. */
  py(y: number): number {
    return this.oy + this.sy * y;
  }
}
