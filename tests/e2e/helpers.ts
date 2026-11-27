// Shared helpers for the end-to-end tests: boot the app with chosen settings, record pipeline
// events in the page, and draw strokes with the mouse in caster space.
import type { Page } from '@playwright/test';

/**
 * Headless Chrome draws through a software GPU (SwiftShader), which compiles its shaders the first
 * time the stage uses a canvas effect: the first press on the mirror then holds input back for three
 * seconds or more, long enough to push a stroke past the segmenter's 4 s cap. These tests check what
 * the app does, not how the GPU draws it, so Chrome runs without the GPU (playwright.config.ts, and
 * every test that launches its own browser).
 */
export const NO_GPU = ['--disable-gpu'];

export interface Seen {
  type: string;
  p: Record<string, any>;
}

/** Open the app, apply settings through the kernel, and start recording events in the page. */
export async function boot(page: Page, settings: Record<string, unknown> = {}, path = '/'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => !!(window as any).__spellglass);
  await page.evaluate(async (s) => {
    const { kernel } = (window as any).__spellglass;
    for (const [key, value] of Object.entries(s)) await kernel.request('settings.set', { key, value });
    (window as any).__seen = [];
    for (const t of ['spell.cast', 'spell.fizzle', 'stroke.end', 'recognition.result', 'tracker.status', 'camera.status', 'replay.state']) {
      kernel.subscribe(t, (e: { payload: unknown }) => (window as any).__seen.push({ type: t, p: e.payload }));
    }
  }, settings);
}

/** Settings for casting with the mouse, every spell open, no camera. */
export const MOUSE = {
  'capture.mirror': false,
  'tracker.active': 'tracker.pointer',
  'spells.unlockAll': true,
  'app.onboarded': true,
};

export async function seen(page: Page, type?: string): Promise<Seen[]> {
  const all = (await page.evaluate(() => (window as any).__seen)) as Seen[];
  return type ? all.filter((e) => e.type === type) : all;
}

export async function casts(page: Page): Promise<string[]> {
  return (await seen(page, 'spell.cast')).map((e) => e.p.spellId);
}

/** Wait until the page has recorded a cast of every spell in `ids`. */
export async function waitForCasts(page: Page, ids: string[], timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const got = new Set(((window as any).__seen as Seen[]).filter((e) => e.type === 'spell.cast').map((e) => e.p.spellId));
      return want.every((id: string) => got.has(id));
    },
    ids,
    { timeout },
  );
}

/** Draw a stroke with the mouse along caster-space points over about `ms` milliseconds (pen mode). */
export async function draw(page: Page, points: [number, number][], ms: number): Promise<void> {
  const box = await page.locator('.mirror-surface').boundingBox();
  if (!box) throw new Error('The mirror is not on the page');
  const at = (x: number, y: number): [number, number] => [box.x + x * box.width, box.y + y * box.height];
  await page.mouse.move(...at(...points[0]));
  await page.mouse.down();
  // Each move waits for the next frame, and a software-rendered frame of the stage can take 30 to
  // 50 ms: past about 32 moves a slow stroke would run into the segmenter's 4 s cap for pen strokes.
  // The recognizer resamples every stroke to 64 points, so fewer moves draw the same shape.
  const steps = Math.min(32, Math.max(12, Math.round(ms / 16)));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const seg = Math.min(points.length - 2, Math.floor(f * (points.length - 1)));
    const local = f * (points.length - 1) - seg;
    const [ax, ay] = points[seg];
    const [bx, by] = points[seg + 1];
    await page.mouse.move(...at(ax + (bx - ax) * local, ay + (by - ay) * local));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** A clockwise circle from the top, round on screen for a mirror of the given aspect. */
export function circle(aspect: number, cx = 0.5, cy = 0.45, r = 0.17): [number, number][] {
  return Array.from({ length: 25 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    return [cx + (r * Math.cos(a)) / aspect, cy + r * Math.sin(a)] as [number, number];
  });
}

export async function mirrorAspect(page: Page): Promise<number> {
  const box = await page.locator('.mirror-surface').boundingBox();
  return box ? box.width / box.height : 16 / 9;
}
