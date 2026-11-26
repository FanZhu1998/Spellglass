import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLumaReader } from './luma';
import type { FrameImage } from './protocol';

// The reader in Node, with a stand-in for VideoFrame: which path a frame takes, what it reads, and
// whether its levels are marked video range for the finder to stretch (wand.ts LumaPlane.limited).

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame whose pixel (x, y) has level `level(x, y)`, in a given format. */
class FakeVideoFrame {
  copies = 0;
  constructor(
    readonly format: string,
    readonly colorSpace: { fullRange?: boolean } | null,
    private readonly level: (x: number, y: number) => number,
    readonly displayWidth = 64,
    readonly displayHeight = 48,
    private readonly fails = false,
  ) {}

  allocationSize(init: { rect: Rect }): number {
    const bytes = this.format.endsWith('A') || this.format.endsWith('X') ? 4 : 1.5;
    return Math.ceil(init.rect.width * init.rect.height * bytes);
  }

  async copyTo(dest: Uint8Array, init: { rect: Rect }): Promise<{ offset: number; stride: number }[]> {
    this.copies++;
    if (this.fails) throw new DOMException('not by rectangle', 'NotSupportedError');
    const { x, y, width, height } = init.rect;
    if (this.format === 'RGBA' || this.format === 'BGRA') {
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          const v = this.level(x + c, y + r), o = (r * width + c) * 4;
          dest[o] = v;
          dest[o + 1] = v;
          dest[o + 2] = v;
          dest[o + 3] = 255;
        }
      }
      return [{ offset: 0, stride: width * 4 }];
    }
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) dest[r * width + c] = this.level(x + c, y + r);
    return [{ offset: 0, stride: width }, { offset: width * height, stride: width }];
  }

  close(): void {}
}

const saved = (globalThis as { VideoFrame?: unknown }).VideoFrame;
beforeEach(() => {
  (globalThis as { VideoFrame?: unknown }).VideoFrame = FakeVideoFrame;
});
afterEach(() => {
  (globalThis as { VideoFrame?: unknown }).VideoFrame = saved;
});

const frame = (...a: ConstructorParameters<typeof FakeVideoFrame>) => new FakeVideoFrame(...a) as unknown as FrameImage & FakeVideoFrame;
const rect = { x: 8, y: 4, width: 16, height: 10 };
const at = (x: number, y: number) => (x * 3 + y * 5) % 200;

describe('the luma reader', () => {
  it("reads a YUV frame's Y plane by rectangle, marked video range unless the frame says full range", async () => {
    const reader = createLumaReader();
    for (const [colorSpace, limited] of [[{ fullRange: false }, true], [null, true], [{}, true], [{ fullRange: true }, false]] as const) {
      const plane = (await reader.read(frame('NV12', colorSpace, at), rect))!;
      expect(plane).toMatchObject({ width: 16, height: 10, x0: 8, y0: 4, limited });
      expect(plane.data[plane.stride * 3 + 5]).toBe(at(8 + 5, 4 + 3));
    }
  });

  it('weighs an RGBA frame to brightness, full range', async () => {
    const plane = (await createLumaReader().read(frame('RGBA', null, () => 120), rect))!;
    expect(plane.limited).toBeFalsy();
    expect(plane.data[0]).toBe(120);
  });

  it('gives up on copying a format that refuses once, and reads nothing without a canvas', async () => {
    const reader = createLumaReader();
    const first = frame('I420', null, at, 64, 48, true);
    expect(await reader.read(first, rect)).toBeNull();
    const second = frame('I420', null, at, 64, 48, true);
    expect(await reader.read(second, rect)).toBeNull();
    // The second frame of that format is not even tried by rectangle.
    expect(second.copies).toBe(0);
    expect(await reader.read(frame('NV12', null, at), { x: 0, y: 0, width: 0, height: 4 })).toBeNull();
  });
});
