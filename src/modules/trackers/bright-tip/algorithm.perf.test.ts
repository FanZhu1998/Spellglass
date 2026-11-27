// The bright tip's time budget (Section 13 "Performance": tracker step 4 ms or less per frame, before
// each release). Run with npm run test:perf on a quiet machine; algorithm.test.ts keeps a generous
// guard in the parallel suite. Node stands in for the worker, which runs the same code.
import { describe, expect, it } from 'vitest';
import { TipTracker } from './algorithm';
import { crop, renderFrame } from './synthetic';

const DT = 1000 / 30;

describe('performance (Section 13: tracker step 4 ms or less per frame)', () => {
  it('tracks a 1920x1080 frame through its window in 4 ms or less (median)', () => {
    const rgba = renderFrame({ width: 1920, height: 1080, background: 18, noise: 5, seed: 3, dots: [{ x: 905.5, y: 512.25, radius: 3.5 }] });
    const tracker = new TipTracker({ staticMask: false });
    // Lock on with two full frames, then time the frames that read only the window round the tip.
    tracker.process(rgba, tracker.plan(1920, 1080, 0), 0);
    tracker.process(rgba, tracker.plan(1920, 1080, DT), DT);
    let t = 2 * DT;
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const plan = tracker.plan(1920, 1080, t);
      const t0 = performance.now();
      const region = plan.survey ? rgba : crop(rgba, plan.rect);
      tracker.process(region, plan, t);
      if (!plan.survey) times.push(performance.now() - t0);
      t += DT;
    }
    times.sort((a, b) => a - b);
    expect(times.length).toBeGreaterThan(20);
    expect(times[times.length >> 1]).toBeLessThanOrEqual(4);
  });
});
