<script lang="ts">
  // Threshold: the first run (Section 10.4). What the app needs, the camera asked for at the moment it
  // is needed with one sentence on why (Section 11.2), and a choice of how the app should see the
  // wand (Section 4's routes). The mirror stays in view beside this page, so the choice shows its
  // result at once; the camera and tracker are described in plain words (Sections 7.9, 10.5).
  // Returning players see it only through "Change how the app sees your wand".
  import { untrack } from 'svelte';
  import type { AppState } from '../app-state.svelte';
  import { ask, describeError, on } from '../../kernel';
  import { focusOnMount, onEscape } from '../actions';
  import Icon from '../components/shell/Icon.svelte';
  import {
    ROUTES, TEXT, TONE_GLYPH, cameraLine, cameraTrouble, currentRoute, routeUnavailable, trackerLine,
    type Route, type StatusLine,
  } from '../components/shell/routes';

  let { app }: { app: AppState } = $props();

  const ICON: Record<Route, string> = { wand: 'wand', hand: 'hand', infrared: 'infrared', pointer: 'pointer' };

  /** A returning player came here to change the route: start from the one in use. */
  const returning = untrack(() => app.settings['app.onboarded'] === true);
  let chosen = $state<Route | null>(untrack(() => (returning ? currentRoute(app.settings) : null)));
  let busy = false;
  let retrying = $state(false);
  let retryFailed = $state(false);
  let starting = $state(false);
  let problem = $state<string | null>(null);
  /** The live status under the routes: what happened to the choice (camera blocked, model loading). */
  let liveEl = $state<HTMLElement | null>(null);
  /** The letter's scrolling body, and whether the last way (mouse or touch, for anyone without a
   *  camera) is out of its view, under the fade at its foot: then the foot offers it in one line. */
  let scrollEl = $state<HTMLElement | null>(null);
  let pointerOutOfView = $state(false);

  $effect(() => {
    const root = scrollEl;
    const route = root?.querySelector('[data-route="pointer"]');
    if (!root || !route || typeof IntersectionObserver !== 'function') return;
    // The fade at the foot is 26 px: a route under it is not in view.
    const io = new IntersectionObserver(([e]) => (pointerOutOfView = !e || e.intersectionRatio < 0.98), {
      root,
      rootMargin: '0px 0px -26px 0px',
      threshold: [0, 0.98],
    });
    io.observe(route);
    return () => io.disconnect();
  });

  const usesCamera = $derived(chosen !== null && chosen !== 'pointer');
  const trouble = $derived(usesCamera && cameraTrouble(app.camera));
  const trackerFailed = $derived(
    usesCamera && !trouble && app.tracker?.state === 'error' && app.tracker.tracker === (chosen === 'hand' ? 'tracker.hand' : 'tracker.bright-tip'),
  );

  /** What the mirror is doing with the choice, line by line. */
  const lines = $derived.by((): StatusLine[] => {
    if (!chosen) return [];
    if (chosen === 'pointer') return [trackerLine(null, 'pointer')!];
    const out: StatusLine[] = [];
    const cam = cameraLine(app.camera, app.desktop);
    if (cam) out.push(trouble && retryFailed ? { ...cam, text: `Not yet. ${cam.text}` } : cam);
    else out.push({ tone: 'wait', text: app.desktop ? TEXT.openingDesktop : TEXT.opening });
    const t = app.tracker;
    if (app.camera?.state === 'on') {
      const line = trackerLine(t, chosen);
      if (line) out.push(line);
    } else if (chosen === 'hand' && !trouble && t?.tracker === 'tracker.hand' && (t.state === 'loading' || t.state === 'error')) {
      // The model downloads while the camera opens.
      const line = trackerLine(t, 'hand');
      if (line) out.push(line);
    }
    return out;
  });

  // Bring the live status into view when the choice changes or a problem appears, so "Camera is
  // blocked... Try again" is never left below the fold (Section 7.9). Only those: the lines themselves
  // change with every tracker.status (twice a second) and whenever the tip is found or lost, and
  // scrolling on each would pull back a player who scrolls up to reread.
  $effect(() => {
    void [chosen, trouble, trackerFailed, problem];
    const el = liveEl;
    if (!el) return;
    queueMicrotask(() => el.scrollIntoView({ block: 'nearest', behavior: app.reducedMotion ? 'auto' : 'smooth' }));
  });

  // Capture sets brightTip.profile from the camera's label when it has no profile for that camera.
  // The player's choice of route A or C wins, and is saved with the camera so it holds next time.
  $effect(() => {
    const route = chosen;
    if (route !== 'wand' && route !== 'infrared') return;
    const profile = route === 'infrared' ? 'infrared' : 'visible';
    return on(app.kernel, 'camera.ready', () => keepProfile(profile));
  });

  // Once the camera opens, a later problem starts afresh.
  $effect(() => {
    if (app.camera?.state === 'on') retryFailed = false;
  });

  function keepProfile(profile: 'visible' | 'infrared') {
    if (app.kernel.setting('brightTip.profile', 'visible') !== profile) void app.set('brightTip.profile', profile);
    void ask(app.kernel, 'camera.profile.save', { profile }).catch(() => {});
  }

  async function choose(route: Route) {
    if (busy) return;
    busy = true;
    chosen = route;
    problem = null;
    retryFailed = false;
    try {
      if (route === 'pointer') {
        await app.set('tracker.active', 'tracker.pointer');
        await app.set('capture.mirror', false);
        return;
      }
      const tracker = route === 'hand' ? 'tracker.hand' : 'tracker.bright-tip';
      if (route !== 'hand') await app.set('brightTip.profile', route === 'infrared' ? 'infrared' : 'visible');
      await app.set('capture.mirror', true);
      // Section 11.2: this is the moment the browser asks for the camera.
      await app.set('capture.consent', true);
      await app.set('tracker.active', tracker);
      // A tracker that stopped with an error starts again when it is chosen again.
      if (app.kernel.modules().find((m) => m.manifest.id === tracker)?.state === 'error') {
        await ask(app.kernel, 'modules.restart', { id: tracker });
      }
      if (route !== 'hand' && app.camera?.state === 'on') keepProfile(route === 'infrared' ? 'infrared' : 'visible');
    } catch (err) {
      problem = describeError(err).message;
    } finally {
      busy = false;
    }
  }

  async function retryCamera() {
    retrying = true;
    retryFailed = false;
    try {
      await ask(app.kernel, 'camera.retry');
    } catch {
      retryFailed = true;
    } finally {
      retrying = false;
    }
  }

  async function restartTracker() {
    const id = chosen === 'hand' ? 'tracker.hand' : 'tracker.bright-tip';
    retrying = true;
    try {
      await ask(app.kernel, 'modules.restart', { id });
    } catch (err) {
      problem = describeError(err).message;
    } finally {
      retrying = false;
    }
  }

  async function start() {
    if (!chosen || starting) return;
    starting = true;
    try {
      await app.set('app.onboarded', true);
    } finally {
      starting = false;
    }
    app.go('mirror');
  }

  function leave() {
    if (app.settings['app.onboarded']) app.go('mirror');
  }

  const pen = $derived(chosen === 'pointer');
  const pointerOff = $derived(routeUnavailable(ROUTES.find((r) => r.id === 'pointer')!, app.modules));
