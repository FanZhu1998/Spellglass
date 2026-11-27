<script lang="ts">
  // Where to stand (Section 4): 0.6 to 1.2 m from the camera, so a 4 mm tip is several pixels wide
  // and a 40 cm gesture fills a good part of the frame. With seated play on (Section 10.6) the same
  // distance is given for sitting, and otherwise the guide says where seated play is turned on. Drawn
  // with percentage coordinates so its labels keep their size at any width.
  let {
    width = 0,
    height = 0,
    fps = 0,
    steppedDown = false,
    seated = false,
  }: { width?: number; height?: number; fps?: number; steppedDown?: boolean; seated?: boolean } = $props();

  const M0 = 11; // x of 0 m, in % of the width
  const PER_M = 43; // % per metre
  const at = (m: number) => `${M0 + m * PER_M}%`;
  const ticks = [0, 0.5, 1, 1.5, 2];

  const verb = $derived(seated ? 'Sit' : 'Stand');

  const sizeLine = $derived.by(() => {
    if (!width || !height) return 'The capture size shows here once the camera is on.';
    const rate = fps ? ` at ${Math.round(fps)} fps` : '';
    if (width >= 1900) return `Capturing at ${width} × ${height}${rate}: at 1 m the tip is about 5 to 7 pixels wide.`;
    if (width >= 1200) {
      const why = steppedDown ? 'The capture size was reduced because frames were slow, so' : 'This camera gives';
      return `${why} ${width} × ${height}${rate}${steppedDown ? '' : ', so'} the tip is smaller, about 3 to 4 pixels at 1 m. ${verb} toward the near end, 0.6 to 0.9 m.`;
    }
    return `Capturing at ${width} × ${height}${rate}. That is small for a wand tip: ${verb.toLowerCase()} at about 0.6 m, or choose another camera.`;
  });
</script>

<figure class="guide">
  <svg class="scale" width="100%" height="100" role="img" aria-label="{verb} 0.6 to 1.2 metres from the camera.">
    <!-- the band to stand in -->
    <rect class="band" x={at(0.6)} y="8" width="{0.6 * PER_M}%" height="62" rx="6" />
    <text class="band-label" x={at(0.9)} y="27" text-anchor="middle">{verb} here</text>
    <!-- a caster, abstract -->
    <circle class="figure" cx={at(0.9)} cy="40" r="6" />
    <line class="figure" x1={at(0.9)} y1="47" x2={at(0.9)} y2="64" />
    <!-- the camera -->
    <svg x="1%" y="51" width="34" height="26" viewBox="0 0 34 26" overflow="visible">
      <rect class="cam" x="1" y="4" width="22" height="16" rx="3" />
      <circle class="cam" cx="12" cy="12" r="4.5" />
      <path class="cam" d="M23 9 L32 5 L32 19 L23 15 Z" />
    </svg>
    <!-- the floor, in metres -->
    <line class="base" x1={at(0)} y1="70" x2={at(2)} y2="70" />
    {#each ticks as m (m)}
      <line class="tick" x1={at(m)} y1="66" x2={at(m)} y2="74" />
      <text class="tick-label" x={at(m)} y="94" text-anchor="middle">{m === 2 ? '2 m' : m}</text>
    {/each}
  </svg>
  <figcaption>
    <p class="main"><strong>{verb} 0.6 to 1.2 m from the camera.</strong> Clear an arm’s length plus the wand all round you.</p>
    {#if !seated}<p class="muted">Casting from a chair? Turn on Seated play in the Workshop, under Access.</p>{/if}
    <p class="muted">{sizeLine}</p>
  </figcaption>
</figure>

<style>
  .guide {
    margin: 0;
    display: grid;
    gap: 6px;
  }

  .scale {
    display: block;
    overflow: visible;
  }

  .band {
    fill: color-mix(in srgb, var(--candle) 16%, transparent);
    stroke: color-mix(in srgb, var(--candle) 55%, transparent);
    stroke-width: 1;
  }

  .band-label {
    fill: var(--candle);
    font-size: 16px;
    font-family: var(--font-text);
  }

  .figure {
    fill: none;
    stroke: var(--vellum);
    stroke-width: 2;
    stroke-linecap: round;
  }

  .cam {
    fill: none;
    stroke: var(--vellum);
    stroke-width: 1.6;
    stroke-linejoin: round;
  }

  .base,
  .tick {
    stroke: var(--ash);
    stroke-width: 1.4;
  }

  .tick-label {
    fill: var(--ash);
    font-size: 16px;
    font-family: var(--font-text);
  }

  figcaption p {
    margin: 0 0 4px;
    font-size: var(--text-small);
  }

  figcaption .main {
    font-size: var(--text-body);
  }

  figcaption strong {
    font-weight: 600;
    color: var(--vellum);
  }
</style>
