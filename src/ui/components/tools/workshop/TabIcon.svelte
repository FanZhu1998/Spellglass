<script lang="ts" module>
  // Small line drawings for the Workshop's tabs: original shapes in the current text color, drawn like
  // the frame's own icons (components/shell/Icon.svelte).
  type Shape =
    | { d: string; fill?: boolean }
    | { cx: number; cy: number; r: number; fill?: boolean }
    | { x: number; y: number; w: number; h: number; rx?: number; fill?: boolean };

  const ICONS: Record<string, Shape[]> = {
    // Two switches.
    settings: [
      { x: 3.5, y: 4.5, w: 17, h: 6.5, rx: 3.25 },
      { cx: 7.6, cy: 7.75, r: 1.9, fill: true },
      { x: 3.5, y: 13, w: 17, h: 6.5, rx: 3.25 },
      { cx: 16.4, cy: 16.25, r: 1.9, fill: true },
    ],
    // Two sheets, one over the other: pack files.
    packs: [
      { d: 'M8 6.2V4.8A1.3 1.3 0 0 1 9.3 3.5h9.4A1.3 1.3 0 0 1 20 4.8v11.4a1.3 1.3 0 0 1-1.3 1.3H17' },
      { x: 4, y: 6.5, w: 13, h: 14, rx: 1.3 },
      { d: 'M7 11h7M7 14h7M7 17h4.5' },
    ],
    // A looping stroke with its start dot.
    gestures: [
      { d: 'M5 17c2.5-.5 4-2.6 4-5.2C9 9.3 10.6 7 13 7c2.3 0 3.6 1.7 3.6 3.6 0 2.4-2 3.8-4.2 3.8-1.6 0-2.4-1-2.4-1' },
      { d: 'M16.6 10.6c1.6 1.3 2.4 3.1 2.4 6.4' },
      { cx: 5, cy: 17, r: 1.7, fill: true },
    ],
    // Two links of a chain.
    bindings: [
      { d: 'M10.2 13.8a3.8 3.8 0 0 0 5.4 0l3.1-3.1a3.8 3.8 0 0 0-5.4-5.4l-1.2 1.2' },
      { d: 'M13.8 10.2a3.8 3.8 0 0 0-5.4 0l-3.1 3.1a3.8 3.8 0 0 0 5.4 5.4l1.2-1.2' },
    ],
    // A small chest.
    data: [
      { x: 4, y: 10, w: 16, h: 9.5, rx: 1.4 },
      { d: 'M4 10c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5' },
      { d: 'M10.4 12.4h3.2v2.8h-3.2z' },
    ],
    // A pulse.
    diagnostics: [{ d: 'M3 12.5h4l2.2-5.5 4.2 10.5 2.3-5H21' }],
  };
</script>

<script lang="ts">
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const shapes = $derived(ICONS[name] ?? []);
</script>

<svg class="tab-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#each shapes as s, i (i)}
    {#if 'd' in s}
      <path d={s.d} class:fill={s.fill} />
    {:else if 'cx' in s}
      <circle cx={s.cx} cy={s.cy} r={s.r} class:fill={s.fill} />
    {:else}
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.rx ?? 0} class:fill={s.fill} />
    {/if}
  {/each}
</svg>

<style>
  .tab-icon {
    display: block;
    flex: none;
    overflow: visible;
  }

  path,
  circle,
  rect {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .fill {
    fill: currentColor;
    stroke: none;
  }
</style>
