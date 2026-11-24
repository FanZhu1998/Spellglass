<script lang="ts">
  // The Workshop (Section 10.4): settings, packs, redrawing a gesture, bindings, your data and
  // diagnostics, as tabs in a wide drawer from the right. A pack file dropped anywhere on the Workshop is
  // imported (Section 11.1). Flows that need the mirror (drawing a gesture, recording a session) fold the
  // drawer down to a bar on the frame, so it never covers the glass while you cast (Section 10.3); the
  // drawer stays mounted behind the bar, so nothing in it is lost.
  import { untrack } from 'svelte';
  import type { Point } from '../../contracts';
  import { geometry, isReducedMotion, watchReducedMotion } from '../../kernel';
  import type { AppState } from '../app-state.svelte';
  import Drawer from '../components/Drawer.svelte';
  import StrokePath from '../components/StrokePath.svelte';
  import CollapsedBar from '../components/tools/CollapsedBar.svelte';
  import { workshopInbox, workshopView } from '../components/tools/session-state.svelte';
  import BindingsTab from '../components/tools/workshop/BindingsTab.svelte';
  import DataTab from '../components/tools/workshop/DataTab.svelte';
  import DiagnosticsTab from '../components/tools/workshop/DiagnosticsTab.svelte';
  import GesturesTab from '../components/tools/workshop/GesturesTab.svelte';
  import { Imports } from '../components/tools/workshop/imports.svelte';
  import PacksTab from '../components/tools/workshop/PacksTab.svelte';
  import { recording } from '../components/tools/workshop/recording.svelte';
  import { Redraw } from '../components/tools/workshop/redraw.svelte';
  import SettingsTab from '../components/tools/workshop/SettingsTab.svelte';
  import TabIcon from '../components/tools/workshop/TabIcon.svelte';
  import { isWorkshopTab, type WorkshopTab } from '../components/tools/workshop/types';
  import { batchSummary } from '../components/tools/workshop/words';

  let { app }: { app: AppState } = $props();

  // ------------------------------------------------------------------ announcements
  let announcement = $state('');
  function announce(text: string): void {
    // Clear first, so the same sentence twice is read twice.
    announcement = '';
    queueMicrotask(() => (announcement = text));
  }

  let reduced = $state(untrack(() => isReducedMotion(app.kernel)));
  $effect(() => watchReducedMotion(app.kernel, (r) => (reduced = r)));

  // ------------------------------------------------------------------ tabs
  const TABS: { id: WorkshopTab; label: string }[] = [
    { id: 'settings', label: 'Settings' },
    { id: 'packs', label: 'Packs' },
    { id: 'gestures', label: 'Gestures' },
    { id: 'bindings', label: 'Bindings' },
    { id: 'data', label: 'Your data' },
    { id: 'diagnostics', label: 'Diagnostics' },
  ];

  // A running recording opens the Workshop where it can be stopped.
  if (untrack(() => recording.active)) workshopView.tab = 'diagnostics';
  const tab = $derived<WorkshopTab>(isWorkshopTab(workshopView.tab) ? workshopView.tab : 'settings');
  const tabEls: HTMLButtonElement[] = $state([]);
  let panelEl = $state<HTMLElement | null>(null);

  function select(id: WorkshopTab, focus = false): void {
    if (workshopView.tab !== id && panelEl) panelEl.scrollTop = 0;
    workshopView.tab = id;
    if (focus) tabEls[TABS.findIndex((t) => t.id === id)]?.focus();
  }

  /** The WAI-ARIA tabs keys: arrows move and choose, Home and End go to the ends. */
  function tabKeys(e: KeyboardEvent, i: number): void {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(TABS[next].id, true);
  }

  const skipped = $derived(app.spellbook?.packs.filter((p) => !!p.error).length ?? 0);

  // ------------------------------------------------------------------ state that outlives a tab
  const redraw = new Redraw();
  const imports = new Imports();

  // ------------------------------------------------------------------ folding down to the frame
  /** The player chose to cast in the mirror while a session records. */
  let castFold = $state(false);
  const drawing = $derived(redraw.phase === 'drawing');
  const recordingFold = $derived(castFold && recording.active && !drawing);
  const folded = $derived(drawing || recordingFold);

  // Folded, the drawer gives the room back: the stroke is drawn on the mirror, and the Mirror bar is
  // live again (AppState.roomInert).
  $effect(() => {
    if (folded) app.foldedDrawer = 'workshop';
    return () => {
      if (app.foldedDrawer === 'workshop') app.foldedDrawer = null;
    };
  });

  // When the drawer unfolds, focus goes back to the flow's own next step (marked data-after-fold), or
  // to the current tab, once the drawer is interactive again.
  let wasFolded = false;
  $effect(() => {
    const f = folded;
    if (wasFolded && !f) {
      untrack(() =>
        setTimeout(() => {
          const target = panelEl?.querySelector<HTMLElement>('[data-after-fold]:not(:disabled)') ?? tabEls[TABS.findIndex((t) => t.id === tab)];
          target?.focus({ preventScroll: false });
        }, 40),
      );
    }
    wasFolded = f;
  });

  $effect(() => {
    if (!recording.active) castFold = false;
  });

  // Closing the Workshop ends a drawing that is still waiting for its stroke.
  $effect(() => () => {
    untrack(() => {
      if (redraw.phase === 'drawing') redraw.cancel(app);
    });
  });

  function close(): void {
    if (drawing) {
      redraw.cancel(app);
      return;
    }
    if (recordingFold) {
      castFold = false;
      return;
    }
    // A recording goes on without the Workshop (it counts every stroke); say where to stop it.
    if (recording.active) app.notify('The session is still recording. Open the Workshop to stop and save it.');
    app.go('mirror');
  }

  // The drawing bar: a countdown, the shape being redrawn, and what the tracker needs.
  let now = $state(Date.now());
  $effect(() => {
    if (!drawing) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });
  const secondsLeft = $derived(Math.max(0, Math.ceil((redraw.endsAt - now) / 1000)));
  const drawingEntry = $derived(redraw.spellId ? app.entry(redraw.spellId) : null);
  const drawingPoints = $derived.by((): Point[] => {
    const e = drawingEntry;
    if (!e) return [];
    const g = e.spell.gesture;
    return 'flick' in g ? geometry.flickPath(g.flick) : (e.templates[0] ?? []);
  });
  const pen = $derived(app.segmenter?.mode === 'pen' || app.tracker?.pen === true);
  const trackerHint = $derived.by(() => {
    switch (app.tracker?.hint) {
      case 'tip-not-found':
        return 'Wand tip not found. Point the tip at the camera and switch on the light beside the lens.';
      case 'hand-not-found':
        return 'Hand not found. Hold your hand up where the camera can see it, in good light.';
      case 'hand-too-small':
        return 'Your hand looks small to the camera. Step closer, or zoom the camera in.';
      case 'too-many-lights':
        return 'Too many bright lights in view. Dim the lamps behind you, or tune the wand.';
      default:
        return null;
    }
  });

  // Drawing finished: say what happened (the result is on the Gestures tab).
  let lastPhase = untrack(() => redraw.phase);
  $effect(() => {
    const p = redraw.phase;
    if (lastPhase === 'drawing' && p !== 'drawing') {
      untrack(() => {
        if (p === 'captured') announce('Drawing captured. It is shown beside the one in use.');
        else if (redraw.note) announce(redraw.note.text);
      });
    }
    lastPhase = p;
  });

  // The recording bar.
  const castable = $derived((app.spellbook?.spells ?? []).filter((e) => e.enabled).map((e) => e.spell.id));
  const recordingName = $derived(recording.intended ? app.spellName(recording.intended) : '');

  async function nextSpell(): Promise<void> {
    const id = recording.nextOf(castable);
    if (!id) return;
    await recording.label(app, id);
    announce(`Now cast ${app.spellName(id)}.`);
  }

  async function stopAndSave(): Promise<void> {
    castFold = false;
    select('diagnostics');
    await recording.stop(app);
    if (recording.saved) announce(`Recording saved as ${recording.saved.filename}.`);
    else if (recording.error) announce(recording.error);
  }

  // ------------------------------------------------------------------ dropping files on the Workshop
  let dragging = $state(false);
  let dragTimer: ReturnType<typeof setTimeout> | null = null;

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }

  // While the Workshop is open a file dropped anywhere is meant for it: the browser must not open it in
  // place of the app.
  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = folded ? 'none' : 'copy';
    if (folded) return;
    dragging = true;
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = setTimeout(() => (dragging = false), 180);
  }

  async function onDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = false;
    if (folded) return;
    await importFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  // Files the shell caught while the Workshop was closed (it opened the Workshop for them).
  $effect(() => {
    const waiting = workshopInbox.files;
    if (!waiting.length) return;
    workshopInbox.files = [];
    void importFiles(waiting);
  });

  /** Dropped or chosen with "Choose a pack file", files are sorted the same way (a data export goes to
   *  Your data to be confirmed), and the whole batch is announced, failures included. */
  async function importFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const batch = await imports.files(app, files);
    if (!batch) return;
    select(batch.where);
    announce(batchSummary(batch));
  }

  $effect(() => () => {
    if (dragTimer) clearTimeout(dragTimer);
  });
