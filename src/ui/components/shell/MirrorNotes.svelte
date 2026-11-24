<script lang="ts">
  // What the mirror says at its top edge (Sections 7.9, 10.4 and 10.5): a camera that needs fixing,
  // a tracker that stopped, "Wand tip not found" (or a hand too small to follow well), the hand model
  // loading, and until the first successful cast the coach line "Hold still, trace the spell, then
  // hold still again."
  // One note at a time, the most pressing first.
  import { fade } from 'svelte/transition';
  import type { AppState } from '../../app-state.svelte';
  import { ask } from '../../../kernel';
  import Icon from './Icon.svelte';
  import { TEXT, TONE_GLYPH, cameraLine, cameraTrouble, cameraWanted as wantsCamera, currentRoute, trackerLine, type Tone } from './routes';

  let { app }: { app: AppState } = $props();

  let retrying = $state(false);
  let retryFailed = $state(false);

  const route = $derived(currentRoute(app.settings));
  /** The camera matters: the tracker needs it, or the player wants a reflection. */
  const cameraWanted = $derived(wantsCamera(app.settings));
  const penMode = $derived(route === 'pointer' || app.segmenter?.mode === 'pen' || app.tracker?.pen === true);

  type Note =
    | { kind: 'camera'; tone: Tone; text: string }
    | { kind: 'consent'; tone: Tone; text: string }
    | { kind: 'tracker-error'; tone: Tone; text: string }
    | { kind: 'hint'; tone: Tone; text: string }
    | { kind: 'progress'; tone: Tone; text: string; progress: number }
    | { kind: 'wait'; tone: Tone; text: string }
    | { kind: 'coach'; tone: Tone; text: string; extra: string | null };

  const note = $derived.by((): Note | null => {
    const s = app.settings;
    // A camera route without consent (settings reset, say): the Threshold explains and asks.
    if (route !== 'pointer' && !s['capture.consent']) {
      return { kind: 'consent', tone: 'warn', text: 'The camera is off. Choose how the app sees your wand to turn it on.' };
    }
    if (cameraWanted && cameraTrouble(app.camera)) {
      const line = cameraLine(app.camera, app.desktop);
      if (line) return { kind: 'camera', tone: 'error', text: retryFailed ? `Not yet. ${line.text}` : line.text };
    }
    const t = app.tracker;
    if (route !== 'pointer' && t && t.tracker === s['tracker.active']) {
      if (t.state === 'error') return { kind: 'tracker-error', tone: 'error', text: trackerLine(t, route)?.text ?? 'The tracker stopped.' };
      if (t.hint === 'tip-not-found') return { kind: 'hint', tone: 'warn', text: TEXT.tipNotFound };
      if (t.hint === 'hand-not-found') return { kind: 'hint', tone: 'warn', text: TEXT.handNotFound };
      if (t.hint === 'hand-too-small') return { kind: 'hint', tone: 'warn', text: TEXT.handTooSmall };
      if (t.hint === 'too-many-lights') return { kind: 'hint', tone: 'warn', text: TEXT.tooManyLights };
      if (t.state === 'loading' && t.tracker === 'tracker.hand') {
        const line = trackerLine(t, route);
        if (line) return { kind: 'progress', tone: 'wait', text: line.text, progress: line.progress ?? 0 };
      }
    }
    if (cameraWanted && app.camera?.state === 'requesting') return { kind: 'wait', tone: 'wait', text: 'Opening the camera.' };
    if (app.firstCastPending) {
      const next = app.nextSpell;
      const how = next ? (next.mirrored && next.spell.gesture_text_mirrored) || next.spell.gesture_text : null;
      return { kind: 'coach', tone: 'ok', text: penMode ? TEXT.coachPen : TEXT.coachHold, extra: next ? `Try ${next.spell.incantation}.${how ? ' ' + how : ''}` : null };
    }
    return null;
  });

  // Once the camera opens, the next problem starts afresh.
  $effect(() => {
    if (app.camera?.state === 'on') retryFailed = false;
  });

  async function retryCamera() {
    retrying = true;
    retryFailed = false;
    try {
      await ask(app.kernel, 'camera.retry');
    } catch {
      retryFailed = true;
    } finally {
      retrying = false;
    }
  }

  async function restartTracker() {
    const id = app.tracker?.tracker;
    if (!id) return;
    retrying = true;
    try {
      await ask(app.kernel, 'modules.restart', { id });
    } catch {
      /* the tracker reports what went wrong */
    } finally {
      retrying = false;
    }
  }

  async function usePointer() {
    await app.set('tracker.active', 'tracker.pointer');
    await app.set('capture.mirror', false);
    app.notify('Mouse or touch is on, and the camera is off.', 'ok');
  }
</script>

