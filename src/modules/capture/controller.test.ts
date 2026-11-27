import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraProfile, CameraReady, CameraStatus, Envelope } from '../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../kernel';
import type { CameraConstraints, TrackCapabilities, TrackSettings } from './camera-utils';
import type { CameraBackend, CameraTrack } from './controller';
import { LINGER_MS, RECOVERY_MS } from './controller';
import type { FramePumpLike } from './frames';
import { buildCaptureModule } from './index';

// ------------------------------------------------------------------------------ a fake camera

interface Mode { width: number; height: number; fps: number }

interface FakeDevice {
  deviceId: string;
  label: string;
  modes: Mode[];
  caps?: TrackCapabilities;
}

const WEBCAM: FakeDevice = {
  deviceId: 'cam-1',
  label: 'Integrated Camera',
  modes: [{ width: 1920, height: 1080, fps: 30 }, { width: 1280, height: 720, fps: 30 }, { width: 640, height: 480, fps: 30 }],
  caps: { exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 2500, step: 1 }, exposureCompensation: { min: -3, max: 3, step: 0.5 } },
};
const SLOW_1080: FakeDevice = {
  deviceId: 'cam-2',
  label: 'USB IR Camera',
  modes: [{ width: 1920, height: 1080, fps: 15 }, { width: 1280, height: 720, fps: 60 }],
};

/** Chrome-like choice: the mode with the smallest relative distance from the ideal values. */
function pick(modes: Mode[], c: CameraConstraints): Mode {
  const ideal = (v: unknown) => (v && typeof v === 'object' && 'ideal' in v ? Number((v as { ideal: number }).ideal) : undefined);
  const w = ideal(c.width), h = ideal(c.height), f = ideal(c.frameRate);
  const d = (a: number, b: number | undefined) => (b === undefined ? 0 : Math.abs(a - b) / Math.max(a, b));
  return [...modes].sort((a, b) => d(a.width, w) + d(a.height, h) + d(a.fps, f) - (d(b.width, w) + d(b.height, h) + d(b.fps, f)))[0];
}

class FakeTrack implements CameraTrack {
  readyState: MediaStreamTrackState = 'live';
  settings: TrackSettings;
  calls: CameraConstraints[] = [];
  private ended = new Set<() => void>();
  constructor(readonly device: FakeDevice, mode: Mode, readonly cam: FakeCamera) {
    this.settings = { deviceId: device.deviceId, width: mode.width, height: mode.height, frameRate: mode.fps };
    if (device.caps?.exposureMode) Object.assign(this.settings, { exposureMode: 'continuous', exposureTime: 333, exposureCompensation: 0 });
  }
  get label() {
    return this.device.label;
  }
  getSettings() {
    return { ...this.settings };
  }
  getCapabilities() {
    return this.device.caps ?? {};
  }
  async applyConstraints(c: CameraConstraints) {
    this.calls.push(c);
    if (c.width || c.height) {
      const m = pick(this.device.modes, c);
      Object.assign(this.settings, { width: m.width, height: m.height, frameRate: m.fps });
    }
    for (const set of c.advanced ?? []) {
      if (this.cam.exposureResetsSize) Object.assign(this.settings, { width: 640, height: 480 });
      if (set.exposureMode) this.settings.exposureMode = set.exposureMode;
      if (set.exposureTime !== undefined) this.settings.exposureTime = set.exposureTime;
      if (set.exposureCompensation !== undefined) this.settings.exposureCompensation = set.exposureCompensation;
    }
  }
  stop() {
    this.readyState = 'ended';
  }
  addEventListener(_t: 'ended', fn: () => void) {
    this.ended.add(fn);
  }
  removeEventListener(_t: 'ended', fn: () => void) {
    this.ended.delete(fn);
  }
  unplug() {
    this.readyState = 'ended';
    for (const fn of this.ended) fn();
  }
}

class FakePump implements FramePumpLike {
  binds: { stream: MediaStream; generation: number }[] = [];
  generation = 0;
  bound = false;
  fps = 30;
  bind(stream: MediaStream, generation: number) {
    this.binds.push({ stream, generation });
    this.generation = generation;
    this.bound = true;
  }
  setGeneration(g: number) {
    this.generation = g;
  }
  unbind() {
    this.bound = false;
  }
  destroy() {}
}

