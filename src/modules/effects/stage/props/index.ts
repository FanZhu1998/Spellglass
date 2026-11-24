// The shelf of props (Section 7.8, "The stage"): an oak mantel along the bottom of the mirror and six
// objects that give every spell something to act on. This is the props half of the stage module; it
// implements the PropView and Shelf interfaces frozen in ../types.ts and is driven by the stage core.
//
// Props are listed in PROP_IDS order. Each one owns its state machine and its art (procedural Canvas 2D,
// original, no image files) and calls services.propsChanged() when its position, tags or state change.

import { SHELF_LAYOUT } from '../../../../contracts';
import type { FrameInfo, Layers, PropView, Shelf, StageServices } from '../types';
import { defaultCanvasFactory, RepaintGate, type CanvasFactory, type Sprite } from './art/canvas';
import { CommonArtCache } from './art/common';
import { FEATHER_NIB_X } from './art/feather';
import { buildShelfArt, type ShelfMarks } from './art/shelf';
import type { PropEnv } from './base';
import { BoxProp } from './box';
import { Candle } from './candle';
import { Dummy } from './dummy';
import { Feather } from './feather';
import { SHELF_TOP } from './geometry';
import { clamp } from './motion';
import { Plant } from './plant';
import { Teacup } from './teacup';
import { ViewCache } from './view';

export { SHELF_TOP } from './geometry';

export interface ShelfOptions {
  /** Where offscreen sprites come from. The default makes document canvases; tests pass a fake. */
  canvasFactory?: CanvasFactory;
}

export function createShelf(options: ShelfOptions = {}): Shelf {
  const env: PropEnv = {
    view: new ViewCache(),
    canvas: options.canvasFactory ?? defaultCanvasFactory,
    common: new CommonArtCache(),
    repaints: new RepaintGate(),
  };
  const props: PropView[] = [
    new Candle(env), new Feather(env), new BoxProp(env), new Teacup(env), new Plant(env), new Dummy(env),
  ];
  const ledge = new Ledge(env);
  return {
    props,
    drawShelf: (layers, frame, services) => ledge.draw(layers, frame, services),
  };
}

/** The ledge sprite spans the canvas width, so it is repainted when the canvas changes size; while a
 *  window is being dragged the old one is stretched to fit until the size has settled. It carries the
 *  old marks of the props that stand on it (wax, ink, a ring) at their homes, so it is repainted too
 *  when the camera's shape moves those homes. */
class Ledge {
  private sprite: Sprite | null = null;
  private builtRes = 0;
  private builtW = 0;
  private builtBottom = 0;
  private builtCandle = Number.NaN;
  private changedAt = -1;
  private failed = false;
  private readonly marks: ShelfMarks = { candle: 0, nib: 0, teacup: 0 };

  constructor(private readonly env: PropEnv) {}

  draw(layers: Layers, frame: FrameInfo, services: StageServices): void {
    const v = this.env.view;
    v.sync(services.view, frame.now);
    const ctx = layers.shade;
    const canvasW = ctx.canvas?.width || v.canvasW;
    const canvasH = ctx.canvas?.height || v.canvasH;
    const lineY = v.py(SHELF_TOP);
    const res = v.pxPerMh;
    const widthMh = canvasW / res;
    const bottomMh = clamp((canvasH - lineY) / res + 2, 40, 400);
    const m = this.marks;
    m.candle = v.px(SHELF_LAYOUT.candle.x) / res;
    m.nib = v.px(SHELF_LAYOUT.feather.x) / res + FEATHER_NIB_X;
    m.teacup = v.px(SHELF_LAYOUT.teacup.x) / res;
    const stale = !this.sprite || Math.abs(res - this.builtRes) / this.builtRes > 0.02 ||
      Math.abs(widthMh - this.builtW) * res > 1 || Math.abs(bottomMh - this.builtBottom) > 2 ||
      !(Math.abs(m.candle - this.builtCandle) < 2);
    if (stale && !this.failed) {
      if (this.changedAt < 0) this.changedAt = frame.now;
      if (!this.sprite || frame.now - this.changedAt >= 160) {
        const s = buildShelfArt(this.env.canvas, res, widthMh, bottomMh, m);
        if (s) {
          this.sprite = s;
          this.builtRes = res;
          this.builtW = widthMh;
          this.builtBottom = bottomMh;
          this.builtCandle = m.candle;
        } else if (!this.sprite) {
          this.failed = true;
        }
        this.changedAt = -1;
      }
    } else if (!stale) {
      this.changedAt = -1;
    }
    const s = this.sprite;
    if (!s) return;
    // Painted in mH with x from 0; stretch its x span over the canvas width (exact once repainted).
    const kx = canvasW / Math.max(1e-6, this.builtW * res);
    ctx.save();
    ctx.translate(0, lineY);
    ctx.scale(res * kx, res);
    ctx.drawImage(s.surface.canvas, s.x, s.y, s.w, s.h);
    ctx.restore();
  }
}
