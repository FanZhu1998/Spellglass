// Text on the glass (fx.text@1).
//
// Section 10.1 step 3: "The incantation writes itself across the glass in italic, left to right."
// The stage writes it on every cast (contracts/effects.ts): IM Fell English italic in Candle, about
// 7% of the mirror height, in the lower middle above the shelf. text.inscribe adds extra text;
// its 'hidden-ink' style is faint silver script that shimmers into view (Revelio).
//
// Text is pre-rendered once per inscription into small canvases (a glow and a dark shadow for
// legibility on bright rooms), then revealed with a moving cut and a feathered edge. Nothing is
// drawn until document.fonts has the display face, so the first cast never flashes a fallback font.

import { CAST_SEQUENCE } from '../../../../contracts';
import { mixRgb, parseColor, rgba } from './color';
import { makeCanvas } from './sprites';
import type { View } from './view';

export type TextStyle = 'incantation' | 'hidden-ink';

export interface Inscription {
  lines: string[];
  style: TextStyle;
  /** Centre of the text block, caster space. */
  x: number;
  y: number;
  /** Font size as a fraction of the mirror height. */
  size: number;
  color: string;
  start: number;
  /** Writing (incantation) or shimmering in (hidden ink). */
  inMs: number;
  holdMs: number;
  outMs: number;
  endedAt: number | null;
  /** Shown at once (reduced motion). */
  still: boolean;
  rendered: Rendered | null;
}

interface Rendered {
  key: string;
  glow: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  width: number;
  height: number;
  fontPx: number;
}

/** Where the incantation sits: centred, in the lower middle, above the shelf (caster space). */
export const INCANTATION_POSITION = { x: 0.5, y: 0.7 };
export const INCANTATION_SIZE = 0.07;
/** Default place for hidden ink: high on the glass, clear of the incantation. */
export const HIDDEN_INK_POSITION = { x: 0.5, y: 0.22 };
export const HIDDEN_INK_SIZE = 0.048;
export const HIDDEN_INK_COLOR = '#DCE6F4';

/** Built-in hidden-ink lines, used when the theme has none (original lines; never quotations). */
export const BUILT_IN_HIDDEN_INK = [
  'What is hidden is only waiting to be asked.',
  'The glass keeps every light it is shown.',
  'Not every door is drawn in wood.',
  'Look again: the shelf is longer than it seems.',
  'A careful hand leaves careful light.',
];

const SAFE_FONT = /^[\w\s-]+$/;

export function fontFamily(display: string | undefined): string {
  const name = display && SAFE_FONT.test(display) ? display : 'IM Fell English';
  return `"${name}", "IM Fell English", "Iowan Old Style", Palatino, Georgia, serif`;
}

/** Lifetime of an inscription, ms from its start to fully gone. */
export function inscriptionSpan(ins: Inscription): number {
  return (ins.still ? 0 : ins.inMs) + ins.holdMs + ins.outMs;
}

export class TextLayer {
  incantation: Inscription | null = null;
  extras: Inscription[] = [];
  fontReady = false;
  private family = fontFamily(undefined);
  private loading: string | null = null;

