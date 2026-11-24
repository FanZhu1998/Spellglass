// Reading pixels in the worker, by rectangle, the cheapest way the browser allows.
//
// Section 13 budgets 4 ms per frame, and getImageData of a whole 1080p frame costs 2 to 5 ms by itself.
// So, in order of preference:
//  1. 'y-plane': a VideoFrame in NV12 or I420 (what webcams deliver in Chromium) is copied by rectangle
//     with copyTo(), and its Y plane is the luma channel already: one byte per pixel, no conversion.
//  2. 'rgba-copy': a VideoFrame that is already RGBA or BGRA is copied by rectangle the same way.
//  3. 'canvas': anything else (an ImageBitmap where VideoFrame is missing, an opaque GPU frame, a colour
//     channel on a YUV frame) is drawn on an OffscreenCanvas with willReadFrequently and read back.
// Every browser API is touched only inside these functions, never at import time.

import type { Channel, PixelRegion, Rect } from './algorithm';
import { limitedRangeLut } from './algorithm';
import type { ReadPath } from './protocol';

export interface ReadResult {
  region: PixelRegion;
  path: ReadPath;
}

export interface FrameReader {
  read(source: VideoFrame | ImageBitmap, rect: Rect, channel: Channel): Promise<ReadResult>;
}

const YUV_FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
const RGB_FORMATS = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX']);

export function isVideoFrame(source: unknown): source is VideoFrame {
  return typeof VideoFrame === 'function' && source instanceof VideoFrame;
}

export function createFrameReader(): FrameReader {
  let buf = new Uint8Array(0);
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  // copyTo can fail for a frame type (an opaque texture, a format the browser will not copy by rect);
  // remember that per format so a failing path costs one exception, not one per frame.
  const copyFails = new Set<string>();
  const limited = limitedRangeLut();

  const ensure = (n: number) => {
    if (buf.length < n) buf = new Uint8Array(n);
    return buf;
  };

  async function copyRect(frame: VideoFrame, rect: Rect): Promise<{ data: Uint8Array; layout: PlaneLayout[] }> {
    const init = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    const size = frame.allocationSize(init);
    const data = ensure(size).subarray(0, size);
    const layout = await frame.copyTo(data, init);
    return { data, layout };
  }

  async function viaCanvas(source: VideoFrame | ImageBitmap, rect: Rect): Promise<ReadResult> {
    const fullW = isVideoFrame(source) ? source.displayWidth : source.width;
    const fullH = isVideoFrame(source) ? source.displayHeight : source.height;
    if (!canvas || canvas.width < fullW || canvas.height < fullH) {
      // Sized once to the whole frame: windows change size every frame and resizing reallocates.
      canvas = new OffscreenCanvas(Math.max(1, fullW), Math.max(1, fullH));
      ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false }) as OffscreenCanvasRenderingContext2D | null;
    }
    if (!ctx) throw new Error('No 2D canvas in the worker');
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const img = ctx.getImageData(0, 0, rect.width, rect.height);
    return { region: { ...rect, format: 'rgba', data: img.data, stride: rect.width * 4 }, path: 'canvas' };
  }

  return {
    async read(source, rect, channel) {
      if (isVideoFrame(source)) {
        const fmt = source.format ?? '';
        if (channel === 'luma' && YUV_FORMATS.has(fmt) && !copyFails.has(fmt)) {
          try {
            const { data, layout } = await copyRect(source, rect);
            const y = layout[0];
            // Webcam YUV is usually limited range (16..235); stretch it so the floor and the contrast
            // readout mean the same on every read path. MJPEG cameras deliver full range.
            const lut = source.colorSpace?.fullRange ? undefined : limited;
            return { region: { ...rect, format: 'gray', data: data.subarray(y.offset), stride: y.stride, lut }, path: 'y-plane' };
          } catch {
            copyFails.add(fmt);
          }
        }
        if (RGB_FORMATS.has(fmt) && !copyFails.has(fmt)) {
          try {
            const { data, layout } = await copyRect(source, rect);
            const p = layout[0];
            const format = fmt.startsWith('BGR') ? 'bgra' : 'rgba';
            return { region: { ...rect, format, data: data.subarray(p.offset), stride: p.stride }, path: 'rgba-copy' };
          } catch {
            copyFails.add(fmt);
          }
        }
      }
      return viaCanvas(source, rect);
    },
  };
}
