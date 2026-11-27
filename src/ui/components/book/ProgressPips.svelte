<script lang="ts">
  // Accepted casts toward learning as a row of ink dots: filled for each accepted cast, open for the
  // rest. Decorative: the words beside it ("2 of 3") carry the meaning, so it is hidden from
  // assistive technology. Shapes differ (filled and open), not only color.
  let { accepted, goal, tone = 'ink' }: { accepted: number; goal: number; tone?: 'ink' | 'light' } = $props();

  const MAX_PIPS = 12;
  const total = $derived(Math.max(1, Math.min(MAX_PIPS, Math.floor(goal) || 1)));
  const done = $derived(Math.max(0, Math.min(total, Math.floor(accepted) || 0)));
</script>

{#if goal <= MAX_PIPS}
  <span class="pips" data-tone={tone} aria-hidden="true">
    {#each { length: total } as _, i (i)}
      <span class="pip" class:on={i < done}></span>
    {/each}
  </span>
{/if}

<style>
  .pips {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    --pip: var(--ink);
  }

  .pips[data-tone='light'] {
    --pip: var(--candle);
  }

  .pip {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--pip);
    opacity: 0.75;
  }

  .pip.on {
    background: var(--pip);
    opacity: 1;
  }
</style>
