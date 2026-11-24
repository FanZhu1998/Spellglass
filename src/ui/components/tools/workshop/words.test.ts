import { describe, expect, it } from 'vitest';
import type { ModuleManifest, VoiceStatus } from '../../../../contracts';
import { sniff } from './imports.svelte';
import { recording } from './recording.svelte';
import {
  alike, batchSummary, capabilityName, DESKTOP_VOICE, importSummary, joinAnd, listens, modeInfo, MODES, moduleView, needsText, reasonText, sentence,
  storageWords, voiceNote, voicePrivacy, voiceUsable,
} from './words';

const manifest = (id: string, kind: ModuleManifest['kind'], title?: string): ModuleManifest => ({ id, kind, version: '1.0.0', contract: '^1.1', provides: [], title });

describe('casting modes', () => {
  it('lists the four modes of Section 7.7, each with one plain line', () => {
    expect(MODES.map((m) => m.id)).toEqual(['gesture', 'assisted', 'strict', 'voice']);
    for (const m of MODES) expect(m.line).toMatch(/^[A-Z].*\.$/);
  });

  it('marks strict and voice only as needing voice', () => {
    expect(MODES.filter((m) => m.voice === 'needs').map((m) => m.id)).toEqual(['strict', 'voice']);
    expect(modeInfo('assisted').voice).toBe('uses');
    expect(modeInfo('nonsense').id).toBe('gesture');
  });
});

