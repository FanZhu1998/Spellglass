// Pre-rendered sprites (soft glows, stars, rays, the shield's ring). Drawing a cached image is far
// cheaper than building gradients every frame, which is how the stage keeps 60 fps on integrated
// graphics (Section 2 targets). Sprites are made on first use and never touched at import time,
// so Node tests can import the stage.

import { parseColor, rgba } from './color';

type Canvas2D = CanvasRenderingContext2D;

/** A canvas to draw sprites into, or null outside a browser. */
export function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** Stand-in returned in Node, where nothing is ever drawn. */
const NOTHING = {} as CanvasImageSource;

export class Sprites {
  private cache = new Map<string, CanvasImageSource>();

  private get(key: string, size: number, paint: (ctx: Canvas2D, size: number) => void): CanvasImageSource {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const canvas = makeCanvas(size, size);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return NOTHING;
    paint(ctx, size);
    this.cache.set(key, canvas);
    return canvas;
  }

  /** A soft round glow: bright centre, long smooth falloff. Draw it 2r wide for radius r. */
  glow(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`glow:${color.toLowerCase()}`, 128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, rgba(c, 1));
      g.addColorStop(0.12, rgba(c, 0.85));
      g.addColorStop(0.3, rgba(c, 0.42));
      g.addColorStop(0.55, rgba(c, 0.14));
      g.addColorStop(0.8, rgba(c, 0.035));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }

  /** A flatter, cloud-like puff for mist and smoke. */
  puff(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`puff:${color.toLowerCase()}`, 96, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, rgba(c, 0.55));
      g.addColorStop(0.45, rgba(c, 0.32));
      g.addColorStop(0.75, rgba(c, 0.1));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }

  /** A four-pointed star with a small halo, for the 'stars' preset and sparkles. */
  star(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`star:${color.toLowerCase()}`, 96, (ctx, s) => {
      const m = s / 2;
      const halo = ctx.createRadialGradient(m, m, 0, m, m, m * 0.55);
      halo.addColorStop(0, rgba(c, 0.9));
      halo.addColorStop(0.35, rgba(c, 0.3));
      halo.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = rgba({ r: 255, g: 255, b: 255 }, 0.95);
      for (let k = 0; k < 4; k++) {
        const len = k % 2 === 0 ? m * 0.98 : m * 0.8;
        ctx.save();
        ctx.translate(m, m);
        ctx.rotate((k * Math.PI) / 2);
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.035);
        ctx.quadraticCurveTo(len * 0.25, 0, len, 0);
        ctx.quadraticCurveTo(len * 0.25, 0, 0, s * 0.035);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    });
  }

  /**
   * A flash: a disc of light with a soft edge. Near full strength over the middle half of its
   * radius, then falling to nothing at the edge, so a flash drawn 2r wide is exactly r in radius
   * and reads as one bright event (the plain glow is mostly falloff and reads as a dim glow).
   */
  flash(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`flash:${color.toLowerCase()}`, 128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, rgba(c, 1));
      g.addColorStop(0.3, rgba(c, 0.94));
      g.addColorStop(0.55, rgba(c, 0.62));
      g.addColorStop(0.75, rgba(c, 0.26));
      g.addColorStop(0.9, rgba(c, 0.07));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }

  /** Soft rays around an orb (Lumos): thin tapered spokes fading outward. The spokes start a
   *  little off the vertical (0.3 rad), so none points straight up the wand. */
  rays(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`rays:${color.toLowerCase()}`, 256, (ctx, s) => {
      const m = s / 2;
      const spokes = 12;
      for (let k = 0; k < spokes; k++) {
        const a = 0.3 + (k / spokes) * Math.PI * 2 + (k % 3) * 0.07;
        const len = m * (k % 2 === 0 ? 0.98 : 0.72);
        const half = 0.045 + (k % 3) * 0.012;
        const g = ctx.createRadialGradient(m, m, 0, m, m, len);
        g.addColorStop(0, rgba(c, 0.55));
        g.addColorStop(0.4, rgba(c, 0.22));
        g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(m, m);
        ctx.lineTo(m + Math.cos(a - half) * len, m + Math.sin(a - half) * len);
        ctx.lineTo(m + Math.cos(a + half) * len, m + Math.sin(a + half) * len);
        ctx.closePath();
        ctx.fill();
      }
    });
  }

  /** The shield's body: clear in the middle, brightening toward a soft rim (a lit soap bubble). */
  dome(color: string): CanvasImageSource {
    const c = parseColor(color, '#ffffff');
    return this.get(`dome:${color.toLowerCase()}`, 384, (ctx, s) => {
      const m = s / 2;
      const g = ctx.createRadialGradient(m, m, 0, m, m, m);
      g.addColorStop(0, rgba(c, 0.035));
      g.addColorStop(0.55, rgba(c, 0.06));
      g.addColorStop(0.82, rgba(c, 0.16));
      g.addColorStop(0.95, rgba(c, 0.42));
      g.addColorStop(0.985, rgba(c, 0.2));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }
}
