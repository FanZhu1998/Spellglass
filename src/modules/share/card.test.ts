import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Keepsake, Point, SpellCast, ThemePack } from '../../contracts';
import { ask, createKernel, emit, memoryPersistence } from '../../kernel';
import {
  CARD_HEIGHT, CARD_WIDTH, LAYOUT, cardContent, cardFilename, cardPalette, drawCard, fitTitle, formatDate, renderCard, strokeOnGlass,
  withAlpha, type CardCanvas,
} from './card';
import { createShareModule } from './index';
import { buildKeepsake } from './keepsakes';

const THEME = {
  schema: 'themepack/1', id: 'candlelit', version: '1.0.0', tokens: { vellum: '#EEE2C8', candle: '#F2B84B', ink: 'not-a-color' },
  fonts: { display: 'IM Fell English', text: 'Spectral' },
  grades: { cast: [{ min: 0.9, label: 'Outstanding' }, { min: 0, label: 'Acceptable' }], fizzle: [] },
} as unknown as ThemePack;

const circle: Point[] = Array.from({ length: 64 }, (_, i) => {
  const a = (i / 63) * Math.PI * 2;
  return [0.5 + (0.25 * Math.cos(a)) / (16 / 9), 0.5 + 0.25 * Math.sin(a)];
});

function keepsake(over: Partial<SpellCast> = {}, points: Point[] = circle): Keepsake {
  const cast: SpellCast = { id: 'cast-1', spellId: 'protego', t: 1, via: 'gesture', quality: 0.93, power: 0.5, aim: { x: 0.5, y: 0.5 }, incantation: 'Protego', ...over };
  const k = buildKeepsake(cast, undefined, 'Protego', 16 / 9, new Date(2026, 10, 21, 18, 30).getTime());
  return { ...k, points };
}

