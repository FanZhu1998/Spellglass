// Clips with stand-ins for MediaRecorder and MediaStream, under fake timers, through a real kernel
// whose stage and audio requests are answered by small fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipState, Envelope, Spellbook } from '../../contracts';
import { KernelError, ask, createKernel, emit, logger, memoryPersistence, type KernelHost } from '../../kernel';
import { ClipRecorder, CLIP_MESSAGES, baseType, clipExtension, clipFilename, pickClipType, type ClipEnv } from './clip';
import { createShareModule } from './index';

class FakeTrack {
  stopped = false;
  constructor(readonly kind: 'video' | 'audio') {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeRecorder extends EventTarget {
  static supported = new Set<string>(['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/webm']);
  static made: FakeRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.has(type);
  }
  state: 'inactive' | 'recording' = 'inactive';
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly stream: FakeStream, readonly options: MediaRecorderOptions = {}) {
    super();
    this.mimeType = options.mimeType ?? 'video/webm';
    FakeRecorder.made.push(this);
  }
  start() {
    this.state = 'recording';
    queueMicrotask(() => this.dispatchEvent(new Event('start')));
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['frames'], { type: this.mimeType }) });
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
}

const ENV = (doc: FakeDocument | null = null): ClipEnv => ({
  MediaRecorder: FakeRecorder as unknown as ClipEnv['MediaRecorder'],
  MediaStream: FakeStream as unknown as ClipEnv['MediaStream'],
  document: doc as unknown as ClipEnv['document'],
});

const SPELLBOOK = {
  revision: 1, packs: [], theme: null, unlockedTier: 1, learnAfter: 3,
  spells: [{ spell: { id: 'nox', incantation: 'Nox' }, packId: 'core-charms', packTitle: 'Core charms', available: true, status: 'open', enabled: true }],
} as unknown as Spellbook;

const kernels: KernelHost[] = [];

async function world(options: { audio?: boolean; stage?: boolean; features?: string[] } = {}) {
  const kernel = createKernel({ persistence: memoryPersistence(), features: options.features ?? ['platform.dom', 'platform.media-recorder'], clock: () => Date.now() });
  kernels.push(kernel);
  await kernel.init();
  const video = new FakeTrack('video');
  const audio = new FakeTrack('audio');
  const requests: { name: string; payload: unknown }[] = [];
  if (options.stage !== false) {
    kernel.handle('stage.capture.start', (p: unknown) => {
      requests.push({ name: 'stage.capture.start', payload: p });
      return { stream: new FakeStream([video]) };
    });
    kernel.handle('stage.capture.stop', (p: unknown) => void requests.push({ name: 'stage.capture.stop', payload: p }));
  }
  if (options.audio) {
    kernel.handle('audio.capture.start', () => ({ stream: new FakeStream([audio]) }));
    kernel.handle('audio.capture.stop', (p: unknown) => void requests.push({ name: 'audio.capture.stop', payload: p }));
  }
  const states: ClipState[] = [];
  kernel.subscribe('share.clip.state', (e: Envelope<ClipState>) => states.push(e.payload));
  return { kernel, requests, states, video };
}

