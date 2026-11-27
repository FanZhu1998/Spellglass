// Reading the brightness of a rectangle of a camera frame in the hand worker, for the wand finder
// (wand.ts), the cheapest way the browser allows:
//  1. A VideoFrame in NV12 or I420 (what webcams deliver in Chromium) is copied by rectangle with
//     copyTo(), and its Y plane is the brightness already: one byte per pixel, no conversion here. It is
//     marked video range unless the frame says full range, and the finder stretches it (wand.ts
//     LumaPlane.limited), so its levels mean what they mean on the other two paths.
//  2. A VideoFrame in RGBA or BGRA is copied the same way and weighted to brightness (BT.601).
//  3. Anything else (an ImageBitmap of the video, an opaque GPU frame) is drawn on an OffscreenCanvas and
//     read back.
// Every browser API is touched only inside these functions, never at import time. A path that fails for a
// format is remembered, so it costs one exception, not one a frame. The bright-tip tracker reads its frames
// the same way (trackers/bright-tip/reader.ts); modules do not share code, so this is the hand's own copy
// of the part it needs.

import type { FrameImage } from './protocol';
import type { LumaPlane, Rect } from './wand';

const YUV = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
const RGB = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX']);

export interface LumaReader {
  read(image: FrameImage, rect: Rect): Promise<LumaPlane | null>;
}

function isVideoFrame(image: unknown): image is VideoFrame {
  return typeof VideoFrame === 'function' && image instanceof VideoFrame;
}

export function createLumaReader(): LumaReader {
  let buf = new Uint8Array(0);
  let gray = new Uint8Array(0);
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  const fails = new Set<string>();

  const ensure = (n: number) => {
    if (buf.length < n) buf = new Uint8Array(n);
    return buf.subarray(0, n);
  };

  /** RGBA or BGRA bytes to brightness, in a buffer of its own (the source buffer is reused). */
  function toGray(data: Uint8Array | Uint8ClampedArray, offset: number, stride: number, w: number, h: number, bgr: boolean): Uint8Array {
    if (gray.length < w * h) gray = new Uint8Array(w * h);
    const r = bgr ? 2 : 0, b = bgr ? 0 : 2;
    for (let y = 0; y < h; y++) {
      let p = offset + y * stride;
      const o = y * w;
      for (let x = 0; x < w; x++, p += 4) gray[o + x] = (77 * data[p + r] + 150 * data[p + 1] + 29 * data[p + b]) >> 8;
    }
    return gray;
  }

  async function copy(frame: VideoFrame, rect: Rect): Promise<{ data: Uint8Array; layout: PlaneLayout[] }> {
    const init = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    const data = ensure(frame.allocationSize(init));
    const layout = await frame.copyTo(data, init);
    return { data, layout };
  }

  function viaCanvas(image: FrameImage, rect: Rect): LumaPlane | null {
    if (typeof OffscreenCanvas !== 'function') return null;
    const fullW = isVideoFrame(image) ? image.displayWidth : image.width;
    const fullH = isVideoFrame(image) ? image.displayHeight : image.height;
    if (!canvas || canvas.width < fullW || canvas.height < fullH) {
      // Sized once to the whole frame: the rectangle moves with the hand every frame.
      canvas = new OffscreenCanvas(Math.max(1, fullW), Math.max(1, fullH));
      ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false }) as OffscreenCanvasRenderingContext2D | null;
    }
    if (!ctx) return null;
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const img = ctx.getImageData(0, 0, rect.width, rect.height);
    return { data: toGray(img.data, 0, rect.width * 4, rect.width, rect.height, false), width: rect.width, height: rect.height, stride: rect.width, x0: rect.x, y0: rect.y };
  }

  return {
    async read(image, rect) {
      if (rect.width <= 0 || rect.height <= 0) return null;
      if (isVideoFrame(image)) {
        const fmt = image.format ?? '';
        if (YUV.has(fmt) && !fails.has(fmt)) {
          try {
            const { data, layout } = await copy(image, rect);
            const y = layout[0];
            // Webcam YUV is usually video range (16 to 235); the finder stretches it (wand.ts LumaPlane), as
            // the bright tip's reader does, so its levels mean the same on every read path. MJPEG cameras
            // send full range.
            return {
              data: data.subarray(y.offset), width: rect.width, height: rect.height, stride: y.stride, x0: rect.x, y0: rect.y,
              limited: image.colorSpace?.fullRange !== true,
            };
          } catch {
            fails.add(fmt);
          }
        }
        if (RGB.has(fmt) && !fails.has(fmt)) {
          try {
            const { data, layout } = await copy(image, rect);
            const p = layout[0];
            return { data: toGray(data, p.offset, p.stride, rect.width, rect.height, fmt.startsWith('BGR')), width: rect.width, height: rect.height, stride: rect.width, x0: rect.x, y0: rect.y };
          } catch {
            fails.add(fmt);
          }
        }
      }
      return viaCanvas(image, rect);
    },
  };
}
