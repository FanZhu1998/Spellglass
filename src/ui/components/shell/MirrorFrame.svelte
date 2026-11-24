<script lang="ts">
  // The mirror's carved and gilded frame (art direction: "layered mouldings, carved corner
  // ornaments, an arched cartouche at the top centre"). Drawn as one SVG at the frame's own size, so
  // it stays crisp at any size and its ornaments keep their shape: the rails are mitred and lit from
  // the upper left, with an outer bead, a cove, a twisted rope and a row of pearls round the glass;
  // acanthus scrolls and a rosette at each corner; a small arched plaque with a crescent moon and
  // stars at the top, and a shell at the bottom. It sits under the glass, so nothing of it covers the
  // stage, and is drawn again only when the frame changes size. Decorative: hidden from assistive
  // technology.
  let w = $state(0);
  let h = $state(0);
  /** The frame's thickness: its padding (App.svelte's --pad). */
  let p = $state(0);
  let host = $state<HTMLDivElement | null>(null);

  $effect(() => {
    void w;
    void h;
    const frame = host?.parentElement;
    if (!frame || typeof getComputedStyle !== 'function') return;
    const pad = parseFloat(getComputedStyle(frame).paddingLeft) || 0;
    if (pad !== p) p = pad;
  });

  /** Design units: the rail is 40 units thick, whatever its size on screen. */
  const k = $derived(p / 40);
  const ready = $derived(w > 0 && h > 0 && p > 0);
  /** Small frames (a phone) keep the mouldings and lose the finest detail. */
  const fine = $derived(p >= 15);
  /** The corner pieces stand proud of the rails; the cartouche is larger still, and smaller on a
   *  narrow frame, where the status tags sit close above it. It never grows past the room left above
   *  the frame on a wide window, where the frame is thicker (App.svelte's --pad). */
  const kc = $derived(k * 1.2);
  const kt = $derived(Math.min(k * (w < 560 ? 0.95 : 1.3), 0.92));

  // The moulding's profile across the rail, outer edge to the glass. Offsets are fractions of the
  // rail; the rope and pearls are drawn over their bands. Old gilding on carved wood: the gold is
  // bright only on the crowns of the two beads, where light and dusting have burnished it; the cove and
  // the recesses between the mouldings are deep and brown, as gilt gone dark in the hollows is.
  const PROFILE: [number, string][] = [
    [0, '#120a04'],
    [0.02, '#3a2810'],
    [0.045, '#9c7a38'],
    [0.068, '#e6cd8c'],
    [0.088, '#8a6a2c'],
    [0.112, '#3e2c12'],
    [0.14, '#22170a'],
    [0.22, '#2c1f0d'],
    [0.3, '#4f3a17'],
    [0.365, '#7d5f27'],
    [0.4, '#b08c46'],
    [0.428, '#ecd492'],
    [0.448, '#c19e56'],
    [0.472, '#6a4f20'],
    [0.495, '#3e2c12'],
    [0.515, '#8a6a2c'],
    [0.535, '#55401a'],
    [0.555, '#2a1c0a'],
    [0.725, '#2a1c0a'],
    [0.75, '#1a1207'],
    [0.79, '#130d05'],
    [0.93, '#130d05'],
    [0.955, '#6a4f20'],
    [1, '#0a0602'],
  ];
  const ROPE = [0.555, 0.725];
  const PEARLS = [0.79, 0.93];

  /** Rope and pearl spacing, fitted so each rail holds a whole number of them. */
  const fit = (length: number, step: number) => length / Math.max(1, Math.round(length / step));
  const ropeStep = $derived(fit(w - 2 * p, p * 0.36));
  const ropeStepV = $derived(fit(h - 2 * p, p * 0.36));
  const pearlStep = $derived(fit(w - 2 * p, p * 0.17));
  const pearlStepV = $derived(fit(h - 2 * p, p * 0.17));

  const n = (v: number) => Math.round(v * 100) / 100;

  /** Where hands and dusting have rubbed the gold through to the red bole: along the outer bead and
   *  the lip of the cove, more on the top and the near side than on the far ones. Fixed places along
   *  each rail, so the wear stays put as the frame changes size. */
  const WEAR_TOP = [0.09, 0.27, 0.36, 0.58, 0.71, 0.9];
  const WEAR_SIDE = [0.18, 0.44, 0.63, 0.86];
  /** Uneven tarnish along a rail: darker reaches between brighter ones. */
  const TARNISH: [number, number][] = [[0, 0.1], [0.12, 0], [0.26, 0.14], [0.4, 0.02], [0.55, 0.12], [0.7, 0], [0.84, 0.16], [1, 0.04]];
