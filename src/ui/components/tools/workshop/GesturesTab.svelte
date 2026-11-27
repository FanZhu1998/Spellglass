<script lang="ts">
  // Redraw a gesture (Section 9.5: "Your own way of drawing a gesture: a recording in the Workshop
  // screen, saved on your device"; the pack and the recognizer are left alone). Pick a spell, choose
  // Draw it now and trace it once in the mirror (the Workshop folds to a bar on the frame meanwhile),
  // see the drawing beside the one in use, check it against the other spells, then keep it or not.
  // Section 11.1: the redrawn gestures leave as one pack file a friend can drop onto their Workshop.
  import type { Point, SpellbookEntry } from '../../../../contracts';
  import { ask, geometry } from '../../../../kernel';
  import type { AppState } from '../../../app-state.svelte';
  import StrokePath from '../../StrokePath.svelte';
  import StatusLine from '../StatusLine.svelte';
  import { errorText, jsonBlob } from '../format';
  import type { Redraw } from './redraw.svelte';
  import type { Announce, Note } from './types';

  let { app, redraw, announce, reducedMotion = false }: { app: AppState; redraw: Redraw; announce: Announce; reducedMotion?: boolean } = $props();

  /** Spells of the packs that are on, grouped by pack in spellbook order. Locked spells can be redrawn
   *  too: the drawing is ready when they open. */
  const groups = $derived.by(() => {
    const out: { title: string; entries: SpellbookEntry[] }[] = [];
    for (const e of app.spellbook?.spells ?? []) {
      if (!e.available) continue;
      const last = out[out.length - 1];
      if (last && last.title === e.packTitle) last.entries.push(e);
      else out.push({ title: e.packTitle, entries: [e] });
    }
    return out;
  });
  const choices = $derived(groups.flatMap((g) => g.entries));

  // Start on the spell the player was looking at, else the first one.
  $effect(() => {
    if (redraw.spellId && choices.some((e) => e.spell.id === redraw.spellId)) return;
    const wanted = choices.find((e) => e.spell.id === app.selectedSpellId) ?? choices[0];
    if (wanted && redraw.phase !== 'drawing' && redraw.phase !== 'saving') redraw.choose(wanted.spell.id);
  });

  const entry = $derived(choices.find((e) => e.spell.id === redraw.spellId) ?? null);
  const busy = $derived(redraw.phase === 'drawing' || redraw.phase === 'saving');

  function pointsOf(e: SpellbookEntry): Point[] {
    const g = e.spell.gesture;
    if ('flick' in g) return geometry.flickPath(g.flick);
    return e.templates[0] ?? [];
  }

  function sourceOf(e: SpellbookEntry): string {
    if (e.overridden) return 'your drawing';
    if (e.gestureSource === 'pack') return 'the book’s drawing';
    const layer = app.spellbook?.packs.find((p) => p.id === e.gestureSource);
    return `from ${layer?.title ?? 'a gesture pack'}`;
  }

  const gestureText = $derived.by(() => {
    const s = entry?.spell;
    if (!s || entry?.overridden) return '';
    return (entry?.mirrored && s.gesture_text_mirrored) || s.gesture_text || '';
  });

  const captured = $derived(redraw.stroke);
  const capturedPoints = $derived(captured ? captured.points.map((p) => [p.x, p.y] as Point) : []);
  const capturedMs = $derived(captured ? Math.max(500, Math.min(3000, captured.t1 - captured.t0)) : 1000);

  // A new drawing traces itself once at the pace it was drawn (motion that answers an action), then
  // rests whole with its arrowhead. StrokePath draws during the first 80% of its duration and would hide
  // the ink when the pass ends, so the still drawing takes over just before.
  let replaying = $state(false);
  $effect(() => {
    const s = captured;
    const ms = capturedMs;
    if (!s || reducedMotion) {
      replaying = false;
      return;
    }
    replaying = true;
    const timer = setTimeout(() => (replaying = false), Math.round(ms * 0.9));
    return () => clearTimeout(timer);
  });
  const verdict = $derived(redraw.phase === 'captured' ? redraw.verdict((id) => app.spellName(id)) : null);

  async function useDrawing(): Promise<void> {
    const ok = await redraw.use(app);
    if (redraw.note) announce(redraw.note.text);
    if (ok) void ask(app.kernel, 'audio.play', { cue: 'page-turn' }).catch(() => undefined);
  }

  async function restore(): Promise<void> {
    await redraw.restore(app);
    if (redraw.note) announce(redraw.note.text);
  }

  // ------------------------------------------------------------------ export my gestures
  const redrawn = $derived(app.spellbook?.spells.filter((e) => e.overridden).length ?? 0);
  let exportLabel = $state('Export my gestures');
  let exportNote = $state<Note | null>(null);
  let exportTimer: ReturnType<typeof setTimeout> | null = null;

  function exportGestures(): void {
    exportNote = null;
    ask(app.kernel, 'packs.export', { gestures: true })
      .then((r) => ask(app.kernel, 'share.file', { blob: jsonBlob(r.text), filename: r.filename, title: 'My Spellglass gestures' }).then((s) => ({ s, filename: r.filename })))
      .then(({ s, filename }) => {
        if (s.outcome === 'cancelled') return;
        exportNote = { kind: 'ok', text: s.outcome === 'shared' ? 'Gestures shared.' : `Saved to your downloads as ${filename}.` };
        exportLabel = 'Gestures exported';
        if (exportTimer) clearTimeout(exportTimer);
        exportTimer = setTimeout(() => (exportLabel = 'Export my gestures'), 4000);
        announce(exportNote.text);
      })
      .catch((err) => {
        exportNote = { kind: 'error', text: errorText(err, 'Your gestures could not be exported.') };
        announce(exportNote.text);
      });
  }

  $effect(() => () => {
    if (exportTimer) clearTimeout(exportTimer);
  });
