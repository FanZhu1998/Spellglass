<script lang="ts">
  import { fly } from 'svelte/transition';
  import type { AppState } from '../app-state.svelte';

  let { app }: { app: AppState } = $props();
  let later = $state(false);
  let updating = $state(false);

  // Updates never interrupt a cast (Section 9.1 rule 10): wait for an idle moment, and stay out of
  // the way of a replay or a stroke in progress, and of the Spellbook or a drawer open over the room.
  const show = $derived(app.updateWaiting && !later && !app.casting && !app.roomInert);

  async function update() {
    updating = true;
    try {
      await app.applyUpdate();
    } finally {
      updating = false;
    }
  }
</script>

{#if show}
  <div class="update on-vellum" role="status" aria-live="polite" transition:fly={{ y: -12, duration: app.reducedMotion ? 0 : 240 }}>
    <p><span class="mark" aria-hidden="true">✦</span>A new edition has arrived. Update now, or after this session.</p>
    <div class="row">
      <button class="btn btn-seal btn-small" onclick={update} disabled={updating}>{updating ? 'Updating' : 'Update now'}</button>
      <button class="btn btn-small btn-ghost" onclick={() => (later = true)}>After this session</button>
    </div>
  </div>
{/if}

<style>
  /* A notice pinned to the glass, as the mirror's own notes are: a slip of parchment with an inked
     rule inside its edge, held by a brass pin. It hangs under whatever the glass's top edge shows (the
     notes, the cast banner: App.svelte's --glass-top anchor), centred, so it covers neither those
     nor the session log in the top right corner, and never the frame. It stays outside the room in
     the page, so the room going inert never silences it. */
  .update {
    position: fixed;
    z-index: 70;
    width: max-content;
    max-width: min(520px, 90vw);
    padding: 14px 20px 14px;
    border-radius: 2px;
    background:
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(120% 120% at 30% 20%, color-mix(in srgb, var(--vellum) 94%, white), var(--vellum) 60%, var(--vellum-2));
    background-blend-mode: soft-light, normal;
    box-shadow: inset 0 0 0 1px rgb(110 76 30 / 0.35), inset 0 0 14px rgb(120 84 36 / 0.2), 2px 8px 22px rgb(0 0 0 / 0.55);
    color: var(--ink);
    text-align: center;
    /* Without anchor positioning: under the status tags at the top right, as before. */
    top: calc(var(--screen-light, 0px) + 64px);
    right: 20px;
  }

  @supports (position-anchor: --glass-top) {
    .update {
      position-anchor: --glass-top;
      top: calc(anchor(bottom) + 12px);
      right: auto;
      left: anchor(center);
      translate: -50% 0;
    }
  }

  /* The inked rule, and the pin. */
  .update::before {
    content: '';
    position: absolute;
    inset: 4px;
    border: 1px solid rgb(43 33 24 / 0.3);
    pointer-events: none;
  }

  .update::after {
    content: '';
    position: absolute;
    top: -4px;
    left: 50%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    border-radius: 50%;
    background: radial-gradient(circle at 36% 30%, #fff2c8, #c9a356 45%, #5a4019);
    box-shadow: 0 0 0 1px #2e2009, 1px 2px 2px rgb(0 0 0 / 0.5);
  }

  .update p {
    margin: 0 0 10px;
    font-size: var(--text-small);
    line-height: 1.4;
  }

  .row {
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px 10px;
  }

  .mark {
    margin-right: 8px;
    color: var(--rubric);
  }
</style>
