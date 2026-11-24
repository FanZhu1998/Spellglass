<script lang="ts">
  // Settings (Section 10.4 Workshop): how spells are cast (Section 7.7), voice (Section 7.6), staged
  // unlocking, access (Section 10.6), sound, and the look (house accents, Section 10.2; stage quality).
  // Every value is a kernel setting: read from app.settings, written with app.set().
  import type { CastingMode, SettingsMap } from '../../../../contracts';
  import { ask } from '../../../../kernel';
  import type { AppState } from '../../../app-state.svelte';
  import StatusLine from '../StatusLine.svelte';
  import ToolSection from '../ToolSection.svelte';
  import { errorText } from '../format';
  import { isSeated, isWholeView } from '../play-area';
  import AccentChoice, { type AccentOption } from './AccentChoice.svelte';
  import ModeChoice from './ModeChoice.svelte';
  import { radioKeys } from './keys';
  import type { Announce, Note } from './types';
  import { DESKTOP_VOICE, listens, modeInfo, voiceNote, voicePrivacy, voiceUsable } from './words';

  let { app, announce }: { app: AppState; announce: Announce } = $props();

  /** Write a setting and say what changed; a refusal is said too. */
  function set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K], said?: string): void {
    app.set(key, value).then(
      () => said && announce(said),
      (err) => announce(errorText(err, 'That setting could not be changed.')),
    );
  }

  // ------------------------------------------------------------------ casting mode
  const mode = $derived(app.settings['engine.mode']);
  const voiceOn = $derived(app.settings['voice.enabled'] === true);
  const voiceOk = $derived(voiceUsable(app.voice));
  const voiceModule = $derived(app.modules.find((m) => m.manifest.kind === 'voice'));
  const voiceMissing = $derived(!voiceModule || voiceModule.state === 'unavailable' || (voiceModule.state === 'error' && !voiceOn));
  /** Where voice is missing: the desktop app has no speech service at all (src/main.ts). */
  const voiceHome = $derived(app.desktop ? 'the desktop app' : 'this browser');

  const modeNote = $derived.by((): Note | null => {
    const m = modeInfo(mode);
    if (m.voice === 'none' || voiceOk) return null;
    // A mode that listens, chosen before (or imported from a browser): the desktop app casts by gesture.
    if (app.desktop && listens(m)) {
      const who = m.id === 'voice' ? 'Voice only' : `${m.title} mode`;
      return { kind: 'warn', text: `${who} needs voice, which the desktop app does not offer. Spells are cast by gesture instead.` };
    }
    if (m.voice === 'uses') {
      return { kind: 'info', text: voiceOn ? 'Assisted mode listens once voice is working. Until then it plays like Gesture.' : 'Assisted mode listens when voice is on. Until then it plays like Gesture.' };
    }
    const who = m.id === 'voice' ? 'Voice only' : 'Strict mode';
    if (voiceMissing) return { kind: 'warn', text: `${who} needs voice, which ${voiceHome} does not offer. Spells are cast by gesture instead.` };
    return voiceOn
      ? { kind: 'warn', text: `${who} needs voice, which is not working yet: see Voice below. Until it is, spells are cast by gesture.` }
      : { kind: 'warn', text: `${who} needs voice. Until voice is on, spells are cast by gesture.` };
  });

  function chooseMode(m: CastingMode): void {
    set('engine.mode', m, `${modeInfo(m).title} chosen.`);
  }

  // ------------------------------------------------------------------ voice
  const vNote = $derived(voiceMissing ? null : voiceNote(app.voice, voiceOn));
  /** The section's own words follow where speech goes, so they never contradict the online notice. */
  const privacy = $derived(voicePrivacy(app.voice, app.settings['voice.allowCloud'] === true));
  const cloudOffered = $derived(app.settings['voice.allowCloud'] === true || (voiceOn && app.voice.cloud === 'available'));
  let installing = $state(false);
  let installNote = $state<Note | null>(null);

  function setVoice(on: boolean): void {
    installNote = null;
    set('voice.enabled', on, on ? 'Voice is on.' : 'Voice is off.');
  }

  function downloadVoice(): void {
    // Straight from the click, with nothing awaited first: install() needs the click's activation.
    const pending = ask(app.kernel, 'voice.install');
    installing = true;
    installNote = null;
    pending.then(
      (r) => {
        installNote = r.ok ? { kind: 'ok', text: 'The speech pack is downloaded. Voice starts now.' } : { kind: 'warn', text: r.message ?? 'The speech pack could not be downloaded. Try again later.' };
        announce(installNote.text);
      },
      (err) => {
        installNote = { kind: 'error', text: errorText(err, 'The speech pack could not be downloaded. Try again later.') };
        announce(installNote.text);
      },
    ).finally(() => (installing = false));
  }

  // ------------------------------------------------------------------ spells
  const openCount = $derived(app.spellbook?.spells.filter((e) => e.enabled).length ?? 0);
  const availableCount = $derived(app.spellbook?.spells.filter((e) => e.available).length ?? 0);

  // ------------------------------------------------------------------ access
  const motionChoices: { id: 'system' | 'on' | 'off'; label: string }[] = [
    { id: 'system', label: 'Follow the system' },
    { id: 'on', label: 'On' },
    { id: 'off', label: 'Off' },
  ];
  const systemReduces = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Seated play (Section 10.6) is the play area fitted to a seated reach (play-area.ts), so it is on
  // exactly while that is the play area: a box moved or resized in Wand tuning becomes the player's own.
  // The play area is kept with each camera and comes back whenever that camera opens (Section 7.1), so
  // AppState stores the choice with the camera, and holds one made with no camera on for the next open.
  const seated = $derived(isSeated(app.settings.playArea));
  const ownArea = $derived(!seated && !isWholeView(app.settings.playArea));

  function setSeated(on: boolean): void {
    app.setSeated(on).then(
      (area) =>
        announce(
          on
            ? 'Seated play is on: the play area fits a seated reach.'
            : isWholeView(area)
              ? 'Seated play is off: the play area is the whole view.'
              : 'Seated play is off: the play area you had before is back.',
        ),
      (err) => announce(errorText(err, 'That setting could not be changed.')),
    );
  }

  // ------------------------------------------------------------------ sound
  let volume = $state(80);
  let holding = false;
  $effect(() => {
    const v = app.settings['audio.volume'];
    if (!holding && typeof v === 'number') volume = Math.round(v * 100);
  });
  const muted = $derived(app.settings['audio.muted'] === true);

  function preview(): void {
    void ask(app.kernel, 'audio.play', { cue: 'chime' }).catch(() => undefined);
  }

  function commitVolume(): void {
    holding = false;
    app.set('audio.volume', Math.max(0, Math.min(1, volume / 100))).then(
      () => {
        if (!muted) preview();
      },
      (err) => announce(errorText(err)),
    );
  }

  // ------------------------------------------------------------------ look
  const theme = $derived(app.spellbook?.theme ?? null);
  const accents = $derived.by((): AccentOption[] => {
    const t = theme;
    const base: AccentOption = { id: 'default', label: 'Theme colors', candle: t?.tokens?.candle ?? '#F2B84B', oxblood: t?.tokens?.oxblood ?? '#7B1E2B' };
    const extra = Object.entries(t?.accents ?? {}).map(([id, a]) => ({ id, label: a.label, candle: a.candle, oxblood: a.oxblood }));
    return [base, ...extra];
  });
  const accent = $derived(accents.some((a) => a.id === app.settings['theme.accent']) ? app.settings['theme.accent'] : 'default');
  const themes = $derived(app.spellbook?.packs.filter((p) => p.kind === 'themepack' && p.enabled && !p.error) ?? []);
  const qualities: { id: 'auto' | 'high' | 'low'; label: string }[] = [
    { id: 'auto', label: 'Automatic' },
    { id: 'high', label: 'High' },
    { id: 'low', label: 'Low' },
  ];
