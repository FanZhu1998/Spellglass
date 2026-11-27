import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TipTracker, type FramePlan } from '../../src/modules/trackers/bright-tip/algorithm';
import { ClipRenderer, DEFAULT_SPELLS, frameBytes, gesturesFromPack, planClip, readY4m, writeY4m, y4mHeader } from './make-y4m';

/** The plan's rectangle of a Y plane, as the worker copies it with VideoFrame.copyTo. */
function readRect(y: Uint8Array, width: number, plan: FramePlan) {
  const r = plan.rect;
  const data = new Uint8Array(r.width * r.height);
  for (let row = 0; row < r.height; row++) data.set(y.subarray((r.y + row) * width + r.x, (r.y + row) * width + r.x + r.width), row * r.width);
  return { ...r, format: 'gray' as const, data, stride: r.width };
}

const dir = mkdtempSync(join(tmpdir(), 'spellglass-y4m-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fake-camera clips', () => {
  it('takes the four core gestures from the shipped pack', () => {
    const g = gesturesFromPack();
    expect(g.map((x) => x.spellId)).toEqual(DEFAULT_SPELLS);
    // Lumos is a flick up: a vertical line, bottom to top.
    const lumos = g[0].path;
    expect(lumos[0][1]).toBeGreaterThan(lumos[lumos.length - 1][1]);
    expect(Math.abs(lumos[0][0] - lumos[lumos.length - 1][0])).toBeLessThan(1e-9);
  });

  it('plans the hold-still rhythm: hold 0.5 s, trace 1.2 s, pause 0.5 s, away', () => {
    const s = planClip({ fps: 30 });
    expect(s.gestures.map((g) => g.spellId)).toEqual(DEFAULT_SPELLS);
    const first = s.gestures[0];
    expect(first.startFrame).toBe(45); // 1.5 s of empty room first
    expect(first.traceStart - first.startFrame).toBe(15);
    expect(first.traceEnd - first.traceStart + 1).toBe(36);
    expect(s.truth[first.traceEnd + 1].phase).toBe('pause');
    expect(s.truth[first.endFrame].phase).toBe('away');
    expect(s.truth[first.endFrame].tip).toBeNull();
    // Stupefy, a flick right as the caster sees it, runs left to right in caster space.
    const st = s.gestures[3];
    expect(s.truth[st.traceEnd].tip!.x).toBeGreaterThan(s.truth[st.traceStart].tip!.x);
  });

  it('writes a y4m file whose header and frames Chrome can read', () => {
    const path = join(dir, 'short.y4m');
    const script = writeY4m(path, { width: 64, height: 36, fps: 10, leadMs: 200, gestures: gesturesFromPack(['stupefy']) });
    const bytes = new Uint8Array(readFileSync(path));
    const header = y4mHeader(64, 36, 10, 'C420jpeg');
    expect(new TextDecoder().decode(bytes.subarray(0, header.length))).toBe('YUV4MPEG2 W64 H36 F10:1 Ip A1:1 C420jpeg\n');
    expect(statSync(path).size).toBe(header.length + script.frames * (6 + frameBytes(64, 36)));
    const file = readY4m(bytes);
    expect(file).toMatchObject({ width: 64, height: 36, fps: 10, colorspace: 'C420jpeg', frameCount: script.frames });
    expect(file.luma(0)).toHaveLength(64 * 36);
  });

  it('draws the dot mirrored: the camera sees the caster\'s right on its left', () => {
    const path = join(dir, 'mirror.y4m');
    const script = writeY4m(path, { width: 320, height: 180, fps: 30, leadMs: 0, holdMs: 100, noise: 0, gestures: gesturesFromPack(['stupefy']) });
    const file = readY4m(new Uint8Array(readFileSync(path)));
    const i = script.gestures[0].traceStart; // the start of a flick right: the caster's left
    const tip = script.truth[i].tip!;
    expect(tip.x).toBeLessThan(0.45);
    const y = file.luma(i);
    let best = 0, bx = 0;
    for (let p = 0; p < y.length; p++) if (y[p] > best) (best = y[p]), (bx = p % 320);
    expect(best).toBeGreaterThan(200);
    expect(bx / 320).toBeCloseTo(1 - tip.x, 1);
  });

  it('is tracked by the bright-tip algorithm at the true caster position', () => {
    const path = join(dir, 'track.y4m');
    const script = writeY4m(path, { width: 640, height: 360, fps: 30, leadMs: 1200, gestures: gesturesFromPack(['wingardium-leviosa']) });
    const file = readY4m(new Uint8Array(readFileSync(path)));
    const tracker = new TipTracker();
    let tracked = 0, worst = 0, traced = 0;
    for (let i = 0; i < file.frameCount; i++) {
      const t = (i * 1000) / 30;
      const plan = tracker.plan(640, 360, t);
      const result = tracker.process(readRect(file.luma(i), 640, plan), plan, t);
      const truth = script.truth[i];
      if (truth.phase !== 'trace') continue;
      traced++;
      if (!result.sample || !truth.tip) continue;
      tracked++;
      // Caster space on both sides: the tracker flips x back.
      worst = Math.max(worst, Math.hypot((result.sample.x - truth.tip.x) * 640, (result.sample.y - truth.tip.y) * 360));
    }
    expect(tracked / traced).toBeGreaterThan(0.95);
    // The short-exposure smear trails the dot by a few pixels on the fastest parts of the stroke.
    expect(worst).toBeLessThan(4);
  });

  it('is followed through the fastest gesture at 1080p, where the dot smears into a streak', () => {
    // Rendered in memory (a file would be 400 MB). Protego's circle moves about 55 px a frame here,
    // so the glint is drawn as a short streak, which the tracker must still take for the tip.
    const options = { width: 1920, height: 1080, fps: 30, leadMs: 1200, gestures: gesturesFromPack(['protego']) };
    const script = planClip(options);
    expect(script.dotRadius).toBe(3); // camera pixels, at every frame size
    const renderer = new ClipRenderer(script, options);
    const buf = new Uint8Array(frameBytes(1920, 1080));
    const tracker = new TipTracker();
    let traced = 0, tracked = 0, worst = 0;
    for (let i = 0; i < script.frames; i++) {
      const t = (i * 1000) / 30;
      const plan = tracker.plan(1920, 1080, t);
      renderer.render(i, buf);
      const result = tracker.process(readRect(buf.subarray(0, 1920 * 1080), 1920, plan), plan, t);
      const truth = script.truth[i];
      if (truth.phase !== 'trace') continue;
      traced++;
      if (!result.sample || !truth.tip) continue;
      tracked++;
      worst = Math.max(worst, Math.hypot((result.sample.x - truth.tip.x) * 1920, (result.sample.y - truth.tip.y) * 1080));
    }
    expect(tracked).toBe(traced);
    // A streak's centroid is the middle of the smear: about an eighth of a frame's travel behind.
    expect(worst).toBeLessThan(10);
  });
});
