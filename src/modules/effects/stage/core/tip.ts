// The wand tip on the glass: a small warm glow while the tip is in view. While the segmenter is
// hovering it counts toward arming with ticks round the tip, and when armed the tip turns gold
// (Section 7.4: "the on-screen tip turns gold and ticks").

import type { SegmenterStatus, TipSample } from '../../../../contracts';
import type { Sprites } from './sprites';
import type { View } from './view';

const TICKS = 12;
const FADE_MS = 220;

export class TipView {
  x = 0;
  y = 0;
  /** Capture time of the last sample. */
  t = -Infinity;
  private seen = false;
  /** Kernel time the last sample arrived (capture times lag; gaps are measured on arrival). */
  private arrivedAt = -Infinity;
  private lostAt: number | null = null;
  private armedAt: number | null = null;
  seg: SegmenterStatus | null = null;

  sample(s: TipSample, now: number): void {
    this.x = s.x;
    this.y = s.y;
    this.t = s.t;
    this.seen = true;
    this.arrivedAt = now;
    this.lostAt = null;
  }

  lost(now: number): void {
    if (this.lostAt === null) this.lostAt = now;
  }

  segmenter(st: SegmenterStatus, now: number): void {
    if (st.state === 'armed' && this.seg?.state !== 'armed') this.armedAt = now;
    if (st.state !== 'armed') this.armedAt = null;
    this.seg = st;
  }

  /** The tip is in view: samples are flowing (a gap longer than lostMs means it is gone; tip event rule 4). */
  inView(now: number, lostMs: number): boolean {
    return this.seen && this.lostAt === null && now - this.arrivedAt <= lostMs + 50;
  }

  /** Last known position, whether or not it is in view. */
  last(): { x: number; y: number } | null {
    return this.seen ? { x: this.x, y: this.y } : null;
  }

  /** 1 while in view, fading to 0 once it is gone. */
  visibility(now: number, lostMs: number): number {
    if (!this.seen) return 0;
    if (this.inView(now, lostMs)) return 1;
    const goneAt = this.lostAt ?? this.arrivedAt + lostMs + 50;
    return Math.max(0, 1 - (now - goneAt) / FADE_MS);
  }

  reset(): void {
    this.seen = false;
    this.lostAt = null;
    this.seg = null;
  }

  /** Shade layer, high contrast only: a dark ring so the tip reads on any background. */
  drawShade(ctx: CanvasRenderingContext2D, view: View, now: number, lostMs: number): void {
    const vis = this.visibility(now, lostMs);
    if (vis <= 0.01) return;
    const H = view.height * view.dpr;
    ctx.globalAlpha = 0.75 * vis;
    ctx.fillStyle = '#05070c';
    ctx.beginPath();
    ctx.arc(view.px(this.x), view.py(this.y), 0.014 * H, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawLight(ctx: CanvasRenderingContext2D, view: View, sprites: Sprites, now: number, lostMs: number, candle: string, reducedMotion: boolean): void {
    const vis = this.visibility(now, lostMs);
    if (vis <= 0.01) return;
    const H = view.height * view.dpr;
    const x = view.px(this.x), y = view.py(this.y);
    const state = this.seg?.state;
    const armed = state === 'armed';
    const gold = armed || state === 'tracing';
    const color = gold ? candle : '#FFE0AE';
    ctx.globalCompositeOperation = 'lighter';
    // Small, so it never hides the real tip in the reflection, but enough to find at a glance (and
    // to serve as the cursor in pointer mode).
    const R = (armed ? 0.036 : 0.03) * H;
    ctx.globalAlpha = (gold ? 0.82 : 0.68) * vis;
    ctx.drawImage(sprites.glow(color), x - R, y - R, R * 2, R * 2);
    const r = 0.009 * H;
    ctx.globalAlpha = 0.95 * vis;
    ctx.drawImage(sprites.glow('#FFFFFF'), x - r, y - r, r * 2, r * 2);

    const progress = state === 'hovering' ? this.seg?.armProgress ?? 0 : armed ? 1 : 0;
    if (progress > 0) {
      const lit = armed ? TICKS : Math.floor(progress * TICKS + 1e-6);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, 0.0034 * H);
      for (let i = 0; i < TICKS; i++) {
        const a = -Math.PI / 2 + (i / TICKS) * Math.PI * 2;
        const r0 = 0.03 * H, r1 = 0.039 * H;
        ctx.strokeStyle = i < lit ? candle : '#FFF0D8';
        ctx.globalAlpha = (i < lit ? 0.95 : 0.22) * vis;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
        ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
        ctx.stroke();
      }
    }
    if (armed && this.armedAt !== null && !reducedMotion) {
      // A ring of light swells once as it arms.
      const k = Math.min(1, (now - this.armedAt) / 320);
      ctx.strokeStyle = candle;
      ctx.lineWidth = Math.max(1, 0.003 * H);
      ctx.globalAlpha = 0.8 * (1 - k) * vis;
      ctx.beginPath();
      ctx.arc(x, y, (0.04 + 0.03 * k) * H, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
