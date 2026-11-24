import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type CameraStatus, type SettingsMap } from '../../../contracts';
import { TEXT, cameraChip, cameraLine, cameraWanted } from './routes';

const settings = (s: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...s });
const camera = (s: Partial<CameraStatus>): CameraStatus => ({ state: 'off', generation: 1, permission: 'unknown', ...s });

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
