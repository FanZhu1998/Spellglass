<script module lang="ts">
  export type Route = 'wand' | 'infrared' | 'hand' | 'pointer';

  export const ROUTES: { id: Route; tracker: string; title: string; line: string }[] = [
    { id: 'wand', tracker: 'tracker.bright-tip', title: 'Wand tip', line: 'Follows the glint of the tip. Needs a light beside the lens.' },
    { id: 'infrared', tracker: 'tracker.bright-tip', title: 'Infrared camera', line: 'The same, for a camera with infrared lights.' },
    { id: 'hand', tracker: 'tracker.hand', title: 'Hand', line: 'Follows your hand or fingertip. No wand needed.' },
    { id: 'pointer', tracker: 'tracker.pointer', title: 'Mouse or touch', line: 'Draw on the mirror. No camera needed.' },
  ];
</script>

<script lang="ts">
  // The four ways the app can see your wand (Section 4 routes A, C and B, plus pointer mode), as one
  // radio group. Native radios keep arrow-key movement and form semantics.
  let {
    value,
    disabled = {},
    busy = false,
    onselect,
  }: {
    value: Route | null;
    /** Routes that cannot run here, with the reason. */
    disabled?: Partial<Record<Route, string>>;
    busy?: boolean;
    onselect: (route: Route) => void;
  } = $props();
</script>

<fieldset class="routes" aria-busy={busy}>
  <legend class="visually-hidden">How Spellglass sees your wand</legend>
  {#each ROUTES as r (r.id)}
    {@const off = disabled[r.id]}
    <label class="route" class:checked={value === r.id} class:off={!!off}>
      <input type="radio" name="tracker-route" value={r.id} checked={value === r.id} disabled={!!off || busy} onchange={() => onselect(r.id)} />
      <svg class="glyph" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        {#if r.id === 'wand'}
          <path d="M7 33 L25 15" class="wand" />
          <circle cx="27.5" cy="12.5" r="3" class="tip" />
          <path d="M27.5 4 V7 M36 12.5 H33 M33.5 6.5 L31.4 8.6 M21.5 6.5 L23.6 8.6 M33.5 18.5 L31.4 16.4" />
        {:else if r.id === 'infrared'}
          <rect x="5" y="12" width="24" height="17" rx="3" />
          <circle cx="17" cy="20.5" r="4.5" />
          <path d="M29 16 L36 12.5 V28.5 L29 25" />
          <circle cx="9" cy="8" r="1.4" class="led" />
          <circle cx="17" cy="6" r="1.4" class="led" />
          <circle cx="25" cy="8" r="1.4" class="led" />
        {:else if r.id === 'hand'}
          <circle cx="20" cy="33" r="2" class="joint" />
          <path d="M20 33 L9 22 L6 15 M20 33 L15 15 L14 7 M20 33 L21 13 L21 5 M20 33 L26 15 L28 8 M20 33 L31 20 L34 15" />
          <circle cx="14" cy="7" r="2" class="tip" />
        {:else}
          <path d="M12 6 L12 30 L18 24.5 L22 33 L26 31 L22 22.5 L30 22 Z" />
        {/if}
      </svg>
      <span class="text">
        <span class="title">{r.title}</span>
        <span class="line">{off ?? r.line}</span>
      </span>
    </label>
  {/each}
</fieldset>

<style>
  .routes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  /* Each way is a panel let into the folio (components.css --inlay-*). */
  .route {
    position: relative;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    min-height: 44px;
    padding: 12px 14px;
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid var(--inlay-edge);
    background: var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
    cursor: pointer;
    transition: border-color var(--duration) var(--ease-out), background var(--duration) var(--ease-out);
  }

  .route:hover {
    border-color: var(--inlay-edge-hover);
  }

  .route.checked {
    border-color: var(--gilt);
    background: var(--inlay-chosen-bg);
    box-shadow: var(--inlay-chosen-shadow);
  }

  /* The selected card also carries a wax dot, so the choice does not rest on color alone. */
  .route.checked::after {
    content: '';
    position: absolute;
    top: 10px;
    right: 10px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--inlay-seal);
    box-shadow: var(--inlay-seal-ring);
  }

  .route.off {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .route:has(input:focus-visible) {
    box-shadow: var(--focus);
  }

  input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }

  .glyph {
    fill: none;
    stroke: var(--vellum);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .route.checked .glyph {
    stroke: var(--gilt-light);
  }

  .glyph .tip,
  .glyph .led,
  .glyph .joint {
    fill: currentColor;
  }

  .route .glyph {
    color: var(--vellum);
  }

  .route.checked .glyph {
    color: var(--gilt-light);
  }

  .glyph .wand {
    stroke-width: 3;
  }

  .text {
    display: grid;
    gap: 2px;
    padding-right: 14px;
  }

  .title {
    font-size: var(--text-body);
    color: var(--vellum);
  }

  .line {
    font-size: var(--text-small);
    line-height: 1.4;
    color: var(--ash);
  }

  @container (max-width: 400px) {
    .routes {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
