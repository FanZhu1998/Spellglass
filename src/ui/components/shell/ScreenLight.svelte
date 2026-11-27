<script lang="ts" module>
  /** The band's height as a fraction of the window, kept to a sensible range. */
  export function screenLightFraction(v: unknown): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.12;
    return Math.min(0.4, Math.max(0.03, n));
  }
</script>

<script lang="ts">
  // Route A's screen light (Section 4, Appendix A step 4): a full-brightness white band along the top
  // of the window, just under the camera, above everything else. App.svelte moves the room down by
  // the same height, and the drawers and the Spellbook start under it (--screen-light), so the band
  // covers nothing and keeps lighting the wand while Wand tuning is open.
  import type { AppState } from '../../app-state.svelte';

  let { app }: { app: AppState } = $props();
</script>

{#if app.settings['shell.screenLight']}
  <div class="screen-light" style:height="{screenLightFraction(app.settings['shell.screenLightHeight']) * 100}vh" role="region" aria-label="Screen light">
    <button class="off" onclick={() => app.set('shell.screenLight', false)}>Turn off the screen light</button>
  </div>
{/if}

<style>
  .screen-light {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: #ffffff;
    container-type: size;
  }

  .off {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    min-height: 44px;
    padding: 6px 16px;
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid rgb(43 33 24 / 0.32);
    background: transparent;
    color: #2b2118;
    font-size: var(--text-small);
    cursor: pointer;
  }

  .off:hover {
    background: rgb(43 33 24 / 0.06);
  }

  .off:focus-visible {
    box-shadow: 0 0 0 3px #ffffff, 0 0 0 5px #2b2118;
  }

  /* A band too thin for the button stays pure light; it is turned off where it was turned on. */
  @container (max-height: 52px) {
    .off {
      display: none;
    }
  }
</style>
