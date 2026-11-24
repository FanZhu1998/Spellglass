import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incantation, VoiceStatus } from '../../contracts';
import { ask, createKernel, memoryPersistence, on, setSetting } from '../../kernel';
import { CHECK_TIMEOUT_MS, FAILURES_BEFORE_ERROR, FIRST_BACKOFF_MS, HEALTHY_SESSION_MS, NO_MICROPHONE_RETRY_MS, RESTART_MS, VOICE_TEXT } from './controller';
import { createVoiceModuleWith, MANIFEST } from './index';
import { detectSpeech } from './speech';
import { FakePhrase, FakeRecognition, fakeSpeech, seedSpellbook, type FakeSpeech } from './testing';

const flush = () => vi.advanceTimersByTimeAsync(0);

interface Booted {
  kernel: ReturnType<typeof createKernel>;
  speech: FakeSpeech;
  statuses: VoiceStatus[];
  heard: Incantation[];
  mic: { grant: (() => void) | null };
  devices: { change: (() => void) | null };
  last(): VoiceStatus;
}

async function boot(settings: Record<string, unknown> = {}, speech: FakeSpeech = fakeSpeech(), opts: { noSpeech?: boolean } = {}): Promise<Booted> {
  const kernel = createKernel({ persistence: memoryPersistence(settings), features: ['platform.speech'], clock: () => Date.now() });
  const mic: Booted['mic'] = { grant: null };
  const devices: Booted['devices'] = { change: null };
  kernel.register(
    createVoiceModuleWith({
      speech: () => (opts.noSpeech ? null : speech.api),
      watchMicrophone: (fn) => {
        mic.grant = fn;
        return () => (mic.grant = null);
      },
      watchDevices: (fn) => {
        devices.change = fn;
        return () => (devices.change = null);
      },
    }),
  );
  await kernel.init();
  kernel.emit('spellbook.changed', seedSpellbook(), 'kernel.packs');
  const statuses: VoiceStatus[] = [];
  const heard: Incantation[] = [];
  on(kernel, 'voice.status', (s) => statuses.push(s));
  on(kernel, 'voice.incantation', (i) => heard.push(i));
  await kernel.start();
  await flush();
  return { kernel, speech, statuses, heard, mic, devices, last: () => statuses[statuses.length - 1] };
}

const ON = { 'voice.enabled': true };

