<script lang="ts">
  // Your data (Section 9.4): "Export my data" writes one JSON file with camera profiles, gesture samples,
  // progress and settings; "Import" reads any older version (merged: the newer record wins); "Delete my
  // data" clears every store and the progress, after a confirmation. The storage status says whether
  // data is saved at all (Section 7.9: storage blocked or full runs without saving and says so), whether
  // the browser has agreed to keep it, and how much space it takes. The desktop app words these lines
  // for a computer rather than a browser (storageWords).
  import { tick, untrack } from 'svelte';
  import { ask } from '../../../../kernel';
  import { focusIfLost } from '../../../actions';
  import type { AppState } from '../../../app-state.svelte';
  import StatusLine from '../StatusLine.svelte';
  import ToolSection from '../ToolSection.svelte';
  import { dateStamp, errorText, formatBytes, jsonBlob, readFileText } from '../format';
  import type { Imports } from './imports.svelte';
  import { reveal } from './keys';
  import type { Announce, Note } from './types';
  import { importSummary, sentence, storageWords } from './words';

  let { app, imports, announce }: { app: AppState; imports: Imports; announce: Announce } = $props();
  const words = $derived(storageWords(app.desktop));

  // ------------------------------------------------------------------ status
  // The request publishes a fresh status (usage figures included), which reaches app.storage.
  let checking = $state(true);
  $effect(() => {
    untrack(() => {
      ask(app.kernel, 'storage.status')
        .catch(() => undefined)
        .finally(() => (checking = false));
    });
  });

  const status = $derived(app.storage);
  const saving = $derived.by((): Note => {
    const s = status;
    if (!s) return { kind: 'busy', text: 'Checking storage on this device…' };
    if (s.persistent) return { kind: 'ok', text: 'Your progress, drawings and keepsakes are saved on this device.' };
    return { kind: 'warn', text: sentence(s.message) || 'Storage is not available, so Spellglass runs without saving.' };
  });
  const used = $derived.by(() => {
    const s = status;
    if (!s || typeof s.usage !== 'number') return null;
    return typeof s.quota === 'number' && s.quota > 0 ? words.space(formatBytes(s.usage), formatBytes(s.quota)) : formatBytes(s.usage);
  });

  let keepLabel = $state('Keep my data');
  let keepNote = $state<Note | null>(null);
  let keeping = $state(false);

  async function keep(): Promise<void> {
    keeping = true;
    keepNote = null;
    try {
      const r = await ask(app.kernel, 'storage.persist');
      keepNote = r.durable ? { kind: 'ok', text: words.keptOk } : { kind: 'info', text: words.keptNot };
      if (r.durable) keepLabel = 'Data kept';
    } catch (err) {
      keepNote = { kind: 'error', text: errorText(err, words.keepError) };
    } finally {
      keeping = false;
    }
    announce(keepNote.text);
  }

  // ------------------------------------------------------------------ export
  let exportLabel = $state('Export my data');
  let exportNote = $state<Note | null>(null);
  let exportTimer: ReturnType<typeof setTimeout> | null = null;

  function exportData(): void {
    exportNote = null;
    const filename = `spellglass-data-${dateStamp()}.json`;
    ask(app.kernel, 'storage.export')
      .then((doc) => ask(app.kernel, 'share.file', { blob: jsonBlob(`${JSON.stringify(doc, null, 2)}\n`), filename, title: 'My Spellglass data' }))
      .then((s) => {
        if (s.outcome === 'cancelled') return;
        exportNote = { kind: 'ok', text: s.outcome === 'shared' ? 'Your data was shared.' : `Saved to your downloads as ${filename}.` };
        exportLabel = 'Data exported';
        if (exportTimer) clearTimeout(exportTimer);
        exportTimer = setTimeout(() => (exportLabel = 'Export my data'), 4000);
        announce(exportNote.text);
      })
      .catch((err) => {
        exportNote = { kind: 'error', text: errorText(err, 'Your data could not be exported.') };
        announce(exportNote.text);
      });
  }

  $effect(() => () => {
    if (exportTimer) clearTimeout(exportTimer);
  });

  // ------------------------------------------------------------------ import
  let input = $state<HTMLInputElement | null>(null);
  let importButton = $state<HTMLButtonElement | null>(null);
  let importing = $state(false);
  let importNote = $state<Note | null>(null);

  async function importText(text: string, filename: string): Promise<void> {
    importing = true;
    importNote = null;
    try {
      // Merge: records already here that are newer are kept. Modules reload what changed on their own.
      const r = await ask(app.kernel, 'storage.import', { data: text, mode: 'merge' });
      importNote = { kind: 'ok', text: importSummary(r) };
    } catch (err) {
      importNote = { kind: 'error', text: `${filename} was not imported. ${errorText(err, 'The file could not be read.')}` };
    } finally {
      importing = false;
    }
    announce(importNote.text);
  }

  async function chosen(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await readFileText(file);
    } catch (err) {
      importNote = { kind: 'error', text: errorText(err, 'The file could not be read.') };
      return;
    }
    await importText(text, file.name);
    // Import is disabled while it works, which takes focus off it.
    await tick();
    focusIfLost(importButton);
  }

  // The question about a dropped data file goes away with its answer, and the focused button with it,
  // which would leave a keyboard player nowhere (access, Section 10.6): focus moves to Import, next to
  // where the result of the import is written, and the way to bring a data file in by hand.
  async function confirmDropped(): Promise<void> {
    const p = imports.pendingData;
    if (!p) return;
    imports.pendingData = null;
    await importText(p.text, p.filename);
    await tick();
    focusIfLost(importButton);
  }

  function notNow(): void {
    imports.pendingData = null;
    void tick().then(() => focusIfLost(importButton));
  }

  // ------------------------------------------------------------------ delete
  let confirming = $state(false);
  let deleting = $state(false);
  let deleteNote = $state<Note | null>(null);
  let deleteButton = $state<HTMLButtonElement | null>(null);

  /** Back out of the confirmation, with focus where it was. */
  function cancelDelete(): void {
    confirming = false;
    void tick().then(() => deleteButton?.focus());
  }

  async function deleteAll(): Promise<void> {
    deleting = true;
    deleteNote = null;
    try {
      await ask(app.kernel, 'storage.clear', {});
      await ask(app.kernel, 'progress.reset', {});
      deleteNote = { kind: 'ok', text: 'Your data on this device is deleted. Spells open in stages again from the first.' };
      confirming = false;
      void tick().then(() => deleteButton?.focus());
    } catch (err) {
      deleteNote = { kind: 'error', text: errorText(err, 'Your data could not be deleted.') };
    } finally {
      deleting = false;
    }
    announce(deleteNote.text);
  }
