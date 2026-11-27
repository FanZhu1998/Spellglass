<script lang="ts">
  // A QR code drawn as SVG rectangles from uqr's module matrix (no {@html}, no images), so it works
  // offline and under the content security policy. Section 11.1: "A QR code on the Mirror screen
  // hands the link to a phone or a friend."
  import { encode } from 'uqr';

  let { text, size = 168, label = 'QR code' }: { text: string; size?: number; label?: string } = $props();

  const qr = $derived(encode(text, { ecc: 'M', border: 2 }));
  const cells = $derived.by(() => {
    const out: { x: number; y: number }[] = [];
    qr.data.forEach((row, y) => row.forEach((on, x) => on && out.push({ x, y })));
    return out;
  });
</script>

<svg class="qr" width={size} height={size} viewBox="0 0 {qr.size} {qr.size}" role="img" aria-label={label} shape-rendering="crispEdges">
  <rect width={qr.size} height={qr.size} fill="#E9DFC7" />
  {#each cells as c (c.y * qr.size + c.x)}
    <rect x={c.x} y={c.y} width="1" height="1" fill="#2B2118" />
  {/each}
</svg>

<style>
  .qr {
    display: block;
    border-radius: 1px;
  }
</style>
