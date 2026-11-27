<script lang="ts">
  // A new tier of spells opened (Section 8: "Practice mode unlocks spells in stages"). The audio module
  // plays the 'unlock-tier' fanfare; this is its picture: a ribbon on the glass naming the new spells.
  // Its words are said by the shell's GlassAnnouncer, outside the room, since the glass goes inert
  // under an open drawer (Section 10.6); its buttons stay here for the keyboard.
  import { fly, fade } from 'svelte/transition';
  import type { AppState } from '../../app-state.svelte';
  import Icon from './Icon.svelte';

  let { app }: { app: AppState } = $props();

  const c = $derived(app.celebration);

  function openBook() {
    const first = c?.spellIds[0];
    app.dismissCelebration();
    app.go('spellbook', first ?? undefined);
  }
</script>

<div class="celebration-slot">
  {#key c?.id}
    {#if c}
      <div class="celebration on-vellum" in:fly={{ y: -10, duration: app.reducedMotion ? 0 : 320 }} out:fade={{ duration: app.reducedMotion ? 0 : 240 }}>
        <span class="seal" aria-hidden="true"><Icon name="star" size={20} /></span>
        <div class="words">
          <p class="title">A new page opens</p>
          <p class="text">{c.text}</p>
        </div>
        <div class="actions">
          <button class="btn btn-small" onclick={openBook}>Open spellbook</button>
          <button class="btn btn-small btn-ghost btn-icon" aria-label="Dismiss" onclick={() => app.dismissCelebration()}><Icon name="close" size={18} /></button>
        </div>
      </div>
    {/if}
  {/key}
</div>

<style>
  .celebration-slot {
    display: grid;
    justify-items: center;
    width: 100%;
  }

  /* A new page of the book, held up to the glass: parchment edged in gilt, sealed in wax with a star,
     and lit by the candle. */
  .celebration {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 14px;
    max-width: min(100%, 680px);
    padding: 12px 14px 12px 14px;
    border-radius: 2px;
    background:
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(120% 140% at 20% 0%, color-mix(in srgb, var(--vellum) 94%, white) 0%, var(--vellum) 60%, var(--vellum-2) 100%);
    background-blend-mode: soft-light, normal;
    color: var(--ink);
    border: 1.5px solid #b8944c;
    box-shadow:
      inset 0 0 0 3px color-mix(in srgb, var(--vellum) 90%, white),
      inset 0 0 0 4px rgb(138 106 44 / 0.55),
      inset 0 0 16px rgb(120 84 36 / 0.2),
      2px 12px 34px rgb(0 0 0 / 0.55),
      0 0 60px rgb(242 184 75 / 0.2);
    pointer-events: auto;
  }

  .seal {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: color-mix(in srgb, var(--oxblood) 50%, #ffe0d6);
    background: radial-gradient(circle at 36% 30%, color-mix(in srgb, var(--oxblood) 78%, #ffd2c4), var(--oxblood) 52%, var(--oxblood-2) 100%);
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--oxblood) 60%, black),
      0 0 0 3.5px color-mix(in srgb, var(--oxblood) 88%, #ffc0b0),
      inset 0 -2px 5px rgb(0 0 0 / 0.4),
      1px 3px 5px rgb(0 0 0 / 0.35);
  }

  .seal :global(.icon) {
    filter: drop-shadow(-0.5px -0.5px 0 rgb(0 0 0 / 0.4)) drop-shadow(0.5px 0.5px 0 rgb(255 255 255 / 0.25));
  }

  .words {
    min-width: 0;
    text-align: left;
  }

  .title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 22px;
    line-height: 1.15;
  }

  .text {
    margin: 0;
    font-size: var(--text-small);
    line-height: 1.35;
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  @container (max-width: 640px) {
    .celebration {
      grid-template-columns: auto 1fr;
    }

    .actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
  }
</style>
