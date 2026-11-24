<script lang="ts">
  // Exposure and threshold for the bright-tip tracker (Section 7.1, 7.2, Appendix A step 5).
  // [Tune automatically] asks the running tracker ('tracker.autotune'); the exposure slider and mode go
  // through 'camera.exposure' (the only way to change exposure; time in 100 µs units) and are offered
  // only when the camera reports exposure control. The threshold is 'brightTip.k'.
  import { tick } from 'svelte';
  import { ask } from '../../../kernel';
  import { focusIfLost } from '../../actions';
  import type { AppState } from '../../app-state.svelte';
  import { errorText, exposureText } from './format';
  import StatusLine, { type StatusKind } from './StatusLine.svelte';

  let { app, announce }: { app: AppState; announce: (text: string) => void } = $props();

  const info = $derived(app.cameraReady?.exposure ?? null);
  const applied = $derived(app.camera?.exposure ?? null);
  const cameraOn = $derived(app.camera?.state === 'on');
  const timeRange = $derived.by(() => {
    if (!info || !info.modes.includes('manual')) return null;
    if (typeof info.min !== 'number' || typeof info.max !== 'number' || !(info.max > info.min)) return null;
    return { min: Math.max(1, info.min), max: info.max, step: info.step && info.step > 0 ? info.step : 1 };
  });
  const comp = $derived(info?.compensation && info.compensation.max > info.compensation.min ? info.compensation : null);
  const mode = $derived<'continuous' | 'manual'>(applied?.mode === 'manual' ? 'manual' : 'continuous');

  // ------------------------------------------------------------------ automatic tuning
  let tuning = $state(false);
  let tuneResult = $state<{ kind: StatusKind; text: string } | null>(null);

  async function autotune(button: HTMLElement): Promise<void> {
    tuning = true;
    tuneResult = { kind: 'busy', text: 'Tuning. The picture darkens for a moment: keep the wand tip in view, pointed at the camera.' };
    announce('Tuning the exposure and threshold.');
    try {
      const r = await ask(app.kernel, 'tracker.autotune');
      tuneResult = { kind: r.ok ? 'ok' : 'warn', text: r.message };
      announce(r.message);
    } catch (err) {
      const text = errorText(err, 'Tuning could not run. Choose the wand tip route first.');
      tuneResult = { kind: 'error', text };
      announce(text);
    } finally {
      tuning = false;
    }
    // Disabled while it tunes, so focus fell to the page: give it back (Section 10.6).
    await tick();
    focusIfLost(button);
  }

  // ------------------------------------------------------------------ exposure time (log scale)
  const STEPS = 1000;
  const toPos = (t: number, r: { min: number; max: number }) =>
    Math.round((Math.log(Math.min(r.max, Math.max(r.min, t)) / r.min) / Math.log(r.max / r.min)) * STEPS);
  const toTime = (p: number, r: { min: number; max: number; step: number }) => {
    const raw = r.min * Math.pow(r.max / r.min, p / STEPS);
    const snapped = Math.round(raw / r.step) * r.step;
    return Math.min(r.max, Math.max(r.min, snapped));
  };

  let pos = $state(500);
  let compValue = $state(0);
  /** The slider is being moved: show its value, and do not follow the camera's until it is let go. */
  let holding = $state(false);
  let exposureBusy = $state(false);
  let exposureError = $state<string | null>(null);

  $effect(() => {
    const r = timeRange;
    const t = applied?.time ?? info?.time;
    if (!holding && r && typeof t === 'number') pos = toPos(t, r);
  });
  $effect(() => {
    const c = applied?.compensation;
    if (!holding && typeof c === 'number') compValue = c;
  });

  const previewTime = $derived(timeRange ? toTime(pos, timeRange) : null);

  async function setExposure(payload: { mode: 'continuous' | 'manual'; time?: number; compensation?: number }): Promise<void> {
    exposureBusy = true;
    exposureError = null;
    try {
      const r = await ask(app.kernel, 'camera.exposure', { requester: 'shell', ...payload });
      const text = r.mode === 'manual' && typeof r.time === 'number' ? `Exposure fixed at ${exposureText(r.time)}.` : 'Exposure is automatic.';
      announce(text);
    } catch (err) {
      exposureError = errorText(err, 'The camera refused that exposure.');
      announce(exposureError);
    } finally {
      exposureBusy = false;
      holding = false;
    }
  }

  function chooseMode(next: 'continuous' | 'manual'): void {
    if (next === mode) return;
    if (next === 'manual' && timeRange) void setExposure({ mode: 'manual', time: toTime(pos, timeRange) });
    else void setExposure({ mode: 'continuous' });
  }

  // ------------------------------------------------------------------ threshold
  let k = $state(4);
  let kHolding = false;
  $effect(() => {
    const v = app.settings['brightTip.k'];
    if (!kHolding && typeof v === 'number') k = v;
  });

  function commitK(): void {
    kHolding = false;
    void app.set('brightTip.k', Math.round(k * 100) / 100).catch((err) => announce(errorText(err)));
  }
