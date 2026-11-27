// Colors on the stage. Pack colors are untrusted strings ('#rgb', '#rrggbb' or '#rrggbbaa',
// contracts/packs.ts), so everything goes through parseColor with a fallback.

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse a pack color. Alpha in '#rrggbbaa' is ignored: the stage sets its own alpha. */
export function parseColor(input: unknown, fallback: string): Rgb {
  const text = typeof input === 'string' && HEX.test(input.trim()) ? input.trim() : fallback;
  let hex = text.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex.slice(0, 6), 16);
  if (!Number.isFinite(n)) return parseColor(fallback, '#ffffff');
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** True when the string is a color the stage would accept. */
export function isColor(input: unknown): input is string {
  return typeof input === 'string' && HEX.test(input.trim());
}

export function toHex(c: Rgb): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/** Scale brightness (0 is black). On the light layer, which is composited with `screen`, a darker
 *  color is a dimmer light, so this is how light fades without alpha seams. */
export function shade(c: Rgb, k: number): Rgb {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export function rgba(c: Rgb, a: number): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.min(1, Math.max(0, a)).toFixed(3)})`;
}

function linear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x "saturated red": R / (R + G + B) >= 0.8 on linearized sRGB values. Flashes in such
 * colors are capped lower (EFFECT_LIMITS.redFlashMaxIntensity), following WCAG's red-flash rule
 * that Section 10.6 ("for photosensitive players") points at.
 */
export function isSaturatedRed(c: Rgb): boolean {
  const r = linear(c.r), g = linear(c.g), b = linear(c.b);
  const sum = r + g + b;
  return sum > 0 && r / sum >= 0.8;
}

/** Relative luminance (WCAG), 0..1. */
export function luminance(c: Rgb): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}