class FakeCamera implements CameraBackend {
  devices: FakeDevice[] = [WEBCAM, SLOW_1080];
  fail: string | null = null;
  /** Cameras another app holds: opening one of them fails with NotReadableError. */
  busy = new Set<string>();
  exposureResetsSize = false;
  calls: MediaStreamConstraints[] = [];
  tracks: FakeTrack[] = [];
  pump = new FakePump();
  permissionFn: ((s: CameraStatus['permission']) => void) | null = null;
  deviceFn: (() => void) | null = null;
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.calls.push(constraints);
    await Promise.resolve();
    if (this.fail) throw Object.assign(new Error('fake failure'), { name: this.fail });
    const v = constraints.video as CameraConstraints;
    const id = v.deviceId && typeof v.deviceId === 'object' && 'exact' in v.deviceId ? (v.deviceId.exact as string) : undefined;
    const device = id ? this.devices.find((d) => d.deviceId === id) : this.devices[0];
    if (!device) throw Object.assign(new Error('no such device'), { name: 'OverconstrainedError' });
    if (this.busy.has(device.deviceId)) throw Object.assign(new Error('in use'), { name: 'NotReadableError' });
    const track = new FakeTrack(device, pick(device.modes, v), this);
    this.tracks.push(track);
    return { getVideoTracks: () => [track], getTracks: () => [track], id: `stream-${this.tracks.length}` } as unknown as MediaStream;
  }
  async enumerateDevices() {
    return this.devices.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: 'videoinput' })).concat([{ deviceId: 'mic', label: 'Mic', kind: 'audioinput' }]);
  }
  watchDevices(fn: () => void) {
    this.deviceFn = fn;
    return () => (this.deviceFn = null);
  }
  watchPermission(fn: (s: CameraStatus['permission']) => void) {
    this.permissionFn = fn;
    fn('prompt');
    return () => (this.permissionFn = null);
  }
  createPump() {
    return this.pump;
  }
  get track() {
    return this.tracks[this.tracks.length - 1];
  }
}

// ------------------------------------------------------------------------------ harness

interface H {
  kernel: KernelHost;
  cam: FakeCamera;
  events: Envelope[];
  stored: Map<string, unknown>;
  of: <T>(type: string) => T[];
  status: () => CameraStatus;
}

async function setup(opts: { consent?: boolean; storage?: boolean; profiles?: Record<string, CameraProfile> } = {}): Promise<H> {
  const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.camera'] });
  const cam = new FakeCamera();
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  const stored = new Map<string, unknown>(Object.entries(opts.profiles ?? {}));
  if (opts.storage !== false) {
    kernel.register({
      manifest: { id: 'storage.idb', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: [] },
      async init(k) {
        k.handle('storage.get', (p: { store: string; key: string }) => stored.get(`${p.store}/${p.key}`) ?? stored.get(p.key));
        k.handle('storage.put', (p: { store: string; key: string; value: unknown }) => {
          stored.set(`${p.store}/${p.key}`, p.value);
        });
      },
      async start() {},
      async stop() {},
    });
  }
  kernel.register(buildCaptureModule(() => cam));
  await kernel.init();
  if (opts.consent !== false) kernel.settings.set('capture.consent', true);
  await kernel.start();
  const of = <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T);
  return { kernel, cam, events, stored, of, status: () => of<CameraStatus>('camera.status').at(-1)! };
}

const start = (h: H, requester: string, exposure?: 'auto' | 'profile') => h.kernel.request<CameraReady>('camera.start', { requester, exposure });
const stop = (h: H, requester: string) => h.kernel.request<void>('camera.stop', { requester });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// ------------------------------------------------------------------------------ tests