describe('voice module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the manifest id, kind and requirement the app depends on', () => {
    expect(MANIFEST).toMatchObject({ id: 'voice.web-speech', kind: 'voice', contract: '^1.1', provides: ['voice@1'], requires: ['platform.speech'] });
  });

  it('stays off, and asks nothing of the browser, unless voice is enabled', async () => {
    const b = await boot();
    expect(b.last()).toMatchObject({ state: 'off', local: true });
    expect(b.speech.availableCalls).toHaveLength(0);
    expect(b.speech.instances).toHaveLength(0);
  });

  it('start() resolves at once even when the availability check never answers', async () => {
    const speech = fakeSpeech({ local: () => new Promise<string>(() => {}) });
    const b = await boot(ON, speech);
    expect(b.kernel.modules().find((m) => m.manifest.id === MANIFEST.id)?.state).toBe('running');
    expect(b.last().state).toBe('off');
    expect(speech.instances).toHaveLength(0);
  });

  it('treats a check that never answers as unavailable, in time', async () => {
    const b = await boot(ON, fakeSpeech({ local: () => new Promise<string>(() => {}), cloud: 'available' }));
    expect(b.last().state).toBe('off');
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(b.last()).toMatchObject({ state: 'unavailable', cloud: 'available' });
  });

  it('listens on the device, with the enabled incantations as phrase hints', async () => {
    const b = await boot({ ...ON, 'voice.lang': 'en-GB', 'voice.quality': 'dictation' });
    expect(b.speech.availableCalls[0]).toEqual({ langs: ['en-GB'], processLocally: true, quality: 'dictation' });
    const rec = b.speech.last();
    expect(rec).toMatchObject({ lang: 'en-GB', continuous: true, interimResults: true, maxAlternatives: 3, processLocally: true, started: true });
    const phrases = rec.phrases as FakePhrase[];
    expect(phrases.map((p) => p.phrase)).toContain('Lumos');
    expect(phrases.map((p) => p.phrase)).toContain('Wingardium Leviosa');
    // The restricted section ships off, so its incantations are not hinted.
    expect(phrases.map((p) => p.phrase)).not.toContain('Crucio');
    expect(phrases.every((p) => p.boost === 5)).toBe(true);
    expect(b.last()).toMatchObject({ state: 'ready', local: true });
    rec.fireStart();
    expect(b.last()).toMatchObject({ state: 'listening', local: true, lang: 'en-GB' });
  });

  it('clamps the phrase boost into 0..10 (SpeechRecognitionPhrase throws outside it)', async () => {
    const b = await boot({ ...ON, 'voice.phraseBoost': 25 });
    expect((b.speech.last().phrases as FakePhrase[])[0].boost).toBe(10);
  });

  it('asks for the language pack download when the check says downloadable', async () => {
    let installed = false;
    const speech = fakeSpeech({ local: () => (installed ? 'available' : 'downloadable'), cloud: 'available' });
    const b = await boot(ON, speech);
    expect(b.last()).toMatchObject({ state: 'needs-download', local: true, cloud: 'available', message: VOICE_TEXT.needsDownload });
    expect(speech.instances).toHaveLength(0);

    const pending = ask(b.kernel, 'voice.install');
    // install() ran synchronously, inside the click, before anything was awaited.
    expect(speech.installCalls).toEqual([{ langs: ['en-US'], processLocally: true, quality: 'command' }]);
    expect(b.last().state).toBe('downloading');
    installed = true;
    await expect(pending).resolves.toEqual({ ok: true });
    await flush();
    expect(speech.last().processLocally).toBe(true);
    speech.last().fireStart();
    expect(b.last()).toMatchObject({ state: 'listening', local: true });
  });

  it('reports a refused download plainly, and keeps offering it', async () => {
    const speech = fakeSpeech({ local: 'downloadable', install: { reject: 'NotAllowedError' } });
    const b = await boot(ON, speech);
    await expect(ask(b.kernel, 'voice.install')).resolves.toEqual({ ok: false, message: VOICE_TEXT.downloadNeedsClick });
    expect(b.last()).toMatchObject({ state: 'needs-download', message: VOICE_TEXT.downloadNeedsClick });

    const failing = fakeSpeech({ local: 'downloadable', install: false });
    const c = await boot(ON, failing);
    await expect(ask(c.kernel, 'voice.install')).resolves.toEqual({ ok: false, message: VOICE_TEXT.downloadFailed });
  });

  it('shows a download already under way, and checks again', async () => {
    let answer = 'downloading';
    const b = await boot(ON, fakeSpeech({ local: () => answer }));
    expect(b.last().state).toBe('downloading');
    answer = 'available';
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.speech.instances).toHaveLength(1);
  });

  it('stays off when on-device recognition is unavailable, unless the player allows the online service', async () => {
    const speech = fakeSpeech({ local: 'unavailable', cloud: 'available' });
    const b = await boot(ON, speech);
    expect(b.last()).toMatchObject({ state: 'unavailable', local: true, cloud: 'available', message: VOICE_TEXT.noLocalCloud });
    expect(speech.instances).toHaveLength(0);

    await setSetting(b.kernel, 'voice.allowCloud', true);
    await flush();
    const rec = speech.last();
    expect(rec.processLocally).toBe(false);
    // Phrase biasing is on-device only.
    expect(rec.phrases).toEqual([]);
    rec.fireStart();
    expect(b.last()).toMatchObject({ state: 'listening', local: false, message: VOICE_TEXT.listeningCloud });
  });

  it('says so when neither on-device nor online recognition exists', async () => {
    const b = await boot({ ...ON, 'voice.allowCloud': true }, fakeSpeech({ local: 'unavailable', cloud: 'unavailable' }));
    expect(b.last()).toMatchObject({ state: 'unavailable', cloud: 'unavailable', message: VOICE_TEXT.noLocal });
    const none = await boot(ON, fakeSpeech(), { noSpeech: true });
    expect(none.last()).toMatchObject({ state: 'unavailable', message: VOICE_TEXT.noRecognition });
  });

  it('treats a browser without available() as online-only', async () => {
    const legacy = fakeSpeech({ legacy: true });
    const b = await boot(ON, legacy);
    expect(b.last()).toMatchObject({ state: 'unavailable', cloud: 'available' });
    expect(legacy.instances).toHaveLength(0);
    const c = await boot({ ...ON, 'voice.allowCloud': true }, fakeSpeech({ legacy: true }));
    expect(c.last()).toMatchObject({ state: 'ready', local: false });
  });

  it('publishes interim and final incantations of one utterance under one id', async () => {
    const b = await boot(ON);
    const rec = b.speech.last();
    rec.fireStart();
    rec.fireResults([{ alts: [['loo', 0]] }]);
    vi.advanceTimersByTime(200);
    rec.fireResults([{ alts: [['lumos', 0]] }]);
    vi.advanceTimersByTime(500);
    rec.fireResults([{ final: true, alts: [['Lumos', 0.92]] }]);
    rec.fireResults([{ final: true, alts: [['Lumos', 0.92]] }]); // repeated: ignored
    expect(b.heard.map((i) => [i.final, i.spellId ?? null, i.id])).toEqual([
      [false, null, b.heard[0].id],
      [false, 'lumos', b.heard[0].id],
      [true, 'lumos', b.heard[0].id],
    ]);
    const fin = b.heard[2];
    expect(fin.conf).toBe(0.92);
    expect(fin.t0).toBe(b.heard[0].t0);
    expect(fin.t).toBe(fin.t0);
    expect(fin.t1!).toBeGreaterThan(fin.t0!);
    expect(fin.t1!).toBeLessThanOrEqual(Date.now());
  });

  it('applies voice.minConf', async () => {
    const b = await boot({ ...ON, 'voice.minConf': 0.95 });
    const rec = b.speech.last();
    rec.fireStart();
    rec.fireResults([{ final: true, alts: [['lumos', 0.9]] }]);
    expect(b.heard[0].spellId).toBeUndefined();
    expect(b.heard[0].alternatives).toEqual([{ spellId: 'lumos', conf: 0.9 }]);
  });

  it('restarts when a session ends, backing off while sessions fail quickly', async () => {
    const b = await boot(ON);
    b.speech.last().fireStart();
    b.speech.last().fireEnd();
    expect(b.speech.instances).toHaveLength(1);
    vi.advanceTimersByTime(FIRST_BACKOFF_MS);
    expect(b.speech.instances).toHaveLength(2);
    b.speech.last().fireEnd();
    vi.advanceTimersByTime(FIRST_BACKOFF_MS);
    expect(b.speech.instances).toHaveLength(2);
    vi.advanceTimersByTime(FIRST_BACKOFF_MS);
    expect(b.speech.instances).toHaveLength(3);
    // A healthy session (it heard something) restarts almost at once and resets the backoff.
    const rec = b.speech.last();
    rec.fireStart();
    rec.fireResults([{ final: true, alts: [['nox', 0.9]] }]);
    rec.fireEnd();
    vi.advanceTimersByTime(RESTART_MS);
    expect(b.speech.instances).toHaveLength(4);
    // Status stayed 'listening' across the restarts: no flicker in the status chips.
    expect(b.statuses.filter((s) => s.state === 'ready')).toHaveLength(1);
  });

  it('says so after repeated quick failures, and recovers when a session hears something', async () => {
    const b = await boot(ON);
    for (let i = 0; i < FAILURES_BEFORE_ERROR; i++) {
      b.speech.last().fireStart();
      b.speech.last().fireEnd();
      // Wait only until the next session opens, so it too fails quickly.
      const count = b.speech.instances.length;
      for (let ms = 0; ms < 20_000 && b.speech.instances.length === count; ms += 50) await vi.advanceTimersByTimeAsync(50);
    }
    expect(b.last()).toMatchObject({ state: 'error', message: VOICE_TEXT.keepsStopping });
    const rec = b.speech.last();
    rec.fireStart();
    expect(b.last().state).toBe('error');
    vi.advanceTimersByTime(HEALTHY_SESSION_MS);
    expect(b.last().state).toBe('listening');
  });

  it('stops listening when voice is turned off, and does not restart', async () => {
    const b = await boot(ON);
    const rec = b.speech.last();
    rec.fireStart();
    await setSetting(b.kernel, 'voice.enabled', false);
    expect(rec.aborted).toBe(true);
    expect(b.last()).toMatchObject({ state: 'off' });
    rec.fireEnd();
    vi.advanceTimersByTime(20_000);
    expect(b.speech.instances).toHaveLength(1);
  });

  it('reports a blocked microphone and recovers once it is allowed', async () => {
    const b = await boot(ON);
    const rec = b.speech.last();
    rec.fireStart();
    rec.fireError('not-allowed');
    rec.fireEnd();
    expect(b.last()).toMatchObject({ state: 'error', message: VOICE_TEXT.micBlocked });
    vi.advanceTimersByTime(30_000);
    expect(b.speech.instances).toHaveLength(1);
    expect(b.mic.grant).toBeTypeOf('function');
    b.mic.grant!();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(b.speech.instances).toHaveLength(2);
  });

  it('checks again once when on-device recognition is refused, then reports it', async () => {
    let answer = 'available';
    const b = await boot(ON, fakeSpeech({ local: () => answer }));
    b.speech.last().fireError('service-not-allowed');
    answer = 'downloadable';
    b.speech.last().fireEnd();
    await flush();
    expect(b.last().state).toBe('needs-download');

    // available() keeps saying yes while start() keeps refusing: one check again, then the error.
    const c = await boot(ON, fakeSpeech({ local: 'available' }));
    c.speech.last().fireError('service-not-allowed');
    c.speech.last().fireEnd();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(c.speech.instances).toHaveLength(2);
    c.speech.last().fireError('service-not-allowed');
    c.speech.last().fireEnd();
    await flush();
    expect(c.last()).toMatchObject({ state: 'error', message: VOICE_TEXT.startFailed });
  });

  it('carries on without phrase hints when the recognizer cannot use them', async () => {
    const b = await boot(ON);
    expect(b.speech.last().phrases.length).toBeGreaterThan(0);
    b.speech.last().fireError('phrases-not-supported');
    b.speech.last().fireEnd();
    vi.advanceTimersByTime(0);
    expect(b.speech.instances).toHaveLength(2);
    expect(b.speech.last().phrases).toEqual([]);
  });

  it('waits for a microphone, retrying slowly and at once when devices change', async () => {
    const b = await boot(ON);
    b.speech.last().fireError('audio-capture');
    b.speech.last().fireEnd();
    expect(b.last()).toMatchObject({ state: 'error', message: VOICE_TEXT.noMicrophone });
    vi.advanceTimersByTime(NO_MICROPHONE_RETRY_MS - 1);
    expect(b.speech.instances).toHaveLength(1);
    b.devices.change!();
    expect(b.speech.instances).toHaveLength(2);
  });

  it('gives a running session the new phrase hints when the spellbook changes', async () => {
    const b = await boot(ON);
    const rec = b.speech.last();
    rec.fireStart();
    b.kernel.emit('spellbook.changed', seedSpellbook({ lumos: { enabled: false, status: 'locked' } }, 2), 'kernel.packs');
    expect(rec.stopped).toBe(true);
    rec.fireEnd();
    vi.advanceTimersByTime(0);
    const next = b.speech.last();
    expect(next).not.toBe(rec);
    expect((next.phrases as FakePhrase[]).map((p) => p.phrase)).not.toContain('Lumos');
  });

  it('checks again with the new language when it changes', async () => {
    const b = await boot(ON);
    const rec = b.speech.last();
    await setSetting(b.kernel, 'voice.lang', 'fr-FR');
    expect(rec.aborted).toBe(true);
    rec.fireEnd();
    await flush();
    expect(b.speech.availableCalls[b.speech.availableCalls.length - 1]).toMatchObject({ langs: ['fr-FR'] });
    expect(b.speech.last().lang).toBe('fr-FR');
  });

  it('stop() aborts, says off, and ignores late answers', async () => {
    let resolve: (v: string) => void = () => {};
    const speech = fakeSpeech({ local: () => new Promise<string>((r) => (resolve = r)) });
    const b = await boot(ON, speech);
    await b.kernel.stop();
    resolve('available');
    await flush();
    expect(speech.instances).toHaveLength(0);
    expect(b.last()).toMatchObject({ state: 'off' });
  });
});

describe('feature detection', () => {
  it('finds the standard and prefixed constructors, and on-device support', () => {
    class OnDevice extends FakeRecognition {
      static available() { return Promise.resolve('available'); }
      static install() { return Promise.resolve(true); }
    }
    expect(detectSpeech({ SpeechRecognition: OnDevice, SpeechRecognitionPhrase: FakePhrase })).toMatchObject({ onDevice: true, Phrase: FakePhrase });
    expect(detectSpeech({ webkitSpeechRecognition: FakeRecognition })).toMatchObject({ onDevice: false, Phrase: null });
    expect(detectSpeech({})).toBeNull();
    expect(detectSpeech(undefined)).toBeNull();
  });
});