</script>

<div class="gestures">
  <div class="picker-col">
    <fieldset class="picker" disabled={busy}>
      <legend class="picker-title">Choose a spell</legend>
      {#each groups as g (g.title)}
        <p class="group-title" aria-hidden="true">{g.title}</p>
        {#each g.entries as e (e.spell.id)}
          <label class="spell" class:checked={redraw.spellId === e.spell.id}>
            <input type="radio" name="ws-redraw-spell" value={e.spell.id} checked={redraw.spellId === e.spell.id} onchange={() => redraw.choose(e.spell.id)} />
            <span class="thumb" aria-hidden="true"><StrokePath points={pointsOf(e)} size={34} tone="light" label="" /></span>
            <span class="name">{e.spell.incantation}</span>
            {#if e.overridden}<span class="mine">yours</span>{/if}
          </label>
        {/each}
      {/each}
    </fieldset>

    <div class="picker-select">
      <label class="ws-label" for="ws-redraw-select">Spell to redraw</label>
      <select id="ws-redraw-select" class="select" value={redraw.spellId ?? ''} disabled={busy} onchange={(e) => redraw.choose(e.currentTarget.value)}>
        {#each groups as g (g.title)}
          <optgroup label={g.title}>
            {#each g.entries as e (e.spell.id)}
              <option value={e.spell.id}>{e.spell.incantation}{e.overridden ? ' (yours)' : ''}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </div>
  </div>

  <div class="bench">
    {#if !entry}
      <StatusLine kind="info" text={app.spellbook ? 'Turn on a spell pack in Packs to redraw its gestures.' : 'Opening the spellbook…'} />
    {:else}
      <header class="spell-head">
        <h3>{entry.spell.incantation}</h3>
        <p class="ws-help">{entry.spell.known_as ? `${entry.spell.known_as} · ` : ''}{entry.packTitle}</p>
      </header>

      <div class="plates">
        <figure class="plate">
          <div class="glass">
            <StrokePath points={pointsOf(entry)} size={168} tone="light" label="The gesture in use now for {entry.spell.incantation}, with its start dot" />
          </div>
          <figcaption>In use now: {sourceOf(entry)}</figcaption>
        </figure>

        <figure class="plate" class:waiting={!captured}>
          <div class="glass">
            {#if captured}
              {#key captured.id}
                <StrokePath points={capturedPoints} aspect={captured.aspect ?? 16 / 9} size={168} tone="light" animate={replaying} loop={false} durationMs={capturedMs} {reducedMotion} label="Your new drawing of {entry.spell.incantation}, with its start dot" />
              {/key}
            {:else}
              <p class="placeholder">{redraw.phase === 'drawing' ? 'Waiting for your stroke…' : 'Your drawing appears here.'}</p>
            {/if}
          </div>
          <figcaption>Your new drawing</figcaption>
        </figure>
      </div>

      {#if gestureText}<p class="ws-help how">The book says: {gestureText}</p>{/if}

      {#if redraw.phase === 'captured' || redraw.phase === 'saving'}
        {#if verdict}<StatusLine kind={verdict.kind} text={verdict.text} />{:else if !redraw.note}<StatusLine kind="busy" text="Checking it against the other spells…" />{/if}
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={useDrawing} disabled={redraw.phase === 'saving'} data-after-fold>Use this drawing</button>
          <button class="btn" type="button" onclick={() => redraw.draw(app)} disabled={redraw.phase === 'saving'}>Draw it again</button>
          <button class="btn btn-ghost" type="button" onclick={() => redraw.discard()} disabled={redraw.phase === 'saving'}>Discard</button>
        </div>
        <p class="ws-help">Saved on this device only. The pack keeps its own drawing, and you can go back to it at any time.</p>
      {:else}
        <div class="ws-actions">
          <button class="btn btn-seal" type="button" onclick={() => redraw.draw(app)} disabled={busy} data-after-fold>Draw it now</button>
          <p class="ws-help grow">Trace it once in the mirror. The Workshop folds away while you draw, and nothing is cast.</p>
        </div>
      {/if}

      {#if redraw.note}<StatusLine kind={redraw.note.kind} text={redraw.note.text} />{/if}

      {#if entry.overridden && redraw.phase !== 'captured' && redraw.phase !== 'saving'}
        <div class="ws-actions">
          <button class="btn" type="button" onclick={restore} disabled={busy}>Back to the book’s drawing</button>
          <p class="ws-help grow">{entry.spell.incantation} uses your drawing on this device.</p>
        </div>
      {/if}

      <section class="share" aria-labelledby="ws-share-gestures">
        <h4 id="ws-share-gestures">Share your drawings</h4>
        <div class="ws-actions">
          <button class="btn" type="button" onclick={exportGestures} disabled={redrawn === 0}>{exportLabel}</button>
          <p class="ws-help grow">
            {redrawn === 0
              ? 'Once you have redrawn a gesture, it can leave as one pack file for a friend to drop onto their Workshop.'
              : `One pack file with the ${redrawn === 1 ? 'gesture' : `${redrawn} gestures`} you redrew. A friend drops it onto their Workshop to cast with your drawings.`}
          </p>
        </div>
        {#if exportNote}<StatusLine kind={exportNote.kind} text={exportNote.text} />{/if}
      </section>
    {/if}
  </div>
</div>

<style>
  /* A workbench like Wand tuning's: the list on the left, the drawing on the right, each scrolling on
     its own when it must. */
  .gestures {
    height: 100%;
    display: grid;
    grid-template-columns: minmax(220px, 290px) minmax(0, 1fr);
    gap: 26px;
  }

  .picker-col,
  .bench {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .picker-col {
    padding: 2px 6px 8px 2px;
  }

  .bench {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 2px 8px 12px 2px;
  }

  .picker {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .picker-title {
    padding: 0;
    margin-bottom: 4px;
    font-family: var(--font-display);
    font-size: 22px;
    color: var(--vellum);
  }

  .group-title {
    margin: 12px 0 4px;
    font-size: var(--text-label);
    color: var(--ash);
    letter-spacing: 0.02em;
  }

  .spell {
    position: relative;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 4px 10px 4px 4px;
    border-radius: var(--radius-small);
    border: 1px solid transparent;
    cursor: pointer;
  }

  .spell:hover {
    background: color-mix(in srgb, var(--vellum) 5%, transparent);
  }

  .spell.checked {
    border-color: var(--gilt);
    background: var(--inlay-chosen-bg);
    box-shadow: var(--inlay-chosen-shadow);
  }

  .spell:has(input:focus-visible) {
    box-shadow: var(--focus);
  }

  .picker:disabled .spell {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .spell input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }

  .thumb {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 1px;
    /* A little mirror, silvered as the big one is (tokens.css). */
    background: var(--glass);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.7), inset 0 0 8px rgb(4 3 6 / 0.6), 0 0 0 1.5px #b8944c, 0 0 0 2.5px #3e2c12;
  }

  /* At thumbnail size the stroke, its arrowhead and its start dot are drawn heavier, so Lumos (up) and
     Nox (down) still read apart. */
  .thumb :global(.ink),
  .thumb :global(.arrow) {
    stroke-width: 6px;
  }

  .thumb :global(.guide) {
    display: none;
  }

  .thumb :global(.start) {
    r: 9px;
  }

  .name {
    font-family: var(--font-display);
    font-size: 20px;
    line-height: 1.15;
    color: var(--vellum);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mine {
    font-size: var(--text-label);
    color: var(--candle);
    font-style: italic;
  }

  .picker-select {
    display: none;
    gap: 6px;
  }

  .spell-head h3 {
    margin: 0;
    font-size: 32px;
    color: var(--vellum);
  }

  .spell-head .ws-help {
    margin-top: 2px;
  }

  .plates {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 220px));
    gap: 18px;
  }

  .plate {
    margin: 0;
    min-width: 0;
    display: grid;
    gap: 8px;
  }

  .glass {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    padding: 12px;
    border-radius: 1px;
    /* The same silvered glass as the mirror's (tokens.css). */
    background: var(--glass-sheen), var(--glass);
    box-shadow:
      var(--glass-rim),
      0 0 0 3px #b8944c,
      0 0 0 4px #3e2c12,
      0 0 0 5px rgb(233 207 138 / 0.55),
      0 0 0 6px rgb(0 0 0 / 0.6),
      0 10px 26px rgb(0 0 0 / 0.4);
  }

  .glass {
    min-width: 0;
  }

  .glass :global(.stroke-path) {
    width: 100%;
    height: auto;
    min-width: 0;
    max-width: 168px;
  }

  .plate.waiting .glass {
    box-shadow:
      var(--glass-rim),
      0 0 0 2px color-mix(in srgb, var(--brass) 30%, transparent);
    outline: 1px dashed color-mix(in srgb, var(--vellum) 22%, transparent);
    outline-offset: -14px;
  }

  .placeholder {
    margin: 0;
    padding: 0 16px;
    text-align: center;
    font-family: var(--font-display);
    font-style: italic;
    font-size: 19px;
    line-height: 1.3;
    color: color-mix(in srgb, var(--vellum) 60%, transparent);
  }

  figcaption {
    font-size: var(--text-small);
    color: var(--ash);
    text-align: center;
  }

  .how {
    margin-top: -4px;
    font-style: italic;
  }

  .grow {
    flex: 1 1 240px;
  }

  .share {
    display: grid;
    gap: 10px;
    margin-top: auto;
    padding-top: 16px;
    border-top: 1px solid transparent;
    border-image: linear-gradient(90deg, transparent, color-mix(in srgb, var(--brass) 45%, transparent) 12%, color-mix(in srgb, var(--brass) 45%, transparent) 88%, transparent) 1;
  }

  .share h4 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 21px;
  }

  /* Narrow: the list becomes a select above the drawing, and the tab scrolls as a whole. */
  @container (max-width: 760px) {
    .gestures {
      height: auto;
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
    }
    .picker-col,
    .bench {
      overflow: visible;
    }
    .picker {
      display: none;
    }
    .picker-select {
      display: grid;
    }
  }
</style>
