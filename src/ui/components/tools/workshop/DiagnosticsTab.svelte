<script lang="ts">
  // Diagnostics (Section 13): live numbers from 'diagnostics.stats' and the session-only overlay that
  // shows them over the room; every module with its state, reason and a Restart for recovery; recording
  // a session in the fixture format ("casting each spell twenty times"); and putting the shelf back.
  import { untrack } from 'svelte';
  import type { SpellbookEntry } from '../../../../contracts';
  import { ask, on } from '../../../../kernel';
  import type { AppState } from '../../../app-state.svelte';
  import DiagnosticsPanel from '../DiagnosticsPanel.svelte';
  import StatusLine from '../StatusLine.svelte';
  import ToolSection from '../ToolSection.svelte';
  import { errorText } from '../format';
  import { recording } from './recording.svelte';
  import type { Announce, Note } from './types';
  import { KIND_WORD, moduleView, type ModuleRow } from './words';

  let { app, announce, oncast }: { app: AppState; announce: Announce; oncast: () => void } = $props();

  // ------------------------------------------------------------------ modules
  // 'modules.list', asked again whenever a module reports a new state.
  let modules = $state.raw<ModuleRow[]>(untrack(() => app.modules));
  $effect(() => {
    const k = app.kernel;
    const refresh = () =>
      ask(k, 'modules.list').then(
        (list) => (modules = list),
        () => undefined,
      );
    untrack(() => void refresh());
    return on(k, 'module.status', () => void refresh());
  });

  const activeTracker = $derived(app.tracker?.tracker && app.tracker.state !== 'stopped' ? app.tracker.tracker : String(app.settings['tracker.active']));
  const rows = $derived(modules.map((m) => ({ m, view: moduleView(m, activeTracker, app.desktop ? 'the desktop app' : 'this browser') })));
  const running = $derived(rows.filter((r) => r.m.state === 'running').length);
  const failing = $derived(rows.filter((r) => r.view.kind === 'error').length);
  let restarting = $state<string | null>(null);
  let moduleNotes = $state<Record<string, Note | undefined>>({});

  async function restart(id: string, title: string): Promise<void> {
    restarting = id;
    moduleNotes = { ...moduleNotes, [id]: undefined };
    try {
      const r = await ask(app.kernel, 'modules.restart', { id });
      const ok = r.state === 'running';
      const note: Note = ok ? { kind: 'ok', text: `${title} restarted.` } : { kind: 'warn', text: `${title} did not start again.` };
      moduleNotes = { ...moduleNotes, [id]: note };
      announce(note.text);
    } catch (err) {
      const note: Note = { kind: 'error', text: errorText(err, `${title} could not be restarted.`) };
      moduleNotes = { ...moduleNotes, [id]: note };
      announce(note.text);
    } finally {
      restarting = null;
    }
  }

  // ------------------------------------------------------------------ recording
  /** Spells that can be cast now, in spellbook order: the ones worth recording. */
  const castable = $derived((app.spellbook?.spells ?? []).filter((e: SpellbookEntry) => e.enabled));
  let intended = $state<string>('');
  $effect(() => {
    // Follow the recording's own label while it runs.
    if (recording.active) intended = recording.intended ?? '';
  });
  $effect(() => {
    if (!recording.active && intended && !castable.some((e) => e.spell.id === intended)) intended = '';
  });
  $effect(() => {
    // A recording this page did not start (the diagnostics module says one runs): show it.
    if (!recording.active) recording.adopt(app);
  });

  const intendedName = $derived(recording.intended ? app.spellName(recording.intended) : '');

  async function start(): Promise<void> {
    const ok = await recording.start(app, intended || null);
    if (ok) {
      announce(intended ? `Recording. Cast ${app.spellName(intended)}.` : 'Recording. Cast any spell.');
      oncast();
    } else if (recording.error) announce(recording.error);
  }

  async function relabel(id: string): Promise<void> {
    intended = id;
    if (recording.active) {
      await recording.label(app, id || null);
      announce(id ? `Now cast ${app.spellName(id)}.` : 'Now cast any spell.');
    }
  }

  async function next(): Promise<void> {
    const id = recording.nextOf(castable.map((e) => e.spell.id));
    if (id) await relabel(id);
  }

  async function stop(): Promise<void> {
    await recording.stop(app);
    if (recording.saved) announce(`Recording saved as ${recording.saved.filename}.`);
    else if (recording.error) announce(recording.error);
  }

  // ------------------------------------------------------------------ the shelf
  let shelfNote = $state<Note | null>(null);
  let resetting = $state(false);

  async function resetShelf(): Promise<void> {
    resetting = true;
    shelfNote = null;
    try {
      await Promise.all([ask(app.kernel, 'stage.reset'), ask(app.kernel, 'engine.reset')]);
      shelfNote = { kind: 'ok', text: 'The shelf is back as it started, and every active spell has ended.' };
    } catch (err) {
      shelfNote = { kind: 'error', text: errorText(err, 'The shelf could not be reset.') };
    } finally {
      resetting = false;
    }
    announce(shelfNote.text);
  }