describe('capture: consent and sharing', () => {
  it('opens nothing without consent, keeps the requester, and serves it when consent arrives', async () => {
    const h = await setup({ consent: false });
    await expect(start(h, 'tracker.bright-tip', 'profile')).rejects.toMatchObject({ name: 'ConsentRequired' });
    expect(h.cam.calls).toHaveLength(0);
    expect(h.status().requesters).toEqual(['tracker.bright-tip']);
    expect(h.of('camera.error').at(-1)).toMatchObject({ name: 'ConsentRequired' });
    await h.kernel.request('settings.set', { key: 'capture.consent', value: true });
    await flush();
    expect(h.cam.calls).toHaveLength(1);
    const ready = h.of<CameraReady>('camera.ready');
    expect(ready).toHaveLength(1);
    expect(h.status().state).toBe('on');
  });

  it('opens once for several requesters and shares the same CameraReady', async () => {
    const h = await setup();
    const [a, b] = await Promise.all([start(h, 'effects.stage'), start(h, 'tracker.hand')]);
    expect(h.cam.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.generation).toBe(1);
    const c = await start(h, 'tracker.bright-tip', 'profile');
    expect(c.generation).toBe(1);
    expect(h.status().requesters).toEqual(['effects.stage', 'tracker.bright-tip', 'tracker.hand']);
    expect(h.cam.pump.binds).toHaveLength(1);
  });

  it('asks for ideal 1920x1080 at 60 fps with no rescaling, and reports the real size', async () => {
    const h = await setup();
    const ready = await start(h, 'effects.stage');
    expect(h.cam.calls[0]).toEqual({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 }, resizeMode: 'none' } });
    expect(ready).toMatchObject({ width: 1920, height: 1080, fps: 30, deviceId: 'cam-1', label: 'Integrated Camera', infrared: false });
    expect(ready.exposure).toMatchObject({ modes: ['continuous', 'manual'], min: 1, max: 2500 });
  });

  it('tries 1280x720 when the preferred size cannot reach capture.minFps', async () => {
    const h = await setup();
    h.kernel.settings.set('capture.deviceId', 'cam-2');
    const ready = await start(h, 'effects.stage');
    expect(ready).toMatchObject({ width: 1280, height: 720, fps: 60, infrared: true });
    expect(h.cam.calls[0].video).toMatchObject({ deviceId: { exact: 'cam-2' } });
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the device open for a moment after the last release', async () => {
      const h = await setup();
      await start(h, 'tracker.hand');
      await stop(h, 'tracker.hand');
      await vi.advanceTimersByTimeAsync(LINGER_MS - 200);
      // A tracker switch: the next tracker asks before the linger ends and gets the same stream.
      const again = await start(h, 'tracker.bright-tip', 'profile');
      expect(again.generation).toBe(1);
      expect(h.cam.calls).toHaveLength(1);
      await stop(h, 'tracker.bright-tip');
      await vi.advanceTimersByTimeAsync(LINGER_MS + 50);
      expect(h.of('camera.stopped')).toEqual([{ reason: 'released', generation: 1 }]);
      expect(h.cam.track.readyState).toBe('ended');
      expect(h.status().state).toBe('off');
    });

    it('drops a requester whose module stops, without camera.stop', async () => {
      const h = await setup();
      await start(h, 'tracker.hand');
      h.kernel.emit('module.status', { id: 'tracker.hand', kind: 'tracker', state: 'stopped' });
      expect(h.status().requesters).toEqual([]);
      await vi.advanceTimersByTimeAsync(LINGER_MS + 50);
      expect(h.of('camera.stopped')).toHaveLength(1);
    });

    it('recovers a missing camera when it is plugged back in', async () => {
      const h = await setup();
      await start(h, 'effects.stage');
      h.cam.track.unplug();
      await flush();
      expect(h.of('camera.stopped').at(-1)).toMatchObject({ reason: 'ended' });
      expect(h.status().state).toBe('missing');
      h.cam.fail = 'NotFoundError';
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(h.status().state).toBe('missing');
      h.cam.fail = null;
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(h.status().state).toBe('on');
      expect(h.of<CameraReady>('camera.ready').at(-1)!.generation).toBe(2);
    });
  });
});

