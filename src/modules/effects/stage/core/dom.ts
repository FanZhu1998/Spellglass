// The stage's elements inside the mirror (src/main.ts creates the mirror and the shell sizes it).
//
//   root (isolation: isolate, so the screen blend stays inside the mirror)
//   ├─ backdrop: plain dark glass, shown whenever there is no reflection
//   ├─ video: the camera, object-fit: contain (the frame is never cropped), mirrored with scaleX(-1)
//   ├─ shade canvas: normal blending (dimming, props, dull ink)
//   └─ light canvas: mix-blend-mode: screen (glows, trails, particles, bolts)
//
// The mirror element itself is never restyled (contracts/events.ts StageSurface.mirror); everything
// here is a child the stage owns. Pointer events pass through to the mirror, where the pointer
// tracker listens.

import { glassBackdropCss } from './glass';
import type { View } from './view';

export interface StageDom {
  root: HTMLDivElement;
  backdrop: HTMLDivElement;
  video: HTMLVideoElement;
  shade: HTMLCanvasElement;
  light: HTMLCanvasElement;
  shadeCtx: CanvasRenderingContext2D;
  lightCtx: CanvasRenderingContext2D;
  /** The mirror's size in CSS px. */
  measure(): { width: number; height: number };
  /** Size the canvases for the view (device pixels). */
  resize(view: View): void;
  /** Show a stream (or none). */
  setStream(stream: MediaStream | null): void;
  /** Whether the reflection shows (hidden for plain replays), and whether it is mirrored. */
  setVideoShown(shown: boolean, mirrored: boolean): void;
  setVideoFilter(filter: string): void;
  /** Offset the whole mirror by (dx, dy) CSS px, grown by `scale` so its edges stay covered. */
  setShake(dx: number, dy: number, scale: number): void;
  destroy(): void;
}

/**
 * CSS filter that lifts the reflection while the camera runs a short manual exposure (the bright-tip
 * tracker locks one so the room goes nearly black and only the tip's glint survives, Section 7.1).
 * The lift is about the square root of how much light the exposure loses: enough to see yourself,
 * not so much that the noise of a dark frame looks broken.
 *  - exposureTime is in 100 µs units; about 333 is an ordinary 1/30 s.
 *  - Cameras that only offer exposureCompensation report it in stops (EV): -2 is a quarter of the light.
 *  - Manual with neither (or a normal exposure) still means the tracker darkened the room: a modest lift.
 */
export function exposureFilter(exposure: { mode: string; time?: number; compensation?: number } | undefined): string {
  if (!exposure || exposure.mode !== 'manual') return '';
  let loss: number | null = null;
  if (typeof exposure.time === 'number' && exposure.time > 0) loss = 333 / exposure.time;
  else if (typeof exposure.compensation === 'number' && Number.isFinite(exposure.compensation)) loss = 2 ** -exposure.compensation;
  const raw = loss === null ? 2.5 : Math.sqrt(loss);
  // A manual exposure near normal needs no help.
  if (raw <= 1.1) return '';
  const lift = Math.min(4, Math.max(1.3, raw));
  return `brightness(${lift.toFixed(2)}) contrast(1.08) saturate(0.85)`;
}

/** The glass's own tone (glass.ts GLASS_BASE), which the clips use too. */
const GLASS = glassBackdropCss();

export function createStageDom(host: HTMLElement): StageDom | null {
  if (typeof document === 'undefined') return null;
  const root = document.createElement('div');
  root.className = 'stage-root';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;isolation:isolate;pointer-events:none;contain:layout paint;';

  const backdrop = document.createElement('div');
  backdrop.className = 'stage-backdrop';
  backdrop.style.cssText = `position:absolute;inset:0;background:${GLASS};`;

  const video = document.createElement('video');
  video.className = 'stage-video';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.setAttribute('aria-hidden', 'true');
  video.disablePictureInPicture = true;
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity 300ms ease;';

  const shade = document.createElement('canvas');
  shade.className = 'stage-shade';
  shade.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  shade.setAttribute('aria-hidden', 'true');
  const light = document.createElement('canvas');
  light.className = 'stage-light';
  light.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:screen;';
  light.setAttribute('aria-hidden', 'true');

  const shadeCtx = shade.getContext('2d');
  const lightCtx = light.getContext('2d');
  if (!shadeCtx || !lightCtx) return null;

  root.append(backdrop, video, shade, light);
  host.append(root);

  let shown = false;
  let mirrored = true;
  let filter = '';
  const applyVideo = () => {
    video.style.opacity = shown && video.srcObject ? '1' : '0';
    video.style.transform = mirrored ? 'scaleX(-1)' : 'none';
    video.style.filter = filter;
  };

  return {
    root, backdrop, video, shade, light, shadeCtx, lightCtx,
    measure() {
      return { width: host.clientWidth, height: host.clientHeight };
    },
    resize(view) {
      if (shade.width !== view.pixelWidth || shade.height !== view.pixelHeight) {
        shade.width = light.width = view.pixelWidth;
        shade.height = light.height = view.pixelHeight;
      }
    },
    setStream(stream) {
      if (video.srcObject === stream) return;
      video.srcObject = stream;
      if (stream) void video.play().catch(() => {});
      applyVideo();
    },
    setVideoShown(next, nextMirrored) {
      shown = next;
      mirrored = nextMirrored;
      applyVideo();
    },
    setVideoFilter(next) {
      if (next === filter) return;
      filter = next;
      applyVideo();
    },
    setShake(dx, dy, scale) {
      const next = dx || dy ? `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)})` : '';
      if (root.style.transform !== next) root.style.transform = next;
    },
    destroy() {
      video.srcObject = null;
      root.remove();
    },
  };
}
