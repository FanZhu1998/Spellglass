// The only place modules are wired together (Section 5). Everything else meets at the contracts.

import './ui/styles/index.css';
import { mount } from 'svelte';
import { ask, createKernel, logger } from './kernel';
import { REPLAY_HASH_KEY } from './contracts';
import { createStorageModule } from './modules/storage';
import { createCaptureModule } from './modules/capture';
import { createBrightTipTracker } from './modules/trackers/bright-tip';
import { createHandTracker } from './modules/trackers/hand';
import { createPointerTracker } from './modules/trackers/pointer';
import { createReplayTracker } from './modules/trackers/replay';
import { createStrokeModule } from './modules/stroke';
import { createTemplateRecognizer } from './modules/recognizers/template';
import { createVoiceModule } from './modules/voice';
import { createSpellEngine } from './modules/spell-engine';
import { createStageModule } from './modules/effects/stage';
import { createAudioModule } from './modules/effects/audio';
import { createShareModule } from './modules/share';
import { createDiagnosticsModule } from './modules/diagnostics';
import { AppState } from './ui/app-state.svelte';
import App from './ui/App.svelte';

const log = logger('main');
const base = import.meta.env.BASE_URL;

/** The desktop app (desktop/main.mjs) serves this build from app://spellglass/: offline by
 *  construction, with no address bar and no web address of its own. */
const desktop = location.protocol === 'app:';

/** What hands Spellglass on (the QR code, replay links): the web address it is served from, or for the
 *  desktop app the one set at build time (SPELLGLASS_WEB_URL), else '' and those are left out. */
const webUrl = desktop ? (import.meta.env.SPELLGLASS_WEB_URL ?? '') : new URL(base, location.href).href;

if (desktop) {
  // Electron has no speech service to listen with: no on-device language packs (Chrome downloads
  // those), and a session with the online one opens the microphone only to end in a network error.
  // So voice is absent here, as in a browser without Web Speech (Section 7.9).
  const g = globalThis as Record<string, unknown>;
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    try {
      delete g[name];
    } catch {
      /* not configurable: voice then reports what it finds */
    }
  }
}

async function boot(): Promise<void> {
  const kernel = createKernel();

  // The mirror: the stage draws into it, the pointer tracker listens on it, the shell places it.
  const mirror = document.createElement('div');
  mirror.className = 'mirror-surface';
  mirror.style.cssText = 'position:absolute;inset:0;';

  kernel.register(
    createStorageModule(),
    createCaptureModule(),
    createBrightTipTracker(),
    createHandTracker({ modelUrl: `${base}models/hand_landmarker.task`, wasmBaseUrl: `${base}models/wasm` }),
    createPointerTracker({ element: mirror }),
    createReplayTracker(),
    createStrokeModule(),
    createTemplateRecognizer(),
    createVoiceModule(),
    createSpellEngine(),
    createStageModule({ host: mirror }),
    createAudioModule(),
    createShareModule({ appUrl: webUrl }),
    createDiagnosticsModule(),
  );

  await kernel.init();
  await kernel.loadPacks(`${base}packs/index.json`);

  // Offline install and updates: prompt mode, so an update waits for the player (Section 9.4). The
  // desktop app needs neither: it carries its files, and a new version is a new download.
  let applyUpdate: (() => Promise<void>) | undefined;
  if (import.meta.env.PROD && !desktop && 'serviceWorker' in navigator) {
    try {
      const { registerSW } = await import('virtual:pwa-register');
      const updateSW = registerSW({
        immediate: true,
        onNeedRefresh: () => kernel.emit('app.update-ready', {}, 'shell'),
      });
      applyUpdate = () => updateSW(true);
    } catch (err) {
      log.warn('offline support unavailable', err);
    }
  }

  const app = new AppState(kernel, { mirror, applyUpdate, startModules: () => kernel.start(), appUrl: webUrl, desktop });

  // A replay link opens straight into the replay, with no camera needed (Section 11.1).
  const hash = location.hash.slice(1);
  if (new URLSearchParams(hash).has(REPLAY_HASH_KEY)) {
    app.replayHash = hash;
    app.screen = 'replay';
  } else if (!kernel.settings.get('app.onboarded', false)) {
    app.screen = 'threshold';
  }

  // A replay link opened in a tab where Spellglass already runs (pasted into the address bar, or
  // clicked in a page of the same app) is a same-document navigation: nothing reloads, so the hash is
  // read again whenever it changes.
  addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (!new URLSearchParams(next).has(REPLAY_HASH_KEY) || next === app.replayHash) return;
    app.replayHash = next;
    app.go('replay');
  });

  mount(App, { target: document.getElementById('app')!, props: { app } });

  // A read-only handle for diagnostics and end-to-end tests. It exposes nothing private.
  Object.defineProperty(window, '__spellglass', { value: Object.freeze({ kernel, app }), configurable: true });

  // Modules start at once. Nothing opens the camera before the Threshold screen has explained why:
  // capture refuses camera.start until the player gives 'capture.consent' (Section 11.2).
  await app.startModules();

  // The desktop app keeps the player's data in its own folder, and makes sure at once that nothing
  // clears it to free space (desktop/policy.mjs grants this quietly, as Chrome would). In a browser the
  // player asks for it in the Workshop, where the browser decides.
  if (desktop) void ask(kernel, 'storage.persist').catch(() => undefined);
}

boot().catch((err) => {
  log.error('Spellglass failed to start', err);
  const el = document.getElementById('app');
  if (el) {
    el.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'padding:2rem;font-family:Georgia,serif;color:#E9DFC7;background:#0F1424;';
    p.textContent = desktop ? 'Spellglass could not start. Close it and open it again.' : 'Spellglass could not start. Try reloading the page.';
    el.append(p);
  }
});
