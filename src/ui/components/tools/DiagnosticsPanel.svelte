<script lang="ts">
  // Live numbers from 'diagnostics.stats' (once a second): how long a decision takes after a stroke
  // ends (target 50 ms or less), how far the trail lags behind the camera (150 ms or less at 30 fps,
  // 100 ms at 60), and events per second by type (Section 2 targets, Section 13). A number over its
  // target gets a dashed edge and the words "over target", not a color alone.
  import { untrack } from 'svelte';
  import type { DiagnosticsStats } from '../../../contracts';
  import { lastPayload, on } from '../../../kernel';
  import type { AppState } from '../../app-state.svelte';

  let {
    app,
    compact = false,
    recordingLine,
  }: {
    app: AppState;
    compact?: boolean;
    /** Replaces the plain "Recording a session" line while one runs (the overlay names the spell). */
    recordingLine?: string;
  } = $props();

  let stats = $state.raw<DiagnosticsStats | null>(null);

  $effect(() => {
    const k = app.kernel;
    untrack(() => (stats = lastPayload(k, 'diagnostics.stats') ?? null));
    return on(k, 'diagnostics.stats', (s) => (stats = s));
  });

  const KEY_RATES: { type: string; label: string; unit: string }[] = [
    { type: 'camera.frame', label: 'Camera frames', unit: 'per second' },
    { type: 'tip.sample', label: 'Tip samples', unit: 'per second' },
    { type: 'tip.filtered', label: 'Trail points', unit: 'per second' },
  ];

  const fpsNow = $derived(app.tracker?.fps ?? 0);
  const trailTarget = $derived(fpsNow >= 50 ? 100 : 150);
  const decisionOver = $derived(typeof stats?.decisionMs === 'number' && stats.decisionMs > 50);
  const trailOver = $derived(typeof stats?.trailLatencyMs === 'number' && stats.trailLatencyMs > trailTarget);
  const others = $derived.by(() => {
    const r = stats?.rates ?? {};
    return Object.entries(r)
      .filter(([type, n]) => n > 0 && !KEY_RATES.some((k) => k.type === type))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40);
  });

  const fmt = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? (n < 10 ? n.toFixed(1) : String(Math.round(n))) : '–');
</script>

<div class="diag" class:compact>
  {#if !stats}
    <p class="muted waiting">Waiting for the first numbers…</p>
  {:else}
    <dl class="keys">
      <div data-over={decisionOver}>
        <dt>Decision</dt>
        <dd>{fmt(stats.decisionMs)} ms</dd>
        {#if !compact}<dd class="target">{decisionOver ? 'over target: ' : 'target '}50 ms or less</dd>{:else if decisionOver}<dd class="target">over target</dd>{/if}
      </div>
      <div data-over={trailOver}>
        <dt>Trail delay</dt>
        <dd>{fmt(stats.trailLatencyMs)} ms</dd>
        {#if !compact}<dd class="target">{trailOver ? 'over target: ' : 'target '}{trailTarget} ms or less</dd>{:else if trailOver}<dd class="target">over target</dd>{/if}
      </div>
      {#each KEY_RATES as k (k.type)}
        <div>
          <dt>{k.label}</dt>
          <dd>{fmt(stats.rates[k.type] ?? 0)}{compact ? '/s' : ''}</dd>
          {#if !compact}<dd class="target">{k.unit}</dd>{/if}
        </div>
      {/each}
    </dl>
    {#if !compact && !stats.decisionMs}
      <p class="muted note">The decision time appears after the first stroke is decided.</p>
    {/if}
    {#if others.length && !compact}
      <table class="rates">
        <caption>Other events per second</caption>
        <tbody>
          {#each others as [type, n] (type)}
            <tr><th scope="row">{type}</th><td>{fmt(n)}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if stats.recording}<p class="rec"><span class="dot" aria-hidden="true"></span>{recordingLine ?? 'Recording a session'}</p>{/if}
  {/if}
</div>

<style>
  .diag {
    display: grid;
    gap: 14px;
  }

  .waiting,
  .note {
    margin: 0;
    font-size: var(--text-small);
  }

  /* A ledger: what is measured, its value, and the target, one row each. */
  .keys {
    display: grid;
    margin: 0;
    border-radius: var(--radius-small);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 50%, transparent);
    overflow: hidden;
  }

  .keys > div {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.75fr) minmax(0, 1.5fr);
    align-items: baseline;
    gap: 4px 12px;
    padding: 8px 14px;
    margin-top: -1px;
    border-top: 1px solid var(--line);
  }

  .keys > div[data-over='true'] {
    background: color-mix(in srgb, var(--candle) 7%, transparent);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--candle) 70%, transparent);
  }

  dt {
    font-size: var(--text-small);
    color: var(--ash);
  }

  dd {
    margin: 0;
    font-size: var(--text-body);
    color: var(--vellum);
    font-variant-numeric: lining-nums tabular-nums;
  }

  dd.target {
    font-size: var(--text-label);
    color: var(--ash);
  }

  [data-over='true'] dd.target {
    color: var(--candle);
  }

  .rates {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-small);
  }

  .rates caption {
    text-align: left;
    padding-bottom: 6px;
    color: var(--ash);
  }

  .rates th,
  .rates td {
    padding: 3px 0;
    border-bottom: 1px solid var(--line);
  }

  .rates th {
    text-align: left;
    font-weight: 400;
    color: var(--vellum);
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: var(--text-small);
    overflow-wrap: anywhere;
  }

  .rates td {
    text-align: right;
    font-variant-numeric: lining-nums tabular-nums;
  }

  .rec {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #d9475a;
    box-shadow: 0 0 0 3px rgb(217 71 90 / 0.25);
  }

  /* The overlay: a small ledger, one number per row, so it keeps to its corner of the room. */
  .compact {
    gap: 8px;
  }

  .compact .keys {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .compact .keys {
    border: 0;
    border-radius: 0;
    background: none;
  }

  .compact .keys > div {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0 10px;
    padding: 3px 2px;
    margin-top: 0;
    border-top: 0;
    border-bottom: 1px solid var(--line);
  }

  .compact .keys > div[data-over='true'] {
    border-bottom: 1px dashed color-mix(in srgb, var(--candle) 70%, transparent);
    box-shadow: none;
  }

  .compact dd {
    font-size: var(--text-small);
  }

  .compact dd.target {
    flex-basis: 100%;
    text-align: right;
  }
</style>
