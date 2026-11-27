import { describe, expect, it } from 'vitest';
import {
  classifyError, compensationForTime, errorMessage, exposureConstraintSet, frameTimestamp, isCameraProfile, isInfraredLabel,
  nextLowerSize, profileExposure, readExposureInfo, resolveExposure, snap, videoConstraints,
} from './camera-utils';

describe('isInfraredLabel', () => {
  it('spots infrared cameras by name (Appendix A step 9)', () => {
    for (const label of ['Integrated IR Camera', 'HP IR Camera (04f2:b6bf)', 'Infrared Camera', 'USB2.0 Infra-Red', 'Night Vision USB', 'NIR cam', 'Windows Hello Face']) {
      expect(isInfraredLabel(label), label).toBe(true);
    }
  });
  it('does not match "ir" inside words', () => {
    for (const label of ['FaceTime HD Camera', 'FireWire Cam', 'Iris webcam', 'Integrated Camera', 'Logitech BRIO', '', undefined]) {
      expect(isInfraredLabel(label), String(label)).toBe(false);
    }
  });
});

describe('constraints', () => {
  it('asks for ideal size and rate, no rescaling, and the chosen device exactly', () => {
    expect(videoConstraints({ width: 1920, height: 1080, fps: 60 })).toEqual({
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 }, resizeMode: 'none',
    });
    expect(videoConstraints({ deviceId: 'abc', width: 1920, height: 1080, fps: 60 }).deviceId).toEqual({ exact: 'abc' });
  });
  it('steps 1080p down to 720p, and on down the ladder', () => {
    expect(nextLowerSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(nextLowerSize(1280, 720)).toEqual({ width: 960, height: 540 });
    expect(nextLowerSize(2560, 1440)).toEqual({ width: 1920, height: 1080 });
    expect(nextLowerSize(640, 360)).toBeNull();
  });
});

describe('exposure', () => {
  const caps = { exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 5000, step: 1 }, exposureCompensation: { min: -3, max: 3, step: 0.5 } };
  it('reads the camera\'s exposure control', () => {
    const info = readExposureInfo(caps, { exposureMode: 'continuous', exposureTime: 312 })!;
    expect(info).toEqual({ modes: ['continuous', 'manual'], min: 1, max: 5000, step: 1, compensation: { min: -3, max: 3, step: 0.5 }, mode: 'continuous', time: 312 });
    expect(readExposureInfo({}, {})).toBeNull();
    expect(readExposureInfo(undefined, {})).toBeNull();
  });
  it('clamps a manual time to the range and snaps to the step', () => {
    const info = readExposureInfo({ exposureMode: ['continuous', 'manual'], exposureTime: { min: 3, max: 2047, step: 4 } }, {});
    expect(resolveExposure(info, { mode: 'manual', time: 1 })).toEqual({ mode: 'manual', time: 3 });
    expect(resolveExposure(info, { mode: 'manual', time: 100 })).toEqual({ mode: 'manual', time: 99 });
    expect(resolveExposure(info, { mode: 'manual', time: 99999 })).toEqual({ mode: 'manual', time: 2047 });
    expect(exposureConstraintSet(info, { mode: 'manual', time: 99 })).toEqual({ exposureMode: 'manual', exposureTime: 99 });
  });
  it('falls back to exposureCompensation where the camera has no exposure time', () => {
    const info = readExposureInfo({ exposureMode: ['continuous'], exposureCompensation: { min: -2, max: 2, step: 0.25 } }, {});
    // 1/30 s → 0 stops; a 4× shorter time → -2 stops.
    expect(compensationForTime(333)).toBeCloseTo(0, 5);
    expect(resolveExposure(info, { mode: 'manual', time: 83 })).toEqual({ mode: 'continuous', compensation: -2 });
    expect(resolveExposure(info, { mode: 'manual', compensation: -1.1 })).toEqual({ mode: 'continuous', compensation: -1 });
    expect(exposureConstraintSet(info, { mode: 'continuous', compensation: -1 })).toEqual({ exposureMode: 'continuous', exposureCompensation: -1 });
  });
  it('does nothing on a camera without exposure control', () => {
    expect(resolveExposure(null, { mode: 'manual', time: 50 })).toBeNull();
  });
  it('turns a profile into an exposure target', () => {
    expect(profileExposure({ exposureMode: 'manual', exposureTime: 40 })).toEqual({ mode: 'manual', time: 40 });
    expect(profileExposure({ exposureMode: 'manual', exposureTime: null })).toEqual({ mode: 'continuous' });
    expect(profileExposure({ exposureMode: 'continuous', exposureCompensation: -1 })).toEqual({ mode: 'continuous', compensation: -1 });
    expect(profileExposure(null)).toEqual({ mode: 'continuous' });
  });
  it('snaps without floating noise', () => {
    expect(snap(0.34, { min: -2, max: 2, step: 1 / 3 })).toBeCloseTo(1 / 3, 5);
    expect(snap(7, { min: 0, max: 5 })).toBe(5);
  });
});

describe('errors', () => {
  it('classifies DOMException names into camera states', () => {
    expect(classifyError('NotAllowedError')).toBe('blocked');
    expect(classifyError('NotFoundError')).toBe('missing');
    expect(classifyError('OverconstrainedError')).toBe('missing');
    expect(classifyError('NotReadableError')).toBe('busy');
    expect(classifyError('ConsentRequired')).toBe('off');
    expect(classifyError('Whatever')).toBe('error');
  });
  it('uses the blueprint\'s words for a blocked camera (Section 10.5)', () => {
    expect(errorMessage('NotAllowedError', false)).toBe('Camera is blocked. Allow camera access in the address bar, then choose Try again.');
  });
  it('checks stored profiles loosely', () => {
    expect(isCameraProfile({ deviceId: 'a', width: 1, height: 1, exposureMode: 'manual' })).toBe(true);
    expect(isCameraProfile({ deviceId: 'a' })).toBe(false);
    expect(isCameraProfile(null)).toBe(false);
  });
});

describe('frameTimestamp', () => {
  it('prefers the camera\'s capture time, converted to the kernel clock', () => {
    expect(frameTimestamp({ captureTime: 960, expectedDisplayTime: 1016 }, 1000, 5000)).toEqual({ t: 4960, timeSource: 'capture' });
  });
  it('falls back to the expected display time, then the callback time', () => {
    expect(frameTimestamp({ captureTime: undefined, expectedDisplayTime: 1016 }, 1000, 1000)).toEqual({ t: 1016, timeSource: 'presented' });
    expect(frameTimestamp(null, 1000, 1000)).toEqual({ t: 1000, timeSource: 'callback' });
  });
  it('distrusts capture times that are far off', () => {
    expect(frameTimestamp({ captureTime: 10, expectedDisplayTime: 1010 }, 5000, 5000).timeSource).toBe('callback');
    expect(frameTimestamp({ captureTime: 1500, expectedDisplayTime: 1010 }, 1000, 1000).timeSource).toBe('presented');
  });
});
