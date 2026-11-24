<script lang="ts" module>
  // Small line drawings for the frame's controls: original shapes, drawn in the current text color.
  // Each is a thing from the study, as an engraver would draw it, not an app's glyph.
  type Shape =
    | { d: string; fill?: boolean }
    | { cx: number; cy: number; r: number; fill?: boolean }
    | { x: number; y: number; w: number; h: number; rx?: number; fill?: boolean };

  const ICONS: Record<string, Shape[]> = {
    // An open book, pages fanned.
    book: [
      { d: 'M12 6.5C10 5 7.2 4.6 3.5 5v13c3.7-.4 6.5 0 8.5 1.5' },
      { d: 'M12 6.5c2-1.5 4.8-1.9 8.5-1.5v13c-3.7-.4-6.5 0-8.5 1.5' },
      { d: 'M12 6.5v13' },
    ],
    // A looping stroke with its start dot: practice a gesture.
    practice: [
      { d: 'M5 17c2.5-.5 4-2.6 4-5.2C9 9.3 10.6 7 13 7c2.3 0 3.6 1.7 3.6 3.6 0 2.4-2 3.8-4.2 3.8-1.6 0-2.4-1-2.4-1' },
      { d: 'M16.6 10.6c1.6 1.3 2.4 3.1 2.4 6.4' },
      { cx: 5, cy: 17, r: 1.7, fill: true },
    ],
    // Tune wand: a tuning fork, ringing, with a glint of magic over its tines.
    tune: [
      { d: 'M12 21V14.4' },
      { d: 'M8.7 3.6v6.6c0 2.5 1.5 4.2 3.3 4.2s3.3-1.7 3.3-4.2V3.6' },
      { cx: 12, cy: 21.2, r: 1.25, fill: true },
      { d: 'M5.4 5.6c-.9 1.3-.9 3 0 4.3M18.6 5.6c.9 1.3.9 3 0 4.3' },
      { d: 'M20.4 1.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z', fill: true },
    ],
    // Share: a folded letter, closed with a wax seal.
    share: [
      { d: 'M3.4 6.6h17.2v12H3.4Z' },
      { d: 'M3.4 6.6l8.6 6.6 8.6-6.6' },
      { d: 'M3.4 18.6l6.2-5.1M20.6 18.6l-6.2-5.1' },
      { cx: 12, cy: 13.2, r: 2.9, fill: true },
    ],
    // The Workshop: a pair of brass dividers over the arc they have drawn.
    workshop: [
      { cx: 12, cy: 4.2, r: 1.7 },
      { d: 'M12 2.5V1' },
      { d: 'M11 5.6 6.2 20.6M13 5.6l4.8 15' },
      { d: 'M7.6 16.2c2.8 1.6 6 1.6 8.8 0' },
    ],
    // The app's link to hand on: a calling card, its corner turned down, printed with a code's three
    // corner marks (it opens the QR code).
    qr: [
      { d: 'M4 3.2h11.6L20 7.6v13.2H4Z' },
      { d: 'M15.6 3.2v4.4H20' },
      { x: 6.6, y: 6, w: 4, h: 4, rx: 0.4 },
      { x: 6.6, y: 14.2, w: 4, h: 4, rx: 0.4 },
      { x: 13.4, y: 14.2, w: 4, h: 4, rx: 0.4 },
      { x: 7.9, y: 7.3, w: 1.4, h: 1.4, fill: true },
      { x: 7.9, y: 15.5, w: 1.4, h: 1.4, fill: true },
      { x: 14.7, y: 15.5, w: 1.4, h: 1.4, fill: true },
      { x: 12.6, y: 10.2, w: 1.4, h: 1.4, fill: true },
    ],
    // How the app sees the wand: a spyglass, its draws pulled out, the lens hood flared at its end.
    eye: [
      { d: 'M2.6 16.4 6.8 14 8 16.1 3.8 18.5Z' },
      { d: 'M6.5 13.4 11.1 10.8 12.9 13.9 8.3 16.5Z' },
      { d: 'M10.7 10.1 16.3 6.9 18.7 11 13.1 14.2Z' },
      { d: 'M16.3 6.9 19.6 4.1 22.4 8.9 18.7 11' },
      { d: 'M13.4 9.3 15.4 12.7' },
    ],
    // A wand with a glint at its tip (route A).
    wand: [
      { d: 'M4 20 14.2 9.8' },
      { d: 'M3.2 19.2l1.6 1.6' },
      { d: 'M17.5 3v3.4M17.5 9.6V13M12.8 8h3.4M18.8 8h3.4M14.2 4.7l1.3 1.3M19.5 10l1.3 1.3M19.5 6l1.3-1.3' },
      { cx: 17.5, cy: 8, r: 1.1, fill: true },
    ],
    // A hand with the index finger raised (route B).
    hand: [
      { d: 'M9.5 13V4.8a1.5 1.5 0 0 1 3 0V11' },
      { d: 'M12.5 11V9.6a1.4 1.4 0 0 1 2.8 0V11.5' },
      { d: 'M15.3 11.2a1.4 1.4 0 0 1 2.7.3v3.2c0 3.3-2.3 5.8-5.6 5.8-2.3 0-3.7-1-5-2.8l-2.1-3.1a1.4 1.4 0 0 1 2.1-1.8L9.5 14.5' },
    ],
    // A camera lens ringed with infrared lights (route C).
    infrared: [
      { cx: 12, cy: 12, r: 4.2 },
      { cx: 12, cy: 12, r: 1.6, fill: true },
      { cx: 12, cy: 3.8, r: 1, fill: true },
      { cx: 12, cy: 20.2, r: 1, fill: true },
      { cx: 3.8, cy: 12, r: 1, fill: true },
      { cx: 20.2, cy: 12, r: 1, fill: true },
      { cx: 6.2, cy: 6.2, r: 1, fill: true },
      { cx: 17.8, cy: 17.8, r: 1, fill: true },
      { cx: 6.2, cy: 17.8, r: 1, fill: true },
      { cx: 17.8, cy: 6.2, r: 1, fill: true },
    ],
    // A pointer arrow (route D).
    pointer: [{ d: 'M6 3.5v15.2l4.1-3.9 2.7 6 2.6-1.2-2.7-5.9 5.6-.3Z' }],
    // Try again.
    retry: [
      { d: 'M19 12a7 7 0 1 1-2.1-5' },
      { d: 'M17.6 3.6 17 7.3l-3.6-.7' },
    ],
    // Watch again.
    replay: [
      { d: 'M5 12a7 7 0 1 0 2.1-5' },
      { d: 'M6.4 3.6 7 7.3l3.6-.7' },
      { d: 'M10.4 9.3v5.4l4.4-2.7Z', fill: true },
    ],
    close: [{ d: 'M6 6l12 12M18 6 6 18' }],
    sun: [
      { cx: 12, cy: 12, r: 3.6 },
      { d: 'M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6' },
    ],
    // A small seal for celebrations.
    star: [{ d: 'm12 3.5 2.4 5.3 5.8.6-4.3 3.9 1.2 5.7L12 16.1 6.9 19l1.2-5.7L3.8 9.4l5.8-.6Z' }],
    // The spell guide: a slip of paper with a traced stroke and its start dot.
    guide: [
      { d: 'M6 3.5h8.5L18 7v13.5H6Z' },
      { d: 'M14.5 3.5V7H18' },
      { d: 'M8.8 16.8c1.4-3.6 2.6-5.3 3.6-5.3 1.5 0 .3 3.8 2.8 3.8' },
      { cx: 8.8, cy: 16.8, r: 1.25, fill: true },
    ],
  };
</script>

<script lang="ts">
  let { name, size = 22 }: { name: keyof typeof ICONS | string; size?: number } = $props();
  const shapes = $derived(ICONS[name] ?? []);
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
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
  .icon {
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
