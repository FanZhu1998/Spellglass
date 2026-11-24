// Capture (capture.camera): opens the camera, sets exposure, hands frames on (blueprint Section 7.1).
// The logic is in controller.ts; frames.ts drives the hidden video; camera-utils.ts holds the pure parts.

import type { Module, ModuleManifest } from '../../contracts';
import { browserBackend } from './backend';
import { CameraController, type CameraBackend } from './controller';

export const MANIFEST: ModuleManifest = {
  id: 'capture.camera',
  kind: 'capture',
  title: 'Camera',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['camera.frames@1'],
  requires: ['platform.camera'],
};

export function createCaptureModule(): Module {
  return buildCaptureModule((now) => browserBackend(now));
}

/** The capture module with its browser side injected (tests pass a fake camera). */
export function buildCaptureModule(makeBackend: (kernelNow: () => number) => CameraBackend): Module {
  let controller: CameraController | null = null;
  return {
    manifest: MANIFEST,
    async init(kernel) {
      controller = new CameraController(kernel, makeBackend(() => kernel.now()));
      // Requests from init(), so the stage and the trackers can ask from their start() on.
      controller.register();
    },
    async start() {
      controller?.begin();
    },
    async stop() {
      await controller?.end();
    },
  };
}

export type { CameraBackend } from './controller';
