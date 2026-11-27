<script lang="ts" module>
  import type { SpellbookEntry, SpellbookPack } from '../../../contracts';

  export interface PackGroup {
    pack: SpellbookPack;
    entries: SpellbookEntry[];
  }
</script>

<script lang="ts">
  // The left page of the Spellbook: every enabled spell pack with its spells in order, each with its
  // status (learned, next, locked) in words as well as a tag, and progress toward learning. One
  // listbox with a group per pack; the arrow keys, Home, End, Page Up and Page Down move through it,
  // and typing a letter jumps to the next spell that starts with it.
  import { tick } from 'svelte';
  import { STATUS_PHRASE, STATUS_WORD, progressText, typeset } from './words';

  let {
    groups,
    selectedId,
    learnAfter,
    onselect,
    idPrefix = 'spellbook',
  }: {
    groups: PackGroup[];
    selectedId: string | null;
    learnAfter: number;
    /** Selection changed by the player: 'key' from the keyboard, 'pointer' from a click. */
    onselect: (spellId: string, how: 'key' | 'pointer') => void;
    idPrefix?: string;
  } = $props();

  let listEl = $state<HTMLElement | null>(null);
  const flat = $derived(groups.flatMap((g) => g.entries));
  const TAG: Record<SpellbookEntry['status'], string> = { learned: 'tag-learned', open: 'tag-open', locked: 'tag-locked' };

  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  export const optionId = (spellId: string) => `${idPrefix}-opt-${safe(spellId)}`;

  function label(e: SpellbookEntry): string {
    const parts = [e.spell.incantation, STATUS_PHRASE[e.status].toLowerCase()];
    if (e.status === 'open') parts.push(`${progressText(e.accepted, learnAfter)} casts`);
    if (!e.available && e.unavailableReason) parts.push(e.unavailableReason);
    return parts.join(', ');
  }

  /** Focus the option of a spell (after the selection has rendered). */
  export async function focusOption(spellId: string | null, scroll = true): Promise<void> {
    await tick();
    if (!listEl || !spellId) return;
    const el = listEl.querySelector<HTMLElement>(`#${optionId(spellId)}`);
    if (!el) return;
    el.focus({ preventScroll: !scroll });
    if (!scroll) el.scrollIntoView({ block: 'center' });
  }

  // When the selection changes from outside while focus is in the list, focus follows it, so the
  // focus ring and the ribbon never mark two different spells.
  $effect(() => {
    const id = selectedId;
    const el = listEl;
    if (!el || !id) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && el.contains(active) && active.id !== optionId(id)) void focusOption(id);
  });

  function move(to: number): void {
    if (!flat.length) return;
    const i = Math.max(0, Math.min(flat.length - 1, to));
    const id = flat[i].spell.id;
    if (id !== selectedId) onselect(id, 'key');
    void focusOption(id);
  }

  let typed = '';
  let typedAt = 0;

  function onkeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = flat.findIndex((x) => x.spell.id === selectedId);
    const page = 6;
    switch (e.key) {
      case 'ArrowDown':
        move(at < 0 ? 0 : at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? 0 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(flat.length - 1);
        break;
      case 'PageDown':
        move(at + page);
        break;
      case 'PageUp':
        move(at - page);
        break;
      default: {
        if (e.key.length !== 1 || e.key === ' ') return;
        // Type-ahead: letters typed in quick succession spell the start of an incantation.
        const now = performance.now();
        typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
        typedAt = now;
        const n = flat.length;
        const from = typed.length === 1 ? at + 1 : Math.max(0, at);
        for (let k = 0; k < n; k++) {
          const cand = flat[(from + k) % n];
          if (cand.spell.incantation.toLowerCase().startsWith(typed)) {
            move((from + k) % n);
            break;
          }
        }
        break;
      }
    }
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="spells"
  role="listbox"
  aria-label="Spells by pack"
  aria-orientation="vertical"
  bind:this={listEl}
  {onkeydown}
>
  {#each groups as g (g.pack.id)}
    {@const head = `${idPrefix}-pack-${safe(g.pack.id)}`}
    <div class="pack" role="group" aria-labelledby={head} aria-describedby={g.pack.description || g.pack.notice ? `${head}-about` : undefined}>
      <div class="pack-head" aria-hidden="true">
        <h3 id={head}>{g.pack.title}</h3>
        {#if g.pack.notice || g.pack.description}
          <p class="pack-about" id="{head}-about">{typeset(g.pack.notice ?? g.pack.description)}</p>
        {/if}
      </div>
      {#each g.entries as e (e.spell.id)}
        {@const selected = e.spell.id === selectedId}
        <!-- Keys are handled by the listbox (they bubble from the focused option). -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id={optionId(e.spell.id)}
          class="spell"
          class:selected
          class:unavailable={!e.available}
          data-status={e.status}
          role="option"
          aria-selected={selected}
          aria-label={label(e)}
          tabindex={selected ? 0 : -1}
          onclick={() => {
            if (e.spell.id !== selectedId) onselect(e.spell.id, 'pointer');
            void focusOption(e.spell.id);
          }}
        >
          <span class="ribbon" aria-hidden="true"></span>
          <span class="name">{e.spell.incantation}</span>
          <span class="leader" aria-hidden="true"></span>
          {#if e.status === 'open'}<span class="count">{progressText(e.accepted, learnAfter)}</span>{/if}
          <span class="tag {TAG[e.status]}">{STATUS_WORD[e.status]}</span>
          {#if !e.available && e.unavailableReason}<span class="why">{e.unavailableReason}</span>{/if}
        </div>
      {/each}
      {#if g.pack.error}
        <p class="pack-error">{g.pack.title} could not be opened: {g.pack.error}</p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .spells {
    display: grid;
    gap: 22px;
    outline: none;
  }

  .pack {
    display: grid;
    gap: 2px;
  }

  /* Each pack opens like a chapter: its title in rubric after a small fleuron, a line on what it
     holds, and a ruled line under them. */
  .pack-head {
    position: relative;
    margin: 0 0 6px;
    padding: 0 6px 9px 33px;
    border-bottom: 1px solid rgb(43 33 24 / 0.24);
    box-shadow: 0 1px 0 rgb(255 255 255 / 0.35);
  }

  .pack-head::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 7px;
    width: 18px;
    height: 18px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cg fill='%237b1e2b'%3E%3Cpath d='M9 1.5C11 4.5 11 7 9 9 7 7 7 4.5 9 1.5Z'/%3E%3Cpath d='M9 16.5C7 13.5 7 11 9 9c2 2 2 4.5 0 7.5Z' opacity='.55'/%3E%3Cpath d='M1.5 9C4.5 7 7 7 9 9 7 11 4.5 11 1.5 9Z' opacity='.8'/%3E%3Cpath d='M16.5 9C13.5 11 11 11 9 9c2-2 4.5-2 7.5 0Z' opacity='.8'/%3E%3C/g%3E%3Ccircle cx='9' cy='9' r='1.4' fill='%23e9dfc7'/%3E%3C/svg%3E") center / contain no-repeat;
  }

  h3 {
    margin: 0;
    font-size: 26px;
    color: var(--rubric);
  }

  .pack-about {
    margin: 4px 0 0;
    font-size: 16px;
    line-height: 1.4;
    font-style: italic;
    color: var(--ink-faint);
  }

  .spell {
    position: relative;
    display: grid;
    grid-template-columns: 20px minmax(0, max-content) minmax(10px, 1fr) auto auto;
    grid-template-areas:
      'ribbon name leader count tag'
      '. why why why why';
    align-items: baseline;
    column-gap: 7px;
    min-height: 44px;
    padding: 8px 8px 7px 6px;
    border-radius: 5px;
    cursor: pointer;
    color: var(--ink);
    transition: background var(--duration) var(--ease-out);
  }

  .spell:hover {
    background: radial-gradient(80% 120% at 30% 50%, rgb(122 86 30 / 0.09), transparent 80%);
  }

  .spell.selected {
    background: linear-gradient(90deg, rgb(123 30 43 / 0.11), rgb(123 30 43 / 0.03) 70%, transparent);
  }

  .spell:focus-visible {
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--candle);
  }

  .ribbon {
    grid-area: ribbon;
    align-self: stretch;
    justify-self: center;
    width: 11px;
    margin: -10px 0 -9px;
  }

  /* The selected spell carries a silk bookmark ribbon, its end cut in a swallowtail: a shape, not
     only a tint. Lit down one edge, the way silk takes the light. */
  .spell.selected .ribbon {
    background:
      linear-gradient(90deg, rgb(255 210 200 / 0.3), transparent 40%, rgb(0 0 0 / 0.22)),
      linear-gradient(180deg, color-mix(in srgb, var(--oxblood) 88%, white), var(--oxblood) 35%, color-mix(in srgb, var(--oxblood) 80%, black));
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%);
    filter: drop-shadow(1px 1px 1px rgb(0 0 0 / 0.3));
  }

  .name {
    grid-area: name;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-display);
    font-size: 22px;
    line-height: 1.2;
  }

  .spell.selected .name {
    color: var(--rubric);
  }

  .spell[data-status='locked'] .name {
    color: var(--ink-faint);
  }

  /* Dotted leaders, as in a book's table of contents. */
  .leader {
    grid-area: leader;
    align-self: end;
    margin-bottom: 0.42em;
    border-bottom: 2px dotted rgb(43 33 24 / 0.32);
  }

  .count {
    grid-area: count;
    font-size: 16px;
    color: var(--ink-soft);
    white-space: nowrap;
  }

  /* The shared tag classes, set at 16 px and a little darker so they meet 4.5:1 across the page. */
  .spell .tag {
    grid-area: tag;
    font-size: 17px;
    line-height: 1.3;
    white-space: nowrap;
    min-width: 4.9em;
    text-align: center;
    background: rgb(255 252 240 / 0.5);
  }

  .spell .tag-learned {
    color: var(--ink-green);
  }

  .spell .tag-open {
    color: var(--ink-brown);
  }

  .spell .tag-locked {
    color: var(--ink-faint);
    border-style: dashed;
    background: transparent;
  }

  .why {
    grid-area: why;
    margin-top: 2px;
    font-size: 16px;
    line-height: 1.35;
    font-style: italic;
    color: var(--ink-soft);
  }

  .pack-error {
    margin: 4px 0 0 33px;
    font-size: 16px;
    font-style: italic;
  }
</style>
