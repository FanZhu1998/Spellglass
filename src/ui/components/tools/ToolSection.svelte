<script lang="ts">
  // One titled group of controls inside a tool drawer (Wand tuning, Keepsakes, Workshop).
  import type { Snippet } from 'svelte';

  let {
    title,
    lede,
    id,
    children,
    aside,
  }: {
    title: string;
    /** One plain line under the title. */
    lede?: string;
    /** Prefix for the heading id, so the section is labelled by its title. */
    id?: string;
    children: Snippet;
    /** Controls beside the title (a status, a small button). */
    aside?: Snippet;
  } = $props();

  const headingId = $derived(id ? `${id}-title` : undefined);
</script>

<section class="tool-section" aria-labelledby={headingId}>
  <header class="head">
    <h3 id={headingId}>{title}</h3>
    {#if aside}<div class="aside">{@render aside()}</div>{/if}
  </header>
  {#if lede}<p class="lede">{lede}</p>{/if}
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  /* Sections of a folio are parted by an ornamental rule in gilt, a lozenge at its middle. */
  .tool-section {
    position: relative;
    padding: 24px 0 24px;
  }

  .tool-section::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 14px;
    transform: translateY(-50%);
    background:
      var(--rule-ornament) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, color-mix(in srgb, var(--gilt) 42%, transparent) 12%, color-mix(in srgb, var(--gilt) 42%, transparent) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), color-mix(in srgb, var(--gilt) 42%, transparent) calc(50% + 60px), color-mix(in srgb, var(--gilt) 42%, transparent) 88%, transparent) center / 100% 1px no-repeat;
    pointer-events: none;
  }

  .tool-section:first-child {
    padding-top: 2px;
  }

  .tool-section:first-child::before {
    display: none;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  /* Titles lettered in gilt on the leather. */
  h3 {
    margin: 0;
    font-size: 24px;
    color: var(--gilt-text);
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.7);
  }

  .aside {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lede {
    margin: 6px 0 0;
    max-width: 62ch;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .body {
    margin-top: 16px;
    display: grid;
    gap: 16px;
  }
</style>
