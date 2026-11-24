<script lang="ts">
  // One pack in the Workshop (Section 7.9: a pack that fails its checks is skipped, with the reason
  // given here; Section 9.2: packs are data only). Title, kind, version, description and notice come
  // from the pack and are rendered as text only.
  import { tick } from 'svelte';
  import type { SpellbookPack } from '../../../../contracts';
  import { ask } from '../../../../kernel';
  import { focusIfLost, tabbables } from '../../../actions';
  import type { AppState } from '../../../app-state.svelte';
  import StatusLine from '../StatusLine.svelte';
  import { errorText, jsonBlob } from '../format';
  import { reveal } from './keys';
  import type { Announce, Note } from './types';
  import { KIND_LABEL, needsText, sentence } from './words';

  let { app, pack, announce }: { app: AppState; pack: SpellbookPack; announce: Announce } = $props();

  const spells = $derived(pack.kind === 'spellpack' ? (app.spellbook?.spells.filter((e) => e.packId === pack.id) ?? []) : []);
  const unavailable = $derived(pack.enabled ? spells.filter((e) => !e.available).length : 0);
  /** Spells whose gesture this gesture pack draws now. */
  const drawn = $derived(pack.kind === 'gesturepack' ? (app.spellbook?.spells.filter((e) => e.gestureSource === pack.id).length ?? 0) : 0);
  const inUse = $derived(pack.kind === 'themepack' && app.spellbook?.theme?.id === pack.id);
  const broken = $derived(!!pack.error);

  const meta = $derived.by(() => {
    const parts = [KIND_LABEL[pack.kind] ?? pack.kind];
    if (pack.version) parts.push(`version ${pack.version}`);
    if (pack.kind === 'spellpack' && !broken) parts.push(`${spells.length} ${spells.length === 1 ? 'spell' : 'spells'}${unavailable ? `, ${unavailable} unavailable` : ''}`);
    if (pack.kind === 'gesturepack' && pack.enabled && !broken) parts.push(drawn ? `draws ${drawn} ${drawn === 1 ? 'spell' : 'spells'}` : 'draws no spell now');
    return parts.join(' · ');
  });

  // ------------------------------------------------------------------ on and off
  let switching = $state(false);
  let note = $state<Note | null>(null);

  async function toggle(input: HTMLInputElement): Promise<void> {
    const on = input.checked;
    switching = true;
    note = null;
    try {
      await ask(app.kernel, 'packs.enable', { id: pack.id, enabled: on });
      announce(`${pack.title} turned ${on ? 'on' : 'off'}.`);
    } catch (err) {
      // The switch shows what the pack is, not what was asked for.
      input.checked = pack.enabled && !broken;
      note = { kind: 'error', text: errorText(err, 'The pack could not be turned on or off.') };
      announce(note.text);
    } finally {
      switching = false;
    }
  }

  // ------------------------------------------------------------------ export (a button keeps its name: Export → Exported)
  let exportLabel = $state('Export');
  let exportTimer: ReturnType<typeof setTimeout> | null = null;

  function exportPack(): void {
    note = null;
    ask(app.kernel, 'packs.export', { id: pack.id })
      .then((r) => ask(app.kernel, 'share.file', { blob: jsonBlob(r.text), filename: r.filename, title: pack.title }).then((s) => ({ s, filename: r.filename })))
      .then(({ s, filename }) => {
        if (s.outcome === 'cancelled') return;
        note = { kind: 'ok', text: s.outcome === 'shared' ? `${pack.title} shared.` : `Saved to your downloads as ${filename}.` };
        exportLabel = 'Exported';
        if (exportTimer) clearTimeout(exportTimer);
        exportTimer = setTimeout(() => (exportLabel = 'Export'), 4000);
        announce(note.text);
      })
      .catch((err) => {
        note = { kind: 'error', text: errorText(err, 'The pack could not be exported.') };
        announce(note.text);
      });
  }

  $effect(() => () => {
    if (exportTimer) clearTimeout(exportTimer);
  });

  // ------------------------------------------------------------------ remove (imported packs only)
  let confirming = $state(false);
  let removeButton = $state<HTMLButtonElement | null>(null);
  let card = $state<HTMLElement | null>(null);

  function cancelRemove(): void {
    confirming = false;
    void tick().then(() => removeButton?.focus());
  }

  async function remove(): Promise<void> {
    confirming = false;
    // The card goes with the pack, and the focused Remove with it, which would leave a keyboard player
    // nowhere (access, Section 10.6): the next pack takes focus, or the one before it, or else the tab's
    // panel. Found now, while this card is still in the list.
    const next = card?.nextElementSibling ?? card?.previousElementSibling ?? null;
    const panel = card?.closest<HTMLElement>('[role="tabpanel"]') ?? null;
    try {
      await ask(app.kernel, 'packs.remove', { id: pack.id });
      announce(`${pack.title} removed from this device.`);
      await tick();
      focusIfLost(next instanceof HTMLElement && next.isConnected ? (tabbables(next)[0] ?? panel) : panel);
    } catch (err) {
      note = { kind: 'error', text: errorText(err, 'The pack could not be removed.') };
      announce(note.text);
      await tick();
      focusIfLost(removeButton);
    }
  }
