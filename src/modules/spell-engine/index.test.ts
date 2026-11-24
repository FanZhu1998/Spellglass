import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, EventMap, Recognition, Stroke } from '../../contracts';
import type { KernelHost } from '../../kernel';
import { ask, createKernel, emit, memoryPersistence, on } from '../../kernel';
import { createSpellEngine, MANIFEST } from './index';
import { detailOf, flickStroke, pathStroke, recognitionOf, seedSpellbook } from './test-support';

type Seen = { type: string; t: number; payload: unknown };

async function boot(settings: Record<string, unknown> = {}, before?: (k: KernelHost) => void) {
  const kernel = createKernel({ persistence: memoryPersistence(settings), features: [], clock: () => Date.now() });
  kernel.register(createSpellEngine());
  await kernel.init();
  kernel.emit('spellbook.changed', seedSpellbook(), 'kernel.packs');
  before?.(kernel);
  await kernel.start();
  const seen: Seen[] = [];
  kernel.subscribe('*', (e: Envelope<unknown>) => {
    if (e.source === MANIFEST.id) seen.push({ type: e.type, t: e.t, payload: e.payload });
  });
  return { kernel, seen };
}

/** Stand in for the recognizer: answer every stroke.end from inside the handler, as the real one
 *  does, so the engine sees the run-to-completion order of the bus. */
function recognizeWith(kernel: KernelHost, answer: (s: Stroke) => Recognition): void {
  on(kernel, 'stroke.end', (s) => emit(kernel, 'recognizer.template', 'recognition.result', answer(s)));
}

const payloads = <K extends keyof EventMap>(seen: Seen[], type: K) => seen.filter((e) => e.type === type).map((e) => e.payload as EventMap[K]);

