// Voice (voice.web-speech): spoken incantations through the Web Speech API (Sections 7.6 and 11.2).
//
// Off unless the player turns on 'voice.enabled'. On-device recognition first (processLocally, after
// SpeechRecognition.available() confirms the language pack); the browser's online service only when
// on-device recognition is unavailable and the player has opted in with 'voice.allowCloud'.
// Continuous recognition with interim results; the enabled incantations go in as phrase hints, and a
// fuzzy matcher against each spell's incantation and heard_as list decides the spell (fuzzy.ts).
//
// Inputs:   settings voice.*; sticky spellbook.changed.
// Outputs:  voice.status (sticky), voice.incantation.
// Requests: voice.install (download the on-device language pack; call it straight from a click).
//
// The pieces: speech.ts (API declarations and detection), controller.ts (when and how to listen),
// heard.ts (results to incantations, timing), fuzzy.ts (the matcher). All but this file are tested
// in Node without a browser.

import type { Kernel, Module, ModuleManifest } from '../../contracts';
import { emit, lastPayload, on, serve, setting } from '../../kernel';
import { VoiceController, type VoiceEnv, type VoiceSettings } from './controller';
import { detectSpeech, type SpeechApi, type SpeechQuality } from './speech';

export const MANIFEST: ModuleManifest = {
  id: 'voice.web-speech',
  kind: 'voice',
  title: 'Voice',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['voice@1'],
  requires: ['platform.speech'],
};

const VOICE_KEYS = ['voice.enabled', 'voice.allowCloud', 'voice.lang', 'voice.minConf', 'voice.phraseBoost', 'voice.quality'];
const QUALITIES: readonly SpeechQuality[] = ['command', 'dictation', 'conversation'];
/** BCP 47 shape, loosely: 'en', 'en-US', 'zh-Hant-TW'. */
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

/** Test seams. The app uses the defaults. */
export interface VoiceModuleDeps {
  /** The Web Speech API, or null where there is none (default: detected on globalThis). */
  speech?: () => SpeechApi | null;
  watchMicrophone?: VoiceEnv['watchMicrophone'];
  watchDevices?: VoiceEnv['watchDevices'];
}

export function createVoiceModule(): Module {
  return createVoiceModuleWith();
}

export function createVoiceModuleWith(deps: VoiceModuleDeps = {}): Module {
  let kernel: Kernel | null = null;
  let controller: VoiceController | null = null;
  let subs: (() => void)[] = [];

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      const env: VoiceEnv = {
        now: () => k.now(),
        speech: deps.speech ?? (() => detectSpeech(globalThis)),
        settings: () => readSettings(k),
        spellbook: () => lastPayload(k, 'spellbook.changed') ?? null,
        status: (s) => emit(k, MANIFEST.id, 'voice.status', s),
        incantation: (i) => emit(k, MANIFEST.id, 'voice.incantation', i),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        watchMicrophone: deps.watchMicrophone ?? watchMicrophonePermission,
        watchDevices: deps.watchDevices ?? watchAudioDevices,
      };
      const c = new VoiceController(env);
      controller = c;
      // Served from init, so the shell can offer the download before voice is even turned on.
      serve(k, 'voice.install', () => c.install());
    },

    async start() {
      const k = kernel;
      const c = controller;
      if (!k || !c) return;
      subs.push(
        on(k, 'settings.changed', ({ key }) => {
          if (VOICE_KEYS.includes(key)) c.sync();
        }),
        on(k, 'spellbook.changed', () => c.sync()),
      );
      // Never waits: availability checks and the microphone run in the background.
      c.start();
    },

    async stop() {
      for (const off of subs) off();
      subs = [];
      controller?.stop();
    },
  };
}

function readSettings(k: Kernel): VoiceSettings {
  const lang = setting(k, 'voice.lang');
  const quality = setting(k, 'voice.quality') as SpeechQuality;
  return {
    enabled: setting(k, 'voice.enabled') === true,
    allowCloud: setting(k, 'voice.allowCloud') === true,
    lang: typeof lang === 'string' && LANG.test(lang) ? lang : 'en-US',
    minConf: clamp(num(setting(k, 'voice.minConf'), 0.55), 0, 1),
    // SpeechRecognitionPhrase throws outside 0..10.
    phraseBoost: clamp(num(setting(k, 'voice.phraseBoost'), 5), 0, 10),
    quality: QUALITIES.includes(quality) ? quality : 'command',
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Call fn once the microphone permission turns to 'granted' (recovery after "Microphone is blocked"). */
function watchMicrophonePermission(fn: () => void): (() => void) | null {
  const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
  if (!perms || typeof perms.query !== 'function') return null;
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const onChange = () => {
    if (status?.state === 'granted') fn();
  };
  perms.query({ name: 'microphone' as PermissionName }).then(
    (s) => {
      if (cancelled) return;
      status = s;
      s.addEventListener('change', onChange);
    },
    () => {},
  );
  return () => {
    cancelled = true;
    status?.removeEventListener('change', onChange);
  };
}

/** Call fn when audio devices change (a microphone plugged in after "No microphone found"). */
function watchAudioDevices(fn: () => void): (() => void) | null {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.addEventListener !== 'function') return null;
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}
