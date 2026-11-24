import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RecordedSession, Stroke, TrackerStatus } from '../../contracts';
import { checkSession } from '../../kernel';
import { SessionRecorder, type RecorderStart } from './recorder';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/sessions/synthetic-01-core.json', import.meta.url));
const T0 = 10_000;

function status(tracker = 'tracker.bright-tip', extra: Partial<TrackerStatus> = {}): TrackerStatus {
  return { tracker, state: 'tracking', lock: 1, fps: 30, aspect: 16 / 9, pen: false, ...extra };
}

function recorder(extra: Partial<RecorderStart> = {}): SessionRecorder {
  return new SessionRecorder({
    id: 'session-test', t0: T0, recordedAt: '2026-11-21T10:00:00.000Z', status: status(), heldTip: null, ...extra,
  });
}

function stroke(id: string, t0: number, t1: number, src = 'tracker.bright-tip'): Stroke {
  return { id, points: [], t0, t1, quality: 1, src, aspect: 16 / 9 };
}

const sample = (t: number, x = 0.5, y = 0.5, src = 'tracker.bright-tip') => ({ t, x, y, conf: 0.9, src, size: 0.002 });

describe('SessionRecorder', () => {
  it('records a live stream in the fixture format, relative to t0', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RecordedSession;
    const rec = recorder();
    for (const e of fixture.events) {
      const t = T0 + e.t;
      if (e.type === 'tip.lost') rec.lost({ t, src: 'tracker.bright-tip', lastSeen: e.lastSeen !== undefined ? T0 + e.lastSeen : undefined }, 'tracker.bright-tip');
      else if (e.type === 'tip.found' || e.type === 'tip.sample') rec.tip(e.type, { t, x: e.x, y: e.y, conf: e.conf, src: 'tracker.bright-tip', ...('size' in e && e.size !== undefined ? { size: e.size } : {}), ...(e.frame !== undefined ? { frame: e.frame } : {}) }, 'tracker.bright-tip');
    }
    const s = rec.finish('tracker.pointer');
    expect(s.events).toEqual(fixture.events);
    expect(s).toMatchObject({ schema: 'session/1', id: 'session-test', tracker: 'tracker.bright-tip', pen: false, recordedAt: '2026-11-21T10:00:00.000Z' });
    expect(s.aspect).toBeCloseTo(16 / 9, 10);
    expect(checkSession(s)).toEqual({ ok: true });
  });

  it('drops events from before t0, from the replay tracker and from other trackers', () => {
    const rec = recorder();
    rec.tip('tip.sample', sample(T0 - 5), 'tracker.bright-tip');
    rec.tip('tip.sample', sample(T0 + 5, 0.5, 0.5, 'tracker.replay'), 'tracker.replay');
    rec.tip('tip.sample', sample(T0 + 6, 0.5, 0.5, 'tracker.pointer'), 'tracker.pointer');
    rec.voice({ t: T0 + 7, text: 'Lumos', conf: 0.8, final: true }, 'tracker.replay');
    rec.voice({ t: T0 - 1, text: 'Nox', conf: 0.8, final: true }, 'voice.speech');
    rec.tip('tip.sample', sample(T0 + 8), 'tracker.bright-tip');
    expect(rec.finish('x').events).toEqual([{ type: 'tip.sample', t: 8, x: 0.5, y: 0.5, conf: 0.9, size: 0.002 }]);
  });

  it('opens with a tip.found at t = 0 when the tip is already held', () => {
    const rec = recorder({ heldTip: { x: 0.31, y: 0.42, conf: 0.95 } });
    rec.tip('tip.sample', sample(T0 + 33, 0.32, 0.42), 'tracker.bright-tip');
    expect(rec.finish('x').events).toEqual([
      { type: 'tip.found', t: 0, x: 0.31, y: 0.42, conf: 0.95 },
      { type: 'tip.sample', t: 33, x: 0.32, y: 0.42, conf: 0.9, size: 0.002 },
    ]);
  });

  it('keeps values inside the session schema', () => {
    const rec = recorder();
    rec.tip('tip.sample', { t: T0 + 1.23456, x: 7, y: -3, conf: 1.4, src: 'tracker.bright-tip', size: 2, frame: 2.5 }, 'tracker.bright-tip');
    rec.voice({ t: T0 + 2, text: 'x'.repeat(900), conf: -1, final: false, spellId: 'lumos', id: 'u1', t0: T0 + 1, t1: T0 + 3 }, 'voice.speech');
    const s = rec.finish('x');
    expect(s.events[0]).toEqual({ type: 'tip.sample', t: 1.2, x: 2, y: -1, conf: 1, size: 1 });
    expect(s.events[1]).toMatchObject({ type: 'voice.incantation', t: 2, conf: 0, final: false, spellId: 'lumos', id: 'u1', t0: 1, t1: 3 });
    expect((s.events[1] as { text: string }).text).toHaveLength(500);
    expect(checkSession(s).ok).toBe(true);
  });

  it('expects what was decided per stroke, at the stroke t1, without a label', () => {
    const rec = recorder();
    rec.strokeEnd(stroke('s1', T0 + 100, T0 + 900));
    rec.decision({ strokeId: 's1', spellId: 'lumos', t: T0 + 900 });
    rec.strokeEnd(stroke('s2', T0 + 1500, T0 + 2600));
    rec.decision({ strokeId: 's2', spellId: null, t: T0 + 2600 });
    expect(rec.finish('x').expected).toEqual([
      { spellId: 'lumos', t: 900, decided: 'lumos', strokeId: 's1' },
      { spellId: null, t: 2600, decided: null, strokeId: 's2' },
    ]);
  });

  it('expects the intended spell when the caster was told what to cast', () => {
    const rec = recorder({ intended: 'alohomora' });
    rec.strokeEnd(stroke('s1', T0 + 100, T0 + 900));
    rec.decision({ strokeId: 's1', spellId: 'accio', t: T0 + 900 });
    rec.strokeEnd(stroke('s2', T0 + 1000, T0 + 1900));
    rec.decision({ strokeId: 's2', spellId: null, t: T0 + 1900 });
    const s = rec.finish('x');
    expect(s.intended).toBe('alohomora');
    expect(s.expected).toEqual([
      { spellId: 'alohomora', t: 900, intended: 'alohomora', decided: 'accio', strokeId: 's1' },
      { spellId: 'alohomora', t: 1900, intended: 'alohomora', decided: null, strokeId: 's2' },
    ]);
  });

  it('labels each stroke with the spell intended when it ended', () => {
    const rec = recorder({ intended: 'lumos' });
    rec.strokeEnd(stroke('s1', T0 + 100, T0 + 400));
    rec.label('nox');
    rec.decision({ strokeId: 's1', spellId: 'lumos', t: T0 + 400 });
    rec.strokeEnd(stroke('s2', T0 + 600, T0 + 900));
    rec.decision({ strokeId: 's2', spellId: 'nox', t: T0 + 900 });
    rec.label(null);
    rec.strokeEnd(stroke('s3', T0 + 1000, T0 + 1300));
    rec.decision({ strokeId: 's3', spellId: 'stupefy', t: T0 + 1300 });
    const s = rec.finish('x');
    expect(s.intended).toBeUndefined();
    expect(s.expected.map((e) => [e.spellId, e.intended, e.decided])).toEqual([
      ['lumos', 'lumos', 'lumos'],
      ['nox', 'nox', 'nox'],
      ['stupefy', undefined, 'stupefy'],
    ]);
  });

  it('joins a decision and its stroke in either order, and ignores strokes it should not count', () => {
    const rec = recorder();
    rec.decision({ strokeId: 'early', spellId: 'nox', t: T0 + 500 });
    rec.strokeEnd(stroke('early', T0 + 100, T0 + 500));
    rec.strokeEnd(stroke('before', T0 - 300, T0 + 200));
    rec.decision({ strokeId: 'before', spellId: 'lumos', t: T0 + 200 });
    rec.strokeEnd(stroke('replayed', T0 + 600, T0 + 800, 'tracker.replay'));
    rec.decision({ strokeId: 'replayed', spellId: 'lumos', t: T0 + 800, replay: true });
    rec.strokeEnd(stroke('other', T0 + 600, T0 + 800, 'tracker.pointer'));
    rec.decision({ strokeId: 'other', spellId: 'lumos', t: T0 + 800 });
    expect(rec.finish('x').expected).toEqual([{ spellId: 'nox', t: 500, decided: 'nox', strokeId: 'early' }]);
  });

  it('records voice-only casts at the incantation time, and never replayed ones', () => {
    const rec = recorder();
    rec.decision({ spellId: 'lumos', t: T0 + 1200 });
    rec.decision({ spellId: 'nox', t: T0 + 1500, replay: true });
    expect(rec.finish('x').expected).toEqual([{ spellId: 'lumos', t: 1200, decided: 'lumos' }]);
  });

  it('counts strokes still waiting for a decision, and leaves out unlabelled ones that never got one', () => {
    const rec = recorder();
    rec.strokeEnd(stroke('s1', T0 + 100, T0 + 900));
    expect(rec.pending).toBe(1);
    rec.close();
    rec.decision({ strokeId: 's1', spellId: 'lumos', t: T0 + 900 });
    expect(rec.pending).toBe(0);
    rec.strokeEnd(stroke('s2', T0 + 1000, T0 + 1900));
    expect(rec.finish('x').expected).toHaveLength(1);

    const labelled = recorder({ intended: 'lumos' });
    labelled.strokeEnd(stroke('s1', T0 + 100, T0 + 900));
    expect(labelled.finish('x').expected).toEqual([{ spellId: 'lumos', t: 900, intended: 'lumos', strokeId: 's1' }]);
  });

  it('says when the recording must stop: another tracker, the tracker stopping, a new shape', () => {
    const rec = recorder();
    expect(rec.status(status('tracker.bright-tip', { state: 'searching' }))).toBeNull();
    expect(rec.status(status('tracker.replay'))).toBeNull();
    expect(rec.status(status('tracker.hand', { state: 'stopped' }))).toBeNull();
    expect(rec.status(status('tracker.hand'))).toBe('tracker-changed');
    expect(recorder().status(status('tracker.bright-tip', { state: 'stopped' }))).toBe('tracker-stopped');
    expect(recorder().status(status('tracker.bright-tip', { aspect: 4 / 3 }))).toBe('shape-changed');
    expect(recorder().status(status('tracker.bright-tip', { aspect: 16 / 9 + 0.001 }))).toBeNull();
    expect(recorder().status(status('tracker.bright-tip', { pen: true }))).toBe('shape-changed');
  });

  it('adopts the first tracker to report when none was running', () => {
    const rec = recorder({ status: null });
    expect(rec.recordedTracker).toBeNull();
    rec.tip('tip.sample', sample(T0 + 5, 0.5, 0.5, 'tracker.replay'), 'tracker.replay');
    expect(rec.status(status('tracker.pointer', { pen: true, aspect: 4 / 3 }))).toBeNull();
    expect(rec.recordedTracker).toBe('tracker.pointer');
    rec.tip('tip.found', sample(T0 + 10, 0.5, 0.5, 'tracker.pointer'), 'tracker.pointer');
    const s = rec.finish('tracker.bright-tip');
    expect(s).toMatchObject({ tracker: 'tracker.pointer', pen: true });
    expect(s.aspect).toBeCloseTo(4 / 3, 10);
    expect(s.events).toHaveLength(1);

    const silent = recorder({ status: null });
    expect(silent.finish('tracker.hand').tracker).toBe('tracker.hand');
  });

  it('keeps the camera for camera trackers, the settings and enabled spells, and a title', () => {
    const camera = { label: 'Desk camera', width: 1920, height: 1080, fps: 30, exposure: { mode: 'manual', time: 50 } };
    const rec = recorder({ camera, enabledSpells: ['lumos', 'nox'], title: 'Twenty Lumos' });
    rec.setSettings({ 'engine.mode': 'assisted' });
    const s = rec.finish('x');
    expect(s).toMatchObject({ camera, enabledSpells: ['lumos', 'nox'], settings: { 'engine.mode': 'assisted' }, title: 'Twenty Lumos' });
    expect(checkSession(s).ok).toBe(true);

    const pen = recorder({ camera, status: status('tracker.pointer', { pen: true }) });
    const p = pen.finish('x');
    expect(p.camera).toBeUndefined();
    expect(p.settings).toBeUndefined();
  });
});
