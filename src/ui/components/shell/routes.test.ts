import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type CameraStatus, type SettingsMap, type TrackerStatus } from '../../../contracts';
import { ROUTES, TEXT, cameraChip, cameraLine, cameraWanted, currentRoute, handModeFor, handRoute, routeInfo, trackerLine, wandFound } from './routes';

const settings = (s: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...s });
const camera = (s: Partial<CameraStatus>): CameraStatus => ({ state: 'off', generation: 1, permission: 'unknown', ...s });
const hand = (s: Partial<TrackerStatus>): TrackerStatus => ({ tracker: 'tracker.hand', state: 'searching', lock: 0, fps: 30, aspect: 16 / 9, ...s });

describe('the camera is wanted', () => {
  it('by a camera route, or for the reflection once the camera is allowed', () => {
    expect(cameraWanted(settings({ 'tracker.active': 'tracker.bright-tip' }))).toBe(true);
    expect(cameraWanted(settings({ 'tracker.active': 'tracker.hand' }))).toBe(true);
    expect(cameraWanted(settings({ 'tracker.active': 'tracker.pointer', 'capture.mirror': true, 'capture.consent': true }))).toBe(true);
    expect(cameraWanted(settings({ 'tracker.active': 'tracker.pointer', 'capture.mirror': false, 'capture.consent': true }))).toBe(false);
    expect(cameraWanted(settings({ 'tracker.active': 'tracker.pointer', 'capture.mirror': true, 'capture.consent': false }))).toBe(false);
  });
});

describe('the camera chip (Section 10.3)', () => {
  it('names each state in words, with its shape', () => {
    expect(cameraChip(camera({ state: 'on' }), true)).toEqual({ state: 'on', text: 'camera on' });
    expect(cameraChip(camera({ state: 'on' }), true, true)).toEqual({ state: 'on', text: 'infrared camera on' });
    expect(cameraChip(camera({ state: 'requesting' }), true)).toEqual({ state: 'warn', text: 'opening camera' });
    expect(cameraChip(camera({ state: 'missing', requesters: ['tracker.hand'] }), true)).toEqual({ state: 'error', text: 'no camera' });
    expect(cameraChip(camera({ state: 'busy' }), true)).toEqual({ state: 'error', text: 'camera in use' });
    expect(cameraChip(null, false)).toEqual({ state: 'off', text: 'camera off' });
  });

  it('keeps a problem in view while something wants the camera', () => {
    const blocked = camera({ state: 'blocked', requesters: ['tracker.bright-tip'] });
    expect(cameraChip(blocked, true)).toEqual({ state: 'error', text: 'camera blocked' });
    // The reflection still asks for it although the route does not.
    expect(cameraChip(camera({ state: 'blocked', requesters: ['effect.stage'] }), false)).toEqual({ state: 'error', text: 'camera blocked' });
    expect(cameraChip(camera({ state: 'off', error: { name: 'NotAllowedError', message: 'denied' } }), true)).toEqual({ state: 'error', text: 'camera blocked' });
  });

  // Mouse or touch chosen after a refusal: capture keeps 'blocked' though nothing asks for the camera.
  it('says the camera is off once nothing wants it any more', () => {
    for (const state of ['blocked', 'missing', 'busy', 'error'] as const) {
      expect(cameraChip(camera({ state, requesters: [] }), false)).toEqual({ state: 'off', text: 'camera off' });
      expect(cameraChip(camera({ state }), false)).toEqual({ state: 'off', text: 'camera off' });
    }
    expect(cameraChip(camera({ state: 'off', error: { name: 'NotAllowedError', message: 'denied' }, requesters: [] }), false)).toEqual({ state: 'off', text: 'camera off' });
  });
});

describe('the camera line', () => {
  it('sends a blocked camera to the address bar in a browser, and to the privacy settings in the desktop app', () => {
    expect(cameraLine(camera({ state: 'blocked' }))?.text).toBe(TEXT.blocked);
    expect(cameraLine(camera({ state: 'blocked' }))?.text).toContain('address bar');
    expect(cameraLine(camera({ state: 'off', error: { name: 'NotAllowedError', message: 'denied' } }), true)?.text).toBe(TEXT.blockedDesktop);
    expect(TEXT.blockedDesktop).not.toContain('address bar');
    expect(cameraLine(camera({ state: 'requesting' }), true)?.text).toBe(TEXT.openingDesktop);
    expect(cameraLine(camera({ state: 'requesting' }))?.text).toBe(TEXT.opening);
  });
});

describe('the hand tracker line', () => {
  it('says the hand looks small, also while the hand is found, and when it is not found', () => {
    expect(trackerLine(hand({ state: 'tracking', hint: null }), 'hand')).toEqual({ tone: 'ok', text: 'Hand found. Your index finger is the wand.' });
    expect(trackerLine(hand({ state: 'tracking', hint: 'hand-too-small' }), 'hand')).toEqual({ tone: 'warn', text: TEXT.handTooSmall });
    expect(trackerLine(hand({ state: 'searching', hint: 'hand-too-small' }), 'hand')).toEqual({ tone: 'warn', text: TEXT.handTooSmall });
    expect(trackerLine(hand({ state: 'searching', hint: 'hand-not-found' }), 'hand')).toEqual({ tone: 'warn', text: TEXT.handNotFound });
    expect(TEXT.handTooSmall).toMatch(/closer/);
  });
});