</script>

<div class="ws-cols">
  <div class="ws-col">
    <ToolSection id="ws-mode" title="Casting mode" lede="How a spell is decided: by the shape you trace, the words you say, or both.">
      <ModeChoice value={mode} {voiceOk} voiceless={app.desktop} onselect={chooseMode} />
      {#if modeNote}
        <div class="ws-stack">
          <StatusLine kind={modeNote.kind} text={modeNote.text} />
          {#if !voiceOn && !voiceMissing && !app.desktop}
            <div class="ws-actions"><button class="btn" type="button" onclick={() => setVoice(true)}>Turn voice on</button></div>
          {/if}
        </div>
      {/if}
    </ToolSection>

    {#if app.desktop}
      <!-- The desktop app has no voice: no switch to turn on, nothing about a microphone it never opens. -->
      <ToolSection id="ws-voice" title="Voice" lede={DESKTOP_VOICE.lede}>
        <StatusLine kind="info" text={DESKTOP_VOICE.status} />
      </ToolSection>
    {:else}
      <ToolSection id="ws-voice" title="Voice" lede={privacy.lede}>
        <div class="ws-setting">
          <label class="switch">
            <input type="checkbox" checked={voiceOn} disabled={voiceMissing && !voiceOn} onchange={(e) => setVoice(e.currentTarget.checked)} aria-describedby="ws-voice-help" />
            <span class="ws-switch-text">Listen for incantations</span>
          </label>
          <p class="ws-help" id="ws-voice-help">{privacy.help}</p>
        </div>

        {#if voiceMissing}
          <StatusLine kind="warn" text="Voice recognition is not available in {voiceHome}, so voice stays off. Gesture play is not affected." />
        {:else if vNote}
          <StatusLine kind={vNote.kind} text={vNote.text} />
        {/if}

        {#if voiceOn && app.voice.state === 'needs-download'}
          <div class="ws-actions">
            <button class="btn btn-seal" type="button" onclick={downloadVoice} disabled={installing}>Download the voice pack</button>
            <p class="ws-help grow">The speech pack for {app.voice.lang ?? 'this language'}. After it, voice works offline.</p>
          </div>
        {/if}
        {#if installNote}<StatusLine kind={installNote.kind} text={installNote.text} />{/if}

        {#if cloudOffered}
          <div class="cloud">
            <label class="switch">
              <input type="checkbox" checked={app.settings['voice.allowCloud'] === true} onchange={(e) => set('voice.allowCloud', e.currentTarget.checked, e.currentTarget.checked ? 'Online speech service allowed.' : 'Online speech service turned off.')} aria-describedby="ws-cloud-help" />
              <span class="ws-switch-text">Use the browser’s online speech service</span>
            </label>
            <p class="cloud-text" id="ws-cloud-help">
              <strong>Audio then leaves this device.</strong> The browser sends what you say to its online speech service to be turned into text.
              Use it only where on-device recognition is missing.
            </p>
          </div>
        {/if}
      </ToolSection>
    {/if}

    <ToolSection id="ws-spells" title="Spells">
      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={app.settings['spells.unlockAll'] === true} onchange={(e) => set('spells.unlockAll', e.currentTarget.checked, e.currentTarget.checked ? 'Every spell is open.' : 'Spells open in stages again.')} aria-describedby="ws-unlock-help" />
          <span class="ws-switch-text">Open every spell</span>
        </label>
        <p class="ws-help" id="ws-unlock-help">
          Skips learning in stages: every spell of the packs you have on can be cast and practised now. While you learn, fewer open spells mean fewer mix-ups.
        </p>
      </div>
      {#if app.spellbook}
        <p class="ws-help count">{openCount} of {availableCount} spells can be cast now.</p>
      {/if}
    </ToolSection>
  </div>

  <div class="ws-col">
    <ToolSection id="ws-access" title="Access">
      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={seated} onchange={(e) => setSeated(e.currentTarget.checked)} aria-describedby="ws-seated-help" />
          <span class="ws-switch-text">Seated play</span>
        </label>
        <p class="ws-help" id="ws-seated-help">
          For casting from a chair or a wheelchair. The play area becomes smaller and lower in the view, to fit a seated reach, so smaller
          gestures cast in full. Sit 0.6 to 1.2 m from the camera. Mouse and touch always use the whole mirror.
          {#if ownArea}The play area now is one set in Wand tuning.{/if}
        </p>
      </div>

      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={app.settings['access.leftHanded'] === true} onchange={(e) => set('access.leftHanded', e.currentTarget.checked, e.currentTarget.checked ? 'Gestures are mirrored for the left hand.' : 'Gestures are drawn for the right hand.')} aria-describedby="ws-left-help" />
          <span class="ws-switch-text">Left-handed</span>
        </label>
        <p class="ws-help" id="ws-left-help">Mirrors every gesture, so each spell is traced the other way round.</p>
      </div>

      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={app.settings['access.highContrastTrail'] === true} onchange={(e) => set('access.highContrastTrail', e.currentTarget.checked)} aria-describedby="ws-contrast-help" />
          <span class="ws-switch-text">High-contrast trail</span>
        </label>
        <p class="ws-help" id="ws-contrast-help">Gives the trail of light a dark edge, so it stands out in a bright room.</p>
      </div>

      <div class="ws-stack">
        <div class="ws-field-row">
          <span class="ws-label" id="ws-motion-label">Reduced motion</span>
          <div class="segmented" role="radiogroup" aria-labelledby="ws-motion-label" aria-describedby="ws-motion-help" use:radioKeys>
            {#each motionChoices as c (c.id)}
              <button type="button" role="radio" aria-checked={app.settings['access.reducedMotion'] === c.id} onclick={() => set('access.reducedMotion', c.id)}>{c.label}</button>
            {/each}
          </div>
        </div>
        <p class="ws-help" id="ws-motion-help">
          With it on, the trail and the incantation appear without animation, and fewer particles fly.
          {#if app.settings['access.reducedMotion'] === 'system'}{systemReduces ? 'Your system asks for it now.' : 'Your system does not ask for it now.'}{/if}
        </p>
      </div>

      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={app.settings['access.captions'] === true} onchange={(e) => set('access.captions', e.currentTarget.checked, e.currentTarget.checked ? 'Captions are on.' : 'Captions are off.')} aria-describedby="ws-captions-help" />
          <span class="ws-switch-text">Captions</span>
        </label>
        <p class="ws-help" id="ws-captions-help">Writes each sound on screen, such as [Rising chime].</p>
      </div>
    </ToolSection>

    <ToolSection id="ws-sound" title="Sound">
      <div class="volume">
        <label class="ws-label" for="ws-volume">Volume</label>
        <input
          id="ws-volume"
          type="range"
          min="0"
          max="100"
          step="5"
          value={volume}
          disabled={muted}
          aria-valuetext="{volume}%"
          oninput={(e) => {
            holding = true;
            volume = Number(e.currentTarget.value);
          }}
          onchange={commitVolume}
        />
        <output for="ws-volume">{muted ? 'muted' : `${volume}%`}</output>
      </div>
      <div class="ws-actions">
        <label class="switch">
          <input type="checkbox" checked={muted} onchange={(e) => set('audio.muted', e.currentTarget.checked, e.currentTarget.checked ? 'Sound is muted.' : 'Sound is on.')} />
          <span class="ws-switch-text">Mute</span>
        </label>
        <button class="btn btn-small push" type="button" onclick={preview} disabled={muted}>Play a sample</button>
      </div>
      <p class="ws-help">{muted ? 'Captions still appear while sound is muted, when they are on.' : 'A short chime plays when you let go of the slider.'}</p>
    </ToolSection>

    <ToolSection id="ws-look" title="Look">
      <div class="ws-stack">
        <span class="ws-label" id="ws-accent-label">House accent</span>
        <AccentChoice options={accents} value={accent} onselect={(id) => set('theme.accent', id, `${accents.find((a) => a.id === id)?.label ?? 'Accent'} chosen.`)} />
        <p class="ws-help">Restyles the candlelight and the wax seals in house colors.</p>
      </div>

      {#if themes.length > 1}
        <div class="ws-field-row">
          <span class="ws-label" id="ws-theme-label">Theme</span>
          <div class="segmented" role="radiogroup" aria-labelledby="ws-theme-label" use:radioKeys>
            {#each themes as t (t.id)}
              <button type="button" role="radio" aria-checked={theme?.id === t.id} onclick={() => set('theme.id', t.id, `${t.title} chosen.`)}>{t.title}</button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="ws-stack">
        <div class="ws-field-row">
          <span class="ws-label" id="ws-quality-label">Stage quality</span>
          <div class="segmented" role="radiogroup" aria-labelledby="ws-quality-label" aria-describedby="ws-quality-help" use:radioKeys>
            {#each qualities as q (q.id)}
              <button type="button" role="radio" aria-checked={app.settings['stage.quality'] === q.id} onclick={() => set('stage.quality', q.id)}>{q.label}</button>
            {/each}
          </div>
        </div>
        <p class="ws-help" id="ws-quality-help">Automatic lowers the detail when frames slow down. Low is lighter work for older computers.</p>
      </div>
    </ToolSection>
  </div>
</div>

<style>
  .cloud {
    display: grid;
    gap: 8px;
    padding: 12px 14px 14px;
    border-radius: var(--radius-small);
    border: 1px dashed color-mix(in srgb, var(--candle) 50%, transparent);
    background: color-mix(in srgb, var(--night) 45%, transparent);
  }

  .cloud-text {
    margin: 0;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .cloud-text strong {
    font-weight: 600;
    color: var(--candle);
  }

  .count {
    margin-top: -4px;
  }

  .volume {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 7ch;
    align-items: center;
    gap: 14px;
  }

  .volume input {
    min-height: 44px;
  }

  .volume output {
    font-size: var(--text-small);
    color: var(--candle);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .push {
    margin-left: auto;
  }

  .grow {
    flex: 1 1 220px;
  }
</style>
