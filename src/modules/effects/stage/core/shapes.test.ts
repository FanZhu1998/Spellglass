import { describe, expect, it } from 'vitest';
import { BOLT_TRAVEL_MS, Bolt, drawBolt } from './shapes';
import type { BoltParams } from './limits';
import type { Sprites } from './sprites';
import { View } from './view';

/** A canvas that records the alpha of everything drawn: strokes and images. */
function recordingContext() {
  const drawn: number[] = [];
  let alpha = 1;
  const ctx = {
    get globalAlpha() { return alpha; },
    set globalAlpha(v: number) { alpha = v; },
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '#000',
    lineWidth: 1,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() { drawn.push(alpha); },
    drawImage() { drawn.push(alpha); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

const sprites = { glow: () => ({}), star: () => ({}) } as unknown as Sprites;

function view(): View {
  const v = new View();
  v.update(1280, 720, 1, 16 / 9);
  return v;
}

const params = (over: Partial<BoltParams> = {}): BoltParams => ({ from: 'tip', to: 'target', color: '#FF4040', width: 2.5, jagged: true, red: false, ...over });

describe('bolts over the flash budget (Section 10.6)', () => {
  it('are drawn as a faint trace: everything a refused bolt draws adds up to under a tenth of full light', () => {
    for (const red of [false, true]) {
      const bolt = new Bolt('c1', params({ red }), { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.4 }, 0, false, 7);
      // Every moment of its life: travelling, arrived (where a bright bolt flares), fading.
      for (let t = 0; t < bolt.duration; t += 16) {
        const { ctx, drawn } = recordingContext();
        drawBolt(ctx, bolt, view(), sprites, t, false);
        // All of it may land on one spot: the sum is what that spot could gain in one frame.
        const total = drawn.reduce((a, b) => a + b, 0);
        expect(total).toBeLessThan(0.1);
      }
    }
  });

  it('keeps a bolt inside the budget bright: it is one of the counted flashes', () => {
    const bolt = new Bolt('c1', params(), { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.4 }, 0, true, 7);
    const { ctx, drawn } = recordingContext();
    drawBolt(ctx, bolt, view(), sprites, BOLT_TRAVEL_MS + 10, false);
    expect(Math.max(...drawn)).toBeGreaterThan(0.5);
  });
});