</script>

<div class="frame-art" bind:this={host} bind:clientWidth={w} bind:clientHeight={h} aria-hidden="true">
  {#if ready}
    <svg width={w} height={h} viewBox="0 0 {w} {h}" focusable="false">
      <defs>
        <linearGradient id="mf-profile" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
          {#each PROFILE as [o, c] (o)}<stop offset={o} stop-color={c} />{/each}
        </linearGradient>
        <linearGradient id="mf-top" href="#mf-profile" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={n(p)} />
        <linearGradient id="mf-bottom" href="#mf-profile" gradientUnits="userSpaceOnUse" x1="0" y1={n(h)} x2="0" y2={n(h - p)} />
        <linearGradient id="mf-left" href="#mf-profile" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={n(p)} y2="0" />
        <linearGradient id="mf-right" href="#mf-profile" gradientUnits="userSpaceOnUse" x1={n(w)} y1="0" x2={n(w - p)} y2="0" />

        <!-- Gold modelled by light from the upper left: burnished only where it stands highest, old
             and brown toward its shadowed side. objectBoundingBox, so each carved piece is lit on
             its own. -->
        <linearGradient id="mf-gold" x1="0.15" y1="0" x2="0.6" y2="1">
          <stop offset="0" stop-color="#efd99c" />
          <stop offset="0.24" stop-color="#c7a45c" />
          <stop offset="0.6" stop-color="#8a6a2c" />
          <stop offset="1" stop-color="#4a3412" />
        </linearGradient>
        <linearGradient id="mf-gold-dim" x1="0.15" y1="0" x2="0.6" y2="1">
          <stop offset="0" stop-color="#cfb06a" />
          <stop offset="0.5" stop-color="#8f6f30" />
          <stop offset="1" stop-color="#4a3412" />
        </linearGradient>
        <radialGradient id="mf-boss" cx="0.36" cy="0.32" r="0.74">
          <stop offset="0" stop-color="#f6e4ab" />
          <stop offset="0.36" stop-color="#c39f56" />
          <stop offset="0.78" stop-color="#7d5f27" />
          <stop offset="1" stop-color="#3e2c12" />
        </radialGradient>
        <linearGradient id="mf-enamel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1d2640" />
          <stop offset="1" stop-color="#080b16" />
        </linearGradient>
        <!-- Each strand of the rope bright only along its crown. -->
        <linearGradient id="mf-strand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#eed898" />
          <stop offset="0.3" stop-color="#b8954c" />
          <stop offset="0.7" stop-color="#6e5222" />
          <stop offset="1" stop-color="#3a2810" />
        </linearGradient>
        <radialGradient id="mf-pearl" cx="0.34" cy="0.3" r="0.72">
          <stop offset="0" stop-color="#f6e4ab" />
          <stop offset="0.4" stop-color="#b8954c" />
          <stop offset="1" stop-color="#3e2c12" />
        </radialGradient>

        <!-- The rope: twisted strands, each a lit lozenge leaning across the band. -->
        <pattern id="mf-rope-h" patternUnits="userSpaceOnUse" x={n(p)} y={n(p * ROPE[0])} width={n(ropeStep)} height={n(p * (ROPE[1] - ROPE[0]))}>
          <rect width={n(ropeStep)} height={n(p * (ROPE[1] - ROPE[0]))} fill="#22170a" />
          <ellipse
            cx={n(ropeStep / 2)}
            cy={n((p * (ROPE[1] - ROPE[0])) / 2)}
            rx={n(ropeStep * 0.72)}
            ry={n(p * (ROPE[1] - ROPE[0]) * 0.3)}
            transform="rotate(-38 {n(ropeStep / 2)} {n((p * (ROPE[1] - ROPE[0])) / 2)})"
            fill="url(#mf-strand)"
            stroke="#1c1308"
            stroke-width={n(Math.max(0.5, k * 0.8))}
          />
        </pattern>
        <pattern id="mf-rope-v" patternUnits="userSpaceOnUse" x={n(p * ROPE[0])} y={n(p)} width={n(p * (ROPE[1] - ROPE[0]))} height={n(ropeStepV)}>
          <rect width={n(p * (ROPE[1] - ROPE[0]))} height={n(ropeStepV)} fill="#22170a" />
          <ellipse
            cx={n((p * (ROPE[1] - ROPE[0])) / 2)}
            cy={n(ropeStepV / 2)}
            rx={n(p * (ROPE[1] - ROPE[0]) * 0.3)}
            ry={n(ropeStepV * 0.72)}
            transform="rotate(-52 {n((p * (ROPE[1] - ROPE[0])) / 2)} {n(ropeStepV / 2)})"
            fill="url(#mf-strand)"
            stroke="#1c1308"
            stroke-width={n(Math.max(0.5, k * 0.8))}
          />
        </pattern>
        <pattern id="mf-pearls-h" patternUnits="userSpaceOnUse" x={n(p)} y={n(p * PEARLS[0])} width={n(pearlStep)} height={n(p * (PEARLS[1] - PEARLS[0]))}>
          <circle cx={n(pearlStep / 2)} cy={n((p * (PEARLS[1] - PEARLS[0])) / 2)} r={n(p * 0.058)} fill="url(#mf-pearl)" />
        </pattern>
        <pattern id="mf-pearls-v" patternUnits="userSpaceOnUse" x={n(p * PEARLS[0])} y={n(p)} width={n(p * (PEARLS[1] - PEARLS[0]))} height={n(pearlStepV)}>
          <circle cx={n((p * (PEARLS[1] - PEARLS[0])) / 2)} cy={n(pearlStepV / 2)} r={n(p * 0.058)} fill="url(#mf-pearl)" />
        </pattern>

        <linearGradient id="mf-tarnish-h" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={n(w)} y2="0">
          {#each TARNISH as [o, a] (o)}<stop offset={o} stop-color="#1a1005" stop-opacity={a} />{/each}
        </linearGradient>
        <linearGradient id="mf-tarnish-v" gradientUnits="userSpaceOnUse" x1="0" y1={n(h)} x2="0" y2="0">
          {#each TARNISH as [o, a] (o)}<stop offset={o} stop-color="#1a1005" stop-opacity={a} />{/each}
        </linearGradient>

        <!-- The carved pieces stand proud of the rails: a tight, dark contact shadow where each meets
             the moulding under it, and a softer one cast to the lower right, away from the candle. -->
        <filter id="mf-drop" x="-20%" y="-20%" width="150%" height="160%" color-interpolation-filters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation={n(Math.max(0.5, k * 0.9))} result="near" />
          <feOffset in="near" dx={n(k * 0.9)} dy={n(k * 1.7)} result="near-off" />
          <feFlood flood-color="#0a0603" flood-opacity="0.82" />
          <feComposite in2="near-off" operator="in" result="contact" />
          <feGaussianBlur in="SourceAlpha" stdDeviation={n(k * 3.6)} result="far" />
          <feOffset in="far" dx={n(k * 2.6)} dy={n(k * 5.2)} result="far-off" />
          <feFlood flood-color="#000" flood-opacity="0.5" />
          <feComposite in2="far-off" operator="in" result="cast" />
          <feMerge>
            <feMergeNode in="cast" />
            <feMergeNode in="contact" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <!-- The pieces turned away from the light (the other three corners and the shell) are each
             one drawing mirrored, so their own modelling would face the wrong way: they are dimmed,
             as the rails beside them are. All the pieces share one shadow (one filtered group):
             headless Chrome's software renderer draws a black tile at the top-left corner when it has
             a shadow group of its own. -->
        <filter id="mf-dim" color-interpolation-filters="sRGB">
          <feComponentTransfer>
            <feFuncR type="linear" slope="0.74" />
            <feFuncG type="linear" slope="0.72" />
            <feFuncB type="linear" slope="0.7" />
          </feComponentTransfer>
        </filter>

        <!-- One corner, drawn for the top left in corner units (a rail is 33 of them across): an
             acanthus leaf along each rail and a rosette over the mitre, the gold worn through to the
             bole at the high points. -->
        <!-- An acanthus leaf growing out from under the rosette and lying along the rail, inside its
             band: five lobes on its outer edge, the last curling over at its tip, a midrib, a vein to
             each lobe, and the light on the lobes' upper edges. -->
        <g id="mf-scroll">
          <path
            d="M30 5C36 3 41.5 3 46 5.2C48.2 2.2 53 1.2 56 3.6C58.4 1.4 63 1 66 3.5C68.6 1.6 73 1.4 75.6 4.1C78.2 2.6 82.2 2.8 84.2 5.6C86.8 4.4 90.4 5.2 91.8 8C95.2 7.6 98.6 6.4 99.2 3.6C99.6 1.2 96.8 .6 95.8 2.6C95.2 4.2 96.4 5.4 97.6 4.8C95.6 10.6 89 13.4 80.4 15.4C68.4 18.4 55.4 22 45.2 27C41 29 36.4 30.6 30 30.6Z"
            fill="url(#mf-gold)"
            stroke="#22170a"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <path d="M32 18.4C48 15.4 70 10.4 93.6 6.4" fill="none" stroke="#3e2c12" stroke-width="1.6" stroke-linecap="round" />
          <path d="M50 14.2Q51 9 51.4 4.4M60.6 12.6Q61.6 8 61.6 3.4M70.6 10.9Q71.2 7 71 3.6M80 9.2Q80.6 6.6 80.2 4.6M88 7.8Q88.4 6.6 88 6.2" fill="none" stroke="#3e2c12" stroke-width="1.1" stroke-linecap="round" />
          <path d="M47.2 6.6C49.2 4.6 52.2 4 54.6 5M57.2 5.4C59.2 3.6 62.2 3.2 64.6 4.6M67.2 5.6C69.2 4 71.8 3.8 74 5M76.6 6.4C78.6 5 81 5 82.6 6.4" fill="none" stroke="#fff0c0" stroke-opacity="0.55" stroke-width="0.9" stroke-linecap="round" />
          <path d="M36 25.6C45 21.6 58 18.6 72 15.6" fill="none" stroke="#120c05" stroke-opacity="0.45" stroke-width="1.4" stroke-linecap="round" />
          <circle cx="61" cy="3.6" r="1.2" fill="#6b2a1e" fill-opacity="0.7" />
          <circle cx="84.4" cy="6.2" r="1.3" fill="#6b2a1e" fill-opacity="0.55" />
        </g>
        <g id="mf-corner">
          <use href="#mf-scroll" />
          <use href="#mf-scroll" transform="matrix(0 1 1 0 0 0)" />
          <circle cx="20" cy="20" r="19.5" fill="url(#mf-boss)" stroke="#22170a" stroke-width="1.7" />
          <circle cx="20" cy="20" r="15.4" fill="none" stroke="#2a1c0a" stroke-width="1.2" stroke-opacity="0.8" />
          {#each [0, 45, 90, 135, 180, 225, 270, 315] as a (a)}
            <ellipse cx="20" cy="9.8" rx="3.4" ry="6.2" transform="rotate({a} 20 20)" fill="url(#mf-gold)" stroke="#2a1c0a" stroke-width="1" />
          {/each}
          <circle cx="20" cy="20" r="5.2" fill="url(#mf-boss)" stroke="#2a1c0a" stroke-width="1.2" />
          <circle cx="18.6" cy="18.4" r="1.6" fill="#fff4d0" fill-opacity="0.75" />
          <circle cx="29.6" cy="6.4" r="1.6" fill="#6b2a1e" fill-opacity="0.6" />
        </g>

        <!-- The top: a small arched plaque of night-blue enamel with a crescent moon and three stars,
             between C-scrolls that run out along the rail, and a star finial. Centered on x = 0,
             the frame's top edge at y = 0. -->
        <g id="mf-cartouche">
          <!-- Acanthus sweeping out along the rail from either side of the plaque. -->
          <use href="#mf-scroll" transform="translate(2 3) scale(0.78)" />
          <use href="#mf-scroll" transform="translate(-2 3) scale(-0.78 0.78)" />
          <path d="M-33 6C-46 0 -49 -13 -41 -19C-34 -23 -28 -17 -32 -12M33 6C46 0 49 -13 41 -19C34 -23 28 -17 32 -12" fill="none" stroke="#2e2009" stroke-width="6" stroke-linecap="round" />
          <path d="M-33 6C-46 0 -49 -13 -41 -19C-34 -23 -28 -17 -32 -12M33 6C46 0 49 -13 41 -19C34 -23 28 -17 32 -12" fill="none" stroke="url(#mf-gold)" stroke-width="3.6" stroke-linecap="round" />
          <path d="M-35 34V-8C-35 -31 -19 -45 0 -47C19 -45 35 -31 35 -8V34Z" fill="url(#mf-gold)" stroke="#2e2009" stroke-width="1.8" />
          <path d="M-29 30V-7C-29 -26 -16 -38 0 -40C16 -38 29 -26 29 -7V30Z" fill="url(#mf-enamel)" stroke="#4a3412" stroke-width="1.6" />
          <path d="M-29 30V-7C-29 -26 -16 -38 0 -40C16 -38 29 -26 29 -7V30" fill="none" stroke="#f3e0a6" stroke-opacity="0.5" stroke-width="0.8" transform="translate(-0.8 -0.8)" />
          <!-- The crescent, and its stars. -->
          <path d="M4 -26A15 15 0 0 0 4 4A19 19 0 0 1 4 -26Z" fill="url(#mf-gold)" stroke="#2e2009" stroke-width="0.9" />
          <path d="M14 -19l1.4 4.1 4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1-4.1-1.4 4.1-1.4z" fill="#f6e4ab" />
          <path d="M17 7l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" fill="#e2c47e" />
          <path d="M-17 15l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" fill="#e2c47e" />
          <circle cx="-18" cy="-21" r="1.2" fill="#e2c47e" />
          <circle cx="8" cy="22" r="1" fill="#e2c47e" />
          <circle cx="21" cy="-4" r="0.9" fill="#e2c47e" />
          <path d="M0 -62l3.2 9.8 9.8 3.2-9.8 3.2-3.2 9.8-3.2-9.8-9.8-3.2 9.8-3.2z" fill="url(#mf-gold)" stroke="#2e2009" stroke-width="1.3" stroke-linejoin="round" />
          <circle cx="0" cy="-49" r="2.8" fill="url(#mf-boss)" stroke="#2e2009" stroke-width="1" />
        </g>

        <!-- The bottom: a scallop shell over the rail, centered on x = 0, the bottom edge at y = 0. -->
        <g id="mf-shell">
          <path d="M-30 -6C-30 -26 -16 -38 0 -38C16 -38 30 -26 30 -6C20 -2 10 0 0 0C-10 0 -20 -2 -30 -6Z" fill="url(#mf-gold)" stroke="#3e2c12" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M0 -3V-36M-8 -3C-10 -14 -11 -26 -9 -36M8 -3C10 -14 11 -26 9 -36M-16 -4C-20 -14 -21 -24 -18 -33M16 -4C20 -14 21 -24 18 -33M-23 -5C-27 -12 -28 -20 -25 -27M23 -5C27 -12 28 -20 25 -27" fill="none" stroke="#5a3f16" stroke-width="1.4" stroke-linecap="round" />
          <path d="M-36 -4C-44 -6 -48 -12 -44 -16C-41 -19 -37 -16 -39 -13M36 -4C44 -6 48 -12 44 -16C41 -19 37 -16 39 -13" fill="none" stroke="url(#mf-gold-dim)" stroke-width="3.4" stroke-linecap="round" />
        </g>
      </defs>

      <!-- Rails, mitred at the corners; the right and bottom turn from the candle and darken. -->
      <polygon points="0,0 {n(w)},0 {n(w - p)},{n(p)} {n(p)},{n(p)}" fill="url(#mf-top)" />
      <polygon points="0,0 {n(p)},{n(p)} {n(p)},{n(h - p)} 0,{n(h)}" fill="url(#mf-left)" />
      <polygon points="{n(w)},0 {n(w)},{n(h)} {n(w - p)},{n(h - p)} {n(w - p)},{n(p)}" fill="url(#mf-right)" />
      <polygon points="0,{n(h)} {n(p)},{n(h - p)} {n(w - p)},{n(h - p)} {n(w)},{n(h)}" fill="url(#mf-bottom)" />

      <!-- The rope and the pearls, between the corner pieces. Each pattern is laid out for the top and
           left bands; the bottom and right bands are the same rects moved across, so the pattern
           moves with them and no strand is cut at a band's edge. -->
      <rect x={n(p)} y={n(p * ROPE[0])} width={n(w - 2 * p)} height={n(p * (ROPE[1] - ROPE[0]))} fill="url(#mf-rope-h)" />
      <rect x={n(p)} y={n(p * ROPE[0])} width={n(w - 2 * p)} height={n(p * (ROPE[1] - ROPE[0]))} fill="url(#mf-rope-h)" transform="translate(0 {n(h - p * (ROPE[0] + ROPE[1]))})" />
      <rect x={n(p * ROPE[0])} y={n(p)} width={n(p * (ROPE[1] - ROPE[0]))} height={n(h - 2 * p)} fill="url(#mf-rope-v)" />
      <rect x={n(p * ROPE[0])} y={n(p)} width={n(p * (ROPE[1] - ROPE[0]))} height={n(h - 2 * p)} fill="url(#mf-rope-v)" transform="translate({n(w - p * (ROPE[0] + ROPE[1]))} 0)" />
      {#if fine}
        <rect x={n(p)} y={n(p * PEARLS[0])} width={n(w - 2 * p)} height={n(p * (PEARLS[1] - PEARLS[0]))} fill="url(#mf-pearls-h)" />
        <rect x={n(p)} y={n(p * PEARLS[0])} width={n(w - 2 * p)} height={n(p * (PEARLS[1] - PEARLS[0]))} fill="url(#mf-pearls-h)" transform="translate(0 {n(h - p * (PEARLS[0] + PEARLS[1]))})" />
        <rect x={n(p * PEARLS[0])} y={n(p)} width={n(p * (PEARLS[1] - PEARLS[0]))} height={n(h - 2 * p)} fill="url(#mf-pearls-v)" />
        <rect x={n(p * PEARLS[0])} y={n(p)} width={n(p * (PEARLS[1] - PEARLS[0]))} height={n(h - 2 * p)} fill="url(#mf-pearls-v)" transform="translate({n(w - p * (PEARLS[0] + PEARLS[1]))} 0)" />
      {/if}

      <!-- Worn gold: tarnish in reaches along the rails, and the bole showing where it is rubbed. -->
      <polygon points="0,0 {n(w)},0 {n(w - p)},{n(p)} {n(p)},{n(p)}" fill="url(#mf-tarnish-h)" />
      <polygon points="0,{n(h)} {n(p)},{n(h - p)} {n(w - p)},{n(h - p)} {n(w)},{n(h)}" fill="url(#mf-tarnish-h)" />
      <polygon points="0,0 {n(p)},{n(p)} {n(p)},{n(h - p)} 0,{n(h)}" fill="url(#mf-tarnish-v)" />
      <polygon points="{n(w)},0 {n(w)},{n(h)} {n(w - p)},{n(h - p)} {n(w - p)},{n(p)}" fill="url(#mf-tarnish-v)" />
      <g fill="#6b2a1e">
        {#each WEAR_TOP as f, i (f)}
          <ellipse cx={n(p + f * (w - 2 * p))} cy={n(p * (i % 2 ? 0.075 : 0.43))} rx={n(p * (0.32 + (i % 3) * 0.14))} ry={n(Math.max(0.6, p * 0.022))} fill-opacity={i % 2 ? 0.55 : 0.4} />
        {/each}
        {#each WEAR_SIDE as f, i (f)}
          <ellipse cx={n(p * (i % 2 ? 0.43 : 0.075))} cy={n(p + f * (h - 2 * p))} rx={n(Math.max(0.6, p * 0.022))} ry={n(p * (0.3 + (i % 3) * 0.12))} fill-opacity={i % 2 ? 0.38 : 0.5} />
        {/each}
      </g>

      <polygon points="{n(w)},0 {n(w)},{n(h)} {n(w - p)},{n(h - p)} {n(w - p)},{n(p)}" fill="#05030a" fill-opacity="0.24" />
      <polygon points="0,{n(h)} {n(p)},{n(h - p)} {n(w - p)},{n(h - p)} {n(w)},{n(h)}" fill="#05030a" fill-opacity="0.32" />
      <!-- The candle, low on the left, warms the near rail while it burns (App.svelte's candle-lit). -->
      <polygon class="candle-warm" points="0,0 {n(p)},{n(p)} {n(p)},{n(h - p)} 0,{n(h)}" fill="#ffb347" fill-opacity="0.06" />

      <g filter="url(#mf-drop)">
        <use href="#mf-corner" transform="scale({n(kc)})" />
        <use href="#mf-cartouche" transform="translate({n(w / 2)} 0) scale({n(kt)})" />
        <use href="#mf-corner" transform="translate({n(w)} 0) scale({n(-kc)} {n(kc)})" filter="url(#mf-dim)" />
        <use href="#mf-corner" transform="translate(0 {n(h)}) scale({n(kc)} {n(-kc)})" filter="url(#mf-dim)" />
        <use href="#mf-corner" transform="translate({n(w)} {n(h)}) scale({n(-kc)})" filter="url(#mf-dim)" />
        {#if fine}<use href="#mf-shell" transform="translate({n(w / 2)} {n(h)}) scale({n(k * 0.95)})" filter="url(#mf-dim)" />{/if}
      </g>
    </svg>
  {/if}
</div>

<style>
  /* The frame's own box; the ornaments reach a little past it (the SVG overflows). */
  .frame-art {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }

  svg {
    display: block;
    overflow: visible;
  }

  .candle-warm {
    fill-opacity: 0.02;
    transition: fill-opacity calc(var(--duration) * 3.5) var(--ease-out);
  }

  :global(.room.candle-lit) .candle-warm {
    fill-opacity: 0.08;
  }
</style>