<div class="notes" role="status" aria-live="polite">
  {#if note}
    {#key note.kind + note.text}
      <div class="note" class:on-vellum={note.kind !== 'coach'} data-kind={note.kind} data-tone={note.tone} in:fade={{ duration: app.reducedMotion ? 0 : 180 }}>
        {#if note.kind === 'coach'}
          <p class="coach">{note.text}</p>
          {#if note.extra}<p class="coach-extra">{note.extra}</p>{/if}
        {:else}
          <p class="line">
            <span class="glyph" data-tone={note.tone} aria-hidden="true">{TONE_GLYPH[note.tone]}</span>
            <span>{note.text}</span>
          </p>
          {#if note.kind === 'progress'}
            <div class="bar" role="progressbar" aria-label="Hand model download" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(note.progress * 100)}>
              <span style:width="{Math.round(note.progress * 100)}%"></span>
            </div>
          {/if}
          {#if note.kind === 'camera'}
            <div class="actions">
              <button class="btn btn-small" onclick={retryCamera} disabled={retrying}><Icon name="retry" size={18} />{retrying ? 'Trying again' : 'Try again'}</button>
              {#if route !== 'pointer'}<button class="btn btn-small btn-ghost" onclick={usePointer}>Use mouse or touch</button>{/if}
            </div>
          {:else if note.kind === 'tracker-error'}
            <div class="actions">
              <button class="btn btn-small" onclick={restartTracker} disabled={retrying}><Icon name="retry" size={18} />{retrying ? 'Trying again' : 'Try again'}</button>
              <button class="btn btn-small btn-ghost" onclick={usePointer}>Use mouse or touch</button>
            </div>
          {:else if note.kind === 'consent'}
            <div class="actions">
              <button class="btn btn-small" onclick={() => app.go('threshold')}>Change how the app sees your wand</button>
            </div>
          {:else if note.kind === 'hint' && app.tracker?.tracker === 'tracker.bright-tip'}
            <div class="actions">
              <button class="btn btn-small btn-ghost" onclick={() => app.go('tuning')}>Tune wand</button>
            </div>
          {/if}
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .notes {
    display: grid;
    justify-items: center;
    width: 100%;
  }

  .note {
    display: grid;
    justify-items: center;
    gap: 8px;
    max-width: min(100%, 640px);
    text-align: center;
  }

  /* A notice pinned to the glass: a slip of parchment with an inked rule inside its edge, the words in
     ink. A warning's rule is dashed and an error's doubled in rubric, so the tone shows by shape. */
  .note:not([data-kind='coach']) {
    position: relative;
    padding: 12px 20px 14px;
    border-radius: 2px;
    background:
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(120% 120% at 50% 30%, color-mix(in srgb, var(--vellum) 94%, white), var(--vellum) 60%, var(--vellum-2));
    background-blend-mode: soft-light, normal;
    box-shadow: inset 0 0 0 1px rgb(110 76 30 / 0.35), inset 0 0 14px rgb(120 84 36 / 0.2), 2px 8px 22px rgb(0 0 0 / 0.55);
    color: var(--ink);
    pointer-events: auto;
  }

  .note:not([data-kind='coach'])::before {
    content: '';
    position: absolute;
    inset: 4px;
    border: 1px solid rgb(43 33 24 / 0.3);
    pointer-events: none;
  }

  .note[data-tone='warn']::before {
    border-style: dashed;
    border-color: rgb(107 68 12 / 0.6);
  }

  .note[data-tone='error']::before {
    border-color: color-mix(in srgb, var(--oxblood) 70%, transparent);
    outline: 1px solid color-mix(in srgb, var(--oxblood) 40%, transparent);
    outline-offset: 2px;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    font-size: var(--text-body);
    line-height: 1.4;
    text-align: left;
  }

  .glyph {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    transform: translateY(3px);
  }

  /* Each tone has its own shape, in inks that read on the parchment. */
  .glyph[data-tone='ok'] {
    border-radius: 50%;
    background: #2f6f64;
    color: #fff;
  }

  .glyph[data-tone='wait'] {
    border-radius: 50%;
    border: 1.5px solid #8a5a12;
    color: #6b440c;
  }

  /* Warnings are diamonds, errors squares: the shape says it as well as the color. */
  .glyph[data-tone='warn'] {
    color: #fff;
    background: #8a5a12;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  .glyph[data-tone='error'] {
    border-radius: 3px;
    background: var(--oxblood);
    color: var(--vellum);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px 10px;
  }

  /* Sized by the column along the glass's top edge (App.svelte's glass-top container), which is about
     two thirds of the glass. */
  .coach {
    margin: 0;
    font-family: var(--font-display);
    font-style: italic;
    font-size: clamp(20px, 3.4cqw, 26px);
    line-height: 1.25;
    color: color-mix(in srgb, var(--vellum) 92%, transparent);
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.95), 0 0 18px rgb(0 0 0 / 0.75);
  }

  .coach-extra {
    margin: 0;
    font-size: var(--text-small);
    color: color-mix(in srgb, var(--candle) 88%, var(--vellum));
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.95), 0 0 14px rgb(0 0 0 / 0.8);
  }

  /* A very small glass (a phone on its side with the guide open): the coach line in a smaller hand,
     so it stays on the glass. */
  @container glass-top (max-width: 260px) {
    .coach {
      font-size: 17px;
    }

    .coach-extra {
      line-height: 1.3;
    }
  }

  /* Progress as a gilt rule filling an inked groove. */
  .bar {
    width: min(320px, 70vw);
    height: 7px;
    border-radius: 1px;
    background: rgb(43 33 24 / 0.14);
    box-shadow: inset 0 1px 2px rgb(43 33 24 / 0.35);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(180deg, #e9cf8a, #b8944c 60%, #8a6a2c);
    transition: width var(--duration) var(--ease-out);
  }
</style>