describe('the routes', () => {
  it('reads the route from the tracker and its mode or profile, and back', () => {
    expect(currentRoute(settings({ 'tracker.active': 'tracker.hand', 'hand.mode': 'wand' }))).toBe('wand');
    expect(currentRoute(settings({ 'tracker.active': 'tracker.hand', 'hand.mode': 'finger' }))).toBe('hand');
    expect(currentRoute(settings({ 'tracker.active': 'tracker.hand', 'hand.mode': 'grip' }))).toBe('hand');
    expect(currentRoute(settings({ 'tracker.active': 'tracker.bright-tip', 'brightTip.profile': 'visible' }))).toBe('glint');
    expect(currentRoute(settings({ 'tracker.active': 'tracker.bright-tip', 'brightTip.profile': 'infrared' }))).toBe('infrared');
    expect(currentRoute(settings({ 'tracker.active': 'tracker.pointer' }))).toBe('pointer');
    // Each route's settings describe it again.
    for (const r of ROUTES) {
      const mode = handModeFor(r.id, 'finger');
      const s = settings({ 'tracker.active': r.tracker, ...(r.settings ?? {}), ...(mode ? { 'hand.mode': mode } : {}) });
      expect(currentRoute(s)).toBe(r.id);
      expect(routeInfo(r.id)).toBe(r);
    }
    expect(handRoute('wand')).toBe(true);
    expect(handRoute('glint')).toBe(false);
  });

  it('puts the wand in the hand first, the way that needs nothing but the wand', () => {
    expect(ROUTES[0]).toMatchObject({ id: 'wand', title: 'The tip of my wand', tracker: 'tracker.hand' });
  });

  it("sets the hand tracker's mode with the route, keeping a player's choice of the knuckles", () => {
    expect(handModeFor('wand', 'finger')).toBe('wand');
    expect(handModeFor('wand', 'grip')).toBe('wand');
    expect(handModeFor('wand', 'wand')).toBeNull();
    expect(handModeFor('hand', 'wand')).toBe('finger');
    expect(handModeFor('hand', 'grip')).toBeNull();
    expect(handModeFor('hand', 'finger')).toBeNull();
    for (const r of ['glint', 'infrared', 'pointer'] as const) expect(handModeFor(r, 'wand')).toBeNull();
  });
});

describe('the wand line (the hand tracker in wand mode)', () => {
  it('counts the wand found when it is seen in most frames, learned or not', () => {
    expect(wandFound(hand({ wand: { seen: 1, learned: false } }))).toBe(true);
    expect(wandFound(hand({ wand: { seen: 0, learned: true } }))).toBe(true);
    expect(wandFound(hand({ wand: { seen: 0.3, learned: false } }))).toBe(false);
    expect(wandFound(hand({}))).toBe(false);
    expect(trackerLine(hand({ state: 'tracking', wand: { seen: 1, learned: false } }), 'wand')).toEqual({ tone: 'ok', text: 'Wand found. Hold still, then trace a spell.' });
  });

  it('finds the hand first, then the wand, and says when the wand is not seen', () => {
    expect(trackerLine(hand({ state: 'tracking', wand: { seen: 0.2, learned: false } }), 'wand')).toEqual({ tone: 'wait', text: 'Hand found. Now hold the wand up so the camera sees all of it.' });
    expect(trackerLine(hand({ state: 'tracking', wand: { seen: 0.9, learned: true } }), 'wand')).toEqual({ tone: 'ok', text: 'Wand found. Hold still, then trace a spell.' });
    expect(trackerLine(hand({ state: 'tracking', hint: 'wand-not-seen', wand: { seen: 0, learned: false } }), 'wand')).toEqual({ tone: 'warn', text: TEXT.wandNotSeen });
    expect(trackerLine(hand({ state: 'searching', hint: 'hand-not-found' }), 'wand')).toEqual({ tone: 'warn', text: TEXT.wandHandNotFound });
    expect(trackerLine(hand({ state: 'tracking', hint: 'hand-too-small' }), 'wand')).toEqual({ tone: 'warn', text: TEXT.handTooSmall });
    // The glint route keeps the bright tip's lines.
    const glint = (s: Partial<TrackerStatus>): TrackerStatus => ({ ...hand(s), tracker: 'tracker.bright-tip' });
    expect(trackerLine(glint({ state: 'searching', hint: 'tip-not-found' }), 'glint')).toEqual({ tone: 'warn', text: TEXT.tipNotFound });
    expect(trackerLine(glint({ state: 'tracking' }), 'glint')).toEqual({ tone: 'ok', text: 'Wand found. Hold still, then trace a spell.' });
  });
});
