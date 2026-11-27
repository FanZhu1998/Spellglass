<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import type { AppState } from '../app-state.svelte';

  let { app }: { app: AppState } = $props();

  // The incantation itself is written on the glass by the stage; the banner adds the grade and
  // the one specific hint. Success and failure differ by shape and words, not color alone.
  // It sits in the column along the top edge of the glass (App.svelte), under the mirror's notes.
  // It is no live region: the glass goes inert under an open drawer, while casting goes on, so the
  // shell's GlassAnnouncer, outside the room, says each result instead (Section 10.6).
  const b = $derived(app.banner);
</script>

<div class="banner-slot">
  {#key b?.id}
    {#if b && app.screen !== 'practice'}
      <div
        class="banner"
        data-kind={b.kind}
        in:fly={{ y: -8, duration: app.reducedMotion ? 0 : 220 }}
        out:fade={{ duration: app.reducedMotion ? 0 : 300 }}
      >
        {#if b.kind === 'cast'}
          <span class="mark" aria-hidden="true">✦</span>
          <span class="name">{b.name}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="grade">{b.grade}</span>
          {#if b.via === 'voice'}<span class="via">by voice</span>{/if}
          {#if b.replay}<span class="via">replay</span>{/if}
        {:else}
          <span class="mark" aria-hidden="true">◌</span>
          {#if b.grade}<span class="grade">{b.grade}.</span>{/if}
          <span class="hint">{b.hint}</span>
        {/if}
      </div>
    {/if}
  {/key}
</div>

<style>
  .banner-slot {
    display: grid;
    justify-items: center;
    max-width: 100%;
    pointer-events: none;
    /* The ribbon and the slip are cut to shape, so their shadow is the shape's own. */
    filter: drop-shadow(1px 5px 6px rgb(0 0 0 / 0.55));
  }

  .banner {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: center;
    gap: 4px 10px;
    max-width: 100%;
    /* Room for the ribbon's tails either side. */
    margin-inline: 24px;
    font-size: var(--text-small);
  }

  /* A cast: a short ribbon of silk in the wax's color, edged with gilt thread, its swallowtailed ends
     folded back behind it, and the words lettered on it in gold. */
  .banner[data-kind='cast'] {
    padding: 7px 26px 8px;
    color: var(--gilt-text);
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.55);
  }

  .banner[data-kind='cast']::before {
    content: '';
    position: absolute;
    z-index: -1;
    inset: 9px -22px -7px;
    background:
      linear-gradient(90deg, rgb(0 0 0 / 0.45) 0, transparent 24px, transparent calc(100% - 24px), rgb(0 0 0 / 0.45)),
      linear-gradient(180deg, color-mix(in srgb, var(--oxblood) 80%, black), color-mix(in srgb, var(--oxblood) 62%, black));
    clip-path: polygon(0 0, 100% 0, calc(100% - 12px) 50%, 100% 100%, 0 100%, 12px 50%);
  }

  .banner[data-kind='cast']::after {
    content: '';
    position: absolute;
    z-index: -1;
    inset: 0;
    background:
      linear-gradient(180deg, rgb(255 215 200 / 0.2), transparent 38%, rgb(0 0 0 / 0.22)),
      linear-gradient(180deg, transparent 3px, #c9a356 3px, #c9a356 4px, transparent 4px, transparent calc(100% - 4px), #8a6a2c calc(100% - 4px), #8a6a2c calc(100% - 3px), transparent calc(100% - 3px)),
      var(--oxblood);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 3px 50%);
  }

  /* A fizzle: a torn scrap of parchment ruled in a dashed line, the ink gone dull. The tear and the
     dashes keep it apart from the cast's ribbon by shape, not color alone. */
  .banner[data-kind='fizzle'] {
    padding: 9px 22px 10px;
    text-align: center;
    color: var(--ink);
    background:
      var(--tex-fibre) 0 0 / 260px,
      linear-gradient(180deg, color-mix(in srgb, var(--vellum) 92%, white), var(--vellum-2));
    background-blend-mode: soft-light, normal;
    clip-path: polygon(0 4px, 6% 1px, 13% 5px, 21% 0, 30% 3px, 38% 1px, 47% 5px, 55% 2px, 63% 4px, 71% 0, 80% 4px, 88% 1px, 95% 5px, 100% 2px, 99.4% 50%, 100% calc(100% - 3px), 93% 100%, 85% calc(100% - 4px), 76% calc(100% - 1px), 68% calc(100% - 5px), 59% calc(100% - 1px), 50% calc(100% - 4px), 41% 100%, 33% calc(100% - 3px), 24% calc(100% - 1px), 16% calc(100% - 5px), 8% calc(100% - 1px), 0 calc(100% - 3px), 0.6% 50%);
  }

  .banner[data-kind='fizzle']::after {
    content: '';
    position: absolute;
    z-index: -1;
    inset: 7px 9px;
    border: 1.5px dashed rgb(43 33 24 / 0.38);
    pointer-events: none;
  }

  .mark {
    font-size: 16px;
  }

  .banner[data-kind='cast'] .mark {
    color: var(--gilt-light);
  }

  .banner[data-kind='fizzle'] .mark {
    color: var(--ink-faint);
  }

  .name {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 23px;
    line-height: 1.15;
  }

  /* Gold leaf on the name. A text shadow would paint over gold that is the text's background. */
  .banner[data-kind='cast'] .name {
    background: linear-gradient(180deg, #fbebb8 15%, #e2c47e 55%, #c9a356 90%) text;
    -webkit-text-fill-color: transparent;
    text-shadow: none;
  }

  .grade {
    font-family: var(--font-label);
    font-size: 17px;
    letter-spacing: 0.05em;
  }

  .banner[data-kind='cast'] .grade {
    color: var(--gilt-light);
  }

  .banner[data-kind='fizzle'] .grade {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 19px;
    letter-spacing: 0;
    color: var(--rubric);
  }

  .via,
  .sep {
    font-style: italic;
    color: color-mix(in srgb, var(--vellum) 88%, var(--oxblood));
  }

  /* A narrow column (the session log takes the glass's top right corner): the ribbon is lettered on
     two lines, the name over its grade, instead of breaking wherever the words run out. The dot
     between them becomes the line break. */
  @container glass-top (max-width: 460px) {
    .banner[data-kind='cast'] .sep {
      flex-basis: 100%;
      height: 0;
      overflow: hidden;
    }
  }
</style>