</script>

<section class="threshold page on-vellum" aria-labelledby="threshold-title" use:focusOnMount use:onEscape={leave}>
  <div class="scroll" bind:this={scrollEl}>
    <header class="head">
      <p class="kicker">{returning ? 'How the app sees your wand' : 'Welcome to Spellglass'}</p>
      <h2 id="threshold-title">{returning ? 'Choose again' : 'Step up to the glass'}</h2>
      <p class="lede">
        Spellglass follows your wand through the camera and answers on the glass with light and sound.
        {#if !returning}{app.desktop ? 'It needs a webcam, or simply a mouse.' : 'It needs Chrome or Edge, and a webcam or simply a mouse.'}{/if}
      </p>
    </header>

    <section class="block" aria-labelledby="route-title">
      <h3 id="route-title">How should the app see your wand?</h3>
      <p class="why">
        {app.desktop
          ? 'The first three use your camera. Your computer may ask you to allow it once.'
          : 'The first three use your camera, so the browser will ask you to allow it.'}
      </p>
      <div class="routes" role="group" aria-labelledby="route-title">
        {#each ROUTES as r (r.id)}
          {@const off = routeUnavailable(r, app.modules)}
          <button
            class="route"
            data-route={r.id}
            aria-pressed={chosen === r.id}
            aria-describedby="route-{r.id}-text"
            disabled={!!off}
            onclick={() => choose(r.id)}
          >
            <span class="well" aria-hidden="true"><Icon name={ICON[r.id]} size={26} /></span>
            <span class="words">
              <span class="title">{r.title}</span>
              <span class="text" id="route-{r.id}-text">{off ?? (app.desktop && r.desktopText ? r.desktopText : r.text)}</span>
            </span>
            {#if chosen === r.id}<span class="mark">✓ Chosen</span>{/if}
          </button>
        {/each}
      </div>

      {#if chosen}
        <div class="live" data-trouble={trouble || trackerFailed} bind:this={liveEl}>
          <ul class="lines" role="status" aria-live="polite">
            {#each lines as line, i (i + line.text)}
              <li class="line" data-tone={line.tone}>
                <span class="glyph" data-tone={line.tone} aria-hidden="true">{TONE_GLYPH[line.tone]}</span>
                <span class="line-text">{line.text}</span>
              </li>
              {#if line.progress !== undefined}
                <li class="progress">
                  <span class="bar" role="progressbar" aria-label="Hand model download" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(line.progress * 100)}>
                    <span style:width="{Math.round(line.progress * 100)}%"></span>
                  </span>
                  <span class="pct" aria-hidden="true">{Math.round(line.progress * 100)}%</span>
                </li>
              {/if}
            {/each}
            {#if problem}<li class="line" data-tone="error"><span class="glyph" data-tone="error" aria-hidden="true">{TONE_GLYPH.error}</span><span class="line-text">{problem}</span></li>{/if}
          </ul>

          {#if trouble}
            <div class="actions">
              <button class="btn btn-small" onclick={retryCamera} disabled={retrying}><Icon name="retry" size={18} />{retrying ? 'Trying again' : 'Try again'}</button>
              <button class="btn btn-small btn-ghost" onclick={() => choose('pointer')}>Use mouse or touch</button>
            </div>
          {:else if trackerFailed}
            <div class="actions">
              <button class="btn btn-small" onclick={restartTracker} disabled={retrying}><Icon name="retry" size={18} />{retrying ? 'Trying again' : 'Try again'}</button>
              <button class="btn btn-small btn-ghost" onclick={() => choose('pointer')}>Use mouse or touch</button>
            </div>
          {/if}

          {#if chosen === 'wand'}
            <label class="switch light-switch">
              <input
                type="checkbox"
                checked={app.settings['shell.screenLight']}
                onchange={(e) => app.set('shell.screenLight', e.currentTarget.checked)}
              />
              <span>No light to hand? Light the tip with a white band across the top of the screen.</span>
            </label>
          {:else if chosen === 'hand'}
            <p class="hand-note">{TEXT.followingCamera}</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  <footer class="foot">
    <button class="btn btn-seal start" onclick={start} disabled={!chosen || starting}>Start casting</button>
    {#if !chosen && pointerOutOfView && !pointerOff}
      <!-- The way for anyone without a webcam, while the letter has it out of sight below. -->
      <p class="foot-note">
        Choose a way above first.
        <button type="button" class="no-camera" onclick={() => choose('pointer')}>No camera? Use the mouse.</button>
      </p>
    {:else}
      <p class="foot-note">{chosen ? 'You can change this later from the mirror.' : 'Choose how the app should see your wand first.'}</p>
    {/if}
  </footer>
</section>

<!-- Under the live mirror: how to cast, minding the room, and where the camera's frames go. -->
<section class="tips" aria-label="Before you cast">
  <article class="tip">
    <h3>How to cast</h3>
    <ol class="rhythm">
      <li>
        <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring" cx="20" cy="20" r="13" /><circle class="dot" cx="20" cy="20" r="4.5" /></svg>
        <span>{pen ? 'Press on the mirror' : 'Hold still'}</span>
      </li>
      <li>
        <svg viewBox="0 0 64 40" aria-hidden="true"><path class="swoosh" d="M6 30 C 14 6, 26 6, 30 20 S 46 36, 58 10" /><circle class="dot" cx="6" cy="30" r="3.5" /></svg>
        <span>Trace the spell</span>
      </li>
      <li>
        <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring" cx="20" cy="20" r="13" /><circle class="dot" cx="20" cy="20" r="4.5" /></svg>
        <span>{pen ? 'Let go' : 'Hold still again'}</span>
      </li>
    </ol>
  </article>
  <article class="tip">
    <h3>Mind the room</h3>
    <p>Clear an arm's length plus the wand around you: drinks, pets, the monitor. Small, slow gestures work better than big ones.</p>
  </article>
  <article class="tip">
    {#if app.desktop}
      <h3>Stays on this computer</h3>
      <p>Camera frames are read here and never leave this computer. No analytics, no account.</p>
    {:else}
      <h3>Stays in this tab</h3>
      <p>Camera frames are read here and never leave the tab. No analytics, no account.</p>
    {/if}
  </article>
</section>

<style>
  /* Two grid items of the room (App.svelte): the page in the side column, the tips under the mirror. */
  /* A letter of invitation: a sheet of parchment folded in three (its creases still show), ruled
     round in ink, written in the book's hand and closed at its foot with a wax seal. */
  .threshold {
    grid-area: side;
    position: relative;
    z-index: 3;
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: 4px 0 10px clamp(10px, 2vw, 28px);
    overflow: hidden;
    border-radius: 2px;
    background:
      linear-gradient(180deg, transparent calc(33.3% - 1px), rgb(255 255 255 / 0.34) calc(33.3% - 1px), rgb(255 255 255 / 0.34) 33.3%, rgb(90 60 24 / 0.13) 33.3%, transparent calc(33.3% + 6px)),
      linear-gradient(180deg, transparent calc(66.6% - 1px), rgb(255 255 255 / 0.34) calc(66.6% - 1px), rgb(255 255 255 / 0.34) 66.6%, rgb(90 60 24 / 0.13) 66.6%, transparent calc(66.6% + 6px)),
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(8% 5% at 86% 14%, rgb(184 154 102 / 0.2), transparent 70%),
      radial-gradient(6% 4% at 10% 60%, rgb(184 154 102 / 0.16), transparent 70%),
      radial-gradient(140% 110% at 50% 30%, color-mix(in srgb, var(--vellum) 90%, white) 0%, var(--vellum) 52%, var(--vellum-2) 100%);
    background-blend-mode: normal, normal, soft-light, normal, normal, normal;
    box-shadow:
      inset 0 0 0 1px rgb(110 76 30 / 0.35),
      inset 0 0 26px rgb(120 84 36 / 0.26),
      6px 18px 50px rgb(0 0 0 / 0.6),
      1px 3px 8px rgb(0 0 0 / 0.4),
      0 0 0 1px rgb(0 0 0 / 0.5);
  }

  /* The inked double rule round the letter. */
  .threshold::before {
    content: '';
    position: absolute;
    z-index: 1;
    inset: 7px;
    border: 1px solid rgb(43 33 24 / 0.34);
    outline: 1px solid rgb(43 33 24 / 0.17);
    outline-offset: 3px;
    pointer-events: none;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 20px clamp(22px, 2.4vw, 36px) 22px;
    /* A soft fade at the bottom edge says there is more below when the list scrolls. */
    mask-image: linear-gradient(to bottom, black calc(100% - 26px), transparent);
  }

  /* The letterhead: a small sigil, the greeting in rubricated small capitals. */
  .head {
    position: relative;
  }

  .kicker {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 4px;
    font-family: var(--font-label);
    font-size: 18px;
    letter-spacing: 0.08em;
    color: var(--rubric);
  }

  .kicker::before {
    content: '';
    flex: none;
    width: 26px;
    height: 26px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Cg fill='none' stroke='%237b1e2b' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='20' cy='20' r='16.4' stroke-width='1.4'/%3E%3Ccircle cx='20' cy='20' r='13.4' stroke-width='1.8' stroke-dasharray='.01 3.05'/%3E%3Cellipse cx='20' cy='17.4' rx='5.4' ry='6.8' stroke-width='1.6'/%3E%3Cpath d='M20 24.3v6.2M17.7 30.6h4.6' stroke-width='1.6'/%3E%3C/g%3E%3Cpath d='M20 13.2l.95 3.25 3.25.95-3.25.95-.95 3.25-.95-3.25-3.25-.95 3.25-.95z' fill='%237b1e2b'/%3E%3C/svg%3E") center / contain no-repeat;
  }

  h2 {
    margin: 0 0 8px;
    font-size: clamp(30px, 2.6vw, 38px);
    color: var(--ink);
  }

  /* The letter's opening capital, in rubric. */
  h2::first-letter {
    font-family: var(--font-ornate);
    font-weight: 700;
    font-size: 1.12em;
    color: var(--rubric);
  }

  /* The greeting is kept short in the eye (a smaller hand, a tighter rule under it) so all four ways
     fit under it on a laptop's screen, the last of them (no camera) above the letter's foot. */
  .lede {
    margin: 0;
    font-size: var(--text-small);
    line-height: 1.5;
  }

  .block {
    position: relative;
    margin-top: 12px;
    padding-top: 14px;
  }

  /* An ornamental rule between the letter's greeting and its question. */
  .block::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 14px;
    transform: translateY(-50%);
    background:
      var(--rule-ornament-ink) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, rgb(43 33 24 / 0.28) 8%, rgb(43 33 24 / 0.28) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), rgb(43 33 24 / 0.28) calc(50% + 60px), rgb(43 33 24 / 0.28) 92%, transparent) center / 100% 1px no-repeat;
  }

  .block h3 {
    margin: 0 0 6px;
    font-size: 24px;
    color: var(--ink);
  }

  .block .why {
    margin: 0 0 10px;
    font-size: var(--text-small);
    line-height: 1.45;
    color: var(--ink-soft);
  }

  .routes {
    display: grid;
    gap: 8px;
  }

  /* Each way is an illuminated entry: its device in a roundel of gold leaf, its name in the book's
     hand with a rubricated capital, inked round with a hairline. */
  .route {
    position: relative;
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 68px;
    padding: 8px 16px 8px 12px;
    /* Reached with Tab, a route scrolls clear of the fade at the letter's foot, its ring whole. */
    scroll-margin-block: 12px 34px;
    border-radius: 2px;
    border: 1px solid rgb(43 33 24 / 0.3);
    background: linear-gradient(180deg, rgb(255 251 238 / 0.55), rgb(255 248 228 / 0.3));
    box-shadow: inset 0 0 0 3px rgb(255 251 238 / 0.35), inset 0 0 0 4px rgb(43 33 24 / 0.1);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    transition: background var(--duration) var(--ease-out), border-color var(--duration) var(--ease-out),
      box-shadow var(--duration) var(--ease-out);
  }

  .route:hover:not(:disabled) {
    background: linear-gradient(180deg, rgb(255 251 238 / 0.9), rgb(255 244 218 / 0.6));
    border-color: rgb(43 33 24 / 0.5);
  }

  .route:disabled {
    cursor: not-allowed;
    opacity: 0.62;
  }

  .route[aria-pressed='true'] {
    background: linear-gradient(180deg, rgb(255 251 238 / 0.92), rgb(255 246 224 / 0.7));
    border-color: var(--oxblood);
    box-shadow: inset 4px 0 0 var(--oxblood), inset 0 0 0 4px rgb(123 30 43 / 0.12), 1px 4px 12px rgb(60 30 10 / 0.14);
  }

  .route:focus-visible {
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--candle);
  }

  /* The roundel: burnished gold leaf, its rim tooled, the device drawn on it in ink. */
  .well {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 1px solid #5a4019;
    background: radial-gradient(circle at 36% 30%, #fbedc0, #e0c071 40%, #b8944c 75%, #8a6a2c);
    box-shadow:
      inset 0 0 0 2px rgb(255 246 215 / 0.45),
      inset 0 0 0 3px rgb(90 64 25 / 0.45),
      1px 2px 3px rgb(60 36 12 / 0.35);
    color: var(--ink);
  }

  /* The chosen route is sealed in wax. */
  .route[aria-pressed='true'] .well {
    border-color: color-mix(in srgb, var(--oxblood) 55%, black);
    background: radial-gradient(circle at 36% 30%, color-mix(in srgb, var(--oxblood) 78%, #ffd2c4), var(--oxblood) 52%, var(--oxblood-2) 100%);
    color: var(--vellum);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--oxblood) 88%, #ffc0b0),
      inset 0 -2px 5px rgb(0 0 0 / 0.4),
      1px 3px 6px rgb(0 0 0 / 0.3);
  }

  .words {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .title {
    font-family: var(--font-display);
    font-size: 21px;
    line-height: 1.2;
  }

  .title::first-letter {
    color: var(--rubric);
  }

  .route[aria-pressed='true'] .title {
    padding-right: 84px;
  }

  .text {
    font-size: var(--text-small);
    line-height: 1.4;
    color: var(--ink-soft);
  }

  /* Shorter windows: every route stays in view with the intro, since choosing one is the point of
     this page (Section 10.4). */
  @media (max-height: 860px) {
    .scroll {
      padding-top: 18px;
    }
    /* The route texts and the tips under the mirror say what is needed; the routes come first. */
    .lede {
      display: none;
    }
    h2 {
      font-size: 28px;
      margin-bottom: 6px;
    }
    .block {
      margin-top: 14px;
      padding-top: 12px;
    }
    .block .why {
      margin-bottom: 10px;
    }
    .routes {
      gap: 7px;
    }
    .route {
      min-height: 0;
      gap: 12px;
      padding: 8px 14px 8px 10px;
      grid-template-columns: 40px minmax(0, 1fr);
    }
    .well {
      width: 40px;
      height: 40px;
    }
  }

  .mark {
    position: absolute;
    top: 13px;
    right: 14px;
    font-family: var(--font-label);
    font-size: 17px;
    letter-spacing: 0.04em;
    color: var(--oxblood);
  }

  /* What the mirror makes of the choice: a postscript set in a ruled box. */
  .live {
    margin-top: 14px;
    padding: 14px 16px;
    border-radius: 2px;
    background: rgb(120 84 36 / 0.07);
    border: 1px dashed rgb(43 33 24 / 0.3);
    display: grid;
    gap: 12px;
  }

  .live[data-trouble='true'] {
    border-style: solid;
    border-color: color-mix(in srgb, var(--oxblood) 55%, transparent);
    background: rgb(123 30 43 / 0.06);
  }

  .lines {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .line {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    line-height: 1.4;
  }

  .glyph {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-top: 2px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
  }

  /* Each tone has its own shape: a filled circle, a ring, a diamond, a square. */
  .glyph[data-tone='ok'] {
    border-radius: 50%;
    background: #2f6f64;
    color: #fff;
  }

  .glyph[data-tone='wait'] {
    border-radius: 50%;
    border: 1.5px solid #8a5a12;
    color: #8a5a12;
  }

  .glyph[data-tone='warn'] {
    background: #8a5a12;
    color: #fff;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  .glyph[data-tone='error'] {
    border-radius: 4px;
    background: var(--oxblood);
    color: var(--vellum);
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 34px;
  }

  /* Progress as a gilt rule filling an inked groove. */
  .bar {
    flex: 1;
    height: 7px;
    border-radius: 1px;
    background: rgb(43 33 24 / 0.14);
    box-shadow: inset 0 1px 2px rgb(43 33 24 / 0.35);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(180deg, #e9cf8a, #b8944c 60%, #8a6a2c);
    transition: width var(--duration) var(--ease-out);
  }

  .pct {
    min-width: 3.2em;
    text-align: right;
    font-size: var(--text-label);
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 10px;
    padding-left: 34px;
  }

  /* On the letter the switch is a box ruled in ink, ticked when on (components.css). */
  .light-switch {
    padding-top: 10px;
    border-top: 1px dashed rgb(43 33 24 / 0.24);
    font-size: var(--text-small);
    line-height: 1.4;
  }

  /* The hand route's postscript about the camera, ruled off as the wand's light switch is. */
  .hand-note {
    margin: 0;
    padding-top: 10px;
    border-top: 1px dashed rgb(43 33 24 / 0.24);
    font-size: var(--text-small);
    line-height: 1.4;
  }

  /* The foot of the letter, where it is sealed. */
  .foot {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px 16px;
    padding: 16px clamp(22px, 2.4vw, 36px) 18px;
    background:
      linear-gradient(90deg, transparent 4%, rgb(43 33 24 / 0.26) 20%, rgb(43 33 24 / 0.26) 80%, transparent 96%) top / 100% 1px no-repeat,
      linear-gradient(to bottom, rgb(233 223 199 / 0.2), rgb(214 198 162 / 0.6));
  }

  /* The seal that closes the letter: a heavier slab of wax and a larger seal. */
  .start {
    flex: none;
    min-width: 170px;
    min-height: 54px;
    padding: 8px 24px 8px 10px;
    font-size: var(--text-body);
  }

  .start::before {
    width: 38px;
    height: 38px;
  }

  .foot-note {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-family: var(--font-display);
    font-style: italic;
    font-size: 17px;
    line-height: 1.35;
    color: var(--ink-soft);
  }

  /* Written into the note in rubric and underlined, as a correction in the margin; its target reaches
     past the words to 44 px (Section 10.6). */
  .no-camera {
    position: relative;
    display: inline;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--rubric);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--rubric) 55%, transparent);
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .no-camera::after {
    content: '';
    position: absolute;
    inset: -12px -6px;
  }

  .no-camera:hover {
    text-decoration-thickness: 2px;
  }

  .no-camera:focus-visible {
    border-radius: 2px;
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--candle);
  }

  /* ------------------------------------------------------------------ tips under the mirror */

  .tips {
    grid-area: bottom;
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 12px;
    padding: 6px var(--stage-pr, 20px) 10px var(--stage-pl, 20px);
  }

  /* Small framed notes hung under the glass: dark leather with a tooled gilt rule. */
  .tip {
    padding: 14px 18px 16px;
    border-radius: 2px;
    background:
      radial-gradient(100% 80% at 20% 0%, rgb(255 214 150 / 0.06), transparent 70%),
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, var(--folio-2), var(--folio));
    background-blend-mode: normal, soft-light, normal;
    border: 1px solid #0b0806;
    outline: 1px solid color-mix(in srgb, var(--gilt) 42%, transparent);
    outline-offset: -6px;
    box-shadow: var(--shadow-hung);
  }

  .tip h3 {
    margin: 0 0 6px;
    font-family: var(--font-label);
    font-size: 19px;
    letter-spacing: 0.06em;
    color: var(--gilt-text);
  }

  .tip p {
    margin: 0;
    font-size: var(--text-small);
    line-height: 1.45;
    color: color-mix(in srgb, var(--vellum) 88%, var(--ash));
  }

  .rhythm {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1.25fr 1fr;
    align-items: start;
    text-align: center;
  }

  .rhythm li {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 2px;
    font-size: var(--text-small);
    line-height: 1.25;
    color: color-mix(in srgb, var(--vellum) 88%, var(--ash));
  }

  .rhythm svg {
    height: 36px;
    width: auto;
    overflow: visible;
  }

  .ring {
    fill: none;
    stroke: var(--brass);
    stroke-width: 1.6;
    stroke-dasharray: 3 3;
  }

  .dot {
    fill: var(--candle);
  }

  .swoosh {
    fill: none;
    stroke: var(--candle);
    stroke-width: 2.4;
    stroke-linecap: round;
    filter: drop-shadow(0 0 3px rgb(242 184 75 / 0.6));
  }
</style>