describe('capture: failures and retry', () => {
  it('rejects with the DOMException name, publishes camera.error, and serves the requester on retry', async () => {
    const h = await setup();
    h.cam.fail = 'NotAllowedError';
    await expect(start(h, 'tracker.bright-tip', 'profile')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(h.status()).toMatchObject({ state: 'blocked', error: { name: 'NotAllowedError' }, requesters: ['tracker.bright-tip'] });
    expect(h.status().message).toBe('Camera is blocked. Allow camera access in the address bar, then choose Try again.');
    expect(h.of('camera.error')).toHaveLength(1);
    h.cam.fail = null;
    const ready = await h.kernel.request<CameraReady>('camera.retry');
    expect(ready.generation).toBe(1);
    expect(h.of('camera.ready')).toHaveLength(1);
    expect(h.status().state).toBe('on');
    expect(h.status().error).toBeUndefined();
  });

  it('says the camera is blocked, not missing, when the permission is taken back while it is on', async () => {
    for (const order of ['permission first', 'track first'] as const) {
      const h = await setup();
      await start(h, 'tracker.bright-tip', 'profile');
      if (order === 'permission first') {
        h.cam.permissionFn?.('denied');
        h.cam.track.unplug();
      } else {
        h.cam.track.unplug();
        await flush();
        h.cam.permissionFn?.('denied');
      }
      await flush();
      expect(h.status(), order).toMatchObject({ state: 'blocked', permission: 'denied', error: { name: 'NotAllowedError' }, requesters: ['tracker.bright-tip'] });
      expect(h.status().message).toBe('Camera is blocked. Allow camera access in the address bar, then choose Try again.');
      // And it comes back when the permission does.
      h.cam.permissionFn?.('granted');
      await flush();
      expect(h.status().state, order).toBe('on');
      await h.kernel.stop();
    }
  });

  it('reopens when the permission turns to granted', async () => {
    const h = await setup();
    h.cam.fail = 'NotAllowedError';
    await start(h, 'effects.stage').catch(() => undefined);
    h.cam.fail = null;
    h.cam.permissionFn?.('granted');
    await flush();
    expect(h.status()).toMatchObject({ state: 'on', permission: 'granted' });
  });

  it('runs without storage', async () => {
    const h = await setup({ storage: false });
    const ready = await start(h, 'tracker.bright-tip', 'profile');
    expect(ready.width).toBe(1920);
    await expect(h.kernel.request('camera.profile.save')).resolves.toMatchObject({ deviceId: 'cam-1' });
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a busy camera quietly: the status changes and camera.error comes only when the outcome does', async () => {
      const h = await setup();
      h.cam.fail = 'NotReadableError';
      await expect(start(h, 'tracker.bright-tip', 'profile')).rejects.toMatchObject({ name: 'NotReadableError' });
      expect(h.status()).toMatchObject({ state: 'busy', error: { name: 'NotReadableError' } });
      const seen = h.of<CameraStatus>('camera.status').length;
      await vi.advanceTimersByTimeAsync(3 * RECOVERY_MS + 100);
      expect(h.cam.calls).toHaveLength(4);
      // No "Opening the camera" in between: the note and its Try again button stay, and nothing is
      // announced again.
      expect(h.of<CameraStatus>('camera.status').slice(seen)).toEqual([]);
      expect(h.of('camera.error')).toHaveLength(1);

      h.cam.fail = 'NotFoundError';
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(h.status()).toMatchObject({ state: 'missing', error: { name: 'NotFoundError' } });
      expect(h.of('camera.error')).toHaveLength(2);

      h.cam.fail = null;
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(h.status().state).toBe('on');
      expect(h.status().error).toBeUndefined();
      expect(h.of('camera.error')).toHaveLength(2);
    });
  });
});

