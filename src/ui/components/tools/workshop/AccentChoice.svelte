<script lang="ts" module>
  export interface AccentOption {
    id: string;
    label: string;
    candle: string;
    oxblood: string;
  }
</script>

<script lang="ts">
  // House accents (Section 10.2): optional pairs that restyle Candle and Oxblood, offered by the theme
  // pack, shown as wax seals. The chosen seal carries a tick as well as a ring, so the choice does not
  // rest on color alone. Pack colors are untrusted: only plain hex colors are drawn.
  let { options, value, onselect }: { options: AccentOption[]; value: string; onselect: (id: string) => void } = $props();

  const HEX = /^#[0-9a-f]{3,8}$/i;
  const safe = (c: string, fallback: string) => (HEX.test(c) ? c : fallback);
</script>

<fieldset class="accents">
  <legend class="visually-hidden">House accent</legend>
  {#each options as a (a.id)}
    <label class="accent" class:checked={value === a.id}>
      <input type="radio" name="house-accent" value={a.id} checked={value === a.id} onchange={() => onselect(a.id)} />
      <span class="seal" style:--a-candle={safe(a.candle, '#f2b84b')} style:--a-oxblood={safe(a.oxblood, '#7b1e2b')} aria-hidden="true">
        <span class="flame"></span>
        {#if value === a.id}
          <svg class="tick" viewBox="0 0 20 20" width="18" height="18"><path d="M5.5 10.4 L8.6 13.4 L14.5 6.8" /></svg>
        {/if}
      </span>
      <span class="label">{a.label}</span>
    </label>
  {/each}
</fieldset>

<style>
  /* The seals share the row; they wrap only when the column is too narrow for all of them. */
  .accents {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .accent {
    flex: 1 1 70px;
    max-width: 128px;
    position: relative;
    display: grid;
    justify-items: center;
    align-content: start;
    gap: 8px;
    min-height: 44px;
    padding: 12px 4px 10px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    cursor: pointer;
    text-align: center;
    transition: border-color var(--duration) var(--ease-out), background var(--duration) var(--ease-out);
  }

  .accent:hover {
    background: color-mix(in srgb, var(--vellum) 5%, transparent);
    border-color: var(--line);
  }

  .accent.checked {
    border-color: color-mix(in srgb, var(--candle) 60%, transparent);
    background: color-mix(in srgb, var(--candle) 7%, transparent);
  }

  .accent:has(input:focus-visible) {
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

  /* A wax seal in the house's oxblood, its flame in the house's candle color. */
  .seal {
    position: relative;
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: radial-gradient(130% 130% at 30% 25%, color-mix(in srgb, var(--a-oxblood) 78%, #ffb4a3) 0%, var(--a-oxblood) 45%, color-mix(in srgb, var(--a-oxblood) 72%, black) 100%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.18),
      inset 0 -2px 5px rgb(0 0 0 / 0.4),
      inset 0 0 0 5px color-mix(in srgb, var(--a-oxblood) 85%, black),
      inset 0 0 0 6px color-mix(in srgb, var(--a-candle) 45%, transparent),
      0 4px 12px rgb(0 0 0 / 0.45);
  }

  .flame {
    width: 11px;
    height: 16px;
    border-radius: 50% 50% 45% 45% / 62% 62% 38% 38%;
    background: radial-gradient(60% 50% at 50% 70%, #fff7e0 0%, var(--a-candle) 55%, color-mix(in srgb, var(--a-candle) 60%, transparent) 100%);
    box-shadow: 0 0 10px color-mix(in srgb, var(--a-candle) 70%, transparent);
  }

  .accent.checked .seal {
    outline: 2px solid var(--candle);
    outline-offset: 3px;
  }

  .tick {
    position: absolute;
    right: -6px;
    bottom: -4px;
    padding: 2px;
    border-radius: 50%;
    background: var(--candle);
    fill: none;
    stroke: var(--night);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .label {
    font-size: var(--text-label);
    line-height: 1.25;
    color: var(--vellum);
  }

  .accent:not(.checked) .label {
    color: var(--ash);
  }
</style>