function recorderFor(kernel: KernelHost, env: ClipEnv | null, replay?: () => Promise<unknown>) {
  return new ClipRecorder({
    kernel, source: 'share.links', env: () => env, log: logger('test'),
    prepareReplay: async (castId) => {
      if (!replay) throw new KernelError('invalid-payload', `no keepsake ${castId}`);
      return { spellId: 'nox', play: replay };
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 21, 18, 5, 9));
  FakeRecorder.made = [];
});

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clip types', () => {
  it('prefers MP4 with H.264 and AAC, then WebM, and lets the browser choose otherwise', () => {
    expect(pickClipType((t) => FakeRecorder.supported.has(t), true)).toBe('video/mp4;codecs=avc1,mp4a.40.2');
    expect(pickClipType((t) => FakeRecorder.supported.has(t), false)).toBe('video/mp4;codecs=avc1');
    expect(pickClipType((t) => t.startsWith('video/webm;codecs=vp8'), true)).toBe('video/webm;codecs=vp8,opus');
    expect(pickClipType(() => false, true)).toBeNull();
    expect(pickClipType(undefined, true)).toBeNull();
    expect(baseType('video/mp4;codecs=avc1,mp4a.40.2')).toBe('video/mp4');
    expect(baseType('')).toBe('video/webm');
    expect(clipExtension('video/webm;codecs=vp9')).toBe('webm');
    expect(clipFilename('nox', 'video/mp4', new Date(2026, 10, 21, 18, 5, 9))).toBe('spellglass-nox-2026-11-21-180509.mp4');
    expect(clipFilename(undefined, 'video/webm', new Date(2026, 10, 21, 8, 5, 9))).toBe('spellglass-mirror-2026-11-21-080509.webm');
  });
});