describe('capture: device choice', () => {
  it('switches device for every requester when capture.deviceId changes', async () => {
    const h = await setup();
    await start(h, 'effects.stage');
    await start(h, 'tracker.hand');
    await h.kernel.request('settings.set', { key: 'capture.deviceId', value: 'cam-2' });
    await flush();
    await flush();
    expect(h.of('camera.stopped').at(-1)).toEqual({ reason: 'switching', generation: 1 });
    const ready = h.of<CameraReady>('camera.ready');
    expect(ready.at(-1)).toMatchObject({ deviceId: 'cam-2', generation: 2 });
    expect(h.cam.calls).toHaveLength(2);
    expect(h.cam.tracks[0].readyState).toBe('ended');
  });

  it('opens the default camera, and says so, while the chosen one is not connected', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      // An id from another browser profile, as an import of the player's data brings along.
      h.kernel.settings.set('capture.deviceId', 'usb-elsewhere');
      await flush();
      const ready = await start(h, 'effects.stage');
      expect(ready).toMatchObject({ deviceId: 'cam-1', label: 'Integrated Camera', generation: 1 });
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'cam-1', message: 'The chosen camera was not found, so the default camera is in use.' });
      expect(h.status().error).toBeUndefined();
      expect(h.of('camera.error')).toHaveLength(0);
      // The choice is kept, so the camera is used again once it is plugged in.
      expect(h.kernel.settings.get('capture.deviceId', null)).toBe('usb-elsewhere');
      h.cam.devices = [...h.cam.devices, { deviceId: 'usb-elsewhere', label: 'USB Camera', modes: [{ width: 1280, height: 720, fps: 30 }] }];
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(h.of('camera.stopped').at(-1)).toEqual({ reason: 'switching', generation: 1 });
      expect(h.of<CameraReady>('camera.ready').at(-1)).toMatchObject({ deviceId: 'usb-elsewhere', generation: 2 });
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'usb-elsewhere' });
      expect(h.status().message).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  const USB: FakeDevice = { deviceId: 'usb-elsewhere', label: 'USB Camera', modes: [{ width: 1280, height: 720, fps: 30 }] };
  const exactIds = (h: H) => h.cam.calls.map((c) => ((c.video as CameraConstraints).deviceId as { exact?: string } | undefined)?.exact ?? 'default');

  it('keeps the default camera until the chosen one, back but held by another app, has opened', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      h.kernel.settings.set('capture.deviceId', 'usb-elsewhere');
      await flush();
      await start(h, 'effects.stage');
      const standIn = h.cam.track;
      // Plugged back in, and another app takes it first.
      h.cam.devices = [...h.cam.devices, USB];
      h.cam.busy.add('usb-elsewhere');
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(exactIds(h)).toEqual(['usb-elsewhere', 'default', 'usb-elsewhere']);
      // Tried, and nothing changed: the mirror and the trackers keep the default camera.
      expect(standIn.readyState).toBe('live');
      expect(h.cam.pump.bound).toBe(true);
      expect(h.of('camera.stopped')).toEqual([]);
      expect(h.of('camera.error')).toEqual([]);
      expect(h.of<CameraReady>('camera.ready')).toHaveLength(1);
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'cam-1', message: 'The chosen camera was not found, so the default camera is in use.' });
      // Tried again quietly while it stays connected, since no device change says when the other app
      // lets go.
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(exactIds(h)).toHaveLength(4);
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'cam-1' });
      h.cam.busy.delete('usb-elsewhere');
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(exactIds(h)).toEqual(['usb-elsewhere', 'default', 'usb-elsewhere', 'usb-elsewhere', 'usb-elsewhere']);
      expect(h.of('camera.stopped')).toEqual([{ reason: 'switching', generation: 1 }]);
      expect(standIn.readyState).toBe('ended');
      expect(h.of<CameraReady>('camera.ready').at(-1)).toMatchObject({ deviceId: 'usb-elsewhere', generation: 2 });
      expect(h.cam.pump.binds.at(-1)).toMatchObject({ generation: 2 });
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'usb-elsewhere' });
      expect(h.status().message).toBeUndefined();
      expect(h.of('camera.error')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops trying the chosen camera while it is unplugged, and tries it again when it is back', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      h.kernel.settings.set('capture.deviceId', 'usb-elsewhere');
      await flush();
      await start(h, 'effects.stage');
      h.cam.devices = [...h.cam.devices, USB];
      h.cam.busy.add('usb-elsewhere');
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(exactIds(h)).toHaveLength(3);
      // Unplugged again before it ever opened: no more attempts until a device change.
      h.cam.devices = h.cam.devices.filter((d) => d !== USB);
      await vi.advanceTimersByTimeAsync(3 * RECOVERY_MS);
      expect(exactIds(h)).toHaveLength(3);
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'cam-1' });
      h.cam.devices = [...h.cam.devices, USB];
      h.cam.busy.clear();
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      expect(h.of<CameraReady>('camera.ready').at(-1)).toMatchObject({ deviceId: 'usb-elsewhere', generation: 2 });
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'usb-elsewhere' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps trying for a new stand-in when a slow try made for the old one fails late', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      h.kernel.settings.set('capture.deviceId', 'usb-elsewhere');
      await flush();
      await start(h, 'effects.stage');
      h.cam.devices = [...h.cam.devices, USB];
      h.cam.busy.add('usb-elsewhere');
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      // The next try of the chosen camera takes 8 s to fail.
      const real = h.cam.getUserMedia.bind(h.cam);
      let slow = true;
      h.cam.getUserMedia = async (c) => {
        if (!slow || ((c.video as CameraConstraints).deviceId as { exact?: string } | undefined)?.exact !== 'usb-elsewhere') return real(c);
        slow = false;
        h.cam.calls.push(c);
        await new Promise((r) => setTimeout(r, 8000));
        throw Object.assign(new Error('in use'), { name: 'NotReadableError' });
      };
      await vi.advanceTimersByTimeAsync(RECOVERY_MS + 50);
      // Meanwhile the stand-in is unplugged, recovery opens another one, and a device change has it try
      // the chosen camera too.
      h.cam.tracks[0].unplug();
      h.cam.devices = h.cam.devices.filter((d) => d.deviceId !== 'cam-1' && d !== USB);
      await vi.advanceTimersByTimeAsync(RECOVERY_MS + 50);
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'cam-2', message: 'The chosen camera was not found, so the default camera is in use.' });
      h.cam.devices = [...h.cam.devices, USB];
      h.cam.deviceFn?.();
      await vi.advanceTimersByTimeAsync(700);
      // The slow try fails now, for a stand-in that has gone: the new stand-in's next try still comes.
      await vi.advanceTimersByTimeAsync(3000);
      const tries = exactIds(h).length;
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(exactIds(h)).toHaveLength(tries + 1);
      h.cam.busy.clear();
      await vi.advanceTimersByTimeAsync(RECOVERY_MS);
      expect(h.status()).toMatchObject({ state: 'on', deviceId: 'usb-elsewhere' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not put another camera in place of a chosen one that is connected', async () => {
    const h = await setup();
    h.kernel.settings.set('capture.deviceId', 'cam-2');
    await flush();
    h.cam.fail = 'NotReadableError';
    await expect(start(h, 'effects.stage')).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(h.status().state).toBe('busy');
    // Listed, yet not found as it opens (on its way out): it is waited for, not replaced.
    h.cam.fail = 'NotFoundError';
    await expect(h.kernel.request('camera.retry')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(h.status()).toMatchObject({ state: 'missing', message: 'The chosen camera was not found. Plug it in, or choose another camera in Wand tuning.' });
    expect(h.cam.calls.map((c) => (c.video as CameraConstraints).deviceId)).toEqual([{ exact: 'cam-2' }, { exact: 'cam-2' }]);
  });

  it('lists cameras and spots infrared ones', async () => {
    const h = await setup();
    const list = await h.kernel.request<{ deviceId: string; infrared: boolean }[]>('camera.devices');
    expect(list).toEqual([
      { deviceId: 'cam-1', label: 'Integrated Camera', infrared: false },
      { deviceId: 'cam-2', label: 'USB IR Camera', infrared: true },
    ]);
  });
});

