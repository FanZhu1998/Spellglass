// WCAG 2 contrast ratio between two CSS hex colors (Section 10.2: the theme's text pairs must reach
// 4.5 to 1). A color with alpha is composited over the background first.

export type Rgb = [number, number, number];

/** '#rgb', '#rrggbb' or '#rrggbbaa' → [r, g, b] 0..255 and alpha 0..1. null when not a hex color. */
export function parseHex(color: string): { rgb: Rgb; alpha: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], alpha: hex.length === 8 ? n(6) / 255 : 1 };
}

/** Relative luminance (WCAG 2.x). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio of a foreground color on a background color, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHex(foreground), bg = parseHex(background);
  if (!fg || !bg) return null;
  // A translucent background sits on black (the room); a translucent foreground on the background.
  const base = bg.alpha < 1 ? (bg.rgb.map((c) => c * bg.alpha) as Rgb) : bg.rgb;
  const top = fg.alpha < 1 ? (fg.rgb.map((c, i) => c * fg.alpha + base[i] * (1 - fg.alpha)) as Rgb) : fg.rgb;
  const a = luminance(top), b = luminance(base);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG's saturated red (used for the lower red-flash cap): red carries at least 80% of the color. */
export function isSaturatedRed(color: string): boolean {
  const c = parseHex(color);
  if (!c) return false;
  const [r, g, b] = c.rgb;
  return r + g + b > 0 && r / (r + g + b) >= 0.8;
}
