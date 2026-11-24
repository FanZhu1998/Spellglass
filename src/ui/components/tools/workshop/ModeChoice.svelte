<script lang="ts">
  // The four casting modes (Section 7.7) as one radio group, each with one plain line. Strict and voice
  // only need voice: until voice works they play by gesture rules, and the card says so. Where there is
  // no voice at all (the desktop app), the modes that listen cannot be chosen. Native radios keep
  // arrow-key movement and form semantics.
  import type { CastingMode } from '../../../../contracts';
  import { MODES, listens } from './words';

  let {
    value,
    voiceOk,
    voiceless = false,
    disabled = false,
    onselect,
  }: {
    value: string;
    /** Voice can hear incantations now. */
    voiceOk: boolean;
    /** There is no voice here at all (the desktop app): Assisted, Strict and Voice only are shut. */
    voiceless?: boolean;
    disabled?: boolean;
    onselect: (mode: CastingMode) => void;
  } = $props();
</script>

<fieldset class="modes">
  <legend class="visually-hidden">Casting mode</legend>
  {#each MODES as m (m.id)}
    {@const shut = voiceless && listens(m)}
    <label class="mode" class:checked={value === m.id}>
      <input type="radio" name="casting-mode" value={m.id} checked={value === m.id} disabled={disabled || shut} onchange={() => onselect(m.id)} />
      <svg class="glyph" viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
        {#if m.id === 'gesture' || m.id === 'assisted' || m.id === 'strict'}
          <path class="stroke" d={m.id === 'gesture' ? 'M6 31 C 10 12, 20 9, 23 19 S 31 29, 35 12' : 'M5 33 C 8 20, 15 18, 17 25 S 23 31, 26 21'} />
          <circle class="dot" cx={m.id === 'gesture' ? 6 : 5} cy={m.id === 'gesture' ? 31 : 33} r="2.4" />
        {/if}
        {#if m.id === 'assisted'}
          <path d="M28 9.5 a5.5 5.5 0 0 1 0 8" />
        {:else if m.id === 'strict'}
          <path d="M28 6.5 a7 7 0 0 1 0 11" />
          <path d="M31.5 3.5 a11 11 0 0 1 0 17" />
          <path class="tie" d="M24 17 L28 13" />
        {:else if m.id === 'voice'}
          <circle class="dot" cx="11" cy="20" r="3" />
          <path d="M17 14 a8 8 0 0 1 0 12" />
          <path d="M22 10 a13 13 0 0 1 0 20" />
          <path d="M27 6 a18 18 0 0 1 0 28" />
        {/if}
      </svg>
      <span class="text">
        <span class="title">
          {m.title}
          {#if shut || (m.voice === 'needs' && !voiceOk)}<span class="needs">Needs voice</span>{/if}
        </span>
        <span class="line">{m.line}</span>
      </span>
    </label>
  {/each}
</fieldset>

<style>
  .modes {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  /* Each mode is a panel let into the folio (components.css --inlay-*). */
  .mode {
    position: relative;
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    align-items: start;
    gap: 14px;
    min-height: 44px;
    padding: 12px 34px 12px 14px;
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid var(--inlay-edge);
    background: var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
    cursor: pointer;
    transition: border-color var(--duration) var(--ease-out), background var(--duration) var(--ease-out);
  }

  .mode:hover {
    border-color: var(--inlay-edge-hover);
  }

  .mode.checked {
    border-color: var(--gilt);
    background: var(--inlay-chosen-bg);
    box-shadow: var(--inlay-chosen-shadow);
  }

  /* The chosen card also carries a wax dot, so the choice does not rest on color alone. */
  .mode.checked::after {
    content: '';
    position: absolute;
    top: 12px;
    right: 12px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--inlay-seal);
    box-shadow: var(--inlay-seal-ring);
  }

  .mode:has(input:focus-visible) {
    box-shadow: var(--focus);
  }

  .mode:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.6;
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
    color: var(--vellum);
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .glyph .stroke {
    stroke-width: 2.2;
  }

  .glyph .dot {
    fill: currentColor;
    stroke: none;
  }

  .mode.checked .glyph {
    color: var(--gilt-light);
  }

  .text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    font-size: var(--text-body);
    color: var(--vellum);
  }

  .needs {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-label);
    color: var(--candle);
  }

  /* A diamond, the shape of a caution everywhere in the app. */
  .needs::before {
    content: '';
    width: 7px;
    height: 7px;
    border: 1.5px solid currentColor;
    transform: rotate(45deg);
  }

  .line {
    font-size: var(--text-small);
    line-height: 1.4;
    color: var(--ash);
  }
</style>