describe('capture: exposure', () => {
  it('belongs to the profile only while a profile requester holds the camera', async () => {
    const h = await setup();
    await start(h, 'effects.stage');
    const r = await h.kernel.request<{ mode: string; time?: number }>('camera.exposure', { requester: 'shell', mode: 'manual', time: 99999 });
    // Clamped to the camera's range, stored, mirrored, but not applied: only the mirror holds the camera.
    expect(r).toEqual({ mode: 'manual', time: 2500, compensation: undefined });
    expect(h.cam.track.settings.exposureMode).toBe('continuous');
    expect(h.kernel.settings.get('capture.exposureMode', '')).toBe('manual');
    expect(h.kernel.settings.get('capture.exposureTime', 0)).toBe(2500);
    expect((h.stored.get('profiles/cam-1') as CameraProfile).exposureTime).toBe(2500);

    await start(h, 'tracker.bright-tip', 'profile');
    await flush();
    expect(h.cam.track.settings).toMatchObject({ exposureMode: 'manual', exposureTime: 2500 });
    expect(h.status().exposure).toMatchObject({ mode: 'manual', time: 2500 });

    await h.kernel.request('camera.exposure', { requester: 'tracker.bright-tip', mode: 'manual', time: 40 });
    expect(h.cam.track.settings.exposureTime).toBe(40);

    // The bright tip goes: continuous exposure again, at once.
    await stop(h, 'tracker.bright-tip');
    await flush();
    expect(h.cam.track.settings.exposureMode).toBe('continuous');
    expect(h.status().exposure?.mode).toBe('continuous');
  });

  it('puts the size back if an exposure change reset it', async () => {
    const h = await setup();
    h.cam.exposureResetsSize = true;
    await start(h, 'tracker.bright-tip', 'profile');
    await h.kernel.request('camera.exposure', { requester: 'tracker.bright-tip', mode: 'manual', time: 50 });
    expect(h.cam.track.settings).toMatchObject({ width: 1920, height: 1080, exposureTime: 50 });
  });

  it('applies a stored profile on open: size, exposure and the bright-tip values', async () => {
    const profile: CameraProfile = {
      dataVersion: 1, deviceId: 'cam-1', label: 'Integrated Camera', width: 1280, height: 720, fps: 30,
      exposureMode: 'manual', exposureTime: 20, k: 6, floor: 150, channel: 'r', flipX: false, playArea: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, savedAt: 1,
    };
    const h = await setup({ profiles: { 'profiles/cam-1': profile } });
    const ready = await start(h, 'tracker.bright-tip', 'profile');
    expect(ready).toMatchObject({ width: 1280, height: 720 });
    expect(h.cam.track.settings).toMatchObject({ exposureMode: 'manual', exposureTime: 20 });
    await flush();
    expect(h.kernel.settings.get('brightTip.k', 0)).toBe(6);
    expect(h.kernel.settings.get('brightTip.floor', 0)).toBe(150);
    expect(h.kernel.settings.get('brightTip.channel', '')).toBe('r');
    expect(h.kernel.settings.get('capture.flipX', true)).toBe(false);
    expect(h.kernel.settings.get('playArea', null)).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(h.kernel.settings.get('brightTip.profile', '')).toBe('visible');
  });

  it('starts a camera without a profile from the exposure settings (the tip-finder page writes them)', async () => {
    const h = await setup();
    h.kernel.settings.set('capture.exposureMode', 'manual');
    h.kernel.settings.set('capture.exposureTime', 12);
    await start(h, 'tracker.bright-tip', 'profile');
    expect(h.cam.track.settings).toMatchObject({ exposureMode: 'manual', exposureTime: 12 });
  });

  it('saves the working settings as a profile', async () => {
    const h = await setup();
    await start(h, 'tracker.bright-tip', 'profile');
    h.kernel.settings.set('brightTip.k', 5.5);
    // "Save for this camera": every per-camera value in effect now.
    const saved = await h.kernel.request<CameraProfile>('camera.profile.save');
    expect(saved).toMatchObject({
      deviceId: 'cam-1', label: 'Integrated Camera', width: 1920, height: 1080, k: 5.5, floor: 200, channel: 'luma', flipX: true,
      profile: 'visible', playArea: { x: 0, y: 0, w: 1, h: 1 }, exposureMode: 'continuous', exposureTime: null, dataVersion: 1,
    });
    expect(h.stored.get('profiles/cam-1')).toEqual(saved);
    // A partial save changes only what it gives, and never the exposure ('camera.exposure' does that).
    h.kernel.settings.set('brightTip.k', 7);
    const patched = await h.kernel.request<CameraProfile>('camera.profile.save', { floor: 180, exposureTime: 1 });
    expect(patched).toMatchObject({ k: 5.5, floor: 180, exposureMode: 'continuous', exposureTime: null });
  });
});