</script>

<article class="pack" class:off={!pack.enabled || broken} aria-labelledby="pack-{pack.id}-title" bind:this={card}>
  <div class="main">
    <header class="head">
      <h4 id="pack-{pack.id}-title">{pack.title || pack.id}</h4>
      {#if pack.user}<span class="tag tag-open">Imported</span>{/if}
      {#if inUse}<span class="tag tag-learned">In use</span>{/if}
    </header>
    <p class="meta">{meta}</p>
    {#if pack.description}<p class="description">{pack.description}</p>{/if}
    {#if pack.notice}<p class="notice">{pack.notice}</p>{/if}
    {#if pack.shadows}<p class="meta">Replaces the copy of this pack that ships with Spellglass.</p>{/if}
  </div>

  <div class="side">
    <label class="switch">
      <input type="checkbox" checked={pack.enabled && !broken} disabled={switching || broken} onchange={(e) => toggle(e.currentTarget)} aria-label="Use {pack.title || pack.id}" />
      <span class="state" aria-hidden="true">{pack.enabled && !broken ? 'On' : 'Off'}</span>
    </label>
    {#if !confirming}
      <div class="buttons">
        {#if pack.user}<button bind:this={removeButton} class="btn btn-small btn-ghost" type="button" onclick={() => (confirming = true)}>Remove</button>{/if}
        <button class="btn btn-small" type="button" onclick={exportPack} disabled={broken}>{exportLabel}</button>
      </div>
    {/if}
  </div>

  {#if broken || pack.unmet.length || pack.warnings?.length || note}
    <div class="notes">
      {#if broken}<StatusLine kind="error" text="Skipped: {sentence(pack.error)} The other packs work as usual." />{/if}
      {#if pack.unmet.length && !broken}
        <StatusLine kind="warn" text="{needsText(pack.unmet)}{pack.kind === 'spellpack' ? ' Its spells are listed as unavailable.' : ''}" />
      {/if}
      {#if pack.warnings?.length}
        <ul class="warnings" aria-label="Notes on {pack.title}">
          {#each pack.warnings as w, i (i)}<li>{sentence(w)}</li>{/each}
        </ul>
      {/if}
      {#if note}<StatusLine kind={note.kind} text={note.text} />{/if}
    </div>
  {/if}

  {#if confirming}
    <div class="confirm" role="group" aria-label="Remove {pack.title}" use:reveal>
      <span class="confirm-text">Remove {pack.title} from this device? You can import its file again later.</span>
      <button class="btn btn-small btn-danger" type="button" onclick={remove}>Remove</button>
      <button class="btn btn-small btn-ghost" type="button" onclick={cancelRemove} data-safe>Keep it</button>
    </div>
  {/if}
</article>

<style>
  .pack {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'main side'
      'notes notes'
      'confirm confirm';
    gap: 10px 24px;
    padding: 16px 18px 14px;
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid color-mix(in srgb, var(--gilt) 16%, transparent);
    background: var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
  }

  /* A pack that is on has its rim gilded. */
  .pack:not(.off) {
    border-color: color-mix(in srgb, var(--gilt) 50%, transparent);
  }

  .main {
    grid-area: main;
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  /* The switch at the top, the buttons at the foot, so the card stays as short as its text. */
  .side {
    grid-area: side;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
  }

  .side .switch {
    min-height: 40px;
  }

  .buttons {
    display: flex;
    gap: 6px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 12px;
  }

  h4 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 24px;
    line-height: 1.15;
    color: var(--vellum);
    overflow-wrap: anywhere;
  }

  .off h4,
  .off .description {
    color: color-mix(in srgb, var(--vellum) 72%, var(--ash));
  }

  .meta {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .description {
    margin: 2px 0 0;
    font-size: var(--text-small);
    line-height: 1.45;
    color: var(--vellum);
    overflow-wrap: anywhere;
  }

  .notice {
    margin: 6px 0 0;
    padding: 8px 12px;
    border-radius: var(--radius-small);
    border-left: 3px solid color-mix(in srgb, var(--brass) 80%, transparent);
    background: color-mix(in srgb, var(--night) 45%, transparent);
    font-size: var(--text-small);
    line-height: 1.45;
    font-style: italic;
    color: var(--vellum);
    overflow-wrap: anywhere;
  }

  .state {
    min-width: 2.2em;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .notes {
    grid-area: notes;
    display: grid;
    gap: 8px;
  }

  .warnings {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }

  /* A diamond, the caution shape used across the app. */
  .warnings li {
    position: relative;
    padding-left: 22px;
    font-size: var(--text-small);
    line-height: 1.45;
    color: var(--vellum);
    overflow-wrap: anywhere;
  }

  .warnings li::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 0.55em;
    width: 7px;
    height: 7px;
    border: 1.5px solid var(--candle);
    transform: rotate(45deg);
  }

  .confirm {
    grid-area: confirm;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px dashed color-mix(in srgb, #e8828c 45%, transparent);
  }

  .confirm-text {
    margin-right: auto;
    font-size: var(--text-small);
  }
</style>
