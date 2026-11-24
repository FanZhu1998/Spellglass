<script lang="ts">
  // Wand tuning (Section 10.4): camera choice, a distance guide, a live view of what the tracker sees,
  // automatic exposure and threshold, and the play-area size. 'tracker.debug' is on only while this
  // drawer is open, so the debug view never costs anything during play (Section 13 budget).
  import { tick, untrack } from 'svelte';
  import type { CameraDevice } from '../../contracts';
  import { ask, on } from '../../kernel';
  import { focusIfLost } from '../actions';
  import type { AppState } from '../app-state.svelte';
  import Drawer from '../components/Drawer.svelte';
  import DistanceGuide from '../components/tools/DistanceGuide.svelte';
  import ExposureControls from '../components/tools/ExposureControls.svelte';
  import LiveView from '../components/tools/LiveView.svelte';
  import StatusLine, { type StatusKind } from '../components/tools/StatusLine.svelte';
  import ToolSection from '../components/tools/ToolSection.svelte';
  import TrackerChoice, { ROUTES, type Route } from '../components/tools/TrackerChoice.svelte';
  import TrackingTest from '../components/tools/TrackingTest.svelte';
  import { errorText } from '../components/tools/format';
  import { isSeated } from '../components/tools/play-area';
  import { TEXT } from '../components/shell/routes';

  let { app }: { app: AppState } = $props();

  let announcement = $state('');
  function announce(text: string): void {
    announcement = '';
    queueMicrotask(() => (announcement = text));
  }

  // ------------------------------------------------------------------ the keyboard's place
  let controls = $state<HTMLElement>();

  /**
   * After a route switch or a camera problem's button, focus can fall to the page (Section 10.6): the
   * problem goes once its cause does ("Use the mouse instead", "Use the camera", a "Try again" that
   * worked), and the radios and "Try again" are disabled while they work. Give it to what is left in
   * their place: the problem's first button while one is still shown and the action came from it,
   * else the route now chosen, where "Mouse or touch chosen." and the like are said.
   */
  async function keepPlace(fromProblem: boolean): Promise<void> {
    await tick();
    const button = fromProblem ? controls?.querySelector('.problem button:not(:disabled)') : null;
    focusIfLost(button ?? controls?.querySelector('input[name="tracker-route"]:checked'));
  }

  // ------------------------------------------------------------------ the debug view, while open
  // Requests run synchronously up to their first await and the settings event reaches AppState at
  // once, so calls made from effects are untracked: the effect must not depend on what it writes.
  $effect(() => {
    untrack(() => void app.set('tracker.debug', true).catch(() => undefined));
    return () => {
      untrack(() => void app.set('tracker.debug', false).catch(() => undefined));
    };
  });

  // ------------------------------------------------------------------ cameras
  let devices = $state.raw<CameraDevice[]>([]);
  let devicesError = $state<string | null>(null);

  async function loadDevices(): Promise<void> {
    try {
      devices = await ask(app.kernel, 'camera.devices');
      devicesError = null;
    } catch (err) {
      devicesError = errorText(err, 'The list of cameras could not be read.');
    }
  }

  // Labels are empty until the camera has been allowed once: read the list again when it opens.
  $effect(() => {
    untrack(() => void loadDevices());
    const k = app.kernel;
    const offReady = on(k, 'camera.ready', () => void loadDevices());
    let lastState = untrack(() => app.camera?.state);
    const offStatus = on(k, 'camera.status', (s) => {
      if (s.state !== lastState && (s.state === 'on' || s.state === 'missing')) void loadDevices();
      lastState = s.state;
    });
    return () => {
      offReady();
      offStatus();
    };
  });

  const chosenDevice = $derived(app.settings['capture.deviceId'] ?? '');
  const chosenMissing = $derived(!!chosenDevice && devices.length > 0 && !devices.some((d) => d.deviceId === chosenDevice));
  const unnamed = $derived(devices.length > 0 && devices.every((d) => !d.label));

  function setDevice(id: string): void {
    void app.set('capture.deviceId', id || null).then(
      () => announce('Camera changed.'),
      (err) => announce(errorText(err)),
    );
  }

  // ------------------------------------------------------------------ the route
  const active = $derived(app.settings['tracker.active']);
  const route = $derived.by((): Route | null => {
    if (active === 'tracker.bright-tip') return app.settings['brightTip.profile'] === 'infrared' ? 'infrared' : 'wand';
    if (active === 'tracker.hand') return 'hand';
    if (active === 'tracker.pointer') return 'pointer';
    return null;
  });
  const usesCamera = $derived(route === 'wand' || route === 'infrared' || route === 'hand');
  const brightTip = $derived(route === 'wand' || route === 'infrared');

  const disabledRoutes = $derived.by(() => {
    const out: Partial<Record<Route, string>> = {};
    for (const r of ROUTES) {
      const m = app.modules.find((x) => x.manifest.id === r.tracker);
      if (!m) out[r.id] = 'Not part of this edition.';
      else if (m.state === 'unavailable' || (m.state === 'error' && r.tracker !== active)) out[r.id] = 'Not available in this browser.';
    }
    return out;
  });

  let switching = $state(false);
  let routeError = $state<string | null>(null);

  // Capture sets brightTip.profile from the camera's label on every open, unless the camera's profile
  // names a route, so a route chosen here would last only until the camera next opens; an infrared
  // camera with a plain name ("USB Camera") would go back to route A. The choice is stored with the
  // camera, as the Threshold does: at once when the camera is on, and on the camera.ready that follows
  // when the choice opens it or switches it to the infrared camera. The save names only the route, so
  // nothing else is held with it.
  /** A route chosen here that is not yet stored with the camera in use. */
  let unsavedRoute: 'visible' | 'infrared' | null = null;
  $effect(() =>
    on(app.kernel, 'camera.ready', () => {
      if (unsavedRoute) keepRoute(unsavedRoute);
    }),
  );

  function keepRoute(profile: 'visible' | 'infrared'): void {
    if (app.kernel.setting('brightTip.profile', 'visible') !== profile) void app.set('brightTip.profile', profile).catch(() => undefined);
    void ask(app.kernel, 'camera.profile.save', { profile }).then(
      () => {
        if (unsavedRoute === profile) unsavedRoute = null;
      },
      // The camera closed meanwhile: the next camera.ready stores it.
      () => undefined,
    );
  }

  /** `fromProblem`: chosen with the camera problem's "Use the mouse instead". */
  async function choose(r: Route, fromProblem = false): Promise<void> {
    const def = ROUTES.find((x) => x.id === r);
    if (!def) return;
    switching = true;
    routeError = null;
    const profile = r === 'infrared' ? 'infrared' : r === 'wand' ? 'visible' : null;
    // Before anything below opens the camera, so the camera.ready that follows is not missed.
    unsavedRoute = profile;
    try {
      // Choosing a camera route here is the moment the camera is needed (Section 11.2); the sentence
      // beside the choice says why.
      if (def.tracker !== 'tracker.pointer' && app.settings['capture.consent'] !== true) await app.set('capture.consent', true);
      if (profile) {
        if (app.settings['brightTip.profile'] !== profile) await app.set('brightTip.profile', profile);
        const ir = devices.find((d) => d.infrared);
        if (r === 'infrared' && ir && !app.cameraReady?.infrared && app.settings['capture.deviceId'] !== ir.deviceId) {
          await app.set('capture.deviceId', ir.deviceId);
        }
      }
      // The reflection goes with the route, as on the Threshold and the mirror's "Use mouse or touch": a
      // camera route shows you in the glass (Sections 7.8 and 10.1), and mouse or touch lets the camera
      // go, so a blocked camera is no longer asked for. Set after the camera choice above, so the
      // camera opens once, on the right device.
      const mirror = def.tracker !== 'tracker.pointer';
      if (app.settings['capture.mirror'] !== mirror) await app.set('capture.mirror', mirror);
      if (app.settings['tracker.active'] !== def.tracker) await app.set('tracker.active', def.tracker);
      if (profile && app.camera?.state === 'on') keepRoute(profile);
      announce(`${def.title} chosen.`);
    } catch (err) {
      routeError = errorText(err, 'That route could not start.');
      announce(routeError);
    } finally {
      switching = false;
    }
    await keepPlace(fromProblem);
  }

  // ------------------------------------------------------------------ camera problems (Section 7.9)
  const cam = $derived(app.camera);
  const problem = $derived.by((): { kind: StatusKind; text: string; retry: boolean; consent: boolean } | null => {
    if (!usesCamera || !cam) return null;
    if (cam.state === 'blocked' && app.desktop) {
      // The desktop app has no address bar: the block comes from the computer's privacy settings.
      return { kind: 'error', text: TEXT.blockedDesktop, retry: true, consent: false };
    }
    if (cam.state === 'blocked' || cam.state === 'missing' || cam.state === 'busy' || cam.state === 'error') {
      const fallback =
        cam.state === 'blocked'
          ? 'Camera is blocked. Allow camera access in the address bar, then choose Try again.'
          : cam.state === 'missing'
            ? 'No camera found. Plug one in, then choose Try again.'
            : cam.state === 'busy'
              ? 'The camera is in use by another app. Close that app, then choose Try again.'
              : 'The camera could not start. Choose Try again.';
      return { kind: 'error', text: cam.error?.message || cam.message || fallback, retry: true, consent: false };
    }
    if (cam.state === 'off' && app.settings['capture.consent'] !== true) {
      return { kind: 'warn', text: 'Spellglass has not been allowed to use the camera yet. The picture is processed here and never leaves this computer.', retry: false, consent: true };
    }
    return null;
  });

  let retrying = $state(false);
  async function retry(): Promise<void> {
    retrying = true;
    try {
      await ask(app.kernel, 'camera.retry');
      announce('The camera is on.');
    } catch (err) {
      announce(errorText(err, 'The camera could not start.'));
    } finally {
      retrying = false;
    }
    await keepPlace(true);
  }

  async function allowCamera(): Promise<void> {
    try {
      await app.set('capture.consent', true);
    } catch (err) {
      announce(errorText(err));
    }
    await keepPlace(true);
  }

  // ------------------------------------------------------------------ light and lamps
  const channels: { id: 'luma' | 'r' | 'g' | 'b'; label: string }[] = [
    { id: 'luma', label: 'White' },
    { id: 'r', label: 'Red' },
    { id: 'g', label: 'Green' },
    { id: 'b', label: 'Blue' },
  ];

  let relearn = $state<{ kind: StatusKind; text: string } | null>(null);
  async function forgetLamps(button: HTMLElement): Promise<void> {
    relearn = { kind: 'busy', text: 'Learning the room again. Keep the wand out of view for two seconds.' };
    announce(relearn.text);
    try {
      await ask(app.kernel, 'tracker.relearn-mask');
      relearn = { kind: 'ok', text: 'The tracker has learned the room again: lamps, windows and reflections are left out.' };
    } catch (err) {
      relearn = { kind: 'error', text: errorText(err, 'The room could not be learned again. Choose the wand tip route first.') };
    }
    announce(relearn.text);
    // Disabled while the room is learned, so focus fell to the page: give it back (Section 10.6).
    await tick();
    focusIfLost(button);
  }

  const lightPct = $derived(Math.round((Number(app.settings['shell.screenLightHeight']) || 0.12) * 100));

  // ------------------------------------------------------------------ save for this camera
  let saved = $state<{ kind: StatusKind; text: string } | null>(null);
  let saveLabel = $state('Save for this camera');
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  async function saveProfile(): Promise<void> {
    try {
      const p = await ask(app.kernel, 'camera.profile.save');
      saved = { kind: 'ok', text: `Saved for ${p.label || 'this camera'}. These settings come back whenever it is used.` };
      saveLabel = 'Saved for this camera';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => (saveLabel = 'Save for this camera'), 4000);
    } catch (err) {
      saved = { kind: 'error', text: errorText(err, 'The settings could not be saved for this camera.') };
    }
    announce(saved.text);
  }
  $effect(() => () => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  const cameraOn = $derived(cam?.state === 'on');
  const inUse = $derived.by(() => {
    if (!cameraOn || !cam) return null;
    const size = cam.width && cam.height ? `${cam.width} × ${cam.height}` : '';
    const rate = cam.fps ? ` at ${cam.fps} fps` : '';
    return `In use: ${cam.label || 'a camera'}${size ? `, ${size}${rate}` : ''}.`;
  });
</script>

<Drawer title="Wand tuning" width={980} onclose={() => app.go('mirror')}>
  <div class="tuning">
    <div class="view-col">
      <div class="view-sticky">
        <LiveView {app} />
        {#if usesCamera}
          <div class="save">
            <button class="btn btn-seal" type="button" onclick={saveProfile} disabled={!cameraOn}>{saveLabel}</button>
            <p class="help">Keeps the exposure, threshold, light color, flip and play area for this camera.</p>
          </div>
          {#if saved}<StatusLine kind={saved.kind} text={saved.text} />{/if}
        {/if}
      </div>
    </div>

    <div class="controls-col" bind:this={controls}>
      {#if problem}
        <div class="problem">
          <StatusLine kind={problem.kind} text={problem.text} />
          <div class="row wrap">
            {#if problem.retry}
              <button class="btn btn-seal" type="button" onclick={retry} disabled={retrying}>{retrying ? 'Trying…' : 'Try again'}</button>
            {/if}
            {#if problem.consent}
              <button class="btn btn-seal" type="button" onclick={allowCamera}>Use the camera</button>
            {/if}
            <button class="btn" type="button" onclick={() => choose('pointer', true)}>Use the mouse instead</button>
          </div>
        </div>
      {/if}

      <ToolSection id="route" title="How Spellglass sees your wand" lede="Camera routes process the picture here; it never leaves this computer.">
        <TrackerChoice value={route} disabled={disabledRoutes} busy={switching} onselect={choose} />
        {#if routeError}<StatusLine kind="error" text={routeError} />{/if}
        {#if route === 'hand'}
          <div class="field-row">
            <span class="label" id="hand-mode-label">The tip is</span>
            <div class="segmented" role="radiogroup" aria-labelledby="hand-mode-label">
              <button type="button" role="radio" aria-checked={app.settings['hand.mode'] === 'finger'} onclick={() => app.set('hand.mode', 'finger')}>Your fingertip</button>
              <button type="button" role="radio" aria-checked={app.settings['hand.mode'] === 'grip'} onclick={() => app.set('hand.mode', 'grip')}>The wand in your hand</button>
            </div>
          </div>
          <p class="help">
            {app.settings['hand.mode'] === 'grip'
              ? 'A point projected forward from the knuckles of the hand that holds the wand.'
              : 'Your index fingertip is the wand. Best for visitors without one.'}
          </p>
        {/if}
      </ToolSection>

      {#if usesCamera}
        <ToolSection id="camera" title="Camera and distance">
          <div class="field">
            <label for="tune-camera">Camera</label>
            <select id="tune-camera" class="select" value={chosenMissing ? '__missing' : chosenDevice} onchange={(e) => setDevice(e.currentTarget.value === '__missing' ? chosenDevice : e.currentTarget.value)}>
              <option value="">The default camera</option>
              {#each devices as d, i (d.deviceId || `camera-${i}`)}
                <option value={d.deviceId}>{d.label || `Camera ${i + 1}`}{d.infrared ? ' (infrared)' : ''}</option>
              {/each}
              {#if chosenMissing}<option value="__missing">The chosen camera (not connected)</option>{/if}
            </select>
            {#if devicesError}
              <p class="help">{devicesError}</p>
            {:else if unnamed}
              <p class="help">Camera names appear once the camera has been allowed.</p>
            {:else if inUse}
              <p class="help">{inUse}</p>
            {/if}
          </div>

          <label class="switch">
            <input type="checkbox" checked={app.settings['capture.flipX']} onchange={(e) => app.set('capture.flipX', e.currentTarget.checked)} />
            <span>Mirror the picture left to right</span>
          </label>
          <p class="help after-switch">Leave this on for ordinary webcams. Turn it off if your camera already mirrors its picture and the tip moves the wrong way.</p>
          <p class="help">{TEXT.followingCamera}</p>

          <DistanceGuide width={cam?.width} height={cam?.height} fps={cam?.fps} steppedDown={cam?.steppedDown} seated={isSeated(app.settings.playArea)} />
        </ToolSection>
      {/if}

      {#if brightTip}
        <ToolSection id="exposure" title="Exposure and threshold" lede="A short exposure turns the room dark, keeps the glint and removes motion blur.">
          <ExposureControls {app} {announce} />
        </ToolSection>

        <ToolSection id="light" title="Light and lamps">
          <div class="field-row">
            <span class="label" id="channel-label">Color of your light</span>
            <div class="segmented" role="radiogroup" aria-labelledby="channel-label">
              {#each channels as c (c.id)}
                <button type="button" role="radio" aria-checked={app.settings['brightTip.channel'] === c.id} onclick={() => app.set('brightTip.channel', c.id)}>{c.label}</button>
              {/each}
            </div>
          </div>
          <p class="help">With a colored light, pick its color: the tip then stands out from white lamps.</p>

          <label class="switch">
            <input type="checkbox" checked={app.settings['shell.screenLight']} onchange={(e) => app.set('shell.screenLight', e.currentTarget.checked)} />
            <span>Light the wand with the screen</span>
          </label>
          <p class="help after-switch">Shows a white band along the top of the window, right under the camera, in place of a clip-on light.</p>
          {#if app.settings['shell.screenLight']}
            <div class="slider-field">
              <label for="light-height">Band height</label>
              <input
                id="light-height"
                type="range"
                min="5"
                max="35"
                step="1"
                value={lightPct}
                aria-valuetext="{lightPct}% of the window"
                oninput={(e) => app.set('shell.screenLightHeight', Number(e.currentTarget.value) / 100)}
              />
              <output for="light-height">{lightPct}%</output>
            </div>
          {/if}

          <div class="stacked">
            <button class="btn" type="button" onclick={(e) => forgetLamps(e.currentTarget)} disabled={relearn?.kind === 'busy' || !cameraOn}>Forget lamps and windows</button>
            <p class="help">The tracker leaves out bright things that never move. Use this after moving a lamp or opening a curtain.</p>
          </div>
          {#if relearn}<StatusLine kind={relearn.kind} text={relearn.text} />{/if}
        </ToolSection>
      {/if}

      <ToolSection id="test" title="Can your camera see the tip?" lede="One evening with the wand, a phone flashlight and a room you can dim settles it.">
        <TrackingTest />
      </ToolSection>
    </div>
  </div>
</Drawer>

<p class="visually-hidden" aria-live="polite">{announcement}</p>

<style>
  /* A workbench: the view stays in place on the left while the controls scroll on the right, so a
     slider's effect can be watched as it moves. Each column scrolls on its own if it must. */
  .tuning {
    height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
    gap: 28px;
  }

  .view-col,
  .controls-col {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    container-type: inline-size;
  }

  .controls-col {
    padding-right: 8px;
  }

  .view-sticky {
    display: grid;
    gap: 12px;
    padding-bottom: 8px;
  }

  .save {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding-top: 4px;
  }

  .save .help {
    flex: 1 1 200px;
  }

  .problem {
    display: grid;
    gap: 12px;
    margin-bottom: 18px;
  }

  .row.wrap {
    flex-wrap: wrap;
  }

  .stacked {
    display: grid;
    justify-items: start;
    gap: 8px;
  }

  .field {
    margin-bottom: 0;
  }

  .field label {
    font-size: var(--text-body);
  }

  .field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    flex-wrap: wrap;
  }

  .label {
    font-size: var(--text-body);
  }

  .help {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .help.after-switch {
    margin-top: -12px;
    padding-left: 58px;
  }

  .switch span {
    font-size: var(--text-body);
  }

  .slider-field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 4ch;
    align-items: center;
    gap: 14px;
  }

  .slider-field label {
    font-size: var(--text-small);
  }

  .slider-field input {
    min-height: 44px;
  }

  .slider-field output {
    font-size: var(--text-small);
    color: var(--candle);
    text-align: right;
  }

  /* Narrow windows: one column that scrolls as a whole, the view first. */
  @media (max-width: 1080px) {
    .tuning {
      height: auto;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .view-col,
    .controls-col {
      overflow: visible;
    }
    .controls-col {
      padding-right: 0;
    }
  }
</style>
