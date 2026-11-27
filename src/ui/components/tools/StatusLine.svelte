<script module lang="ts">
  export type { StatusKind } from './status';
</script>

<script lang="ts">
  import type { StatusKind } from './status';
  // A result shown in words and in shape, never by color alone (Section 10.6): a tick for done, a
  // diamond with a bar for a warning, a cross for a failure, three dots while busy.
  // Announcements go through the screen's own live region; this line is what the eye reads.
  let { kind = 'info', text, compact = false }: { kind?: StatusKind; text: string; compact?: boolean } = $props();
</script>

<p class="status" class:compact data-kind={kind}>
  <svg class="mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    {#if kind === 'ok'}
      <circle cx="10" cy="10" r="8.5" />
      <path d="M5.8 10.4 L8.7 13.2 L14.3 7" />
    {:else if kind === 'warn'}
      <path d="M10 1.8 L18.2 10 L10 18.2 L1.8 10 Z" />
      <path d="M10 6 L10 11" />
      <circle class="dot" cx="10" cy="14" r="1.2" />
    {:else if kind === 'error'}
      <rect x="2" y="2" width="16" height="16" rx="3" />
      <path d="M6.6 6.6 L13.4 13.4 M13.4 6.6 L6.6 13.4" />
    {:else if kind === 'busy'}
      <circle class="dot" cx="4" cy="10" r="1.8" />
      <circle class="dot" cx="10" cy="10" r="1.8" />
      <circle class="dot" cx="16" cy="10" r="1.8" />
    {:else}
      <circle cx="10" cy="10" r="8.5" />
      <path d="M10 9 L10 14.5" />
      <circle class="dot" cx="10" cy="5.8" r="1.2" />
    {/if}
  </svg>
  <span class="text">{text}</span>
</p>

<style>
  .status {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 0;
    padding: 10px 14px;
    border-radius: var(--radius-small);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 55%, transparent);
    color: var(--vellum);
    font-size: var(--text-small);
    line-height: 1.45;
  }

  .status.compact {
    padding: 0;
    border: 0;
    background: none;
  }

  .mark {
    flex: none;
    margin-top: 1px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mark .dot {
    fill: currentColor;
    stroke: none;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .status[data-kind='ok'] .mark { color: var(--verdigris); }
  .status[data-kind='warn'] .mark { color: var(--candle); }
  .status[data-kind='error'] .mark { color: #e8828c; }
  .status[data-kind='busy'] .mark,
  .status[data-kind='info'] .mark { color: var(--ash); }

  .status[data-kind='ok']:not(.compact) { border-color: color-mix(in srgb, var(--verdigris) 45%, transparent); }
  .status[data-kind='warn']:not(.compact) { border-color: color-mix(in srgb, var(--candle) 45%, transparent); border-style: dashed; }
  .status[data-kind='error']:not(.compact) { border-color: color-mix(in srgb, #e8828c 55%, transparent); border-style: dashed; }
</style>
