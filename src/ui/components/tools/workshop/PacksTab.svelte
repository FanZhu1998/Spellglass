<script lang="ts">
  // Packs (Section 9, Section 11.1 "Your content: a pack file"): every pack in the spellbook with its
  // title, version, description, notice, on/off switch, unmet needs, warnings and errors in plain words.
  // A pack file is imported by dropping it anywhere on the Workshop or choosing it here; the import's
  // own warnings are shown as they come back. Chosen files go the way dropped ones do (the Workshop's
  // onfiles): a data export goes to Your data, and a recorded session is refused in plain words.
  import { tick } from 'svelte';
  import type { SpellbookPack } from '../../../../contracts';
  import { focusIfLost } from '../../../actions';
  import type { AppState } from '../../../app-state.svelte';
  import StatusLine from '../StatusLine.svelte';
  import ToolSection from '../ToolSection.svelte';
  import type { Imports } from './imports.svelte';
  import PackCard from './PackCard.svelte';
  import TabIcon from './TabIcon.svelte';
  import type { Announce } from './types';
  import { KIND_LABEL, sentence } from './words';

  let {
    app,
    imports,
    announce,
    onfiles,
  }: {
    app: AppState;
    imports: Imports;
    announce: Announce;
    /** Imports the files, switches to the tab that shows the outcome and announces it. */
    onfiles: (files: File[]) => Promise<void>;
  } = $props();

  const book = $derived(app.spellbook);
  const groups = $derived.by(() => {
    const packs = book?.packs ?? [];
    const of = (kind: SpellbookPack['kind']) => packs.filter((p) => p.kind === kind);
    return [
      { id: 'spellpack', title: 'Spell packs', packs: of('spellpack') },
      { id: 'gesturepack', title: 'Gesture packs', packs: of('gesturepack') },
      { id: 'themepack', title: 'Themes', packs: of('themepack') },
    ]
      .filter((g) => g.packs.length > 0)
      .map((g) => ({ ...g, skipped: g.packs.filter((p) => !!p.error).length }));
  });

  let input = $state<HTMLInputElement | null>(null);
  let chooseButton = $state<HTMLButtonElement | null>(null);

  async function chosen(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const files = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';
    if (!files.length) return;
    await onfiles(files);
    // The button is disabled while it imports, which takes focus off it (Section 10.6). After a data
    // export the tab is Your data, whose question takes focus itself.
    await tick();
    focusIfLost(chooseButton);
  }
</script>

<div class="packs">
  <section class="import" aria-labelledby="ws-import-title" aria-busy={imports.busy}>
    <span class="import-icon" aria-hidden="true"><TabIcon name="packs" size={30} /></span>
    <div class="import-text">
      <h3 id="ws-import-title">Add a pack</h3>
      <p class="ws-help">
        Drop a pack file anywhere on the Workshop, or choose one. Packs are data only, with no scripts, so a pack from a friend is safe to open.
      </p>
    </div>
    <div class="import-action">
      <input bind:this={input} class="visually-hidden" type="file" accept=".json,application/json" multiple tabindex="-1" aria-hidden="true" onchange={chosen} />
      <button bind:this={chooseButton} class="btn btn-seal" type="button" onclick={() => input?.click()} disabled={imports.busy}>{imports.busy ? 'Importing…' : 'Choose a pack file'}</button>
    </div>
  </section>

  {#if imports.packs.length}
    <ul class="results" aria-label="Imported files">
      {#each imports.packs as r (r.id)}
        <li class="result">
          {#if r.ok}
            <StatusLine kind="ok" text="Imported {r.title ?? r.filename}{r.kind ? `, a ${KIND_LABEL[r.kind].toLowerCase()}` : ''}." />
            {#each r.warnings as w, i (i)}<StatusLine kind="warn" text={sentence(w)} compact />{/each}
          {:else}
            <StatusLine kind="error" text="{r.filename} was not imported. {r.error ?? ''}" />
          {/if}
          <button class="btn btn-ghost btn-small dismiss" type="button" onclick={() => imports.dismiss(r.id)} aria-label="Dismiss this message">Dismiss</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if book?.indexError}
    <StatusLine kind="error" text="The packs that ship with Spellglass could not be read. {sentence(book.indexError)} Packs you imported still work." />
  {/if}

  {#if !book}
    <StatusLine kind="busy" text="Opening the packs…" />
  {:else if groups.length === 0}
    <StatusLine kind="info" text="No packs are loaded. Drop a pack file here to add one." />
  {/if}

  {#each groups as g (g.id)}
    <ToolSection id="ws-group-{g.id}" title={g.title}>
      {#snippet aside()}
        {#if g.skipped}<span class="problems">{g.skipped} {g.skipped === 1 ? 'pack was' : 'packs were'} skipped</span>{/if}
      {/snippet}
      <div class="list">
        {#each g.packs as p (p.id)}
          <PackCard {app} pack={p} {announce} />
        {/each}
      </div>
    </ToolSection>
  {/each}
</div>

<style>
  .packs {
    display: grid;
    gap: 16px;
  }

  .import {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    border-radius: var(--radius);
    border: 1px dashed color-mix(in srgb, var(--brass) 70%, transparent);
    background:
      radial-gradient(120% 160% at 0% 0%, rgb(242 184 75 / 0.07), transparent 60%),
      color-mix(in srgb, var(--night) 40%, transparent);
  }

  .import-icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    color: var(--candle);
    background: color-mix(in srgb, var(--night) 60%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brass) 55%, transparent);
  }

  .import-text {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .import h3 {
    margin: 0;
    font-size: 23px;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .result {
    display: grid;
    gap: 6px;
    position: relative;
    padding-right: 96px;
  }

  .dismiss {
    position: absolute;
    top: 4px;
    right: 0;
  }

  .problems {
    font-size: var(--text-small);
    color: var(--candle);
  }

  .list {
    display: grid;
    gap: 12px;
  }

  @container (max-width: 560px) {
    .import {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .import-action {
      grid-column: 1 / -1;
    }
  }
</style>