describe('spell engine module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the manifest id and kind the app depends on', () => {
    expect(MANIFEST).toMatchObject({ id: 'engine.rules', kind: 'engine', contract: '^1.1', provides: ['engine@1'] });
  });

  it('casts through the bus, publishing a cast before the spell.ended it causes', async () => {
    const { kernel, seen } = await boot();
    recognizeWith(kernel, (s) => recognitionOf(s.id, s.id === 's1' ? { lumos: 0.95, nox: 0.2 } : { nox: 0.95, lumos: 0.2 }, { stage: 'flick' }));
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: now - 300, durationMs: 300 }));
    vi.advanceTimersByTime(1000);
    const t = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s2', 'down', { t0: t - 300, durationMs: 300 }));
    expect(seen.map((e) => e.type)).toEqual(['spell.cast', 'spell.cast', 'spell.ended']);
    const [lumos, nox] = payloads(seen, 'spell.cast');
    expect(payloads(seen, 'spell.ended')[0]).toMatchObject({ spellId: 'lumos', castId: lumos.id, by: 'nox', byCastId: nox.id });
    // The envelope's t is the decision time; the payload's t the capture time of the stroke's end.
    expect(seen[1].t).toBe(t);
    expect(nox.t).toBe(t);
  });

  it('assisted: publishes spell.pending and decides on the gesture alone when the window closes', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'assisted' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    recognizeWith(kernel, (s) => recognitionOf(s.id, { alohomora: 0.64, protego: 0.4 }, { details: [detailOf('alohomora', 0.64, { reached: 0.8 })] }));
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', pathStroke('s1', 'alohomora', { t0: now - 1500, durationMs: 1500 }));
    expect(payloads(seen, 'spell.pending')).toEqual([{ strokeId: 's1', until: now + 1000, waitingFor: 'voice' }]);
    vi.advanceTimersByTime(999);
    expect(payloads(seen, 'spell.fizzle')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(payloads(seen, 'spell.fizzle')).toMatchObject([{
      strokeId: 's1', reason: 'low-score', hint: 'The downstroke stopped short: carry it through the circle.',
    }]);
    // A final result that arrives later changes nothing.
    emit(kernel, 'voice.web-speech', 'voice.incantation', { id: 'u1', t: now + 500, text: 'alohomora', spellId: 'alohomora', conf: 0.9, final: true });
    expect(payloads(seen, 'spell.cast')).toEqual([]);
  });

  it('assisted: an incantation heard after the stroke, inside the window, casts at the assisted score', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'assisted' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    recognizeWith(kernel, (s) => recognitionOf(s.id, { alohomora: 0.64, protego: 0.4 }));
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', pathStroke('s1', 'alohomora', { t0: now - 1500, durationMs: 1500 }));
    vi.advanceTimersByTime(500);
    emit(kernel, 'voice.web-speech', 'voice.incantation', { id: 'u1', t: now + 200, t0: now + 200, t1: now + 450, text: 'alohomora', spellId: 'alohomora', conf: 0.9, final: true });
    expect(payloads(seen, 'spell.cast')).toMatchObject([{ spellId: 'alohomora', via: 'both', score: 0.64, strokeId: 's1', targetId: 'box' }]);
    vi.advanceTimersByTime(5000);
    expect(seen.filter((e) => e.type === 'spell.cast' || e.type === 'spell.fizzle')).toHaveLength(1);
  });

  it('hears stroke.begin: a word said once the next stroke has begun is that stroke’s (Section 7.7)', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'assisted' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    // The second flick, 35° off vertical, is ambiguous on its own.
    recognizeWith(kernel, (s) => (s.id === 's1' ? recognitionOf('s1', { lumos: 0.95 }, { stage: 'flick' }) : recognitionOf('s2', { lumos: 0.84, expelliarmus: 0.82 })));
    const t = Date.now();
    // A Lumos flick casts at once: nothing has been heard yet.
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: t - 300, durationMs: 300 }));
    // The pen goes down again, and "Lumos" is said while the next flick is traced.
    vi.advanceTimersByTime(400);
    emit(kernel, 'segmenter.pen', 'stroke.begin', { id: 's2', points: [], t0: t + 400, t1: t + 400, quality: 1 });
    vi.advanceTimersByTime(600);
    emit(kernel, 'voice.web-speech', 'voice.incantation', { id: 'u1', t: t + 450, t0: t + 450, t1: t + 850, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true });
    vi.advanceTimersByTime(300);
    emit(kernel, 'segmenter.pen', 'stroke.end', flickStroke('s2', 'up', { t0: t + 400, durationMs: 900 }));
    expect(payloads(seen, 'spell.cast')).toMatchObject([{ strokeId: 's1', via: 'gesture' }, { strokeId: 's2', spellId: 'lumos', via: 'both' }]);
  });

  it('strict: no incantation in time is a strict mismatch', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'strict' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'ready', local: true });
    recognizeWith(kernel, (s) => recognitionOf(s.id, { lumos: 0.95 }, { stage: 'flick' }));
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: now - 300, durationMs: 300 }));
    vi.advanceTimersByTime(1000);
    expect(payloads(seen, 'spell.fizzle')).toMatchObject([{ reason: 'strict-mismatch', nearest: { spellId: 'lumos' } }]);
  });

  it('voice only: the incantation alone casts, aimed at the last tip', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'voice' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'tip.filtered', { t: now - 100, x: 0.2, y: 0.3, conf: 1, src: 'tracker.hand' });
    emit(kernel, 'voice.web-speech', 'voice.incantation', { id: 'u1', t: now - 50, text: 'stupefy', spellId: 'stupefy', conf: 0.8, final: true });
    expect(payloads(seen, 'spell.cast')).toMatchObject([{ spellId: 'stupefy', via: 'voice', aim: { x: 0.2, y: 0.3 }, targetId: 'dummy', quality: 0.8 }]);
  });

  it('ends a timed spell when its time is up, counted from the bloom', async () => {
    const { kernel, seen } = await boot();
    recognizeWith(kernel, (s) => recognitionOf(s.id, { protego: 0.9, accio: 0.4 }));
    const now = Date.now();
    emit(kernel, 'segmenter.hold-still', 'stroke.end', pathStroke('s1', 'protego', { t0: now - 2000, durationMs: 2000 }));
    vi.advanceTimersByTime(250 + 5000 - 1);
    expect(payloads(seen, 'spell.ended')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(payloads(seen, 'spell.ended')).toMatchObject([{ spellId: 'protego', by: 'timeout' }]);
  });

  it('under reduced motion the effect blooms at once, so a timed spell lasts exactly its duration', async () => {
    const { kernel, seen } = await boot({ 'access.reducedMotion': 'on' });
    recognizeWith(kernel, (s) => recognitionOf(s.id, { protego: 0.9 }));
    emit(kernel, 'segmenter.hold-still', 'stroke.end', pathStroke('s1', 'protego', { t0: Date.now() - 2000, durationMs: 2000 }));
    vi.advanceTimersByTime(5000);
    expect(payloads(seen, 'spell.ended')).toMatchObject([{ spellId: 'protego', by: 'timeout' }]);
  });

  it('serves engine.cast and engine.reset', async () => {
    const { kernel, seen } = await boot();
    const cast = await ask(kernel, 'engine.cast', { spellId: 'lumos', via: 'gesture', quality: 0.8, power: 0.3, replay: true });
    expect(cast).toMatchObject({ spellId: 'lumos', replay: true, effectScale: 1 });
    expect(payloads(seen, 'spell.cast')).toEqual([cast]);
    await ask(kernel, 'engine.reset');
    expect(payloads(seen, 'spell.ended')).toMatchObject([{ castId: cast.id, by: 'reset' }]);
    await expect(ask(kernel, 'engine.cast', { spellId: 'nope', via: 'gesture', quality: 1, power: 1, replay: true })).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('reads sticky practice focus at start and grades strokes against it', async () => {
    const { kernel, seen } = await boot({}, (k) => emit(k, 'shell', 'practice.focus', { spellId: 'lumos' }));
    recognizeWith(kernel, (s) => recognitionOf(s.id, { lumos: 0.95 }, { stage: 'flick' }));
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: Date.now() - 300, durationMs: 300 }));
    expect(seen.map((e) => e.type)).toEqual(['spell.cast', 'practice.attempt']);
    expect(payloads(seen, 'practice.attempt')[0]).toMatchObject({ spellId: 'lumos', attempt: 1, success: true });
  });

  it('measures pointer strokes against the whole mirror, whatever the play area (tracker.status pen)', async () => {
    const { kernel, seen } = await boot({ playArea: { x: 0.3, y: 0.15, w: 0.4, h: 0.6 } });
    emit(kernel, 'tracker.pointer', 'tracker.status', { tracker: 'tracker.pointer', state: 'tracking', lock: 1, fps: 60, aspect: 16 / 9, pen: true });
    recognizeWith(kernel, (s) => recognitionOf(s.id, { lumos: 0.95 }, { stage: 'flick' }));
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: Date.now() - 200, durationMs: 200, length: 0.4, src: 'tracker.pointer' }));
    const [cast] = payloads(seen, 'spell.cast');
    // Against the play area this flick would be Lumos Maxima at about 0.92.
    expect(cast.power).toBeCloseTo(0.52, 2);
    expect(cast.variant).toBeUndefined();
  });

  it('applies settings changes at the next decision', async () => {
    const { kernel, seen } = await boot();
    recognizeWith(kernel, (s) => recognitionOf(s.id, { lumos: 0.93 }, { stage: 'flick' }));
    await ask(kernel, 'settings.set', { key: 'engine.acceptScore', value: 0.95 });
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: Date.now() - 300, durationMs: 300 }));
    expect(payloads(seen, 'spell.fizzle')).toMatchObject([{ reason: 'low-score' }]);
  });

  it('stops cleanly: active spells end, and nothing is decided while stopped', async () => {
    const { kernel, seen } = await boot();
    recognizeWith(kernel, (s) => recognitionOf(s.id, { lumos: 0.95 }, { stage: 'flick' }));
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s1', 'up', { t0: Date.now() - 300, durationMs: 300 }));
    await kernel.stop();
    expect(payloads(seen, 'spell.ended')).toMatchObject([{ spellId: 'lumos', by: 'stopped' }]);
    emit(kernel, 'segmenter.hold-still', 'stroke.end', flickStroke('s2', 'up', { t0: Date.now() - 300, durationMs: 300 }));
    expect(payloads(seen, 'spell.cast')).toHaveLength(1);
  });
});
