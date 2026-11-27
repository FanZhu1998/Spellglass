// Keepsake cards (Section 11.1: "A keepsake card (PNG)"), 1200 × 630, the size link previews use.
// A vellum card in a dark frame: on the left an oval mirror in a brass frame with the stroke drawn in
// candlelight; on the right the incantation in IM Fell English italic, the grade the theme gives the
// cast's quality, and the date; at the foot the word Spellglass and, small, "An unofficial fan
// project" (Section 10.7). Everything is drawn here, from shapes and gradients: original art, no
// images, no official marks.
//
// The layout is pure (tested in Node); drawCard paints it on any 2D context; renderCard makes the PNG
// in the browser after the display face has loaded ("Wait for document.fonts before drawing").

import type { Keepsake, Point, ThemePack } from '../../contracts';
import { gradeFor, geometry } from '../../kernel';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Section 10.2 tokens; a theme pack's own tokens replace them. */
export interface CardPalette {
  night: string;
  slate: string;
  vellum: string;
  ink: string;
  candle: string;
  oxblood: string;
  display: string;
  text: string;
}

const DEFAULT_PALETTE: CardPalette = {
  night: '#0F1424', slate: '#232A3B', vellum: '#E9DFC7', ink: '#2B2118', candle: '#F2B84B', oxblood: '#7B1E2B',
  display: 'IM Fell English', text: 'Spectral',
};

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONT_NAME = /^[A-Za-z0-9 -]{1,64}$/;

export function cardPalette(theme: ThemePack | null | undefined): CardPalette {
  const out = { ...DEFAULT_PALETTE };
  const tokens = theme?.tokens ?? {};
  for (const key of ['night', 'slate', 'vellum', 'ink', 'candle', 'oxblood'] as const) {
    const v = tokens[key];
    if (typeof v === 'string' && COLOR.test(v)) out[key] = v;
  }
  // Pack strings are untrusted (contracts/packs.ts): font names are checked before going into a CSS font.
  if (typeof theme?.fonts?.display === 'string' && FONT_NAME.test(theme.fonts.display)) out.display = theme.fonts.display;
  if (typeof theme?.fonts?.text === 'string' && FONT_NAME.test(theme.fonts.text)) out.text = theme.fonts.text;
  return out;
}