describe('capture: a profile holds only what was saved for its camera', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PER_CAMERA = ['profile', 'flipX', 'k', 'floor', 'channel', 'minArea', 'maxArea', 'playArea'];
  /** The per-camera values the stored profile of cam-1 holds. */
  const held = (h: H) => PER_CAMERA.filter((f) => f in (h.stored.get('profiles/cam-1') as object));

  /** The last requester goes, the linger ends, and the camera opens again. */
  async function reopen(h: H): Promise<void> {
    await stop(h, 'tracker.bright-tip');
    await vi.advanceTimersByTimeAsync(LINGER_MS + 50);
    expect(h.status().state).toBe('off');
    await start(h, 'tracker.bright-tip', 'profile');
    await flush();
  }

  it("keeps a partial save to the fields it gives, so the player's later changes survive a reopen", async () => {
    const h = await setup();
    await start(h, 'tracker.bright-tip', 'profile');
    // The Threshold keeps the route with the camera.
    await h.kernel.request('camera.profile.save', { profile: 'visible' });
    expect(h.stored.get('profiles/cam-1')).toMatchObject({ deviceId: 'cam-1', label: 'Integrated Camera', width: 1920, height: 1080, exposureMode: 'continuous' });
    expect(held(h)).toEqual(['profile']);
    // Changed in Wand tuning, without "Save for this camera".
    h.kernel.settings.set('capture.flipX', false);
    h.kernel.settings.set('brightTip.k', 6);
    h.kernel.settings.set('brightTip.channel', 'r');
    h.kernel.settings.set('playArea', { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    await reopen(h);
    expect(h.of<CameraReady>('camera.ready')).toHaveLength(2);
    expect(h.kernel.settings.get('capture.flipX', true)).toBe(false);
    expect(h.kernel.settings.get('brightTip.k', 0)).toBe(6);
    expect(h.kernel.settings.get('brightTip.channel', '')).toBe('r');
    expect(h.kernel.settings.get('playArea', null)).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(h.kernel.settings.get('brightTip.profile', '')).toBe('visible');
  });

  it('holds only the exposure after an exposure change, and adds only k and floor from the autotune', async () => {
    const h = await setup();
    await start(h, 'tracker.bright-tip', 'profile');
    await h.kernel.request('camera.exposure', { requester: 'tracker.bright-tip', mode: 'manual', time: 40 });
    expect(h.stored.get('profiles/cam-1')).toMatchObject({ exposureMode: 'manual', exposureTime: 40 });
    expect(held(h)).toEqual([]);
    h.kernel.settings.set('capture.flipX', false);
    await reopen(h);
    expect(h.kernel.settings.get('capture.flipX', true)).toBe(false);
    expect(h.cam.track.settings).toMatchObject({ exposureMode: 'manual', exposureTime: 40 });

    // The autotune keeps what it found for this camera (bright-tip's TuneSession.finish).
    await h.kernel.request('camera.profile.save', { k: 5, floor: 180 });
    expect(h.stored.get('profiles/cam-1')).toMatchObject({ exposureMode: 'manual', exposureTime: 40, k: 5, floor: 180 });
    expect(held(h)).toEqual(['k', 'floor']);
    h.kernel.settings.set('brightTip.k', 8);
    h.kernel.settings.set('brightTip.channel', 'g');
    await reopen(h);
    // This camera's own values come back; the rest stays as the player left it.
    expect(h.kernel.settings.get('brightTip.k', 0)).toBe(5);
    expect(h.kernel.settings.get('brightTip.floor', 0)).toBe(180);
    expect(h.kernel.settings.get('brightTip.channel', '')).toBe('g');
    expect(h.kernel.settings.get('capture.flipX', true)).toBe(false);
  });
});

describe('capture: frame rate', () => {
  it('steps the size down once, with a new generation', async () => {
    const h = await setup();
    await start(h, 'tracker.bright-tip', 'profile');
    // Manual exposure: a slow camera is not the dim-room case.
    await h.kernel.request('camera.exposure', { requester: 'tracker.bright-tip', mode: 'manual', time: 40 });
    h.cam.pump.fps = 30;
    const size = await h.kernel.request('camera.step-down', { requester: 'tracker.bright-tip', fps: 14 });
    expect(size).toEqual({ width: 1280, height: 720 });
    const ready = h.of<CameraReady>('camera.ready');
    expect(ready.at(-1)).toMatchObject({ width: 1280, height: 720, generation: 2 });
    expect(h.cam.pump.generation).toBe(2);
    expect(h.status()).toMatchObject({ steppedDown: true, message: 'Frame rate low: capture size reduced', width: 1280 });
    // Same track, same stream: no reopen, and the manual exposure is kept.
    expect(h.cam.calls).toHaveLength(1);
    expect(h.cam.track.settings.exposureTime).toBe(40);
    await expect(h.kernel.request('camera.step-down', { requester: 'tracker.bright-tip', fps: 14 })).resolves.toBeNull();
  });

  it('changes nothing, and says why, when the camera offers no smaller size', async () => {
    const h = await setup();
    // One mode only, as many virtual cameras offer.
    h.cam.devices = [{ deviceId: 'cam-v', label: 'Virtual Camera', modes: [{ width: 1920, height: 1080, fps: 12 }] }];
    const ready = await start(h, 'tracker.bright-tip', 'profile');
    expect(ready).toMatchObject({ width: 1920, height: 1080, generation: 1 });
    h.cam.pump.fps = 12;
    await expect(h.kernel.request('camera.step-down', { requester: 'tracker.bright-tip', fps: 12 })).resolves.toBeNull();
    // No new generation: the tracker keeps its tip and its mask.
    expect(h.of<CameraReady>('camera.ready')).toHaveLength(1);
    expect(h.cam.pump.generation).toBe(1);
    expect(h.status()).toMatchObject({ width: 1920, height: 1080, message: 'Frames are slow, and this camera offers no smaller size.' });
    expect(h.status().steppedDown).toBeUndefined();
    // Not tried again on this camera.
    const tries = h.cam.track.calls.length;
    await expect(h.kernel.request('camera.step-down', { requester: 'tracker.bright-tip', fps: 12 })).resolves.toBeNull();
    expect(h.cam.track.calls).toHaveLength(tries);
  });

  it('blames a dim room instead when the camera itself slows down under continuous exposure', async () => {
    const h = await setup();
    await start(h, 'tracker.bright-tip', 'profile');
    h.cam.pump.fps = 12;
    await expect(h.kernel.request('camera.step-down', { requester: 'tracker.bright-tip', fps: 12 })).resolves.toBeNull();
    expect(h.status().message).toMatch(/dim room/);
    expect(h.cam.track.settings.width).toBe(1920);
  });
});
