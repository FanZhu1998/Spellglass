import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RecordedSession } from '../../../contracts';
import { DEFAULT_ASPECT, dueAt, MAX_SPEED, normalizeSpeed, planSession, readEvent, REPLAY_TAIL_MS, tailMs } from './plan';

const FIXTURE = fileURLToPath(new URL('../../../../tests/fixtures/sessions/synthetic-01-core.json', import.meta.url));

function session(events: unknown[], extra: Partial<RecordedSession> = {}): unknown {
  return { schema: 'session/1', id: 's', recordedAt: '2026-11-21T00:00:00Z', tracker: 'tracker.hand', aspect: 4 / 3, events, expected: [], ...extra };
}

describe('planSession', () => {
  it('keeps a recorded fixture exactly as it is', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RecordedSession;
    const plan = planSession(fixture);
    expect(plan.count).toBe(fixture.events.length);
    expect(plan.skipped).toBe(0);
    expect(plan.steps.some((s) => s.synthetic)).toBe(false);
    expect(plan.steps.map((s) => s.event)).toEqual(fixture.events);
    expect(plan.aspect).toBeCloseTo(16 / 9, 10);
    expect(plan.pen).toBe(false);
    expect(plan.endT).toBe(fixture.events.at(-1)!.t);
    expect(plan.sampleRate).toBeGreaterThan(20);
  });

  it('takes the aspect and pen flag from the session, with defaults', () => {
    expect(planSession(session([], { pen: true }))).toMatchObject({ aspect: 4 / 3, pen: true, count: 0, steps: [] });
    expect(planSession(session([], { aspect: -1 })).aspect).toBe(DEFAULT_ASPECT);
    expect(planSession({ events: [] }).aspect).toBe(DEFAULT_ASPECT);
  });

  it('skips unknown and malformed events (readers are tolerant)', () => {
    const plan = planSession(session([
      { type: 'tip.found', t: 0, x: 0.5, y: 0.5, conf: 1 },
      { type: 'tip.sample', t: 0, x: 0.5, y: 0.5, conf: 1 },
      { type: 'tip.wobble', t: 10 },
      { type: 'tip.sample', t: 20, x: 'left', y: 0.5, conf: 1 },
      { type: 'tip.sample', t: Number.NaN, x: 0.5, y: 0.5, conf: 1 },
      null,
      { type: 'voice.incantation', t: 25, text: 'Lumos', conf: 0.9 },
      { type: 'tip.lost', t: 30 },
    ]));
    expect(plan.count).toBe(3);
    expect(plan.skipped).toBe(5);
    expect(plan.steps.map((s) => s.event.type)).toEqual(['tip.found', 'tip.sample', 'tip.lost']);
  });

  it('repairs the tip event rules a hand-edited file may break', () => {
    const plan = planSession(session([
      { type: 'tip.lost', t: 0 },
      { type: 'tip.sample', t: 10, x: 0.2, y: 0.3, conf: 0.8, frame: 4 },
      { type: 'tip.found', t: 20, x: 0.2, y: 0.3, conf: 0.8 },
      { type: 'tip.sample', t: 30, x: 0.25, y: 0.3, conf: 0.8 },
    ]));
    expect(plan.steps).toEqual([
      { t: 10, event: { type: 'tip.found', t: 10, x: 0.2, y: 0.3, conf: 0.8, frame: 4 }, synthetic: true },
      { t: 10, event: { type: 'tip.sample', t: 10, x: 0.2, y: 0.3, conf: 0.8, frame: 4 } },
      { t: 30, event: { type: 'tip.sample', t: 30, x: 0.25, y: 0.3, conf: 0.8 } },
      { t: 30, event: { type: 'tip.lost', t: 30, lastSeen: 30 }, synthetic: true },
    ]);
    expect(plan.count).toBe(2);
    expect(plan.skipped).toBe(2);
  });

  it('puts events in time order, keeping the order of equal times', () => {
    const plan = planSession(session([
      { type: 'tip.found', t: 50, x: 0.5, y: 0.5, conf: 1 },
      { type: 'tip.sample', t: 50, x: 0.5, y: 0.5, conf: 1 },
      { type: 'voice.incantation', t: 20, text: 'Lumos', conf: 0.9, final: false, id: 'u1', t0: 20 },
      { type: 'tip.lost', t: 80, lastSeen: 50 },
    ]));
    expect(plan.steps.map((s) => `${s.event.type}@${s.t}`)).toEqual(['voice.incantation@20', 'tip.found@50', 'tip.sample@50', 'tip.lost@80']);
  });

  it('refuses what is not a session, or a newer format', () => {
    expect(() => planSession(null)).toThrow('That is not a recorded session.');
    expect(() => planSession('session')).toThrow('That is not a recorded session.');
    expect(() => planSession({ schema: 'spellpack/1', events: [] })).toThrow('That is not a recorded session.');
    expect(() => planSession({ schema: 'session/2', events: [] })).toThrow('newer version of Spellglass');
    expect(() => planSession({ schema: 'session/1' })).toThrow('The recording has no events to play.');
  });
});

describe('readEvent', () => {
  it('keeps optional fields only when they are well formed', () => {
    expect(readEvent({ type: 'tip.sample', t: 1, x: 0.1, y: 0.2, conf: 0.5, size: 'big', frame: 3 })).toEqual({ type: 'tip.sample', t: 1, x: 0.1, y: 0.2, conf: 0.5, frame: 3 });
    expect(readEvent({ type: 'tip.lost', t: 5, lastSeen: 'yesterday' })).toEqual({ type: 'tip.lost', t: 5 });
    expect(readEvent({ type: 'voice.incantation', t: 1, text: 'Nox', conf: 0.7, final: true, spellId: 'nox', id: 'u', t0: 0.5, t1: 1.5 }))
      .toEqual({ type: 'voice.incantation', t: 1, text: 'Nox', conf: 0.7, final: true, spellId: 'nox', id: 'u', t0: 0.5, t1: 1.5 });
  });
});

describe('pacing', () => {
  it('normalizes the speed', () => {
    expect(normalizeSpeed(undefined)).toBe(1);
    expect(normalizeSpeed(0)).toBe(0);
    expect(normalizeSpeed(2)).toBe(2);
    expect(normalizeSpeed(-3)).toBe(1);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
    expect(normalizeSpeed(1000)).toBe(MAX_SPEED);
  });

  it('schedules a step at start + t / speed, and at once at speed 0', () => {
    expect(dueAt(1000, 500, 1)).toBe(1500);
    expect(dueAt(1000, 500, 2)).toBe(1250);
    expect(dueAt(1000, 500, 0)).toBe(1000);
    expect(dueAt(1000, -20, 1)).toBe(1000);
    expect(tailMs(1)).toBe(REPLAY_TAIL_MS);
    expect(tailMs(4)).toBe(REPLAY_TAIL_MS / 4);
    expect(tailMs(0)).toBe(0);
  });
});
