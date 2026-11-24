<script lang="ts">
  // The shell frame (Section 10.3): the wordmark and status chips on top, the framed mirror in the
  // middle at the camera's aspect (so the shelf along its bottom is never cropped), the controls of
  // the current screen on the frame below it, and the unofficial notice (Section 10.7). The first run
  // puts its page beside the mirror, and so does the spell guide at home (under the Mirror bar on
  // narrow windows); drawers and the spellbook come in from the edges over it.
  import type { AppState } from './app-state.svelte';
  import { hostElement } from './actions';
  import { applyTheme } from './theme';
  import StatusChips from './components/StatusChips.svelte';
  import CastBanner from './components/CastBanner.svelte';
  import Captions from './components/Captions.svelte';
  import UpdatePrompt from './components/UpdatePrompt.svelte';
  import Toast from './components/Toast.svelte';
  import SessionLog from './components/shell/SessionLog.svelte';
  import MirrorNotes from './components/shell/MirrorNotes.svelte';
  import Celebration from './components/shell/Celebration.svelte';
  import GlassAnnouncer from './components/shell/GlassAnnouncer.svelte';
  import MirrorFrame from './components/shell/MirrorFrame.svelte';
  import ScreenLight, { screenLightFraction } from './components/shell/ScreenLight.svelte';
  import DiagnosticsOverlay from './components/tools/DiagnosticsOverlay.svelte';
  import SpellGuide from './components/guide/SpellGuide.svelte';
  import { workshopInbox, workshopView } from './components/tools/session-state.svelte';
  import Threshold from './screens/Threshold.svelte';
  import MirrorHome from './screens/Mirror.svelte';
  import Spellbook from './screens/Spellbook.svelte';
  import Practice from './screens/Practice.svelte';
  import WandTuning from './screens/WandTuning.svelte';
  import Keepsakes from './screens/Keepsakes.svelte';
  import Workshop from './screens/Workshop.svelte';
  import Replay from './screens/Replay.svelte';

  let { app }: { app: AppState } = $props();

  const aspect = $derived.by(() => {
    const c = app.cameraReady;
    return c && c.width > 0 && c.height > 0 ? c.width / c.height : 16 / 9;
  });

  /** The first run's page sits beside the mirror, so the mirror shows the result of each choice. */
  const side = $derived(app.screen === 'threshold');
  /** Screens that are the mirror at home (drawers open over it). */
  const atHome = $derived(app.screen !== 'threshold' && app.screen !== 'replay' && app.screen !== 'practice');
  /** The spell guide stays open beside the mirror at home, under drawers too, so opening one never
   *  resizes the mirror. Practice has its own guide on the glass; a replay and the first run have none. */
  const guide = $derived(atHome && app.spellGuideOpen);
  const lightHeight = $derived(app.settings['shell.screenLight'] ? `${screenLightFraction(app.settings['shell.screenLightHeight']) * 100}vh` : '0px');
  /** The Spellbook or an unfolded drawer is open: the room behind it is inert, so neither Tab nor a
   *  screen reader reaches the Mirror bar behind the scrim (Section 10.6). Whatever must still be said
   *  stays outside it: the toast, captions, the update prompt, and the cast banner and tier ribbon's
   *  words (GlassAnnouncer), since casting goes on under a drawer. So does the screen light's switch. */
  const behind = $derived(app.roomInert);
  /** The frame's width, so the controls below line up with its edges. */
  let frameWidth = $state(0);
  /** The glass's height. On a short glass the props fill the shelf's front edge, so the captions go
   *  on the frame's bottom rail instead (Captions.svelte). */
  let glassHeight = $state(0);
  const shortGlass = $derived(glassHeight > 0 && glassHeight < 400);
  /** Whenever the mirror is short of height rather than width (the guide open beside it, or a short
   *  window), a bar narrow enough to wrap onto more rows takes height from the mirror, which narrows
   *  it again, until the mirror is gone: the bar keeps at least the width at which it wraps no further
   *  (two rows), as far as the window allows (Mirror.svelte caps it at the space it has). */
  const BAR_MIN_W = 660;
  const barWidth = $derived(frameWidth ? `max(${frameWidth}px, ${BAR_MIN_W}px)` : null);

  $effect(() => {
    applyTheme(app.spellbook?.theme, app.settings);
  });

  // A file dropped on the app must never replace it (the browser's default opens the file in the tab).
  // While the Workshop is open it takes drops itself; otherwise the shell opens the Workshop for the
  // files (Section 11.1: "a friend drops it onto the Workshop screen"), once the first run is done.
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

  function onDragOver(e: DragEvent): void {
    if (app.screen === 'workshop' || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = app.screen === 'threshold' ? 'none' : 'copy';
  }

  function onDrop(e: DragEvent): void {
    if (app.screen === 'workshop' || !hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    if (app.screen === 'threshold') {
      app.notify('Start casting first, then drop the file on the Workshop.', 'warn');
      return;
    }
    workshopInbox.files = files;
    workshopView.tab = 'packs';
    app.go('workshop');
  }
</script>

<svelte:window
  onpointerdown={() => app.unlockAudio()}
  onkeydown={() => app.unlockAudio()}
  ondragenter={onDragOver}
  ondragover={onDragOver}
  ondrop={onDrop}
/>

<ScreenLight {app} />

<div
  class="room"
  data-screen={app.screen}
  class:with-side={side}
  class:at-home={atHome}
  class:with-guide={guide}
  class:candle-lit={app.candleLit}
  class:short-glass={shortGlass}
  style:--screen-light={lightHeight}
  style:--mirror-aspect={aspect}
>
  <!-- The candle's light on the wall, then the shadow gathering in the room's corners over it. -->
  <div class="candle-light" aria-hidden="true"><div class="flame-light"></div></div>
  <div class="vignette" aria-hidden="true"></div>

  <header class="topbar" inert={behind}>
    <h1 class="wordmark"><span class="wordmark-letters">Spellglass</span></h1>
    <StatusChips {app} />
  </header>

  <!-- The first run: its page takes the side column and its tips the space under the mirror. -->
  {#if side}<Threshold {app} />{/if}

  <main class="stage-area" aria-label="The mirror" inert={behind}>
    <div class="mirror-frame" class:with-log={atHome && app.log.length > 0} bind:clientWidth={frameWidth}>
      <MirrorFrame />
      <div class="mirror-glass" use:hostElement={app.mirror} bind:clientHeight={glassHeight}></div>
      {#if atHome}<SessionLog {app} />{/if}
      <div class="glass-top">
        {#if app.screen === 'mirror'}<MirrorNotes {app} />{/if}
        <CastBanner {app} />
        <Celebration {app} />
      </div>
    </div>
  </main>

  {#if !side}
    <div class="bottom" style:--frame-w={barWidth} inert={behind}>
      {#if app.screen === 'practice'}
        <Practice {app} />
      {:else if app.screen === 'replay'}
        <!-- A new link while a replay is showing starts the screen afresh. -->
        {#key app.replayHash}<Replay {app} />{/key}
      {:else}
        <MirrorHome {app} />
      {/if}
    </div>
  {/if}

  <!-- The spell guide, after the Mirror bar in reading order: beside the mirror on wide windows, under
       the bar on narrow ones. Inert only with the rest of the room, behind the Spellbook or a drawer. -->
  {#if guide}
    <div class="guide-slot" style:--frame-w={frameWidth ? `${frameWidth}px` : null} inert={behind}>
      <SpellGuide {app} />
    </div>
  {/if}

  <footer class="notice" inert={behind}>
    Spellglass is an unofficial fan project. It is not affiliated with or endorsed by Warner Bros. or Universal.
  </footer>

  <!-- Drawers and pages that come in over the mirror; a zero-size cell keeps them out of the layout. -->
  <div class="overlays">
    {#if app.screen === 'spellbook'}<Spellbook {app} />{/if}
    {#if app.screen === 'tuning'}<WandTuning {app} />{/if}
    {#if app.screen === 'keepsakes'}<Keepsakes {app} />{/if}
    {#if app.screen === 'workshop'}<Workshop {app} />{/if}
  </div>

  <GlassAnnouncer {app} />
  <Captions {app} />
  <!-- Live numbers while 'diagnostics.overlay' is on (session-only); renders nothing otherwise. -->
  <DiagnosticsOverlay {app} />
  <Toast {app} />
  <UpdatePrompt {app} />
</div>

<style>
  .room {
    /* The mirror at the camera's aspect, and the height it takes when the width limits it, so the
       mirror and the controls under it are centered as one group (the spare rows share the rest). */
    --side-w: 0px;
    --stage-pl: clamp(10px, 2vw, 28px);
    --stage-pr: clamp(10px, 2vw, 28px);
    /* The frame's thickness: wide enough for its mouldings to read (MirrorFrame draws them), and
       heavier on a wide window, as an heirloom's frame is; small windows keep their glass. */
    --pad: clamp(12px, 3.1vmin + max(0px, (100vw - 1200px) * 0.04), 40px);
    /* --bar-w: the Mirror bar's column beside the mirror, in short windows only. */
    --mirror-h: calc((100vw - var(--side-w) - var(--bar-w, 0px) - var(--stage-pl) - var(--stage-pr) - 2 * var(--pad)) / var(--mirror-aspect) + 2 * var(--pad) + 8px);
    position: relative;
    height: 100%;
    display: grid;
    grid-template-columns: var(--side-w) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) minmax(0, var(--mirror-h)) auto minmax(0, 1fr) auto;
    grid-template-areas:
      'top top'
      'side .'
      'side stage'
      'side bottom'
      'side .'
      'foot foot';
    /* Route A's screen light takes the top of the window; the room moves down under it. */
    padding-top: var(--screen-light, 0px);
    /* The study at night: a wall of cut stone, cold where the light does not reach, and a faint cool
       rim of moonlight from the upper right. The candle's warm light (.candle-light) and the shadow in
       the corners (.vignette) are layers of their own over it. */
    background:
      radial-gradient(40% 36% at 100% 0%, rgb(150 168 214 / 0.07), transparent 75%),
      var(--tex-stone) 0 0 / 640px 384px,
      var(--stone);
    overflow: hidden;
  }

  /* A pool of warm candlelight rising from the mantel under the mirror, low on the left where the
     candle stands. It follows the stage's candle (AppState.candleLit): while the candle is out only a
     little warmth is left on the wall, from the embers and the room beyond, and nothing flickers;
     Incendio brings the light up over a moment, and the flicker with it. */
  .candle-light {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(46% 38% at 30% 84%, rgb(242 170 72 / 0.17), rgb(217 142 43 / 0.06) 55%, transparent 80%),
      radial-gradient(70% 50% at 42% 100%, rgb(168 82 28 / 0.14), transparent 70%);
    opacity: 0.4;
    transition: opacity calc(var(--duration) * 3.5) var(--ease-out);
  }

  .room.candle-lit .candle-light {
    opacity: 1;
  }

  /* Deep shadow in the corners, over the candlelight as well as the stone. */
  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(130% 115% at 46% 48%, transparent 38%, rgb(4 3 7 / 0.55) 74%, rgb(3 2 5 / 0.92) 100%);
  }

  /* The first run: its page in a side column beside the mirror. */
  .room.with-side {
    --side-w: clamp(390px, 38vw, 560px);
    --stage-pl: clamp(14px, 1.6vw, 24px);
  }

  /* At home with the spell guide open: the guide takes the side column, narrower than the first run's
     page, and the mirror shrinks beside it. The slot spans the mirror's row and its bar's, so the guide
     lines up with the frame; contain: size keeps a long list of spells from sizing those rows (the
     list scrolls inside instead). */
  .room.with-guide {
    --side-w: clamp(280px, 25vw, 380px);
    --stage-pl: clamp(12px, 1.4vw, 22px);
  }

  .guide-slot {
    grid-column: 1;
    grid-row: 3 / 5;
    position: relative;
    z-index: 2;
    min-width: 0;
    min-height: 0;
    contain: size;
    padding: 4px 0 4px clamp(10px, 2vw, 28px);
  }

  /* Portrait and squarish windows (phones, tablets held upright): the guide is a strip under the
     Mirror bar, as wide as the frame. There the mirror is short of width, not height, so the strip
     costs it nothing: the mirror keeps its size first and the strip takes what is left, at least one
     row of cards, scrolling inside. Every wider window keeps the column, a laptop's small window too
     (900 by 700): a strip there took two thirds of the glass and showed a single spell. */
  @media (max-aspect-ratio: 6/5) {
    .room.with-guide {
      --side-w: 0px;
      --stage-pl: clamp(10px, 2vw, 28px);
      grid-template-rows: auto 0 minmax(0, var(--mirror-h)) auto minmax(180px, 1fr) 0 auto;
      grid-template-areas:
        'top top'
        'side .'
        'side stage'
        'side bottom'
        'side guide'
        'side .'
        'foot foot';
    }

    /* As wide as the frame, and like the Mirror bar never narrower than 640 px where the window
       allows: a mirror short of height narrows its frame, and a strip as narrow would stack its head
       and show no card whole. */
    .guide-slot {
      grid-area: guide;
      justify-self: center;
      width: min(calc(100% - 2 * var(--stage-pr)), max(var(--frame-w, 100%), 640px));
      padding: 2px 0 8px;
    }
  }

  /* Short, wide windows (a phone on its side): height is what they lack. At home the Mirror bar
     stands in a column of its own beside the mirror, one control a row, from the top of the window
     beside the wordmark and the tags, so the glass keeps the whole height under the top bar instead of
     sharing it with two rows of controls. Practice and a replay keep their panel under the mirror,
     which is laid out for a wide row.
     The column costs width, so it is used only where it leaves the larger glass (measured): with the
     guide closed, on windows 8:5 or wider; with the guide's column open as well, only where the bar
     under the mirror would wrap to four rows beside it (narrow windows, 7:4 or wider) or the window is
     wider still (21:10). The rules are the same for both, written out for each. */
  @media (max-height: 560px) and (min-aspect-ratio: 8/5) {
    .room.at-home:not(.with-guide) {
      --bar-w: clamp(212px, 26vw, 248px);
      grid-template-columns: var(--side-w) minmax(0, 1fr) var(--bar-w);
      grid-template-rows: auto minmax(0, 1fr) minmax(0, var(--mirror-h)) minmax(0, 1fr) auto;
      grid-template-areas:
        'top top bottom'
        'side . bottom'
        'side stage bottom'
        'side . bottom'
        'foot foot foot';
    }

    /* The column scrolls, should the window be shorter still than its controls. */
    .room.at-home:not(.with-guide) .bottom {
      --stage-pr: 0px;
      align-self: center;
      max-height: 100%;
      overflow-y: auto;
      padding: 4px clamp(10px, 2vw, 20px) 2px 2px;
    }
  }

  @media (max-height: 560px) and (min-aspect-ratio: 21/10), (max-height: 560px) and (max-width: 900px) and (min-aspect-ratio: 7/4) {
    /* The guide's column narrows to leave the mirror room between the two. */
    .room.at-home.with-guide {
      --side-w: clamp(240px, 28vw, 320px);
      --bar-w: clamp(212px, 26vw, 248px);
      grid-template-columns: var(--side-w) minmax(0, 1fr) var(--bar-w);
      grid-template-rows: auto minmax(0, 1fr) minmax(0, var(--mirror-h)) minmax(0, 1fr) auto;
      grid-template-areas:
        'top top bottom'
        'side . bottom'
        'side stage bottom'
        'side . bottom'
        'foot foot foot';
    }

    .room.at-home.with-guide .guide-slot {
      grid-row: 2 / 5;
      padding-bottom: 8px;
    }

    .room.at-home.with-guide .bottom {
      --stage-pr: 0px;
      align-self: center;
      max-height: 100%;
      overflow-y: auto;
      padding: 4px clamp(10px, 2vw, 20px) 2px 2px;
    }
  }

  /* The only ambient motion: the candle's flicker (Section 10.6), on the wall round the mantel's
     candle, low on the left, and only while its flame burns. */
  .flame-light {
    position: absolute;
    left: -14vmax;
    bottom: -30vmax;
    width: 80vmax;
    height: 70vmax;
    background: radial-gradient(closest-side at 50% 50%, rgb(242 184 75 / 0.12), rgb(242 184 75 / 0.04) 55%, transparent);
    opacity: 0.85;
  }

  .room.candle-lit .flame-light {
    animation: flicker 5.5s ease-in-out infinite;
  }

  @keyframes flicker {
    0%, 100% { opacity: 0.85; }
    18% { opacity: 1; }
    37% { opacity: 0.78; }
    52% { opacity: 0.95; }
    71% { opacity: 0.82; }
  }

  :global(:root[data-motion='reduced']) .room.candle-lit .flame-light {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .room.candle-lit .flame-light {
      animation: none;
    }
  }

  .topbar {
    grid-area: top;
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 16px;
    padding: 10px clamp(14px, 2.4vw, 34px) 6px;
  }

  /* The wordmark: lettered in gold leaf on a small plaque of black lacquer with scooped corners and a
     gilt rim, a flourish at either end. The letters are the heading's own text, filled with gold. */
  .wordmark {
    position: relative;
    margin: 0 30px;
    padding: 4px 18px 5px;
    font-family: var(--font-ornate);
    font-weight: 700;
    font-size: 24px;
    line-height: 1.3;
    letter-spacing: 0.05em;
    color: var(--gilt-text);
    border-radius: 9px;
    corner-shape: scoop;
    background:
      radial-gradient(90% 120% at 30% 0%, rgb(255 220 160 / 0.08), transparent 60%),
      var(--tex-grain) 0 0 / 180px,
      linear-gradient(180deg, #17110c, #0c0907);
    background-blend-mode: normal, soft-light, normal;
    box-shadow:
      inset 0 0 0 1px #070504,
      inset 0 0 0 2.5px #b8944c,
      inset 0 0 0 4px #120d09,
      inset 0 0 0 5px rgb(201 163 86 / 0.4),
      2px 5px 12px rgb(0 0 0 / 0.65);
  }

  .wordmark-letters {
    background: linear-gradient(180deg, #fbebb8 10%, #e0c071 42%, #a9843a 58%, #e9cf8a 86%) text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 1px 0 rgb(0 0 0 / 0.9));
  }

  /* Gilt flourishes either side of the plaque. */
  .wordmark::after {
    content: '';
    position: absolute;
    inset: 0 -30px;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 24'%3E%3Cg fill='none' stroke='%23c9a356' stroke-linecap='round'%3E%3Cpath d='M30 12C22 12 18 6 12 6C7 6 5 10 7 13C9 16 13 14 12 11' stroke-width='1.6'/%3E%3Cpath d='M30 12C24 13 21 18 15 19C11 20 7 19 5 16' stroke-width='1.1' stroke-opacity='.7'/%3E%3C/g%3E%3Ccircle cx='2.6' cy='12' r='1.6' fill='%23c9a356'/%3E%3C/svg%3E") left center / 30px 24px no-repeat,
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 24'%3E%3Cg fill='none' stroke='%23c9a356' stroke-linecap='round'%3E%3Cpath d='M0 12C8 12 12 6 18 6C23 6 25 10 23 13C21 16 17 14 18 11' stroke-width='1.6'/%3E%3Cpath d='M0 12C6 13 9 18 15 19C19 20 23 19 25 16' stroke-width='1.1' stroke-opacity='.7'/%3E%3C/g%3E%3Ccircle cx='27.4' cy='12' r='1.6' fill='%23c9a356'/%3E%3C/svg%3E") right center / 30px 24px no-repeat;
    pointer-events: none;
  }

  .stage-area {
    grid-area: stage;
    position: relative;
    z-index: 1;
    min-height: 0;
    min-width: 0;
    display: grid;
    place-items: center;
    padding: 4px var(--stage-pr) 4px var(--stage-pl);
    container-type: size;
    /* The glass's height, as .mirror-frame sizes it, for what is laid out on the glass (the session
       log keeps to its top half). The container units resolve where it is used, against this area. */
    --glass-h: calc((min(100cqw, (100cqh - 2 * var(--pad)) * var(--mirror-aspect) + 2 * var(--pad)) - 2 * var(--pad)) / var(--mirror-aspect));
    /* The session log's width in the glass's top right corner. */
    --log-w: 224px;
  }

  /* The frame is carved and gilded (MirrorFrame draws it over this box, under the glass); the box
     gives it its thickness and hangs it on the wall: a dark gap at its edge, its shadow falling to
     the lower right, away from the candle. The gradient is what shows before the drawing is sized. */
  .mirror-frame {
    position: relative;
    width: min(100cqw, calc((100cqh - 2 * var(--pad)) * var(--mirror-aspect) + 2 * var(--pad)));
    padding: var(--pad);
    border-radius: 2px;
    background: linear-gradient(160deg, #e3c67f 0%, #8a6a2c 30%, #c9a356 55%, #5a4019 100%);
    box-shadow:
      0 0 0 1px #0d0905,
      8px 16px 34px rgb(3 5 14 / 0.66),
      2px 4px 8px rgb(3 4 10 / 0.52),
      -6px 10px 60px rgb(242 160 60 / 0.03);
    transition: box-shadow calc(var(--duration) * 3.5) var(--ease-out);
  }

  /* The burning candle's glow on the wall round the frame's near side. */
  .room.candle-lit .mirror-frame {
    box-shadow:
      0 0 0 1px #0d0905,
      8px 16px 34px rgb(3 5 14 / 0.66),
      2px 4px 8px rgb(3 4 10 / 0.52),
      -6px 10px 60px rgb(242 160 60 / 0.09);
  }

  /* The glass sits in the frame's sight edge, over the frame's drawing. */
  .mirror-glass {
    position: relative;
    z-index: 1;
    aspect-ratio: var(--mirror-aspect);
    width: 100%;
    overflow: hidden;
    border-radius: 2px;
    /* What shows before the stage first draws: the glass's own tone (tokens.css). */
    background: var(--glass);
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.85);
    /* The captions, outside the room, sit at its foot (Captions.svelte). */
    anchor-name: --glass;
    touch-action: none;
  }

  /* The top edge of the glass: the mirror's notes, then the cast banner, then celebrations. Only their
     buttons take pointer events, so tracing on the glass is never blocked. */
  .glass-top {
    position: absolute;
    z-index: 3;
    top: calc(var(--pad) + 12px);
    /* Centred by its margins, not a transform: the update prompt anchors to its box, and an anchor's
       box is laid out without its transform. */
    left: 0;
    right: 0;
    margin-inline: auto;
    width: min(88%, 780px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: none;
    /* What it holds lays itself out by the width it is given (the banner breaks between the name and
       the grade, a celebration puts its buttons under its words). */
    container: glass-top / inline-size;
    /* The update prompt, outside the room, hangs under it (UpdatePrompt.svelte). */
    anchor-name: --glass-top;
  }

  /* With the session log in the glass's top right corner (SessionLog shows it on mirrors over 980 px
     wide), the notes, the banner and a celebration stay centred but keep out of that corner, so the
     two never overlap: as wide as the glass less the log's corner on both sides. */
  @container (min-width: 981px) {
    .mirror-frame.with-log .glass-top {
      width: min(88%, 780px, 100% - 2 * (var(--log-w) + var(--pad) + 26px));
    }
  }

  .bottom {
    grid-area: bottom;
    position: relative;
    z-index: 2;
    min-width: 0;
  }

  /* The unofficial notice (Section 10.7), lettered small at the foot of the wall. */
  .notice {
    grid-area: foot;
    position: relative;
    z-index: 1;
    padding: 2px 16px 8px;
    text-align: center;
    font-family: var(--font-display);
    font-style: italic;
    font-size: var(--text-label);
    line-height: 1.4;
    color: var(--ash);
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  }

  .overlays {
    grid-area: 1 / 1 / 2 / 2;
    width: 0;
    height: 0;
  }

  @media (max-height: 560px) {
    .notice {
      display: none;
    }
    .wordmark {
      font-size: 24px;
    }
  }
</style>