</script>

<div class="exposure">
  <div class="tune">
    <button class="btn btn-seal" type="button" onclick={(e) => autotune(e.currentTarget)} disabled={tuning || !cameraOn}>
      {tuning ? 'Tuning…' : 'Tune automatically'}
    </button>
    <p class="help">Lowers the exposure until the room is nearly black, then picks a threshold that keeps the tip.</p>
  </div>
  {#if tuneResult}<StatusLine kind={tuneResult.kind} text={tuneResult.text} />{/if}

  <div class="group">
    <div class="group-head">
      <span class="label" id="exposure-label">Exposure</span>
      {#if timeRange}
        <div class="segmented" role="radiogroup" aria-labelledby="exposure-label">
          <button type="button" role="radio" aria-checked={mode === 'continuous'} disabled={exposureBusy} onclick={() => chooseMode('continuous')}>Automatic</button>
          <button type="button" role="radio" aria-checked={mode === 'manual'} disabled={exposureBusy} onclick={() => chooseMode('manual')}>Fixed</button>
        </div>
      {/if}
    </div>

    {#if !cameraOn}
      <p class="help">Exposure can be set once the camera is on.</p>
    {:else if timeRange}
      <div class="slider-row">
        <input
          id="exposure-time"
          type="range"
          min="0"
          max={STEPS}
          step="1"
          value={pos}
          aria-labelledby="exposure-label"
          aria-valuetext={previewTime ? exposureText(previewTime) : undefined}
          disabled={exposureBusy}
          oninput={(e) => {
            holding = true;
            pos = Number(e.currentTarget.value);
          }}
          onchange={() => previewTime && setExposure({ mode: 'manual', time: previewTime })}
        />
        <output for="exposure-time" class="value">{mode === 'manual' || holding ? exposureText(previewTime) : 'automatic'}</output>
      </div>
      <p class="help">Shorter is darker. Lower it until the room is nearly black but the tip still shows; it also stops motion blur. Moving the slider fixes the exposure.</p>
    {:else if comp}
      <div class="slider-row">
        <input
          id="exposure-comp"
          type="range"
          min={comp.min}
          max={comp.max}
          step={comp.step || 'any'}
          value={compValue}
          aria-labelledby="exposure-label"
          disabled={exposureBusy}
          oninput={(e) => {
            holding = true;
            compValue = Number(e.currentTarget.value);
          }}
          onchange={() => setExposure({ mode: 'continuous', compensation: compValue })}
        />
        <output for="exposure-comp" class="value">{compValue > 0 ? '+' : ''}{Math.round(compValue * 10) / 10}</output>
      </div>
      <p class="help">This camera offers exposure compensation only. Lower it until the room is nearly black.</p>
    {:else}
      <StatusLine kind="info" text="This camera offers no exposure control. Dim the room instead, so the tip is the brightest thing in view." />
    {/if}
    {#if exposureError}<StatusLine kind="error" text={exposureError} />{/if}
  </div>

  <div class="group">
    <div class="group-head">
      <label class="label" for="threshold-k">Threshold</label>
      <output for="threshold-k" class="value">{k.toFixed(2)}</output>
    </div>
    <input
      id="threshold-k"
      type="range"
      min="2"
      max="8"
      step="0.25"
      value={k}
      aria-valuetext="{k.toFixed(2)} standard deviations above the picture's mean"
      oninput={(e) => {
        kHolding = true;
        k = Number(e.currentTarget.value);
      }}
      onchange={commitK}
    />
    <p class="help">How far above the room’s average brightness a spot must be to count. Raise it when lamps or glasses are picked up; lower it when the tip comes and goes.</p>
  </div>
</div>

<style>
  .exposure {
    display: grid;
    gap: 18px;
  }

  .tune {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .tune .help {
    flex: 1 1 220px;
  }

  .group {
    display: grid;
    gap: 8px;
  }

  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .label {
    font-size: var(--text-body);
    color: var(--vellum);
  }

  .slider-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
  }

  .value {
    min-width: 7ch;
    text-align: right;
    font-size: var(--text-small);
    color: var(--candle);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .help {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  input[type='range'] {
    min-height: 44px;
  }
</style>