/** A 2D context that records every call and property set. Text is 0.5 em per character wide. */
function recordingContext() {
  const calls: { name: string; args: unknown[] }[] = [];
  const props: Record<string, unknown> = { font: '10px serif' };
  const gradient = { addColorStop: (...args: unknown[]) => calls.push({ name: 'addColorStop', args }) };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, name: string) {
      if (name in props) return props[name];
      if (name === 'measureText') return (text: string) => ({ width: text.length * Number(/(\d+)px/.exec(String(props.font))?.[1] ?? 10) * 0.5 });
      if (name === 'createRadialGradient' || name === 'createLinearGradient') {
        return (...args: unknown[]) => {
          calls.push({ name, args });
          return gradient;
        };
      }
      return (...args: unknown[]) => calls.push({ name, args });
    },
    set(_target, name: string, value: unknown) {
      props[name] = value;
      calls.push({ name: `=${name}`, args: [value] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('card content', () => {
  it('names the incantation, or the variant, with the theme grade and the date', () => {
    expect(cardContent(keepsake(), THEME)).toMatchObject({ title: 'Protego', grade: 'Outstanding', date: '21 November 2026', aspect: 16 / 9 });
    expect(cardContent(keepsake({ variant: 'Lumos Maxima', quality: 0.5 }), THEME)).toMatchObject({ title: 'Lumos Maxima', grade: 'Acceptable' });
    expect(cardContent(keepsake({ quality: 0.85 }), null).grade).toBe('Exceeds Expectations');
    expect(formatDate(new Date(2027, 0, 2).getTime())).toBe('2 January 2027');
    expect(cardFilename(keepsake())).toBe('spellglass-protego-2026-11-21.png');
  });

  it('takes the theme tokens it can trust and keeps the defaults for the rest', () => {
    const p = cardPalette(THEME);
    expect(p).toMatchObject({ vellum: '#EEE2C8', ink: '#2B2118', night: '#0F1424', display: 'IM Fell English' });
    expect(cardPalette({ ...THEME, fonts: { display: 'Evil"; font: x', text: 'Spectral' } } as ThemePack).display).toBe('IM Fell English');
    expect(withAlpha('#F2B84B', 0.5)).toBe('rgba(242, 184, 75, 0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
  });
});

describe('card layout', () => {
  it('fits the stroke inside the glass and keeps a circle round', () => {
    const pts = strokeOnGlass(circle, 16 / 9);
    const m = LAYOUT.mirror;
    for (const [x, y] of pts) expect(((x - m.cx) / m.rx) ** 2 + ((y - m.cy) / m.ry) ** 2).toBeLessThan(0.75);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeCloseTo(1, 2);
    expect(strokeOnGlass([[0.5, 0.5]], 16 / 9)).toEqual([]);
  });

  it('does not blow a tiny stroke up to fill the glass', () => {
    const tiny = strokeOnGlass([[0.5, 0.5], [0.501, 0.5]], 16 / 9);
    expect(Math.abs(tiny[1][0] - tiny[0][0])).toBeLessThan(10);
  });

  it('fits a title on one line, or two when one will not do', () => {
    const measure = (text: string, size: number) => text.length * size * 0.5;
    expect(fitTitle(measure, 'Lumos', 500)).toEqual({ size: 84, lines: ['Lumos'] });
    expect(fitTitle(measure, 'Wingardium Leviosa', 500)).toEqual({ size: 54, lines: ['Wingardium Leviosa'] });
    const long = fitTitle(measure, 'A very long imported spell name indeed', 500);
    expect(long.lines).toHaveLength(2);
    for (const line of long.lines) expect(measure(line, long.size)).toBeLessThanOrEqual(500);
  });
});

describe('drawing', () => {
  it('draws the vellum, the mirror, the light and every word the card carries', () => {
    const { ctx, calls } = recordingContext();
    drawCard(ctx, cardContent(keepsake(), THEME), cardPalette(THEME));
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['21 November 2026', 'Protego', 'Outstanding', 'Spellglass', 'An unofficial fan project']);
    const fontFor = (text: string) => {
      const i = calls.findIndex((c) => c.name === 'fillText' && c.args[0] === text);
      return calls.slice(0, i).filter((c) => c.name === '=font').at(-1)?.args[0];
    };
    expect(fontFor('Protego')).toMatch(/^italic 400 \d+px "IM Fell English"/);
    expect(fontFor('An unofficial fan project')).toMatch(/18px "Spectral"/);
    expect(calls.filter((c) => c.name === 'save').length).toBe(calls.filter((c) => c.name === 'restore').length);
    expect(calls.some((c) => c.name === 'ellipse')).toBe(true);
    expect(calls.filter((c) => c.name === 'quadraticCurveTo').length).toBeGreaterThan(60);
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([0, 0, CARD_WIDTH, CARD_HEIGHT]);
  });

  it('shows a glow in the mirror for a voice-only cast', () => {
    const { ctx, calls } = recordingContext();
    drawCard(ctx, cardContent(keepsake({ via: 'voice' }, []), THEME), cardPalette(THEME));
    expect(calls.some((c) => c.name === 'quadraticCurveTo')).toBe(false);
    expect(calls.some((c) => c.name === 'arc')).toBe(true);
  });

  it('waits for the display face before it draws, then encodes a PNG', async () => {
    const order: string[] = [];
    const { ctx } = recordingContext();
    const canvas: CardCanvas = {
      width: 0, height: 0,
      getContext: () => {
        order.push('draw');
        return ctx;
      },
      toBlob: (cb, type) => {
        order.push(`encode ${type}`);
        cb(new Blob(['png'], { type: 'image/png' }));
      },
    };
    const env = {
      createCanvas: (w: number, h: number) => {
        order.push(`canvas ${w}x${h}`);
        return canvas;
      },
      fonts: {
        load: async (font: string) => {
          order.push(`font ${font}`);
          return [];
        },
      },
    };
    const blob = await renderCard(cardContent(keepsake(), THEME), cardPalette(THEME), env);
    expect(blob.type).toBe('image/png');
    expect(order[0]).toBe('font italic 64px "IM Fell English"');
    expect(order.slice(-3)).toEqual(['canvas 1200x630', 'draw', 'encode image/png']);
  });
});

describe('share.card', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the PNG and its file name', async () => {
    const { ctx } = recordingContext();
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: Blob) => void) => cb(new Blob(['png'], { type: 'image/png' })) };
    vi.stubGlobal('document', { createElement: () => canvas, fonts: { load: async () => [] } });
    const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.dom'] });
    kernel.register(createShareModule({ appUrl: 'https://example.test/' }));
    await kernel.init();
    await kernel.start();
    emit(kernel, 'engine.rules', 'spell.cast', { id: 'cast-7', spellId: 'nox', t: 1, via: 'gesture', quality: 0.95, power: 0.4, aim: { x: 0.5, y: 0.5 }, incantation: 'Nox' });
    const card = await ask(kernel, 'share.card', { castId: 'cast-7' });
    expect(card.blob.type).toBe('image/png');
    expect(card.filename).toMatch(/^spellglass-nox-\d{4}-\d{2}-\d{2}\.png$/);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);
    await kernel.stop();
  });
});
