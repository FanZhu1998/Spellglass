<script lang="ts">
  // The status area on the frame (Section 10.3: "camera on  wand found  mic"): the camera, the
  // tracker, the microphone (a toggle while voice is in use) and storage when it cannot save
  // (Section 7.9: "Runs without saving and says so"). Each chip has a shape as well as a color.
  import type { AppState } from '../app-state.svelte';
  import { ask } from '../../kernel';
  import { cameraChip, cameraWanted } from './shell/routes';

  let { app }: { app: AppState } = $props();

  /** The player switched the mic off here this session: keep the toggle so it can come back on. */
  let micTouched = $state(false);

  /** A camera problem shows only while something wants the camera, as on the mirror's notes. */
  const camera = $derived(cameraChip(app.camera, cameraWanted(app.settings), app.cameraReady?.infrared === true));

  const tip = $derived.by(() => {
    const t = app.tracker;
    if (!t) return null;
    if (t.tracker === 'tracker.pointer') return { state: 'on', text: 'mouse or touch' };
    if (t.tracker === 'tracker.replay') return { state: 'on', text: 'replaying' };
    const what = t.tracker === 'tracker.hand' ? 'hand' : 'wand';
    if (t.state === 'loading' && t.tracker === 'tracker.hand') {
      const p = typeof t.progress === 'number' ? Math.round(Math.max(0, Math.min(1, t.progress)) * 100) : null;
      return { state: 'warn', text: p !== null && p < 90 ? `hand model ${p}%` : 'hand model starting' };
    }
    // A camera tracker cannot start while the camera is blocked, missing or busy: say what it waits for.
    const cam = app.camera?.state;
    if ((t.state === 'starting' || t.state === 'searching') && (cam === 'blocked' || cam === 'missing' || cam === 'busy' || cam === 'error')) {
      return { state: 'off', text: 'waiting for the camera' };
    }
    if (t.state === 'loading' || t.state === 'starting') return { state: 'warn', text: `${what} tracker starting` };
    if (t.state === 'stopped') return { state: 'off', text: `${what} tracker off` };
    if (t.state === 'error') return { state: 'error', text: `${what} tracker stopped` };
    // Found or not, a hand that small is followed badly: the mirror's note says what to do.
    if (t.hint === 'hand-too-small') return { state: 'warn', text: 'hand looks small' };
    if (t.state === 'tracking') return { state: 'on', text: `${what} found` };
    if (t.hint === 'tip-not-found' || t.hint === 'hand-not-found') return { state: 'warn', text: `${what} not found` };
    if (t.hint === 'too-many-lights') return { state: 'warn', text: 'too many bright lights' };
    return { state: 'off', text: `looking for ${what}` };
  });

  const voiceOn = $derived(app.settings['voice.enabled'] === true);

  const mic = $derived.by(() => {
    if (!voiceOn && !micTouched) return null;
    if (!voiceOn) return { state: 'off', text: 'mic off' };
    const v = app.voice;
    switch (v.state) {
      case 'listening':
        return { state: 'on', text: v.local ? 'mic on, on this device' : 'mic on, online' };
      case 'ready':
        return { state: 'on', text: 'mic ready' };
      case 'error':
      case 'unavailable':
        return { state: 'error', text: 'voice unavailable' };
      case 'needs-download':
        return { state: 'warn', text: 'voice pack needed' };
      case 'downloading':
        return { state: 'warn', text: 'voice pack downloading' };
      default:
        return { state: 'warn', text: 'mic starting' };
    }
  });

  const storage = $derived.by(() => {
    const s = app.storage;
    if (!s || s.persistent) return null;
    const why: Record<string, string> = { blocked: 'storage blocked', full: 'storage full', closed: 'storage closed', unsupported: 'no storage' };
    return {
      text: `not saving: ${why[s.reason ?? ''] ?? 'storage unavailable'}`,
      message: s.message ?? 'Storage cannot be used, so Spellglass runs without saving.',
    };
  });

  async function toggleMic() {
    micTouched = true;
    await app.set('voice.enabled', !voiceOn);
  }

  function installVoice() {
    // Straight from the click: the download needs the click's user activation.
    ask(app.kernel, 'voice.install').then(
      (r) => {
        if (!r.ok && r.message) app.notify(r.message, 'warn');
      },
      () => app.notify('The speech pack could not be downloaded. Try again later.', 'warn'),
    );
  }
</script>

<ul class="chips" aria-label="Status">
  <li class="chip" data-state={camera.state}>{camera.text}</li>
  {#if tip}<li class="chip" data-state={tip.state}>{tip.text}</li>{/if}
  {#if mic}
    <li>
      <button
        class="chip chip-button"
        data-state={mic.state}
        aria-pressed={voiceOn}
        aria-label="Microphone: {mic.text}. {voiceOn ? 'Turn voice off' : 'Turn voice on'}"
        title={voiceOn ? 'Turn voice off' : 'Turn voice on'}
        onclick={toggleMic}
      >{mic.text}</button>
    </li>
    {#if voiceOn && app.voice.state === 'needs-download'}
      <li><button class="chip chip-button" data-state="warn" onclick={installVoice}>download voice pack</button></li>
    {/if}
  {/if}
  {#if storage}
    <li>
      <button class="chip chip-button" data-state="warn" title={storage.message} aria-label="{storage.text}. {storage.message}" onclick={() => app.notify(storage.message, 'warn')}>
        {storage.text}
      </button>
    </li>
  {/if}
</ul>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chips > li:not(.chip) {
    display: flex;
  }
</style>
