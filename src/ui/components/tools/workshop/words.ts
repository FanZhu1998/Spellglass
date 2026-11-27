// Plain words for the Workshop (Section 10.5: flavor lives in names, instructions stay plain, sentence
// case). Pure functions over contract types, so every sentence is the same wherever it appears. Pack
// strings are untrusted: these only build text, which the screens render as text.

import type { CastingMode, ModuleKind, ModuleManifest, ModuleState, PackKind, StoreName, VoiceStatus } from '../../../../contracts';
import type { Note } from './types';

// ------------------------------------------------------------------------------------ casting modes

export interface ModeInfo {
  id: CastingMode;
  title: string;
  /** One plain line (Section 7.7). */
  line: string;
  /** needs: plays by gesture rules until voice works; uses: better with voice, fine without. */
  voice: 'needs' | 'uses' | 'none';
}

export const MODES: readonly ModeInfo[] = [
  { id: 'gesture', title: 'Gesture', line: 'The shape you trace casts the spell. For everyday play.', voice: 'none' },
  {
    id: 'assisted',
    title: 'Assisted',
    line: 'Say the incantation as you trace, and a rougher shape still casts that spell. For beginners, or when tracking is shaky.',
    voice: 'uses',
  },
  { id: 'strict', title: 'Strict', line: 'The shape you trace and the incantation you say must agree. For purists.', voice: 'needs' },
  { id: 'voice', title: 'Voice only', line: 'The spoken incantation alone casts the spell. For play without a wand in view.', voice: 'needs' },
];

