<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { AppState } from '../app-state.svelte';

  let { app }: { app: AppState } = $props();
</script>

<!-- Short messages from any screen ("Cast shared", "Link copied"). A success carries a tick and a
     problem a diamond, so they differ by shape as well as color. Celebrations of a new tier of spells
     have their own ribbon on the glass (components/shell/Celebration.svelte). -->
<div class="toast-slot" role="status" aria-live="polite">
  {#key app.toast?.id}
    {#if app.toast}
      <p class="toast" data-tone={app.toast.tone ?? 'plain'} transition:fade={{ duration: app.reducedMotion ? 0 : 200 }}>
        {#if app.toast.tone === 'ok'}<span class="mark" aria-hidden="true">✓</span>{/if}
        {#if app.toast.tone === 'warn'}<span class="mark warn" aria-hidden="true">!</span>{/if}
        <span>{app.toast.text}</span>
      </p>
    {/if}
  {/key}
</div>

<style>
  .toast-slot {
    position: fixed;
    top: calc(var(--screen-light, 0px) + 64px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 80;
    width: max-content;
    max-width: min(90vw, 620px);
    pointer-events: none;
  }

  /* A slip of dark leather with a gilt rule, lowered for a moment from the top of the wall. A problem's
     rule is dashed. */
  .toast {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    padding: 10px 22px;
    border-radius: 3px;
    corner-shape: bevel;
    background:
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, var(--folio-2), var(--folio));
    background-blend-mode: soft-light, normal;
    border: 1px solid #0b0806;
    outline: 1px solid color-mix(in srgb, var(--gilt) 55%, transparent);
    outline-offset: -5px;
    color: var(--vellum);
    font-size: var(--text-small);
    line-height: 1.4;
    box-shadow: var(--shadow-panel);
  }

  .toast[data-tone='ok'] {
    outline-color: color-mix(in srgb, var(--verdigris) 65%, transparent);
  }

  .toast[data-tone='warn'] {
    outline-style: dashed;
    outline-color: color-mix(in srgb, var(--candle) 70%, transparent);
  }

  .mark {
    color: var(--verdigris);
  }

  .mark.warn {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    font-size: 11px;
    font-weight: 600;
    color: var(--night);
    background: var(--candle);
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
    transform: translateY(2px);
  }
</style>