  /** Ask the browser for the display face (and give up waiting after a moment). */
  ensureFont(display: string | undefined): void {
    const family = fontFamily(display);
    if (family === this.family && (this.fontReady || this.loading === family)) return;
    this.family = family;
    this.loading = family;
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') {
      this.fontReady = true;
      return;
    }
    this.fontReady = false;
    const done = () => {
      if (this.loading === family) this.fontReady = true;
    };
    fonts.load(`italic 400 48px ${family}`).then(done, done);
    // Never hold the incantation back for long: after a moment the fallback serif will do.
    setTimeout(done, 2500);
  }

  /** The cast's incantation. Replaces one still showing. */
  writeIncantation(text: string, color: string, start: number, reducedMotion: boolean): Inscription {
    if (this.incantation) this.fadeOut(this.incantation, start);
    const ins: Inscription = {
      lines: [text], style: 'incantation', x: INCANTATION_POSITION.x, y: INCANTATION_POSITION.y, size: INCANTATION_SIZE, color,
      start, inMs: CAST_SEQUENCE.inscribeMs, holdMs: reducedMotion ? 2300 : 1500, outMs: reducedMotion ? 500 : 750, endedAt: null,
      still: reducedMotion, rendered: null,
    };
    this.incantation = ins;
    return ins;
  }

  /** Extra text (text.inscribe). */
  inscribe(lines: string[], style: TextStyle, at: { x: number; y: number }, color: string, start: number, holdMs: number, reducedMotion: boolean): Inscription {
    const ins: Inscription = {
      lines, style, x: at.x, y: at.y, size: style === 'hidden-ink' ? HIDDEN_INK_SIZE : INCANTATION_SIZE * 0.8, color,
      start, inMs: style === 'hidden-ink' ? 1200 : CAST_SEQUENCE.inscribeMs, holdMs, outMs: 900, endedAt: null,
      still: reducedMotion, rendered: null,
    };
    this.extras.push(ins);
    while (this.extras.length > 3) this.extras.shift();
    return ins;
  }

  /** Start fading now (a newer incantation replaces it, or its step was ended). */
  fadeOut(ins: Inscription, now: number): void {
    if (ins.endedAt === null) ins.endedAt = now;
  }

  /** True once it has fully faded. */
  gone(ins: Inscription, now: number): boolean {
    if (ins.endedAt !== null) return now >= ins.endedAt + ins.outMs;
    return now >= ins.start + inscriptionSpan(ins);
  }

  update(now: number): void {
    if (!this.fontReady) {
      // "Wait for document.fonts before drawing": hold the start until the face has loaded.
      if (this.incantation && this.incantation.start < now) this.incantation.start = now;
      for (const e of this.extras) if (e.start < now) e.start = now;
      return;
    }
    if (this.incantation && this.gone(this.incantation, now)) this.incantation = null;
    if (this.extras.some((e) => this.gone(e, now))) this.extras = this.extras.filter((e) => !this.gone(e, now));
  }

  clear(): void {
    this.incantation = null;
    this.extras = [];
  }

  /** Shade layer: a soft dark shadow under each text, so it reads on a bright room. */
  drawShade(ctx: CanvasRenderingContext2D, view: View, now: number): void {
    if (!this.fontReady) return;
    for (const ins of this.all()) this.drawOne(ctx, ins, view, now, 'shadow');
  }

  drawLight(ctx: CanvasRenderingContext2D, view: View, now: number): void {
    if (!this.fontReady) return;
    for (const ins of this.all()) this.drawOne(ctx, ins, view, now, 'glow');
  }

  private *all(): Iterable<Inscription> {
    if (this.incantation) yield this.incantation;
    yield* this.extras;
  }

  /** Overall alpha from fading in and out (the writing itself is the cut, not alpha). */
  private alpha(ins: Inscription, now: number): number {
    const t = now - ins.start;
    if (t < 0) return 0;
    const shownAt = ins.still ? 0 : ins.inMs;
    const end = ins.endedAt ?? ins.start + shownAt + ins.holdMs;
    let a = 1;
    if (ins.style === 'hidden-ink' && !ins.still) a = Math.min(1, t / ins.inMs);
    if (now > end) a *= Math.max(0, 1 - (now - end) / ins.outMs);
    return a;
  }

  private render(ins: Inscription, view: View): Rendered | null {
    const H = view.height * view.dpr;
    let fontPx = Math.max(8, Math.round(ins.size * H));
    const key = `${ins.lines.join('\n')}|${fontPx}|${ins.color}|${this.family}`;
    if (ins.rendered && ins.rendered.key === key) return ins.rendered;
    const probe = makeCanvas(4, 4)?.getContext('2d');
    if (!probe) return null;
    const fontOf = (px: number) => `italic 400 ${px}px ${this.family}`;
    probe.font = fontOf(fontPx);
    let widest = Math.max(...ins.lines.map((l) => probe.measureText(l).width));
    const maxWidth = view.pixelWidth * 0.9;
    if (widest > maxWidth) {
      fontPx = Math.max(8, Math.floor(fontPx * (maxWidth / widest)));
      probe.font = fontOf(fontPx);
      widest = Math.max(...ins.lines.map((l) => probe.measureText(l).width));
    }
    const pad = Math.ceil(fontPx * 0.7);
    const lineH = fontPx * 1.18;
    const width = Math.ceil(widest + pad * 2);
    const height = Math.ceil(lineH * ins.lines.length + pad * 2);
    const glow = makeCanvas(width, height);
    const shadow = makeCanvas(width, height);
    const g = glow?.getContext('2d');
    const s = shadow?.getContext('2d');
    if (!glow || !shadow || !g || !s) return null;
    const base = parseColor(ins.color, '#F2B84B');
    const core = rgba(mixRgb(base, { r: 255, g: 250, b: 235 }, ins.style === 'hidden-ink' ? 0.2 : 0.35), 1);
    const baseline = (i: number) => pad + fontPx * 0.92 + i * lineH;
    for (const c of [g, s]) {
      c.font = fontOf(fontPx);
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
    }
    // Glow: the letters in their color with a soft halo, then a crisper, paler core.
    g.shadowColor = rgba(base, 0.9);
    g.shadowBlur = fontPx * 0.3;
    g.fillStyle = rgba(base, 1);
    ins.lines.forEach((line, i) => g.fillText(line, width / 2, baseline(i)));
    g.shadowBlur = 0;
    g.fillStyle = core;
    ins.lines.forEach((line, i) => g.fillText(line, width / 2, baseline(i)));
    // Shadow only: draw the text far off the canvas and let its shadow land in place.
    s.shadowColor = 'rgba(0, 0, 0, 0.9)';
    s.shadowBlur = fontPx * 0.35;
    s.shadowOffsetX = width * 3;
    s.fillStyle = '#000';
    ins.lines.forEach((line, i) => s.fillText(line, width / 2 - width * 3, baseline(i)));
    ins.rendered = { key, glow, shadow, width, height, fontPx };
    return ins.rendered;
  }

  private drawOne(ctx: CanvasRenderingContext2D, ins: Inscription, view: View, now: number, pass: 'glow' | 'shadow'): void {
    const alpha = this.alpha(ins, now);
    if (alpha <= 0.01) return;
    const r = this.render(ins, view);
    if (!r) return;
    let dx = view.px(ins.x) - r.width / 2;
    const dy = view.py(ins.y) - r.height / 2;
    dx = Math.max(0, Math.min(view.pixelWidth - r.width, dx));
    const src = pass === 'glow' ? r.glow : r.shadow;
    const peak = pass === 'shadow' ? (ins.style === 'hidden-ink' ? 0.25 : 0.55) : ins.style === 'hidden-ink' ? 0.6 : 1;
    ctx.globalCompositeOperation = pass === 'glow' ? 'lighter' : 'source-over';

    if (ins.style === 'incantation' && !ins.still) {
      // Writing left to right: a sharp cut with a feathered edge.
      const k = Math.min(1, Math.max(0, (now - ins.start) / ins.inMs));
      const p = k < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * k) : 1;
      const feather = r.fontPx * 0.9;
      const span = r.width + feather;
      const cut = p * span - feather;
      ctx.globalAlpha = peak * alpha;
      if (cut > 0) ctx.drawImage(src, 0, 0, Math.min(r.width, cut), r.height, dx, dy, Math.min(r.width, cut), r.height);
      const slices = 8;
      for (let i = 0; i < slices; i++) {
        const x0 = cut + (i * feather) / slices;
        if (x0 >= r.width || x0 + feather / slices <= 0) continue;
        const sx = Math.max(0, x0), sw = Math.min(r.width, x0 + feather / slices) - sx;
        if (sw <= 0) continue;
        ctx.globalAlpha = peak * alpha * (1 - (i + 1) / (slices + 1));
        ctx.drawImage(src, sx, 0, sw, r.height, dx + sx, dy, sw, r.height);
      }
      ctx.globalAlpha = 1;
      return;
    }

    ctx.globalAlpha = peak * alpha;
    ctx.drawImage(src, dx, dy);
    if (pass === 'glow' && ins.style === 'hidden-ink' && !ins.still) {
      // Hidden ink shimmers: a soft band of brightness drifts across the letters.
      const t = ((now - ins.start) / 2400) % 1;
      const bandW = r.width * 0.22;
      const bx = -bandW + t * (r.width + bandW * 2);
      for (let i = 0; i < 4; i++) {
        const w = bandW * (1 - i / 4);
        const sx = Math.max(0, bx - w / 2), sw = Math.min(r.width, bx + w / 2) - sx;
        if (sw <= 0) continue;
        ctx.globalAlpha = 0.18 * alpha;
        ctx.drawImage(src, sx, 0, sw, r.height, dx + sx, dy, sw, r.height);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
