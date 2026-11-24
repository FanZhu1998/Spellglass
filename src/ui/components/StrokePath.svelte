<script lang="ts" module>
  /** Each drawing's mask needs an id of its own on the page. */
  let nextId = 0;
</script>

<script lang="ts">
  // Draws a gesture: the stroke "with a start dot" (Section 10.3), optionally drawing itself at the
  // intended pace with a pace dot. Points are an isotropic unit-square path (SpellbookEntry.templates,
  // or geometry.flickPath for flicks), or caster-space points with `aspect` (keepsakes).
  // Under reduced motion the stroke appears whole, with an arrowhead to show its direction.
  // In ink (on parchment) it is drawn as with a quill: a broad nib held at a slant, so the line swells
  // where it runs across the nib and thins where it runs along it, touches down lightly and lifts off
  // thin; it draws itself through a mask that follows the stroke. In light (on the dark glass) it is
  // an even line of candlelight.
  import type { Point } from '../../contracts';

  let {
    points,
    aspect = 1,
    size = 220,
    animate = false,
    durationMs = 1400,
    loop = true,
    reducedMotion = false,
    tone = 'ink',
    label = 'Gesture',
  }: {
    points: Point[];
    aspect?: number;
    size?: number;
    animate?: boolean;
    durationMs?: number;
    loop?: boolean;
    reducedMotion?: boolean;
    /** ink: dark on vellum; light: candle on dark glass. */
    tone?: 'ink' | 'light';
    label?: string;
  } = $props();

  const PAD = 12;
  /** The nib's slant: 35 degrees, a writing master's angle. */
  const NIB = (35 * Math.PI) / 180;
  const uid = `stroke-${++nextId}`;

  const fitted = $derived.by(() => {
    const iso = points.map(([x, y]) => [x * aspect, y] as Point);
    if (iso.length === 0) return [] as Point[];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of iso) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const side = Math.max(maxX - minX, maxY - minY) || 1;
    const s = (100 - PAD * 2) / side;
    const ox = PAD + (100 - PAD * 2 - (maxX - minX) * s) / 2;
    const oy = PAD + (100 - PAD * 2 - (maxY - minY) * s) / 2;
    return iso.map(([x, y]) => [ox + (x - minX) * s, oy + (y - minY) * s] as Point);
  });

  const d = $derived(fitted.length ? 'M' + fitted.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L') : '');
  const start = $derived(fitted[0]);
  const end = $derived(fitted[fitted.length - 1]);
  const arrow = $derived.by(() => {
    if (fitted.length < 2 || !end) return '';
    const before = fitted[Math.max(0, fitted.length - 4)];
    const a = Math.atan2(end[1] - before[1], end[0] - before[0]);
    const l = 6;
    const p1 = [end[0] - l * Math.cos(a - 0.5), end[1] - l * Math.sin(a - 0.5)];
    const p2 = [end[0] - l * Math.cos(a + 0.5), end[1] - l * Math.sin(a + 0.5)];
    return `M${p1[0].toFixed(2)} ${p1[1].toFixed(2)} L${end[0].toFixed(2)} ${end[1].toFixed(2)} L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  });
  const moving = $derived(animate && !reducedMotion && fitted.length > 1);

  /** The nib's widths in drawing units: a small drawing (the guide's cards) needs a heavier hand to
   *  read at all. */
  const widest = $derived(size <= 80 ? 5.6 : size <= 130 ? 4.6 : 4);
  const narrowest = $derived(widest * (size <= 80 ? 0.34 : 0.24));

  /** The quill's outline: each point pushed out either side by half the nib's width there. */
  const quill = $derived.by(() => {
    const pts = fitted;
    if (tone !== 'ink' || pts.length < 2) return '';
    const n = pts.length;
    const along: number[] = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = along[n - 1] || 1;
    const dir = (i: number) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      return Math.atan2(b[1] - a[1], b[0] - a[0]);
    };
    // Width by direction, smoothed along the line so a corner turns the nib rather than snapping it.
    // The power keeps the thin strokes hairline-thin a little longer, as a broad nib draws them.
    const raw = pts.map((_, i) => narrowest + (widest - narrowest) * Math.abs(Math.sin(dir(i) - NIB)) ** 1.4);
    const smooth = raw.map((_, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { sum += raw[j]; count++; }
      return sum / count;
    });
    // A light touch going down, a thin lift at the end.
    const taper = (s: number) => {
      const t0 = Math.min(1, s / Math.min(9, total * 0.18));
      const t1 = Math.min(1, (total - s) / Math.min(14, total * 0.25));
      return 0.45 + 0.55 * Math.sqrt(Math.max(0, Math.min(t0, t1)));
    };
    const left: Point[] = [];
    const right: Point[] = [];
    let w0 = 0, wn = 0;
    for (let i = 0; i < n; i++) {
      const a = dir(i);
      const w = (smooth[i] * taper(along[i])) / 2;
      if (i === 0) w0 = w;
      if (i === n - 1) wn = w;
      const nx = -Math.sin(a) * w;
      const ny = Math.cos(a) * w;
      left.push([pts[i][0] + nx, pts[i][1] + ny]);
      right.push([pts[i][0] - nx, pts[i][1] - ny]);
    }
    right.reverse();
    const f = (p: Point) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    // Each edge as a curve through the midpoints between its points, so the ink has no corners the
    // hand did not make.
    const edge = (side: Point[]) => {
      let s = '';
      for (let i = 1; i < side.length - 1; i++) {
        const mid: Point = [(side[i][0] + side[i + 1][0]) / 2, (side[i][1] + side[i + 1][1]) / 2];
        s += ` Q${f(side[i])} ${f(mid)}`;
      }
      return `${s} L${f(side[side.length - 1])}`;
    };
    return `M${f(left[0])}${edge(left)} A${wn.toFixed(2)} ${wn.toFixed(2)} 0 0 1 ${f(right[0])}${edge(right)} A${w0.toFixed(2)} ${w0.toFixed(2)} 0 0 1 ${f(left[0])} Z`;
  });

  /** The arrowhead in ink: a small filled barb at the end of the line. */
  const barb = $derived.by(() => {
    if (fitted.length < 2 || !end) return '';
    const before = fitted[Math.max(0, fitted.length - 4)];
    const a = Math.atan2(end[1] - before[1], end[0] - before[0]);
    const l = widest * 1.9;
    const tip = [end[0] + Math.cos(a) * widest * 0.6, end[1] + Math.sin(a) * widest * 0.6];
    const p1 = [tip[0] - l * Math.cos(a - 0.42), tip[1] - l * Math.sin(a - 0.42)];
    const p2 = [tip[0] - l * Math.cos(a + 0.42), tip[1] - l * Math.sin(a + 0.42)];
    const back = [tip[0] - l * 0.62 * Math.cos(a), tip[1] - l * 0.62 * Math.sin(a)];
    const f = (p: number[]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    return `M${f(tip)} L${f(p1)} Q${f(back)} ${f(p2)} Z`;
  });
</script>

<svg
  class="stroke-path"
  data-tone={tone}
  width={size}
  height={size}
  viewBox="0 0 100 100"
  role="img"
  aria-label={label}
  style:--draw-ms="{durationMs}ms"
  style:--iterations={loop ? 'infinite' : '1'}
>
  {#if d}
    {#if quill}
      <!-- The pencilled guide, the inked stroke over it, its barb, and the start dot in rubric. -->
      <path class="guide" d={d} />
      {#if moving}
        <mask id={uid} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
          <path class="reveal moving" d={d} pathLength="1" style:stroke-width={widest * 2.2} />
        </mask>
      {/if}
      <path class="quill" d={quill} mask={moving ? `url(#${uid})` : undefined} />
      {#if !moving}<path class="barb" d={barb} />{/if}
      {#if start}<circle class="start" cx={start[0]} cy={start[1]} r={Math.max(3.4, widest * 0.85)} />{/if}
      {#if moving}<circle class="pace" r="2.6" style:offset-path="path('{d}')" />{/if}
    {:else}
      <path class="guide" d={d} />
      <path class="ink" class:moving d={d} pathLength="1" />
      {#if !moving}<path class="arrow" d={arrow} />{/if}
      {#if start}<circle class="start" cx={start[0]} cy={start[1]} r="3.4" />{/if}
      {#if moving}<circle class="pace" r="2.6" style:offset-path="path('{d}')" />{/if}
    {/if}
  {/if}
</svg>

<style>
  .stroke-path {
    display: block;
    overflow: visible;
    --c-ink: #2b2118;
    --c-guide: rgb(43 33 24 / 0.14);
    --c-start: #7b1e2b;
    --c-pace: #8a5a12;
  }

  .stroke-path[data-tone='light'] {
    --c-ink: var(--candle);
    --c-guide: rgb(233 223 199 / 0.14);
    --c-start: var(--vellum);
    --c-pace: #fff3d6;
  }

  path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .guide {
    stroke: var(--c-guide);
    stroke-width: 5;
  }

  /* On parchment the guide is a pencilled line, finer than the ink over it. */
  .stroke-path[data-tone='ink'] .guide {
    stroke-width: 3.2;
    stroke-dasharray: 0.6 2.4;
  }

  .ink {
    stroke: var(--c-ink);
    stroke-width: 3;
  }

  /* Iron-gall ink: nearly black, browning where it pools. */
  .quill {
    fill: var(--c-ink);
    stroke: none;
  }

  .barb {
    fill: var(--c-ink);
    stroke: none;
  }

  .reveal {
    stroke: #fff;
  }

  /* forwards: a single pass (loop={false}) leaves the ink drawn instead of snapping back to empty. */
  .ink.moving,
  .reveal.moving {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: draw var(--draw-ms) cubic-bezier(0.45, 0.05, 0.55, 0.95) var(--iterations) forwards;
  }

  .arrow {
    stroke: var(--c-ink);
    stroke-width: 3;
  }

  .start {
    fill: var(--c-start);
  }

  .stroke-path[data-tone='ink'] .start {
    stroke: rgb(255 246 230 / 0.6);
    stroke-width: 0.8;
  }

  .pace {
    fill: var(--c-pace);
    offset-rotate: 0deg;
    animation: pace var(--draw-ms) cubic-bezier(0.45, 0.05, 0.55, 0.95) var(--iterations) forwards;
  }

  @keyframes draw {
    0% { stroke-dashoffset: 1; }
    80%, 100% { stroke-dashoffset: 0; }
  }

  @keyframes pace {
    0% { offset-distance: 0%; opacity: 1; }
    80% { offset-distance: 100%; opacity: 1; }
    100% { offset-distance: 100%; opacity: 0; }
  }
</style>
