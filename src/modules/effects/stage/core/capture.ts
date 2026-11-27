// Clips (Section 11.1): "The clip records the effects layer. Your camera image is left out unless
// you tick 'Include my camera'." Each requester gets its own canvas, into which every animation
// frame composites the plain glass (or the mirrored video, only when includeCamera) and both layers
// with their blend modes; canvas.captureStream(fps) turns it into a video track.

import { KernelError } from '../../../../kernel';
import type { StageDom } from './dom';
import { fillGlassBase, glassBaseGradient } from './glass';
import { makeCanvas } from './sprites';
import type { View } from './view';

interface Clip {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  stream: MediaStream;
  includeCamera: boolean;
  /** The plain glass, matching the stage's backdrop (glass.ts GLASS_BASE, in its unit space). */
  glass: CanvasGradient;
}

/** Clips are capped at this width; larger mirrors are scaled down. */
const MAX_CLIP_WIDTH = 1920;

export class ClipCompositor {
  private clips = new Map<string, Clip>();

  get active(): boolean {
    return this.clips.size > 0;
  }

  start(requester: string, includeCamera: boolean, fps: number, view: View): MediaStream {
    this.stop(requester);
    const k = Math.min(1, MAX_CLIP_WIDTH / view.pixelWidth);
    const canvas = makeCanvas(view.pixelWidth * k, view.pixelHeight * k);
    const ctx = canvas?.getContext('2d');
    const capture = canvas as (HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }) | null;
    if (!canvas || !ctx || typeof capture?.captureStream !== 'function') {
      throw new KernelError('not-supported', 'This browser cannot record the mirror.');
    }
    const stream = capture.captureStream(Math.max(1, Math.min(60, fps || 30)));
    const glass = glassBaseGradient(ctx);
    this.clips.set(requester, { canvas, ctx, stream, includeCamera, glass });
    return stream;
  }

  stop(requester: string): void {
    const clip = this.clips.get(requester);
    if (!clip) return;
    for (const track of clip.stream.getTracks()) track.stop();
    this.clips.delete(requester);
  }

  stopAll(): void {
    for (const id of [...this.clips.keys()]) this.stop(id);
  }

  /** Composite one frame into every clip. */
  composite(dom: StageDom, view: View, videoShown: boolean, videoMirrored: boolean, videoFilter: string, shake: { dx: number; dy: number }): void {
    for (const clip of this.clips.values()) {
      const { canvas, ctx } = clip;
      const k = canvas.width / Math.max(1, view.pixelWidth);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      fillGlassBase(ctx, clip.glass, canvas.width, canvas.height);
      const dx = shake.dx * view.dpr * k, dy = shake.dy * view.dpr * k;
      const video = dom.video;
      if (clip.includeCamera && videoShown && video.readyState >= 2 && video.videoWidth > 0) {
        const r = view.caster;
        const x = r.x * view.dpr * k + dx, y = r.y * view.dpr * k + dy;
        const w = r.width * view.dpr * k, h = r.height * view.dpr * k;
        ctx.save();
        if (videoFilter) ctx.filter = videoFilter;
        if (videoMirrored) {
          ctx.translate(x + w, y);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, w, h);
        } else {
          ctx.drawImage(video, x, y, w, h);
        }
        ctx.restore();
      }
      ctx.drawImage(dom.shade, dx, dy, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(dom.light, dx, dy, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
