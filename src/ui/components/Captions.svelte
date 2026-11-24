<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { AppState } from '../app-state.svelte';

  let { app }: { app: AppState } = $props();
</script>

<!-- Every sound cue has a caption (Section 10.6), shown when captions are on. -->
<div class="captions" aria-live="polite">
  {#each app.captions as c (c.id)}
    <p class="caption" transition:fade={{ duration: app.reducedMotion ? 0 : 180 }}>[{c.text}]</p>
  {/each}
</div>

<style>
  /* On the glass, at its foot: the captions sit along the front edge of the mantel shelf, centred
     under the props, clear of the Mirror bar's controls below the frame (App.svelte names the glass
     --glass). The element stays outside the room in the page, so the room going inert under a drawer
     never silences it. Several at once sit side by side, and a further row rises above them. */
  .captions {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-wrap: wrap-reverse;
    justify-content: center;
    align-items: flex-end;
    gap: 6px 8px;
    width: max-content;
    max-width: min(560px, 90vw);
    pointer-events: none;
    /* On the slips' cut shapes (a filter on a clipped slip itself would be clipped away). */
    filter: drop-shadow(1px 2px 2px rgb(0 0 0 / 0.55));
    /* Without anchor positioning: low in the window, as before. */
    left: 50%;
    bottom: 96px;
    translate: -50% 0;
  }

  @supports (position-anchor: --glass) {
    .captions {
      position-anchor: --glass;
      left: anchor(center);
      bottom: calc(anchor(bottom) + 5px);
      max-width: min(560px, 90vw, anchor-size(width));
    }

    /* A short glass (App.svelte's short-glass): the props reach down to the shelf's edge, so the
       slips are tucked into the frame's bottom rail instead, as a nameplate is, centred on it. */
    :global(.room.short-glass) .captions {
      bottom: calc(anchor(bottom) - var(--pad, 16px) / 2 - 13px);
    }
  }

  /* A short slip of old, darkened parchment, the sound written on it in the book's italic, in ink. */
  .caption {
    position: relative;
    margin: 0;
    padding: 2px 14px 3px;
    font-family: var(--font-display);
    font-style: italic;
    font-size: 18px;
    line-height: 1.3;
    color: var(--ink);
    background:
      var(--tex-fibre) 0 0 / 260px,
      linear-gradient(180deg, #ddcba4, #cdb88e);
    background-blend-mode: soft-light, normal;
    clip-path: polygon(0 2px, 8% 0, 22% 2px, 37% 0, 52% 2px, 68% 0, 83% 2px, 100% 0, 99.5% 50%, 100% 100%, 86% calc(100% - 2px), 70% 100%, 55% calc(100% - 2px), 40% 100%, 24% calc(100% - 2px), 9% 100%, 0 calc(100% - 1px), 0.5% 50%);
  }
</style>
