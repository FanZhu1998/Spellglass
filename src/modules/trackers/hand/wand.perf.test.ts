// The wand finder's time budget. It runs in the hand worker after the landmarks, on every frame in wand
// mode, so it adds to the trail's delay: 4 ms or less a frame (median) for a hand at arm's length in a
// 1080p frame, the bright tip's own budget (Section 13). Measured in the desktop app on 1280 x 720 clips of
// a fist holding a wand, the pixels' read included: 2.4 to 2.6 ms median, 6.2 to 6.7 ms at the 95th
// percentile. Run with npm run test:perf on a quiet machine.
import { describe, expect, it } from 'vitest';
import { gripFrame, toGrip, WandFinder, wandRegion, type LumaPlane } from './wand';
import { renderScene } from './wand-scene';

function planeFor(scene: ReturnType<typeof renderScene>): LumaPlane {
  const g = gripFrame(scene.landmarks, 2, 1, 1);
  const r = wandRegion(g, scene.width, scene.height);
  const data = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) data.set(scene.data.subarray((r.y + y) * scene.width + r.x, (r.y + y) * scene.width + r.x + r.width), y * r.width);
  return { data, width: r.width, height: r.height, stride: r.width, x0: r.x, y0: r.y };
}

function median(times: number[]): number {
  const s = [...times].sort((a, b) => a - b);
  return s[s.length >> 1];
}

describe('performance (wand finder: 4 ms or less a frame)', () => {
  const scene = renderScene({
    width: 1920, height: 1080, hand: { x: 960, y: 820, palm: 110, angle: -Math.PI / 2 - 0.2 },
    wand: { angle: -1.9, length: 2.6 }, background: 'room',
  });
  const plane = planeFor(scene);

  it('searches every direction in 4 ms or less (median), a hand at arm\'s length in a 1080p frame', () => {
    const finder = new WandFinder();
    for (let i = 0; i < 10; i++) finder.find(plane, scene.landmarks, null);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      finder.find(plane, scene.landmarks, null);
      times.push(performance.now() - t0);
    }
    expect(median(times)).toBeLessThanOrEqual(4);
  });

  it('searches around the prior in less time still', () => {
    const finder = new WandFinder();
    const prior = toGrip(gripFrame(scene.landmarks, 2, 1, 1), scene.tip!.x, scene.tip!.y);
    for (let i = 0; i < 10; i++) finder.find(plane, scene.landmarks, prior);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const f = finder.find(plane, scene.landmarks, prior);
      times.push(performance.now() - t0);
      expect(f?.search).toBe('prior');
    }
    expect(median(times)).toBeLessThanOrEqual(3);
  });
});