describe('recording', () => {
  it('records the mirror with its sound, stops at maxMs and hands over the clip', async () => {
    const { kernel, requests, states, video } = await world({ audio: true });
    const clips = recorderFor(kernel, ENV());
    await clips.start({ includeCamera: false, maxMs: 2000 });
    expect(requests[0]).toEqual({ name: 'stage.capture.start', payload: { requester: 'share.links', includeCamera: false, fps: 30 } });
    const recorder = FakeRecorder.made[0];
    expect(recorder.options.mimeType).toBe('video/mp4;codecs=avc1,mp4a.40.2');
    expect(recorder.stream.getTracks().map((t) => t.kind)).toEqual(['video', 'audio']);

    await vi.advanceTimersByTimeAsync(2100);
    expect(states[0]).toEqual({ state: 'recording', elapsedMs: 0 });
    expect(states.filter((s) => s.state === 'recording').length).toBeGreaterThan(3);
    expect(states.at(-1)).toEqual({ state: 'stopped', elapsedMs: 2000, reason: 'time-limit' });
    expect(requests.map((r) => r.name)).toEqual(expect.arrayContaining(['stage.capture.stop', 'audio.capture.stop']));

    const clip = await clips.stop();
    expect(clip).toMatchObject({ filename: 'spellglass-mirror-2026-11-21-180509.mp4', mime: 'video/mp4' });
    expect(clip.blob.type).toBe('video/mp4');
    expect(clip.blob.size).toBeGreaterThan(0);
    // The stage owns its track; the clip only asked for it to be stopped.
    expect(video.stopped).toBe(false);
  });

  it('records a silent clip when there is no audio module', async () => {
    const { kernel } = await world();
    const clips = recorderFor(kernel, ENV());
    await clips.start({ includeCamera: true });
    expect(FakeRecorder.made[0].options.mimeType).toBe('video/mp4;codecs=avc1');
    expect(FakeRecorder.made[0].stream.getTracks().map((t) => t.kind)).toEqual(['video']);
    await vi.advanceTimersByTimeAsync(500);
    const clip = await clips.stop();
    expect(clip.mime).toBe('video/mp4');
  });

  it('stops when the tab is hidden', async () => {
    const { kernel, states } = await world();
    const doc = new FakeDocument();
    const clips = recorderFor(kernel, ENV(doc));
    await clips.start({ includeCamera: false });
    await vi.advanceTimersByTimeAsync(1200);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toMatchObject({ state: 'stopped', reason: 'hidden' });
    expect((await clips.stop()).blob.size).toBeGreaterThan(0);
  });

  it('records a keepsake replay and stops when the replay is over', async () => {
    const { kernel, states } = await world();
    let played = false;
    const clips = recorderFor(kernel, ENV(), () => new Promise((resolve) => setTimeout(() => {
      played = true;
      resolve({ durationMs: 3000 });
    }, 3000)));
    await clips.start({ includeCamera: false, castId: 'cast-1', maxMs: 10_000 });
    expect(states[0]).toEqual({ state: 'recording', elapsedMs: 0, castId: 'cast-1' });
    await vi.advanceTimersByTimeAsync(3500);
    expect(played).toBe(true);
    expect(states.at(-1)).toMatchObject({ state: 'stopped', reason: 'replay-finished', castId: 'cast-1' });
    expect((await clips.stop()).filename).toMatch(/^spellglass-nox-/);
  });

  it('reports a replay that cannot finish as an error, and share.clip.stop says why', async () => {
    const { kernel, states } = await world();
    const clips = recorderFor(kernel, ENV(), () => Promise.reject(new KernelError('not-supported', 'A replay is already playing.')));
    await clips.start({ includeCamera: false, castId: 'cast-1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(states.at(-1)).toMatchObject({ state: 'error', reason: 'A replay is already playing.' });
    await expect(clips.stop()).rejects.toThrow('A replay is already playing.');
  });

  it('refuses plainly: no recorder, no mirror, one clip at a time, nothing to hand over', async () => {
    const none = await world({ features: ['platform.dom'] });
    await expect(recorderFor(none.kernel, ENV()).start({ includeCamera: false })).rejects.toThrow(CLIP_MESSAGES.unsupported);
    await expect(recorderFor(none.kernel, null).start({ includeCamera: false })).rejects.toThrow(CLIP_MESSAGES.unsupported);

    const noStage = await world({ stage: false });
    await expect(recorderFor(noStage.kernel, ENV()).start({ includeCamera: false })).rejects.toThrow(CLIP_MESSAGES.noStage);

    const { kernel } = await world();
    const clips = recorderFor(kernel, ENV());
    await expect(clips.stop()).rejects.toThrow(CLIP_MESSAGES.none);
    await clips.start({ includeCamera: false });
    await expect(clips.start({ includeCamera: false })).rejects.toThrow(CLIP_MESSAGES.busy);
    await clips.stop();
  });
});

describe('share.clip.start and share.clip.stop', () => {
  it('records a keepsake replay through the module, with the browser classes it finds', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('MediaStream', FakeStream);
    const k = createKernel({ persistence: memoryPersistence(), features: ['platform.dom', 'platform.media-recorder'], clock: () => Date.now() });
    kernels.push(k);
    k.register(createShareModule({ appUrl: 'https://example.test/' }));
    await k.init();
    await k.start();
    const captures: unknown[] = [];
    const replays: unknown[] = [];
    k.handle('stage.capture.start', (p: unknown) => {
      captures.push(p);
      return { stream: new FakeStream([new FakeTrack('video')]) };
    });
    k.handle('stage.capture.stop', () => undefined);
    k.handle('stage.replay', (p: unknown) => {
      replays.push(p);
      return new Promise((resolve) => setTimeout(() => resolve({ castId: 'replay-1', durationMs: 2500 }), 2500));
    });
    k.emit('spellbook.changed', SPELLBOOK, 'kernel.packs');
    emit(k, 'engine.rules', 'spell.cast', { id: 'cast-1', spellId: 'nox', t: 1, via: 'voice', quality: 0.8, power: 0.3, aim: { x: 0.5, y: 0.5 } });
    const seen: ClipState[] = [];
    k.subscribe('share.clip.state', (e: Envelope<ClipState>) => seen.push(e.payload));

    await ask(k, 'share.clip.start', { includeCamera: true, castId: 'cast-1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen.at(-1)).toMatchObject({ state: 'stopped', reason: 'replay-finished', castId: 'cast-1' });
    const clip = await ask(k, 'share.clip.stop');
    expect(clip.filename).toMatch(/^spellglass-nox-.*\.mp4$/);
    expect(clip.mime).toBe('video/mp4');
    // The camera the player asked for is in the picture: captured, and the replay plays over it.
    expect(captures).toEqual([{ requester: 'share.links', includeCamera: true, fps: 30 }]);
    expect(replays).toEqual([expect.objectContaining({ spellId: 'nox', backdrop: 'camera' })]);
  });
});
