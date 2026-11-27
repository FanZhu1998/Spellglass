// A minimal stand-in for the capture module, for the hand tracker's development page only. It answers
// 'camera.start' and 'camera.stop' and publishes camera.ready, camera.status and one camera.frame per
// video frame, like src/modules/capture does, from either the webcam or a still image drawn into a canvas
// stream (so a photo of a hand can stand in for the camera). It lives here, not in tools/, because a
// module folder may only import the kernel, the contracts and itself.

import type { CameraFrame, CameraReady, Module } from '../../../../contracts';
import { emit } from '../../../../kernel';

export function createDevCamera(opts: { image?: string | null; width?: number; height?: number }): Module {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let ready: CameraReady | null = null;
  let opening: Promise<CameraReady> | null = null;
  let frameNo = 0;
  let raf = 0;

  async function imageStream(url: string): Promise<MediaStream> {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d')!;
    const draw = () => {
      // Letterboxed, so the hand keeps its proportions. A frame is only produced when the canvas is drawn.
      g.fillStyle = '#000';
      g.fillRect(0, 0, width, height);
      const s = Math.min(width / img.naturalWidth, height / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      g.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return canvas.captureStream(30);
  }

  return {
    manifest: { id: 'capture.camera', kind: 'capture', version: '0.0.1', contract: '^1.1', provides: ['camera.frames@1'], requires: [], title: 'Development camera' },
    async init(k) {
      k.handle('camera.start', async () => {
        if (ready) return ready;
        opening ??= (async () => {
          stream = opts.image ? await imageStream(opts.image) : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } } });
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.srcObject = stream;
          v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
          document.body.append(v);
          await v.play();
          video = v;
          const track = stream.getVideoTracks()[0];
          const s = track.getSettings();
          const r: CameraReady = {
            deviceId: s.deviceId ?? 'dev', label: opts.image ? 'Still image' : track.label, width: v.videoWidth || width, height: v.videoHeight || height,
            fps: s.frameRate ?? 30, stream, exposure: null, infrared: false, generation: 1,
          };
          ready = r;
          emit(k, 'capture.camera', 'camera.ready', r);
          emit(k, 'capture.camera', 'camera.status', { state: 'on', generation: 1, permission: 'granted', label: r.label, width: r.width, height: r.height, fps: r.fps });
          const tick: VideoFrameRequestCallback = (now, meta) => {
            if (!video) return;
            video.requestVideoFrameCallback(tick);
            const f: CameraFrame = {
              t: meta.captureTime ?? meta.expectedDisplayTime ?? now,
              timeSource: meta.captureTime !== undefined ? 'capture' : 'presented',
              frame: frameNo++, generation: 1, width: meta.width || r.width, height: meta.height || r.height, video,
            };
            emit(k, 'capture.camera', 'camera.frame', f, f.t);
          };
          v.requestVideoFrameCallback(tick);
          return r;
        })();
        return opening;
      });
      k.handle('camera.stop', () => {
        /* the page keeps the camera until it closes */
      });
    },
    async start() {},
    async stop() {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      video?.remove();
      video = null;
    },
  };
}
