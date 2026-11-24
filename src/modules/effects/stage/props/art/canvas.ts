// Offscreen sprites. Every static body is painted once per size into an offscreen canvas and then drawn
// transformed each frame (task brief: "pre-render static bodies into offscreen canvases per size and
// draw them transformed; no allocations per frame in hot paths").
//
// Nothing here touches a browser API at import time, so the module loads in Node. The factory is
// feature-detected when first called and returns null where no canvas exists (tests inject a fake).

export interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Pixel size. */
  width: number;
  height: number;
}

export type CanvasFactory = (width: number, height: number) => Surface | null;

/** A document canvas where there is a document (the stage runs on the main thread), else an
 *  OffscreenCanvas, else nothing. */
export const defaultCanvasFactory: CanvasFactory = (width, height) => {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) return { canvas, ctx, width: w, height: h };
    }
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      // The 2D APIs used here are the same on both context types.
      if (ctx) return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D, width: w, height: h };
    }
  } catch {
    // A browser without 2D canvas: the props simply draw nothing.
  }
  return null;
};

export interface ArtBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A painted canvas and where it sits in art units (mH), relative to the art's origin. */
export interface Sprite {
  surface: Surface;
  /** Top-left corner and size of the whole canvas in mH, margin included. Draw with drawSprite()
   *  after scaling the context to mH. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The area that was painted, in mH (the canvas minus its margin). */
  box: ArtBox;
  /** Pixels per mH it was painted at. */
  res: number;
}

/** Transparent margin in pixels, so outlines and soft edges are never clipped. */
const PAD = 4;
/** Browsers refuse or slow down on huge canvases. */
const MAX_SIDE = 4096;

/** Paint art authored in mH into a new sprite at `res` pixels per mH. */
export function paintSprite(
  factory: CanvasFactory,
  res: number,
  box: ArtBox,
  paint: (ctx: CanvasRenderingContext2D) => void,
): Sprite | null {
  const spanW = Math.max(1e-3, box.x1 - box.x0);
  const spanH = Math.max(1e-3, box.y1 - box.y0);
  const r = Math.min(res, (MAX_SIDE - 2 * PAD) / spanW, (MAX_SIDE - 2 * PAD) / spanH);
  const pw = Math.ceil(spanW * r) + 2 * PAD;
  const ph = Math.ceil(spanH * r) + 2 * PAD;
  const surface = factory(pw, ph);
  if (!surface) return null;
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(r, 0, 0, r, PAD - box.x0 * r, PAD - box.y0 * r);
  paint(ctx);
  ctx.restore();
  return {
    surface,
    x: box.x0 - PAD / r,
    y: box.y0 - PAD / r,
    w: surface.width / r,
    h: surface.height / r,
    box: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
    res: r,
  };
}

/** Draw a sprite in the current transform, which must be scaled to mH. */
export function drawSprite(ctx: CanvasRenderingContext2D, s: Sprite): void {
  ctx.drawImage(s.surface.canvas, s.x, s.y, s.w, s.h);
}

/** Draw a sprite with its painted box stretched onto a rectangle in mH (the box lid's faces, which
 *  foreshorten as the lid swings). Callers pass a positive height. */
export function drawSpriteIn(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, w: number, h: number): void {
  const bw = s.box.x1 - s.box.x0;
  const bh = s.box.y1 - s.box.y0;
  if (!(bw > 0 && bh > 0 && w > 0 && h > 0)) return;
  const kx = w / bw;
  const ky = h / bh;
  ctx.drawImage(s.surface.canvas, x + (s.x - s.box.x0) * kx, y + (s.y - s.box.y0) * ky, s.w * kx, s.h * ky);
}

/** A thin ring around the sprite's silhouette: the faint outline a shattered prop leaves (Reducto),
 *  and the cold rim of a frozen dummy. */
export function makeOutline(factory: CanvasFactory, src: Sprite, color: string, widthPx: number): Sprite | null {
  const out = factory(src.surface.width, src.surface.height);
  if (!out) return null;
  const c = out.ctx;
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    c.drawImage(src.surface.canvas, Math.cos(a) * widthPx, Math.sin(a) * widthPx);
  }
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, out.width, out.height);
  c.globalCompositeOperation = 'destination-out';
  c.drawImage(src.surface.canvas, 0, 0);
  c.globalCompositeOperation = 'source-over';
  return { ...src, surface: out };
}

/** The sprite washed with a color (Petrificus Totalus: "snaps rigid with a pale tint"). */
export function makeTinted(factory: CanvasFactory, src: Sprite, color: string, alpha: number): Sprite | null {
  const out = factory(src.surface.width, src.surface.height);
  if (!out) return null;
  const c = out.ctx;
  c.drawImage(src.surface.canvas, 0, 0);
  c.globalCompositeOperation = 'source-atop';
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.fillRect(0, 0, out.width, out.height);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  return { ...src, surface: out };
}

/** Lets one prop repaint its sprites per frame. Painting a prop's art takes a few milliseconds, and
 *  after a resize every prop wants to repaint at once: spread over frames, no frame grows long (the
 *  others keep drawing their old sprites scaled meanwhile). A first paint is never held back. */
export class RepaintGate {
  private frame = Number.NaN;
  private used = false;

  /** True for the first repaint asked for in the frame stamped `now`. */
  take(now: number): boolean {
    if (now !== this.frame) {
      this.frame = now;
      this.used = false;
    }
    if (this.used) return false;
    this.used = true;
    return true;
  }
}

/** Holds one prop's sprites and repaints them when the mirror's size changes. While a window is being
 *  dragged the size changes every frame, so repainting waits until it has been steady for a moment and
 *  the old sprites are drawn scaled meanwhile (they are positioned in mH, so they stay in place). */
export class SpriteBank<T> {
  private art: T | null = null;
  private builtRes = 0;
  private changedAt = -1;
  private failed = false;

  constructor(private readonly build: (factory: CanvasFactory, res: number) => T | null) {}

  /** `res` is the wanted pixels per mH; `now` is the kernel clock. A repaint waits its turn at `gate`. */
  get(factory: CanvasFactory, res: number, now: number, gate?: RepaintGate): T | null {
    if (!(res > 0) || this.failed) return this.art;
    if (!this.art) return this.rebuild(factory, res);
    const off = Math.abs(res - this.builtRes) / this.builtRes;
    if (off < 0.02) {
      this.changedAt = -1;
      return this.art;
    }
    if (this.changedAt < 0) this.changedAt = now;
    // Growing past the painted size blurs at once, so repaint promptly; shrinking can wait.
    const due = now - this.changedAt >= 160 || res > this.builtRes * 1.25;
    if (due && (!gate || gate.take(now))) return this.rebuild(factory, res);
    return this.art;
  }

  get resolution(): number {
    return this.builtRes;
  }

  clear(): void {
    this.art = null;
    this.builtRes = 0;
    this.failed = false;
  }

  private rebuild(factory: CanvasFactory, res: number): T | null {
    const art = this.build(factory, res);
    if (!art) {
      // No canvas in this environment: stop trying every frame.
      if (!this.art) this.failed = true;
      return this.art;
    }
    this.art = art;
    this.builtRes = res;
    this.changedAt = -1;
    return art;
  }
}
