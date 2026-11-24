// The browser side of capture: getUserMedia, device and permission events, and the frame pump.
// Everything is touched inside the functions, never at import time, so Node can import the module.

import type { CameraStatus } from '../../contracts';
import type { CameraBackend } from './controller';
import { FramePump } from './frames';

export function browserBackend(kernelNow: () => number): CameraBackend {
  const media = () => {
    const md = globalThis.navigator?.mediaDevices;
    if (!md) throw Object.assign(new Error('This browser cannot open a camera here (it needs HTTPS).'), { name: 'NotSupportedError' });
    return md;
  };
  return {
    getUserMedia: (constraints) => media().getUserMedia(constraints),
    enumerateDevices: async () => (await media().enumerateDevices()).map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind })),
    watchDevices(fn) {
      const md = globalThis.navigator?.mediaDevices;
      if (!md?.addEventListener) return () => undefined;
      md.addEventListener('devicechange', fn);
      return () => md.removeEventListener('devicechange', fn);
    },
    watchPermission(fn) {
      let status: PermissionStatus | null = null;
      let cancelled = false;
      const onChange = () => {
        if (status) fn(permissionState(status.state));
      };
      // Not every browser knows the 'camera' permission name (it throws): then it stays 'unknown'.
      (async () => {
        try {
          const q = globalThis.navigator?.permissions?.query;
          if (typeof q !== 'function') return;
          status = await navigator.permissions.query({ name: 'camera' as PermissionName });
          if (cancelled) return;
          fn(permissionState(status.state));
          status.addEventListener('change', onChange);
        } catch {
          if (!cancelled) fn('unknown');
        }
      })();
      return () => {
        cancelled = true;
        status?.removeEventListener('change', onChange);
      };
    },
    createPump: (onFrame) => new FramePump(onFrame, kernelNow),
  };
}

function permissionState(s: PermissionState): CameraStatus['permission'] {
  return s === 'granted' || s === 'prompt' || s === 'denied' ? s : 'unknown';
}