export interface CardContent {
  /** The incantation, or the variant's label when the cast was one (Lumos Maxima). */
  title: string;
  grade: string;
  date: string;
  points: Point[];
  aspect: number;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "21 November 2026", in local time. English, like every other word on the card. */
export function formatDate(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function cardContent(k: Keepsake, theme: ThemePack | null | undefined): CardContent {
  const variant = typeof k.cast.variant === 'string' && k.cast.variant.trim() ? k.cast.variant : '';
  return {
    title: (variant || k.cast.incantation || k.spellName || k.cast.spellId).slice(0, 60),
    grade: gradeFor(k.cast.quality, 'cast', theme ?? null),
    date: formatDate(k.savedAt),
    points: k.points,
    aspect: k.aspect,
  };
}

export function cardFilename(k: Keepsake): string {
  const d = new Date(Number.isFinite(k.savedAt) ? k.savedAt : 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `spellglass-${k.cast.spellId}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.png`;
}

// ------------------------------------------------------------------------------------------ layout

/** Where things go, in canvas pixels. */
export const LAYOUT = {
  card: { x: 36, y: 36, w: 1128, h: 558 },
  mirror: { cx: 322, cy: 315, rx: 196, ry: 236, frame: 14 },
  /** The stroke stays inside this share of the glass (a box inside an ellipse needs at most 1/√2). */
  strokeFill: 0.6,
  textX: 862,
  textWidth: 500,
  dateY: 118,
  titleY: 262,
  ruleY: 330,
  gradeY: 384,
  brandY: 512,
  fanY: 548,
  seal: { x: 1070, y: 520, r: 30 },
} as const;

/** The stroke (caster space) in canvas pixels: made isotropic, then fitted and centred in the glass. */
export function strokeOnGlass(points: readonly Point[], aspect: number): Point[] {
  if (points.length < 2) return [];
  const iso = geometry.toIsotropic(points, aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9);
  const m = LAYOUT.mirror;
  const halfW = m.rx * LAYOUT.strokeFill;
  const halfH = m.ry * LAYOUT.strokeFill;
  const b = geometry.bbox(iso);
  // A tiny stroke (a flick seen edge-on) is not blown up to fill the glass.
  const side = Math.max(b.w, b.h, 0.15);
  const s = Math.min((2 * halfW) / side, (2 * halfH) / side);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return iso.map(([x, y]) => [m.cx + (x - cx) * s, m.cy + (y - cy) * s] as Point);
}

/** The largest size from maxSize down to minSize at which the text fits; two lines when one will not do. */
export function fitTitle(measure: (text: string, size: number) => number, text: string, maxWidth: number, maxSize = 84, minSize = 44): { size: number; lines: string[] } {
  for (let size = maxSize; size >= minSize; size -= 2) if (measure(text, size) <= maxWidth) return { size, lines: [text] };
  const words = text.split(' ');
  if (words.length > 1) {
    // Break at the space that leaves the longer line shortest.
    let best: string[] = [text];
    let bestWidth = Infinity;
    for (let i = 1; i < words.length; i++) {
      const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      const width = Math.max(...lines.map((l) => measure(l, minSize)));
      if (width < bestWidth) {
        best = lines;
        bestWidth = width;
      }
    }
    for (let size = maxSize - 16; size >= 28; size -= 2) if (best.every((l) => measure(l, size) <= maxWidth)) return { size, lines: best };
    return { size: 28, lines: best };
  }
  let size = minSize;
  while (size > 24 && measure(text, size) > maxWidth) size -= 2;
  return { size, lines: [text] };
}

// ----------------------------------------------------------------------------------------- drawing

const displayFont = (p: CardPalette, size: number, italic = false) =>
  `${italic ? 'italic ' : ''}400 ${size}px "${p.display}", "IM Fell English", "Iowan Old Style", Palatino, Georgia, serif`;
const textFont = (p: CardPalette, size: number, italic = false) =>
  `${italic ? 'italic ' : ''}400 ${size}px "${p.text}", "Spectral", "Iowan Old Style", Georgia, serif`;

/** #rgb, #rrggbb or #rrggbbaa with a new alpha, as rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Paint the whole card. */
export function drawCard(ctx: CanvasRenderingContext2D, content: CardContent, p: CardPalette): void {
  ctx.save();
  drawRoom(ctx, p);
  drawVellum(ctx, p);
  drawMirror(ctx, p, strokeOnGlass(content.points, content.aspect));
  drawWords(ctx, p, content);
  drawSeal(ctx, p);
  ctx.restore();
}

/** The study behind the card: the app's dark stone, warmed from low on the left by the candle, as the
 *  shell's room is (src/ui tokens), rather than the old navy. */
function drawRoom(ctx: CanvasRenderingContext2D, p: CardPalette): void {
  ctx.fillStyle = '#0B0A10';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  const stone = ctx.createRadialGradient(CARD_WIDTH / 2, CARD_HEIGHT / 2, 60, CARD_WIDTH / 2, CARD_HEIGHT / 2, CARD_WIDTH * 0.7);
  stone.addColorStop(0, '#2A272C');
  stone.addColorStop(1, '#0B0A10');
  ctx.fillStyle = stone;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  const candle = ctx.createRadialGradient(CARD_WIDTH * 0.18, CARD_HEIGHT * 0.95, 20, CARD_WIDTH * 0.18, CARD_HEIGHT * 0.95, CARD_WIDTH * 0.55);
  candle.addColorStop(0, withAlpha(p.candle, 0.16));
  candle.addColorStop(1, withAlpha(p.candle, 0));
  ctx.fillStyle = candle;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

function drawVellum(ctx: CanvasRenderingContext2D, p: CardPalette): void {
  const c = LAYOUT.card;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = p.vellum;
  ctx.fillRect(c.x, c.y, c.w, c.h);
  ctx.restore();
  // Age: a lighter middle and foxed, darker edges.
  const age = ctx.createRadialGradient(c.x + c.w * 0.55, c.y + c.h * 0.45, 40, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.62);
  age.addColorStop(0, 'rgba(255, 252, 240, 0.35)');
  age.addColorStop(0.7, 'rgba(255, 252, 240, 0)');
  age.addColorStop(1, 'rgba(110, 80, 40, 0.22)');
  ctx.fillStyle = age;
  ctx.fillRect(c.x, c.y, c.w, c.h);
  // A double rule, as printers framed a page.
  ctx.strokeStyle = withAlpha(p.ink, 0.55);
  ctx.lineWidth = 2;
  ctx.strokeRect(c.x + 14, c.y + 14, c.w - 28, c.h - 28);
  ctx.strokeStyle = withAlpha(p.ink, 0.3);
  ctx.lineWidth = 1;
  ctx.strokeRect(c.x + 21, c.y + 21, c.w - 42, c.h - 42);
  ctx.fillStyle = withAlpha(p.ink, 0.5);
  for (const [x, y] of [[c.x + 14, c.y + 14], [c.x + c.w - 14, c.y + 14], [c.x + 14, c.y + c.h - 14], [c.x + c.w - 14, c.y + c.h - 14]]) diamond(ctx, x, y, 6);
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

function drawMirror(ctx: CanvasRenderingContext2D, p: CardPalette, stroke: Point[]): void {
  const m = LAYOUT.mirror;
  drawGiltMoulding(ctx, m);
  // Dark silvered glass, the same near-neutral base as the mirror's (stage core/glass.ts), so the card
  // a friend receives matches the glass they will see.
  const glass = ctx.createRadialGradient(m.cx - m.rx * 0.2, m.cy - m.ry * 0.3, 10, m.cx, m.cy, Math.max(m.rx, m.ry));
  glass.addColorStop(0, '#26252B');
  glass.addColorStop(0.55, '#17161C');
  glass.addColorStop(1, '#0B0A10');
  ctx.beginPath();
  ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 236, 190, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // A faint sheen across the upper left of the glass.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.clip();
  const sheen = ctx.createLinearGradient(m.cx - m.rx, m.cy - m.ry, m.cx, m.cy);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(m.cx - m.rx, m.cy - m.ry, m.rx * 2, m.ry * 2);
  if (stroke.length >= 2) drawLight(ctx, p, stroke);
  else drawOrb(ctx, p, m.cx, m.cy, 70);
  ctx.restore();
}

/**
 * The oval's frame as carved, gilded moulding lit from the upper left like the mirror's own frame (the
 * shell's MirrorFrame): an outer cove, a dark recess, a row of beads, and a fine bright fillet against
 * the glass. Gold leaf tones from the art direction; no single flat brass line.
 */
function drawGiltMoulding(ctx: CanvasRenderingContext2D, m: (typeof LAYOUT)['mirror']): void {
  const lit = (a: string, b: string, c: string) => {
    const g = ctx.createLinearGradient(m.cx - m.rx, m.cy - m.ry, m.cx + m.rx, m.cy + m.ry);
    g.addColorStop(0, a);
    g.addColorStop(0.45, b);
    g.addColorStop(1, c);
    return g;
  };
  const ring = (grow: number, width: number, style: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.ellipse(m.cx, m.cy, m.rx + grow, m.ry + grow, 0, 0, Math.PI * 2);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const f = m.frame;
  // The cove, casting its shadow on the card.
  ctx.save();
  ctx.shadowColor = 'rgba(20, 12, 4, 0.55)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ring(f * 0.62, f * 0.76, lit('#E9CF8A', '#C9A356', '#5E4419'));
  ctx.restore();
  // The cove's turn: a highlight on its upper left, the dark recess inside it.
  ring(f * 0.86, Math.max(1, f * 0.12), lit('rgba(255, 244, 210, 0.75)', 'rgba(233, 207, 138, 0.35)', 'rgba(62, 44, 18, 0.6)'));
  ring(f * 0.22, Math.max(1, f * 0.12), '#3E2C12');
  // A row of beads round the inner edge, each lit from the upper left.
  const n = Math.max(36, Math.round((Math.PI * (m.rx + m.ry)) / Math.max(6, f * 0.42)));
  const r = Math.max(1.5, f * 0.15);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = m.cx + Math.cos(a) * (m.rx + f * 0.12);
    const y = m.cy + Math.sin(a) * (m.ry + f * 0.12);
    const bead = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
    bead.addColorStop(0, '#F6E3A8');
    bead.addColorStop(0.6, '#B8913F');
    bead.addColorStop(1, '#4A3412');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = bead;
    ctx.fill();
  }
  // The fillet against the glass.
  ring(0, Math.max(1, f * 0.06), lit('#F2DC9A', '#B8913F', '#6B4F1F'));
}

/** The stroke in candlelight: a wide soft glow, a warm body and a pale hot core, ending in the tip. */
function drawLight(ctx: CanvasRenderingContext2D, p: CardPalette, pts: Point[]): void {
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = p.candle;
  ctx.shadowBlur = 30;
  trace();
  ctx.strokeStyle = withAlpha(p.candle, 0.32);
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.shadowBlur = 12;
  trace();
  ctx.strokeStyle = withAlpha(p.candle, 0.85);
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;
  trace();
  ctx.strokeStyle = 'rgba(255, 246, 222, 0.95)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  const tip = pts[pts.length - 1];
  drawOrb(ctx, p, tip[0], tip[1], 22);
}

function drawOrb(ctx: CanvasRenderingContext2D, p: CardPalette, x: number, y: number, r: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const orb = ctx.createRadialGradient(x, y, 0, x, y, r);
  orb.addColorStop(0, 'rgba(255, 250, 235, 0.95)');
  orb.addColorStop(0.25, withAlpha(p.candle, 0.8));
  orb.addColorStop(1, withAlpha(p.candle, 0));
  ctx.fillStyle = orb;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWords(ctx: CanvasRenderingContext2D, p: CardPalette, content: CardContent): void {
  const L = LAYOUT;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = withAlpha(p.ink, 0.72);
  ctx.font = textFont(p, 22, true);
  ctx.fillText(content.date, L.textX, L.dateY);

  const measure = (text: string, size: number) => {
    ctx.font = displayFont(p, size, true);
    return ctx.measureText(text).width;
  };
  const title = fitTitle(measure, content.title, L.textWidth);
  ctx.font = displayFont(p, title.size, true);
  ctx.fillStyle = p.ink;
  const lineHeight = title.size * 1.08;
  const firstY = L.titleY - ((title.lines.length - 1) * lineHeight) / 2 + title.size * 0.3;
  title.lines.forEach((line, i) => ctx.fillText(line, L.textX, firstY + i * lineHeight));

  // A rule with a lozenge, under the incantation.
  ctx.strokeStyle = withAlpha(p.ink, 0.45);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(L.textX - 90, L.ruleY);
  ctx.lineTo(L.textX - 12, L.ruleY);
  ctx.moveTo(L.textX + 12, L.ruleY);
  ctx.lineTo(L.textX + 90, L.ruleY);
  ctx.stroke();
  ctx.fillStyle = withAlpha(p.ink, 0.55);
  diamond(ctx, L.textX, L.ruleY, 5);

  ctx.fillStyle = p.oxblood;
  ctx.font = displayFont(p, 38);
  ctx.fillText(content.grade, L.textX, L.gradeY);

  ctx.fillStyle = p.ink;
  ctx.font = displayFont(p, 42);
  ctx.fillText('Spellglass', L.textX, L.brandY);
  ctx.fillStyle = withAlpha(p.ink, 0.72);
  ctx.font = textFont(p, 18);
  ctx.fillText('An unofficial fan project', L.textX, L.fanY);
  ctx.restore();
}

/** A plain wax seal with a pressed star: generic stationery, no crest. */
function drawSeal(ctx: CanvasRenderingContext2D, p: CardPalette): void {
  const { x, y, r } = LAYOUT.seal;
  ctx.save();
  ctx.shadowColor = 'rgba(40, 10, 10, 0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  // A slightly uneven rim, as wax spreads; the wobble is fixed so every card is the same.
  ctx.beginPath();
  const lobes = 18;
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const rr = r * (1 + 0.06 * Math.sin(i * 2.7) + 0.04 * Math.cos(i * 1.3));
    if (i === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    else ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath();
  const wax = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r * 1.1);
  wax.addColorStop(0, '#A33A47');
  wax.addColorStop(0.6, p.oxblood);
  wax.addColorStop(1, '#4A0F18');
  ctx.fillStyle = wax;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 220, 220, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 225, 225, 0.32)';
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 6;
    const rr = i % 2 === 0 ? r * 0.5 : r * 0.2;
    if (i === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    else ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------------------------- rendering

/** The canvas the browser gives: an HTMLCanvasElement or an OffscreenCanvas. */
export interface CardCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): unknown;
  toBlob?(callback: (blob: Blob | null) => void, type?: string): void;
  convertToBlob?(options?: { type?: string }): Promise<Blob>;
}

export interface CardEnv {
  createCanvas(width: number, height: number): CardCanvas | null;
  /** document.fonts, when there is one. */
  fonts?: { load(font: string): Promise<unknown> } | null;
}

/** The browser's canvas and fonts, looked up when a card is made (never at import time). */
export function browserCardEnv(): CardEnv | null {
  const g = globalThis as { document?: Document; OffscreenCanvas?: new (w: number, h: number) => CardCanvas };
  const doc = g.document;
  if (doc && typeof doc.createElement === 'function') {
    return {
      createCanvas: (w, h) => {
        const c = doc.createElement('canvas');
        c.width = w;
        c.height = h;
        return c as unknown as CardCanvas;
      },
      fonts: doc.fonts ?? null,
    };
  }
  if (typeof g.OffscreenCanvas === 'function') {
    const Offscreen = g.OffscreenCanvas;
    return { createCanvas: (w, h) => new Offscreen(w, h), fonts: null };
  }
  return null;
}

/** How long a card waits for its fonts before drawing with the fallbacks. */
const FONT_WAIT_MS = 2500;

/** Draw the card and encode it as PNG. Throws when the browser cannot draw. */
export async function renderCard(content: CardContent, palette: CardPalette, env: CardEnv): Promise<Blob> {
  await fontsLoaded(env, palette);
  const canvas = env.createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx) throw new Error('This browser cannot draw a card.');
  drawCard(ctx, content, palette);
  return toPng(canvas);
}

async function fontsLoaded(env: CardEnv, p: CardPalette): Promise<void> {
  const fonts = env.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loads = Promise.all([
    fonts.load(`italic 64px "${p.display}"`),
    fonts.load(`64px "${p.display}"`),
    fonts.load(`italic 22px "${p.text}"`),
    fonts.load(`18px "${p.text}"`),
  ]).catch(() => undefined);
  await Promise.race([loads, new Promise<void>((resolve) => (timer = setTimeout(resolve, FONT_WAIT_MS)))]);
  if (timer !== null) clearTimeout(timer);
}

function toPng(canvas: CardCanvas): Promise<Blob> {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('This browser cannot save a card.'));
      return;
    }
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This browser cannot save a card.'))), 'image/png');
  });
}
