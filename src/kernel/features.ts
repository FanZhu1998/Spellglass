// Feature detection (Section 15.1: "feature detection everywhere; each feature is an optional
// module"). Each detected feature becomes a 'platform.*' capability that modules can require.

export const PLATFORM = {
  camera: 'platform.camera',
  rvfc: 'platform.video-frame-callback',
  trackProcessor: 'platform.track-processor',
  worker: 'platform.worker',
  offscreenCanvas: 'platform.offscreen-canvas',
  webgl: 'platform.webgl',
  wasm: 'platform.wasm',
  audio: 'platform.audio',
  speech: 'platform.speech',
  speechLocal: 'platform.speech-local',
  indexedDb: 'platform.indexeddb',
  mediaRecorder: 'platform.media-recorder',
  shareFiles: 'platform.share-files',
  share: 'platform.share',
  clipboard: 'platform.clipboard',
  serviceWorker: 'platform.service-worker',
  pointer: 'platform.pointer',
  dom: 'platform.dom',
} as const;

type AnyGlobal = typeof globalThis & Record<string, any>;

/** Detect what this browser offers. Never throws; anything uncertain counts as absent. */
export function detectFeatures(g: AnyGlobal = globalThis as AnyGlobal): string[] {
  const found: string[] = [];
  const test = (cap: string, fn: () => unknown) => {
    try {
      if (fn()) found.push(cap);
    } catch {
      /* absent */
    }
  };
  const nav = g.navigator as any;
  test(PLATFORM.dom, () => typeof g.document !== 'undefined');
  test(PLATFORM.camera, () => !!nav?.mediaDevices?.getUserMedia);
  test(PLATFORM.rvfc, () => typeof g.HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in g.HTMLVideoElement.prototype);
  test(PLATFORM.trackProcessor, () => typeof g.MediaStreamTrackProcessor === 'function');
  test(PLATFORM.worker, () => typeof g.Worker === 'function');
  test(PLATFORM.offscreenCanvas, () => typeof g.OffscreenCanvas === 'function');
  test(PLATFORM.webgl, () => {
    if (typeof g.document === 'undefined') return false;
    const c = g.document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  test(PLATFORM.wasm, () => typeof g.WebAssembly === 'object');
  test(PLATFORM.audio, () => typeof (g.AudioContext ?? g.webkitAudioContext) === 'function');
  test(PLATFORM.speech, () => typeof (g.SpeechRecognition ?? g.webkitSpeechRecognition) === 'function');
  test(PLATFORM.speechLocal, () => typeof (g.SpeechRecognition ?? g.webkitSpeechRecognition)?.available === 'function');
  test(PLATFORM.indexedDb, () => typeof g.indexedDB === 'object' && g.indexedDB !== null);
  test(PLATFORM.mediaRecorder, () => typeof g.MediaRecorder === 'function');
  test(PLATFORM.share, () => typeof nav?.share === 'function');
  test(PLATFORM.shareFiles, () => {
    if (typeof nav?.canShare !== 'function' || typeof g.File !== 'function') return false;
    return nav.canShare({ files: [new g.File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })] });
  });
  test(PLATFORM.clipboard, () => typeof nav?.clipboard?.writeText === 'function');
  test(PLATFORM.serviceWorker, () => 'serviceWorker' in (nav ?? {}));
  test(PLATFORM.pointer, () => typeof g.PointerEvent === 'function');
  return found;
}