</script>

<div class="ws-cols">
  <div class="ws-col">
    {#if imports.pendingData}
      <div class="pending" role="group" aria-labelledby="ws-pending-title" use:reveal>
        <h3 id="ws-pending-title">Import {imports.pendingData.filename}?</h3>
        <p class="ws-help">
          This is a Spellglass data file. Importing adds what it holds to your data here: where both have the same record, the newer one is
          kept, and the file’s settings replace yours.
        </p>
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={confirmDropped} disabled={importing}>Import</button>
          <button class="btn btn-ghost" type="button" onclick={notNow} data-safe>Not now</button>
        </div>
      </div>
    {/if}

    <ToolSection id="ws-storage" title="Storage on this device">
      <StatusLine kind={saving.kind} text={saving.text} />
      <dl class="facts">
        <div>
          <dt>{words.keptLabel}</dt>
          <dd>
            {#if status?.durable}
              <span class="yes">Yes</span>: {words.keptYes}
            {:else}
              {words.keptNo}
            {/if}
          </dd>
        </div>
        <div>
          <dt>Space used</dt>
          <dd>{used ?? (checking ? 'Checking…' : words.spaceUnknown)}</dd>
        </div>
      </dl>
      {#if status?.persistent && !status.durable}
        <div class="ws-actions">
          <button class="btn" type="button" onclick={keep} disabled={keeping}>{keepLabel}</button>
          <p class="ws-help grow">{words.keepHelp}</p>
        </div>
      {/if}
      {#if keepNote}<StatusLine kind={keepNote.kind} text={keepNote.text} />{/if}
      <p class="ws-help">Nothing here leaves this computer unless you export it. There is no account and no server.</p>
    </ToolSection>
  </div>

  <div class="ws-col">
    <ToolSection id="ws-move" title="Export and import" lede={words.moveLede}>
      <div class="ws-stack">
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={exportData}>{exportLabel}</button>
        </div>
        <p class="ws-help">
          One file with your camera profiles, learned strokes, redrawn gestures, progress, keepsakes, imported packs and settings. Recorded
          sessions stay out.
        </p>
        {#if exportNote}<StatusLine kind={exportNote.kind} text={exportNote.text} />{/if}
      </div>

      <div class="ws-stack">
        <div class="ws-actions">
          <input bind:this={input} class="visually-hidden" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true" onchange={chosen} />
          <button bind:this={importButton} class="btn" type="button" onclick={() => input?.click()} disabled={importing}>{importing ? 'Importing…' : 'Import'}</button>
        </div>
        <p class="ws-help">Reads a file from Export my data, from this edition or an older one. Records already here that are newer are kept.</p>
        {#if importNote}<StatusLine kind={importNote.kind} text={importNote.text} />{/if}
      </div>
    </ToolSection>

    <ToolSection id="ws-delete" title="Delete my data">
      {#if confirming}
        <div class="confirm" role="group" aria-labelledby="ws-delete-q" use:reveal>
          <p id="ws-delete-q" class="question">Delete everything Spellglass keeps on this device?</p>
          <p class="ws-help">
            Progress and learned spells, learned strokes, redrawn gestures, keepsakes, imported packs, camera profiles and recorded sessions.
            Your settings stay. This cannot be undone: export your data first to keep a copy.
          </p>
          <div class="ws-actions">
            <button class="btn btn-danger" type="button" onclick={deleteAll} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete my data'}</button>
            <button class="btn btn-ghost" type="button" onclick={cancelDelete} disabled={deleting} data-safe>Keep it</button>
          </div>
        </div>
      {:else}
        <div class="ws-actions">
          <button bind:this={deleteButton} class="btn btn-danger-quiet" type="button" onclick={() => ((confirming = true), (deleteNote = null))}>Delete my data</button>
          <p class="ws-help grow">Asks before anything is deleted.</p>
        </div>
      {/if}
      {#if deleteNote}<StatusLine kind={deleteNote.kind} text={deleteNote.text} />{/if}
    </ToolSection>
  </div>
</div>

<style>
  .pending {
    display: grid;
    gap: 8px;
    margin-bottom: 18px;
    padding: 16px 18px;
    border-radius: var(--radius);
    border: 1px dashed color-mix(in srgb, var(--candle) 60%, transparent);
    background: color-mix(in srgb, var(--candle) 6%, color-mix(in srgb, var(--night) 45%, transparent));
  }

  .pending h3 {
    margin: 0;
    font-size: 22px;
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .facts > div {
    display: grid;
    gap: 2px;
    padding: 10px 14px;
    border-radius: var(--radius-small);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 40%, transparent);
  }

  dt {
    font-size: var(--text-small);
    color: var(--ash);
  }

  dd {
    margin: 0;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .yes {
    color: var(--verdigris);
  }

  .yes::before {
    content: '✓ ';
  }

  .grow {
    flex: 1 1 220px;
  }

  .confirm {
    display: grid;
    gap: 8px;
    padding: 14px 16px;
    border-radius: var(--radius);
    border: 1px dashed color-mix(in srgb, #e8828c 60%, transparent);
    background: color-mix(in srgb, #e8828c 6%, transparent);
  }

  .question {
    margin: 0;
    font-size: var(--text-body);
    color: var(--vellum);
  }
</style>