export function modeInfo(id: string): ModeInfo {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

// ------------------------------------------------------------------------------------ voice

/** Voice can hear incantations right now. */
export function voiceUsable(v: VoiceStatus | null | undefined): boolean {
  return v?.state === 'ready' || v?.state === 'listening';
}

/** The voice status in words and shape, or null when there is nothing to say. */
export function voiceNote(v: VoiceStatus, enabled: boolean): Note | null {
  if (!enabled && (v.state === 'off' || v.state === 'ready' || v.state === 'listening')) return null;
  switch (v.state) {
    case 'off':
      return enabled ? { kind: 'busy', text: 'Voice is starting.' } : null;
    case 'unavailable':
      return { kind: 'warn', text: sentence(v.message) || 'Voice recognition is not available here, so voice stays off. Gesture play is not affected.' };
    case 'needs-download':
      return { kind: 'info', text: sentence(v.message) || 'Voice needs a one-time download of the speech pack for this language.' };
    case 'downloading':
      return { kind: 'busy', text: sentence(v.message) || 'Downloading the speech pack.' };
    case 'ready':
      return { kind: 'ok', text: v.local ? 'Voice is ready. What you say is recognized on this device.' : "Voice is ready, through the browser's online speech service." };
    case 'listening':
      return { kind: 'ok', text: sentence(v.message) || (v.local ? 'Listening on this device.' : "Listening through the browser's online speech service.") };
    case 'error':
      return { kind: 'error', text: sentence(v.message) || 'Voice stopped. Turn it off and on to try again.' };
    default:
      return null;
  }
}

/** The desktop app has no speech recognition at all (src/main.ts) and never opens the microphone
 *  (desktop/policy.mjs): its Voice section says so instead of offering a switch, and the casting modes
 *  that listen cannot be chosen there. */
export const DESKTOP_VOICE = {
  lede: 'Spells are cast by the shape you trace. The desktop app does not listen: it has no speech recognition, and it never uses the microphone.',
  status: 'Voice recognition is not available in the desktop app. To cast by voice, play Spellglass in Chrome or Edge.',
} as const;

/** The casting modes that listen (Assisted, Strict, Voice only): voice 'uses' or 'needs'. */
export function listens(mode: ModeInfo): boolean {
  return mode.voice !== 'none';
}

/** Where speech goes, for the Voice section's lede and the help under its switch (Sections 7.6 and
 *  11.2). The promise that speech stays on the device holds only while recognition is local: once the
 *  browser's online service is in use (status local: false) the words say so, and while it is allowed
 *  but not yet needed they say when it would be. */
export function voicePrivacy(v: VoiceStatus, allowCloud: boolean): { lede: string; help: string } {
  if (v.local === false) {
    return {
      lede: "Say the incantation as you cast. The browser's online speech service turns it into text, and Spellglass keeps no audio.",
      help: "The browser asks to use the microphone. What you say is sent to the browser's online speech service to be turned into text. Spellglass keeps no audio.",
    };
  }
  if (allowCloud) {
    return {
      lede: 'Say the incantation as you cast. Speech is recognized on this device where the browser can, and no audio is kept.',
      help: "The browser asks to use the microphone. What you say is turned into text on this computer where the browser can; where it cannot, it is sent to the browser's online speech service, as allowed below.",
    };
  }
  return {
    lede: 'Say the incantation as you cast. Speech is recognized on this device, and no audio is kept.',
    help: 'The browser asks to use the microphone. What you say is turned into text here and never leaves this computer.',
  };
}

// ------------------------------------------------------------------------------------ packs

export const KIND_LABEL: Record<PackKind, string> = {
  spellpack: 'Spell pack',
  themepack: 'Theme',
  gesturepack: 'Gesture pack',
};

/** Plain names for capabilities (the pack service words its spell reasons the same way). */
const CAPABILITY_NAMES: Record<string, string> = {
  'fx.light': 'light effects',
  'fx.particles': 'particle effects',
  'fx.props': 'the prop shelf',
  'fx.shapes': 'shape effects',
  'fx.scene': 'scene effects',
  'fx.text': 'writing on the glass',
  audio: 'sound',
  voice: 'voice recognition',
  recognition: 'gesture recognition',
  engine: 'the spell engine',
  storage: 'storage',
  'camera.frames': 'camera frames',
  'platform.camera': 'a camera',
  'platform.worker': 'background workers',
  'platform.offscreen-canvas': 'offscreen drawing',
  'platform.wasm': 'WebAssembly',
  'platform.audio': 'Web Audio',
  'platform.speech': 'speech recognition',
  'platform.speech-local': 'on-device speech recognition',
  'platform.pointer': 'pointer input',
  'platform.dom': 'a page to draw on',
  'platform.indexeddb': 'IndexedDB storage',
  'platform.media-recorder': 'video recording',
  'platform.webgl': 'WebGL',
};

export function capabilityName(cap: string): string {
  const at = cap.lastIndexOf('@');
  const name = at > 0 ? cap.slice(0, at) : cap;
  const version = at > 0 ? Number(cap.slice(at + 1)) : 1;
  const plain = CAPABILITY_NAMES[name] ?? name;
  return Number.isFinite(version) && version > 1 ? `${plain} (version ${version})` : plain;
}

/** "Needs scene effects, which this edition does not have." (Worded so that one name or several, plural
 *  nouns or not, read the same.) */
export function needsText(unmet: readonly string[]): string {
  const names = [...new Set(unmet.map(capabilityName))];
  if (!names.length) return '';
  return `Needs ${joinAnd(names)}, which this edition does not have.`;
}

/**
 * One announcement for a batch of dropped or chosen files (Section 10.6), so a screen reader hears what
 * became of every file and not only of the last one read. One file keeps its own sentence; several are
 * counted, and the files that were not imported are named (their reasons are listed on the Packs tab).
 * A data export in the batch waits on Your data, and the announcement says so.
 */
export function batchSummary(batch: { results: readonly { filename: string; ok: boolean; title?: string; error?: string }[]; data: string | null }): string {
  const { results, data } = batch;
  const parts: string[] = [];
  if (results.length === 1) {
    const r = results[0];
    parts.push(r.ok ? `Imported ${r.title ?? r.filename}.` : `${r.filename} was not imported.${r.error ? ` ${sentence(r.error)}` : ''}`);
  } else if (results.length > 1) {
    const failed = results.filter((r) => !r.ok).map((r) => r.filename);
    const done = results.length - failed.length;
    if (!failed.length) parts.push(results.length === 2 ? 'Imported both files.' : `Imported all ${results.length} files.`);
    else {
      if (done > 0) parts.push(`Imported ${done} of ${results.length} files.`);
      parts.push(`${joinAnd(failed)} ${failed.length === 1 ? 'was' : 'were'} not imported.`);
    }
  }
  if (data !== null) parts.push(`${data} is a data file: confirm its import on Your data.`);
  return parts.join(' ');
}

// ------------------------------------------------------------------------------------ modules

export const KIND_WORD: Partial<Record<ModuleKind, string>> = {
  tracker: 'Tracker',
  segmenter: 'Strokes',
  recognizer: 'Recognizer',
  voice: 'Voice',
  engine: 'Spell engine',
  effect: 'Effects',
  scene: 'Scene',
  share: 'Sharing',
  storage: 'Storage',
  capture: 'Camera',
  diagnostics: 'Diagnostics',
};

export interface ModuleRow {
  manifest: ModuleManifest;
  state: ModuleState;
  reason?: string;
}

export interface ModuleView {
  /** ok: running; info: idle by design; warn: stopped; error: failed or unavailable. */
  kind: 'ok' | 'info' | 'warn' | 'error';
  word: string;
  reason?: string;
  /** Restart makes sense for it. */
  restartable: boolean;
}

/** One module's state in words. Trackers other than the active one are idle by design. `home` names
 *  where Spellglass runs, for what it lacks: "this browser", or "the desktop app". */
export function moduleView(m: ModuleRow, activeTracker: string, home = 'this browser'): ModuleView {
  const isTracker = m.manifest.kind === 'tracker';
  const isActive = !isTracker || m.manifest.id === activeTracker;
  const reason = m.reason ? reasonText(m.reason, home) : undefined;
  switch (m.state) {
    case 'running':
      return { kind: 'ok', word: 'Running', restartable: true };
    case 'initialized':
    case 'stopped':
      if (!isActive) return { kind: 'info', word: 'Not in use', restartable: false };
      return m.state === 'stopped' ? { kind: 'warn', word: 'Stopped', reason, restartable: true } : { kind: 'info', word: 'Ready', restartable: true };
    case 'registered':
      return { kind: 'info', word: 'Waiting to start', restartable: false };
    case 'unavailable':
      return { kind: 'info', word: 'Not available here', reason, restartable: false };
    case 'error':
      return { kind: 'error', word: 'Stopped with an error', reason, restartable: isActive };
    default:
      return { kind: 'info', word: String(m.state), reason, restartable: false };
  }
}

/** A module reason as a sentence: "needs platform.speech" becomes "Needs speech recognition, which this
 *  browser does not have." (or "which the desktop app does not have."); anything else gets a capital
 *  and a full stop. */
export function reasonText(reason: string, home = 'this browser'): string {
  const needs = /^needs\s+(.+)$/i.exec(reason.trim());
  if (needs) {
    const names = [...new Set(needs[1].split(/\s*,\s*/).filter(Boolean).map(capabilityName))];
    return `Needs ${joinAnd(names)}, which ${home} does not have.`;
  }
  return sentence(reason);
}

// ------------------------------------------------------------------------------------ your data

/** The storage lines of Your data. In a browser the browser keeps the data and may be asked to keep it
 *  for good (navigator.storage.persist()); the desktop app keeps it in its own folder on the computer
 *  and asks by itself (src/main.ts), so its words name no browser. */
export function storageWords(desktop: boolean) {
  if (desktop) {
    return {
      keptLabel: 'Safe when space runs low',
      keptYes: 'it is never cleared to free space.',
      keptNo: 'Not promised: it may be cleared if space runs very low.',
      space: (used: string, quota: string) => `${used} of the ${quota} Spellglass may use on this computer`,
      spaceUnknown: 'Not reported',
      keepHelp: 'Makes sure Spellglass’s data is kept even when space runs low.',
      keptOk: 'Your data will be kept, even when space runs low.',
      keptNot: 'That could not be made sure of yet. Try again later.',
      keepError: 'Spellglass could not ask for its data to be kept.',
      moveLede: 'Move your progress, drawings and settings to another computer or to Spellglass in a browser, or keep a copy.',
    };
  }
  return {
    keptLabel: 'Kept by the browser',
    keptYes: 'the browser will not clear it to free space.',
    keptNo: 'Not promised: the browser may clear it if space runs very low.',
    space: (used: string, quota: string) => `${used} of the ${quota} this browser allows`,
    spaceUnknown: 'Not reported by this browser',
    keepHelp: 'Asks the browser to keep Spellglass’s data even when space runs low.',
    keptOk: 'The browser will keep your data, even when space runs low.',
    keptNot: 'The browser did not promise to keep it yet. Browsers usually agree once Spellglass is installed or used often.',
    keepError: 'The browser could not be asked to keep the data.',
    moveLede: 'Move your progress, drawings and settings to another browser or computer, or keep a copy.',
  };
}

export const STORE_WORDS: Record<StoreName, [one: string, many: string]> = {
  profiles: ['camera profile', 'camera profiles'],
  samples: ['learned stroke', 'learned strokes'],
  overrides: ['redrawn gesture', 'redrawn gestures'],
  progress: ['spell’s progress', 'spells’ progress'],
  keepsakes: ['keepsake', 'keepsakes'],
  packs: ['imported pack', 'imported packs'],
  sessions: ['recorded session', 'recorded sessions'],
  kv: ['other value', 'other values'],
};

/** "Imported 3 redrawn gestures, 12 spells’ progress and 5 settings." */
export function importSummary(r: { imported: Partial<Record<StoreName, number>>; settings: number }): string {
  const parts: string[] = [];
  for (const [store, n] of Object.entries(r.imported) as [StoreName, number][]) {
    if (!n || n < 1 || store === 'kv') continue;
    const [one, many] = STORE_WORDS[store] ?? [store, store];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (r.settings > 0) parts.push(`${r.settings} ${r.settings === 1 ? 'setting' : 'settings'}`);
  if (!parts.length) return 'Nothing new to import: everything in the file is already here, or newer here.';
  return `Imported ${joinAnd(parts)}.`;
}

// ------------------------------------------------------------------------------------ helpers

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  const list = items.filter((x) => x.length > 0);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** A capital first letter and a full stop. */
export function sentence(text: string | undefined | null): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const capital = t[0].toUpperCase() + t.slice(1);
  return /[.!?:]$/.test(capital) ? capital : `${capital}.`;
}

/** 0.64 as "64%". */
export function alike(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}