</script>

<div class="ws-cols">
  <div class="ws-col">
    <ToolSection
      id="ws-live"
      title="Live numbers"
      lede="Updated every second. The plan’s targets: a decision within 50 ms of a stroke’s end, and the trail within 150 ms of the camera (100 ms at 60 fps)."
    >
      <div class="ws-setting">
        <label class="switch">
          <input type="checkbox" checked={app.settings['diagnostics.overlay'] === true} onchange={(e) => app.set('diagnostics.overlay', e.currentTarget.checked)} aria-describedby="ws-overlay-help" />
          <span class="ws-switch-text">Show these over the room</span>
        </label>
        <p class="ws-help" id="ws-overlay-help">In a corner, away from the middle of the mirror. For this session only.</p>
      </div>
      <DiagnosticsPanel {app} />
    </ToolSection>
  </div>

  <div class="ws-col">
    <ToolSection
      id="ws-record"
      title="Record a session"
      lede="Saves what the tracker sees and what was decided, in the test fixture format. Cast each spell twenty times to build a test set."
    >
      {#snippet aside()}
        {#if recording.active}<span class="rec"><span class="rec-dot" aria-hidden="true"></span>Recording</span>{/if}
      {/snippet}
      <div class="field">
        <label for="ws-intended">The spell you will cast</label>
        <select id="ws-intended" class="select" value={intended} disabled={recording.busy} onchange={(e) => relabel(e.currentTarget.value)}>
          <option value="">Any spell (not labelled)</option>
          {#each castable as e (e.spell.id)}
            <option value={e.spell.id}>{e.spell.incantation}</option>
          {/each}
        </select>
        <p class="field-help">The label is the ground truth: each stroke is recorded as meant for this spell, whatever was decided.</p>
      </div>

      {#if recording.active}
        <div class="counter" aria-live="off">
          <div class="big">
            <span class="n">{recording.total}</span>
            <span class="what">{recording.total === 1 ? 'stroke recorded' : 'strokes recorded'}</span>
          </div>
          {#if recording.intended}
            <p class="for">{intendedName}: {recording.forSpell} recorded, {recording.rightForSpell} cast as meant</p>
          {/if}
          {#if recording.last}
            <StatusLine kind={recording.last.ok ? 'ok' : 'warn'} text="Last: {recording.last.text}." compact />
          {/if}
        </div>
        {#if recording.interrupted}
          <StatusLine kind="warn" text="The recording stopped when the tracker stopped or changed. Choose Stop and save to keep what was recorded." />
        {/if}
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={stop} disabled={recording.busy} data-after-fold>{recording.busy ? 'Saving…' : 'Stop and save'}</button>
          <button class="btn" type="button" onclick={next} disabled={recording.busy || castable.length === 0}>Next spell</button>
          <button class="btn btn-ghost" type="button" onclick={oncast} disabled={recording.busy}>Cast in the mirror</button>
        </div>
      {:else}
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={start} disabled={recording.busy} data-after-fold>Start recording</button>
          <p class="ws-help grow">The Workshop folds away so you can cast; the bar on the frame counts each stroke.</p>
        </div>
      {/if}
      {#if recording.error}<StatusLine kind="error" text={recording.error} />{/if}
      {#if recording.saved && !recording.active}
        <StatusLine
          kind="ok"
          text="Saved {recording.saved.filename} with {recording.saved.decisions} {recording.saved.decisions === 1 ? 'stroke' : 'strokes'}{recording.saved.outcome === 'downloaded' ? ', in your downloads' : ''}. It is kept on this device too."
        />
      {/if}
    </ToolSection>

    <ToolSection id="ws-shelf" title="The shelf" lede="Put every prop back where it started and end every spell that is active.">
      <div class="ws-actions">
        <button class="btn" type="button" onclick={resetShelf} disabled={resetting}>Reset the shelf</button>
      </div>
      {#if shelfNote}<StatusLine kind={shelfNote.kind} text={shelfNote.text} />{/if}
    </ToolSection>
  </div>
</div>

<ToolSection id="ws-modules" title="Modules" lede="Each part of the pipeline and how it is doing. Restart one that has stopped; a running one can be restarted too if it misbehaves.">
  {#snippet aside()}
    <span class="summary">{running} running{failing ? ` · ${failing} stopped with an error` : ''}</span>
  {/snippet}
  <ul class="modules">
    {#each rows as { m, view } (m.manifest.id)}
      {@const title = m.manifest.title ?? m.manifest.id}
      {@const trouble = view.kind === 'error' || view.kind === 'warn'}
      <li class="module" data-kind={view.kind}>
        <div class="who">
          <span class="title">{title}</span>
          <span class="meta">
            {#if m.manifest.kind === 'tracker' || !m.manifest.title}{KIND_WORD[m.manifest.kind] ?? m.manifest.kind} ·{/if}
            <code>{#each m.manifest.id.split('.') as part, i (i)}{i > 0 ? '.' : ''}<wbr />{part}{/each}</code> · {m.manifest.version}
          </span>
          {#if view.reason}<span class="reason">{view.reason}</span>{/if}
          {#if moduleNotes[m.manifest.id]}<StatusLine kind={moduleNotes[m.manifest.id]!.kind} text={moduleNotes[m.manifest.id]!.text} compact />{/if}
        </div>
        <div class="state">
          <StatusLine kind={view.kind} text={view.word} compact />
          {#if view.restartable}
            <button
              class="btn btn-small"
              class:btn-ghost={!trouble}
              type="button"
              onclick={() => restart(m.manifest.id, title)}
              disabled={restarting !== null}
              aria-label="Restart {title}"
            >
              {restarting === m.manifest.id ? 'Restarting…' : 'Restart'}
            </button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</ToolSection>

<style>
  .summary {
    font-size: var(--text-small);
    color: var(--ash);
  }

  /* A ledger of the modules, in two columns where the drawer is wide. */
  .modules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0 18px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 40%, transparent);
    overflow: hidden;
  }

  @container (min-width: 880px) {
    .modules {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 0 14px;
    }
    .module {
      padding-inline: 0;
    }
  }

  .module {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 14px;
    padding: 9px 14px;
    /* Rules between rows only: the first row's rule tucks under the list's own edge. */
    margin-top: -1px;
    border-top: 1px solid var(--line);
  }

  .module[data-kind='error'] {
    background: color-mix(in srgb, #e8828c 7%, transparent);
  }

  .who {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .title {
    font-size: var(--text-body);
    color: var(--vellum);
  }

  .meta {
    font-size: var(--text-label);
    color: var(--ash);
  }

  code {
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: var(--text-small);
  }

  .reason {
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .state {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  .state :global(.status) {
    white-space: nowrap;
  }

  .rec {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .rec-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #d9475a;
    box-shadow: 0 0 0 3px rgb(217 71 90 / 0.25);
  }

  .field {
    margin: 0;
  }

  .field label {
    font-size: var(--text-body);
  }

  .counter {
    display: grid;
    gap: 6px;
    padding: 12px 16px;
    border-radius: var(--radius);
    border: 1px solid color-mix(in srgb, #d9475a 45%, transparent);
    background: color-mix(in srgb, var(--night) 50%, transparent);
  }

  .big {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .n {
    font-family: var(--font-display);
    font-size: 40px;
    line-height: 1;
    color: var(--vellum);
    font-variant-numeric: lining-nums tabular-nums;
  }

  .what {
    font-size: var(--text-small);
    color: var(--ash);
  }

  .for {
    margin: 0;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .grow {
    flex: 1 1 220px;
  }
</style>