</script>

<svelte:window ondragenter={onDragOver} ondragover={onDragOver} ondrop={onDrop} />

<div class="tool-drawer" class:folded inert={folded}>
  <Drawer title="Workshop" width={980} onclose={close}>
    <div class="workshop">
      <div class="tabs" role="tablist" aria-label="Workshop sections">
        {#each TABS as t, i (t.id)}
          <button
            bind:this={tabEls[i]}
            class="tab"
            type="button"
            role="tab"
            id="ws-tab-{t.id}"
            aria-selected={tab === t.id}
            aria-controls="ws-panel"
            tabindex={tab === t.id ? 0 : -1}
            onclick={() => select(t.id)}
            onkeydown={(e) => tabKeys(e, i)}
          >
            <TabIcon name={t.id} />
            <span class="tab-label">{t.label}</span>
            {#if t.id === 'packs' && skipped}
              <span class="badge warn" aria-hidden="true"></span><span class="visually-hidden">, {skipped} skipped</span>
            {:else if t.id === 'diagnostics' && recording.active}
              <span class="badge rec" aria-hidden="true"></span><span class="visually-hidden">, recording</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="ws-panel" id="ws-panel" role="tabpanel" aria-labelledby="ws-tab-{tab}" tabindex="-1" bind:this={panelEl} data-tab={tab}>
        {#if tab === 'settings'}
          <SettingsTab {app} {announce} />
        {:else if tab === 'packs'}
          <PacksTab {app} {imports} {announce} onfiles={importFiles} />
        {:else if tab === 'gestures'}
          <GesturesTab {app} {redraw} {announce} reducedMotion={reduced} />
        {:else if tab === 'bindings'}
          <BindingsTab {app} />
        {:else if tab === 'data'}
          <DataTab {app} {imports} {announce} />
        {:else}
          <DiagnosticsTab {app} {announce} oncast={() => (castFold = true)} />
        {/if}
      </div>
    </div>
  </Drawer>
</div>

{#if drawing}
  <CollapsedBar label="Drawing a gesture">
    {#snippet lead()}
      <span class="bar-thumb" aria-hidden="true"><StrokePath points={drawingPoints} size={44} tone="light" label="" /></span>
    {/snippet}
    <span class="bar-main">
      {#if pen}
        Press on the mirror, trace <strong>{drawingEntry?.spell.incantation ?? 'the spell'}</strong> once, then let go.
      {:else}
        Hold still, trace <strong>{drawingEntry?.spell.incantation ?? 'the spell'}</strong> once, then hold still.
      {/if}
    </span>
    <span class="bar-note">{trackerHint ?? `Nothing is cast while you draw · ${secondsLeft} s left`}</span>
    {#snippet actions()}
      <button class="btn" type="button" onclick={() => redraw.cancel(app)}>Cancel</button>
    {/snippet}
  </CollapsedBar>
{:else if recordingFold}
  <CollapsedBar label="Recording a session" tone="recording" wide>
    <span class="bar-main">
      Recording. Cast {#if recordingName}<strong>{recordingName}</strong>{:else}any spell{/if}.
    </span>
    <span class="bar-note">
      {#if recording.intended}{recording.forSpell} for {recordingName}, {recording.total} in all{:else}{recording.total} recorded{/if}
      {#if recording.last}
        · <span class="last" data-ok={recording.last.ok}><span class="mark" aria-hidden="true">{recording.last.ok ? '✓' : '✕'}</span> {recording.last.text}</span>
      {/if}
      {#if recording.interrupted}· The tracker changed, so the recording stopped.{/if}
    </span>
    {#snippet actions()}
      <button class="btn" type="button" onclick={nextSpell} disabled={recording.busy || castable.length === 0}>Next spell</button>
      <button class="btn btn-seal" type="button" onclick={stopAndSave} disabled={recording.busy}>Stop and save</button>
      <button class="btn btn-ghost" type="button" onclick={() => (castFold = false)}>Back to the Workshop</button>
    {/snippet}
  </CollapsedBar>
{/if}

{#if dragging && !folded}
  <div class="drop-hint" aria-hidden="true">
    <div class="drop-card">
      <TabIcon name="packs" size={40} />
      <p class="drop-title">Drop the file to import it</p>
      <p class="drop-text">Spell packs, gesture packs, themes, or a file from Export my data.</p>
    </div>
  </div>
{/if}

<p class="visually-hidden" aria-live="polite">{announcement}</p>

<style>
  /* While a flow needs the mirror the drawer slides away but stays mounted, keeping its state. */
  .tool-drawer :global(.drawer) {
    transition: transform var(--duration) var(--ease-out);
  }

  .tool-drawer.folded :global(.drawer) {
    transform: translateX(105%);
  }

  .tool-drawer.folded :global(.drawer-scrim) {
    opacity: 0;
    pointer-events: none;
  }

  .workshop {
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }

  /* Ledger tabs along the top edge of the folio, under its title: leather tabs, the open one raised
     and lettered in gilt. */
  .tabs {
    display: flex;
    gap: 3px;
    margin: -14px -24px 0 -28px;
    padding: 8px 18px 0 22px;
    border-bottom: 1px solid color-mix(in srgb, var(--gilt) 40%, transparent);
    background: linear-gradient(to bottom, rgb(0 0 0 / 0.08), rgb(0 0 0 / 0.28));
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 50px;
    padding: 8px 14px 8px 12px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 5px 5px 0 0;
    corner-shape: bevel bevel square square;
    background: transparent;
    color: var(--ash);
    font-family: var(--font-text);
    font-size: var(--text-body);
    line-height: 1.2;
    cursor: pointer;
    transition: color var(--duration) var(--ease-out), background var(--duration) var(--ease-out);
  }

  .tab:hover {
    color: var(--vellum);
    background: linear-gradient(180deg, rgb(255 230 180 / 0.05), transparent);
  }

  .tab[aria-selected='true'] {
    color: var(--gilt-text);
    border-color: color-mix(in srgb, var(--gilt) 45%, transparent);
    background:
      linear-gradient(180deg, rgb(255 230 180 / 0.07), transparent 70%),
      linear-gradient(180deg, var(--folio-2), var(--folio));
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.7);
  }

  .tab[aria-selected='true'] :global(.tab-icon) {
    color: var(--candle);
  }

  /* The chosen tab is marked by a candle rule and a heavier label, not by color alone. */
  .tab[aria-selected='true']::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: -1px;
    height: 3px;
    border-radius: 3px 3px 0 0;
    background: var(--candle);
  }

  .tab[aria-selected='true'] .tab-label {
    font-weight: 600;
  }

  .tab:focus-visible {
    box-shadow: inset 0 0 0 2px var(--candle);
  }

  /* Narrower than the drawer: the labels alone, so every tab stays in view. */
  @media (max-width: 860px) {
    .tabs {
      padding-inline: 8px;
    }
    .tab {
      padding-inline: 10px;
    }
    .tab :global(.tab-icon) {
      display: none;
    }
  }

  .badge {
    width: 9px;
    height: 9px;
    margin-left: -2px;
  }

  .badge.warn {
    border: 1.5px solid var(--candle);
    transform: rotate(45deg) scale(0.9);
  }

  .badge.rec {
    border-radius: 50%;
    background: #d9475a;
    box-shadow: 0 0 0 3px rgb(217 71 90 / 0.25);
  }

  .ws-panel {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 22px 8px 6px 2px;
    container-type: inline-size;
  }

  /* ---------------------------------------------------------------- shared by the tabs */

  /* Two columns where the drawer is wide (it is at 900 px and up), one below. */
  .workshop :global(.ws-cols) {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0 34px;
    align-items: start;
  }

  @container (min-width: 800px) {
    .workshop :global(.ws-cols) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .workshop :global(.ws-col) {
    display: grid;
    align-content: start;
    min-width: 0;
  }

  .workshop :global(.ws-stack) {
    display: grid;
    gap: 8px;
  }

  .workshop :global(.ws-help) {
    margin: 0;
    font-size: var(--text-small);
    line-height: 1.45;
    color: var(--ash);
  }

  .workshop :global(.ws-setting) {
    display: grid;
    gap: 0;
  }

  /* Help under a switch lines up with the switch's label (46 px switch, 12 px gap). */
  .workshop :global(.ws-setting > .ws-help) {
    margin-top: -6px;
    padding-left: 58px;
  }

  .workshop :global(.ws-switch-text),
  .workshop :global(.ws-label) {
    font-size: var(--text-body);
    color: var(--vellum);
  }

  .workshop :global(.ws-actions) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
  }

  .workshop :global(.ws-field-row) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
  }

  .workshop :global(.btn-danger) {
    border-color: color-mix(in srgb, #e8828c 60%, transparent);
    color: #f3c2c7;
  }

  .workshop :global(.btn-danger:hover) {
    filter: brightness(1.15);
    border-color: #e8828c;
  }

  .workshop :global(.btn-danger-quiet) {
    background: transparent;
    border-color: color-mix(in srgb, #e8828c 35%, transparent);
    color: #f3c2c7;
  }

  .workshop :global(.btn-danger-quiet:hover) {
    background: color-mix(in srgb, #e8828c 10%, transparent);
    border-color: color-mix(in srgb, #e8828c 70%, transparent);
  }

  /* ---------------------------------------------------------------- the bars on the frame */

  .bar-thumb {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 1px;
    /* A little mirror, silvered as the big one is (tokens.css). */
    background: var(--glass);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.7), inset 0 0 10px rgb(4 3 6 / 0.6), 0 0 0 2px #b8944c, 0 0 0 3px #3e2c12;
  }

  .bar-thumb :global(.ink),
  .bar-thumb :global(.arrow) {
    stroke-width: 5px;
  }

  .bar-thumb :global(.start) {
    r: 7px;
  }

  .bar-main {
    display: block;
  }

  .bar-main strong {
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 22px;
    color: var(--candle);
  }

  .bar-note {
    display: block;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .last[data-ok='true'] .mark {
    color: var(--verdigris);
  }

  .last[data-ok='false'] .mark {
    color: #e8828c;
  }

  /* ---------------------------------------------------------------- dropping a file */

  .drop-hint {
    position: fixed;
    /* Over the drawer, which starts under the screen light. */
    top: var(--screen-light, 0px);
    right: 0;
    bottom: 0;
    z-index: 43;
    width: min(980px, 100vw);
    display: grid;
    place-items: center;
    padding: 24px;
    pointer-events: none;
    background: rgb(10 8 6 / 0.8);
  }

  /* Where to let the file fall: a leather tray ruled in a dashed candle line. */
  .drop-card {
    display: grid;
    justify-items: center;
    gap: 8px;
    width: min(520px, 100%);
    padding: 36px 28px 30px;
    border-radius: 3px;
    border: 2px dashed var(--candle);
    background:
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, var(--folio-2), var(--folio));
    background-blend-mode: soft-light, normal;
    color: var(--candle);
    text-align: center;
    box-shadow: 0 0 60px rgb(242 184 75 / 0.12);
  }

  .drop-title {
    margin: 6px 0 0;
    font-family: var(--font-display);
    font-size: 30px;
    color: var(--vellum);
  }

  .drop-text {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }
</style>