describe('voice', () => {
  const status = (s: Partial<VoiceStatus>): VoiceStatus => ({ state: 'off', local: true, ...s });

  it('is usable only while ready or listening', () => {
    expect(voiceUsable(status({ state: 'ready' }))).toBe(true);
    expect(voiceUsable(status({ state: 'listening' }))).toBe(true);
    expect(voiceUsable(status({ state: 'needs-download' }))).toBe(false);
    expect(voiceUsable(null)).toBe(false);
  });

  it('says nothing while off and not wanted', () => {
    expect(voiceNote(status({ state: 'off' }), false)).toBeNull();
  });

  it('keeps the module’s own sentence, as a sentence, with a shape that matches', () => {
    expect(voiceNote(status({ state: 'error', message: 'microphone is blocked' }), true)).toEqual({ kind: 'error', text: 'Microphone is blocked.' });
    expect(voiceNote(status({ state: 'downloading' }), true)?.kind).toBe('busy');
    expect(voiceNote(status({ state: 'ready', local: false }), true)?.text).toMatch(/online speech service/);
  });

  // Sections 7.6 and 11.2: the section never promises on-device speech while the online service is in use.
  it('says where speech goes: on this device, or to the online service once it is in use', () => {
    const local = voicePrivacy(status({ state: 'listening', local: true }), false);
    expect(local.lede).toMatch(/recognized on this device/);
    expect(local.help).toMatch(/never leaves this computer/);

    for (const v of [status({ state: 'listening', local: false }), status({ state: 'ready', local: false })]) {
      const online = voicePrivacy(v, true);
      expect(`${online.lede} ${online.help}`).not.toMatch(/on this device|never leaves/);
      expect(online.help).toMatch(/sent to the browser's online speech service/);
      expect(online.help).toMatch(/Spellglass keeps no audio\.$/);
    }
  });

  it('says when speech would go online while that is allowed but not in use', () => {
    const allowed = voicePrivacy(status({ state: 'off', local: true }), true);
    expect(allowed.help).not.toMatch(/never leaves/);
    expect(allowed.help).toMatch(/where it cannot, it is sent to the browser's online speech service/);
  });
});

describe('packs', () => {
  it('names capabilities plainly, keeping a version above 1', () => {
    expect(capabilityName('fx.scene@1')).toBe('scene effects');
    expect(capabilityName('audio@2')).toBe('sound (version 2)');
    expect(capabilityName('fx.weather@1')).toBe('fx.weather');
  });

  it('words unmet needs so that one or several read correctly', () => {
    expect(needsText(['fx.scene@1'])).toBe('Needs scene effects, which this edition does not have.');
    expect(needsText(['audio@1', 'fx.light@1', 'audio@1'])).toBe('Needs sound and light effects, which this edition does not have.');
    expect(needsText([])).toBe('');
  });
});

describe('modules', () => {
  it('turns a "needs" reason into a sentence about the browser', () => {
    expect(reasonText('needs platform.speech')).toBe('Needs speech recognition, which this browser does not have.');
    expect(reasonText('speaks contract ^2.0; this kernel is 1.1')).toBe('Speaks contract ^2.0; this kernel is 1.1.');
  });

  it('treats trackers other than the active one as idle by design', () => {
    const hand = { manifest: manifest('tracker.hand', 'tracker'), state: 'stopped' as const };
    expect(moduleView(hand, 'tracker.pointer')).toMatchObject({ kind: 'info', word: 'Not in use', restartable: false });
    expect(moduleView({ ...hand, state: 'error', reason: 'boom' }, 'tracker.hand')).toMatchObject({ kind: 'error', restartable: true, reason: 'Boom.' });
  });

  it('offers a restart for running and stopped modules, not for unavailable ones', () => {
    const voice = manifest('voice.web-speech', 'voice', 'Voice');
    expect(moduleView({ manifest: voice, state: 'running' }, '').restartable).toBe(true);
    expect(moduleView({ manifest: voice, state: 'stopped' }, '')).toMatchObject({ kind: 'warn', restartable: true });
    expect(moduleView({ manifest: voice, state: 'unavailable', reason: 'needs platform.speech' }, '')).toMatchObject({
      restartable: false,
      reason: 'Needs speech recognition, which this browser does not have.',
    });
  });

  it('names the desktop app, not a browser, for what the desktop app lacks', () => {
    const voice = manifest('voice.web-speech', 'voice', 'Voice');
    expect(reasonText('needs platform.speech', 'the desktop app')).toBe('Needs speech recognition, which the desktop app does not have.');
    expect(moduleView({ manifest: voice, state: 'unavailable', reason: 'needs platform.speech' }, '', 'the desktop app').reason).toBe(
      'Needs speech recognition, which the desktop app does not have.',
    );
  });
});

describe('the desktop app without voice', () => {
  it('shuts exactly the modes that listen', () => {
    expect(MODES.filter(listens).map((m) => m.id)).toEqual(['assisted', 'strict', 'voice']);
  });

  it('says plainly that it does not listen, and names no switch or browser prompt', () => {
    const text = `${DESKTOP_VOICE.lede} ${DESKTOP_VOICE.status}`;
    expect(text).toMatch(/never uses the microphone/);
    expect(text).not.toMatch(/asks to use the microphone|recognized on this device|Listen for/);
  });
});

describe('your data', () => {
  it('summarizes an import in words, leaving out internal values', () => {
    expect(importSummary({ imported: { overrides: 3, progress: 1, kv: 1 }, settings: 5 })).toBe('Imported 3 redrawn gestures, 1 spell’s progress and 5 settings.');
    expect(importSummary({ imported: {}, settings: 0 })).toMatch(/^Nothing new to import/);
  });

  it('words storage for a computer in the desktop app, and for the browser elsewhere', () => {
    const desktop = storageWords(true);
    const web = storageWords(false);
    const all = (w: ReturnType<typeof storageWords>) => [w.keptLabel, w.keptYes, w.keptNo, w.space('11 KB', '145 GB'), w.spaceUnknown, w.keepHelp, w.keptOk, w.keptNot, w.keepError].join(' ');
    expect(all(desktop)).not.toMatch(/browser/i);
    expect(desktop.space('11 KB', '145 GB')).toBe('11 KB of the 145 GB Spellglass may use on this computer');
    // Moving data between the desktop app and the web version is the one place a browser belongs.
    expect(desktop.moveLede).toMatch(/another computer or to Spellglass in a browser/);
    expect(web.keptLabel).toBe('Kept by the browser');
    expect(web.space('11 KB', '145 GB')).toBe('11 KB of the 145 GB this browser allows');
  });
});

describe('dropped files', () => {
  it('tells a data export and a recorded session from a pack', () => {
    expect(sniff(JSON.stringify({ schema: 'spellglass-data/1' }))).toBe('data');
    expect(sniff(`﻿${JSON.stringify({ schema: 'session/1' })}`)).toBe('session');
    expect(sniff(JSON.stringify({ schema: 'spellpack/1' }))).toBe('pack');
    expect(sniff('{ not json')).toBe('pack');
  });

  const ok = (filename: string, title: string) => ({ filename, ok: true, title });
  const no = (filename: string, error = 'This file is not JSON.') => ({ filename, ok: false, error });

  it('announces one file in its own sentence', () => {
    expect(batchSummary({ results: [ok('a.json', 'Early charms')], data: null })).toBe('Imported Early charms.');
    expect(batchSummary({ results: [no('a.json', 'this file is not JSON')], data: null })).toBe('a.json was not imported. This file is not JSON.');
    expect(batchSummary({ results: [], data: 'mine.json' })).toBe('mine.json is a data file: confirm its import on Your data.');
  });

  // Access (Section 10.6): a screen reader hears every outcome of a batch, not only the last file read.
  it('counts a batch and names every file that was not imported', () => {
    const four = [no('broken.json'), ok('needs-pack.json', 'Needs'), ok('legacy.json', 'Early charms'), no('session.json')];
    expect(batchSummary({ results: four, data: null })).toBe('Imported 2 of 4 files. broken.json and session.json were not imported.');
    expect(batchSummary({ results: [no('broken2.json'), ok('legacy2.json', 'Early charms')], data: null })).toBe('Imported 1 of 2 files. broken2.json was not imported.');
    expect(batchSummary({ results: [no('a.json'), no('b.json')], data: null })).toBe('a.json and b.json were not imported.');
    expect(batchSummary({ results: [ok('a.json', 'A'), ok('b.json', 'B')], data: null })).toBe('Imported both files.');
    expect(batchSummary({ results: [ok('a.json', 'A'), ok('b.json', 'B'), ok('c.json', 'C')], data: null })).toBe('Imported all 3 files.');
  });

  it('points to Your data when a data export came with the packs', () => {
    expect(batchSummary({ results: [ok('legacy.json', 'Early charms')], data: 'spellglass-data-2026-11-22.json' })).toBe(
      'Imported Early charms. spellglass-data-2026-11-22.json is a data file: confirm its import on Your data.',
    );
  });
});

describe('recording', () => {
  it('moves to the next spell in order, wrapping round', () => {
    expect(recording.nextOf([])).toBeNull();
    expect(recording.nextOf(['lumos', 'nox'])).toBe('lumos');
    recording.intended = 'lumos';
    expect(recording.nextOf(['lumos', 'nox'])).toBe('nox');
    recording.intended = 'nox';
    expect(recording.nextOf(['lumos', 'nox'])).toBe('lumos');
    recording.intended = null;
  });
});

describe('helpers', () => {
  it('joins, punctuates and rounds', () => {
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(sentence('  the tracker stopped ')).toBe('The tracker stopped.');
    expect(sentence('Done!')).toBe('Done!');
    expect(alike(0.6449)).toBe('64%');
    expect(alike(1.2)).toBe('100%');
  });
});
