<script lang="ts">
  // Practice (Section 10.3, third layout; Section 10.4: "Trace against a guide and get a grade and
  // one specific hint"). This bar replaces the bottom bar under the mirror; the stage draws the faint
  // guide stroke and its pace dot on the glass itself (from 'practice.focus', which
  // app.startPractice sends). Each 'practice.attempt' shows "{Spell}, attempt {n}", its grade and the
  // one hint; success and failure differ by shape and words. Progress toward learning comes from the
  // spellbook entry, and the moment the spell becomes learned is marked. It stays calm: the boldness
  // belongs to the cast on the glass (Section 10.1).
  import { tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { PracticeAttempt } from '../../contracts';
  import { isReducedMotion, on, watchReducedMotion } from '../../kernel';
  import { onEscape } from '../actions';
  import type { AppState } from '../app-state.svelte';
  import ProgressPips from '../components/book/ProgressPips.svelte';
  import { describeAttempt, joinNames, practiceBlock, progressText, readableId } from '../components/book/words';

  let { app }: { app: AppState } = $props();

  let reduced = $state(untrack(() => isReducedMotion(app.kernel)));
  $effect(() => watchReducedMotion(app.kernel, (r) => (reduced = r)));

  const spellId = $derived(app.selectedSpellId);
  const entry = $derived(app.entry(spellId));
  const name = $derived(entry?.spell.incantation ?? (spellId ? readableId(spellId) : ''));
  const learnAfter = $derived(app.spellbook?.learnAfter ?? 3);
  const blocked = $derived(entry && app.spellbook ? practiceBlock(entry, app.spellbook) : null);

  const nameOf = (id: string) => app.entry(id)?.spell.incantation ?? readableId(id);
  const entryOf = (id: string) => app.entry(id);

  // ------------------------------------------------------------------ attempts

  const last = $derived(app.practiceAttempts.at(-1) ?? null);
  /** "Try again" clears the last result. Kept by identity, so a new session never hides a number. */
  let cleared = $state.raw<PracticeAttempt | null>(null);
  const shown = $derived(last && last !== cleared ? last : null);
  /** The attempt being shown, or the one about to be made. */
  const attemptNo = $derived(shown ? shown.attempt : (last?.attempt ?? 0) + 1);
  const view = $derived(shown ? describeAttempt(shown, { grade: (q, k) => app.grade(q, k), nameOf, entryOf }) : null);

  const pen = $derived(app.segmenter?.mode === 'pen' || app.tracker?.pen === true);
  const idleText = $derived.by(() => {
    if (!entry) return 'Choose a spell in the spellbook to practise it here.';
    if (blocked) return `${name} cannot be cast yet. ${blocked}`;
    const t = app.tracker;
    if (t?.hint === 'tip-not-found') return 'Wand tip not found. Point the tip at the camera and switch on the light beside the lens.';
    if (t?.hint === 'hand-not-found') return 'Hand not found. Hold your hand up where the camera can see it.';
    if (t?.hint === 'hand-too-small') return 'Your hand looks small to the camera. Step closer, or zoom the camera in.';
    if (t?.hint === 'wand-not-seen') return 'Hand found, but not the wand. Hold it up across the camera, not pointed at it.';
    const how = pen
      ? 'Press and draw the shape on the mirror, keeping pace with the moving dot.'
      : 'Hold the tip still until it turns gold, then trace the shape at the pace of the moving dot.';
    return shown === null && last ? `Ready for attempt ${attemptNo}. ${how}` : how;
  });

  // ------------------------------------------------------------------ learning

  /** The moment the practised spell becomes learned (the attempt whose cast did it), and any spells
   *  that opened with it. The cast's 'practice.attempt' arrives before its 'progress.changed'. */
  let learnedAt = $state.raw<{ attempt: PracticeAttempt | null; spellId: string; opened: string[] } | null>(null);
  const celebrating = $derived(!!learnedAt && learnedAt.spellId === spellId && learnedAt.attempt === shown);
  let opened = $state<string[]>([]);

  $effect(() => {
    const id = spellId;
    if (!id) return;
    // Read once: the spellbook that shows the spell learned arrives just before 'progress.changed'.
    let wasLearned = untrack(() => app.entry(id)?.status === 'learned');
    return on(app.kernel, 'progress.changed', (p) => {
      const newly = Array.isArray(p.unlockedSpells) ? p.unlockedSpells.filter((s) => typeof s === 'string') : [];
      if (p.spellId === id && p.learned && !wasLearned) {
        wasLearned = true;
        learnedAt = { attempt: app.practiceAttempts.at(-1) ?? null, spellId: id, opened: newly };
        opened = [];
      } else if (newly.length) {
        // Another spell's cast opened a tier while practising: say so, quietly.
        opened = newly;
      }
    });
  });

  const openedNames = $derived(joinNames((learnedAt && celebrating ? learnedAt.opened : opened).map(nameOf), 'and'));

  // ------------------------------------------------------------------ actions

  let slow = $state(false);

  function toggleSlow(): void {
    slow = !slow;
    app.showGuide(slow);
  }

  function tryAgain(): void {
    if (last) cleared = last;
    opened = [];
  }

  function back(): void {
    app.go('spellbook', spellId);
  }

  // A new practice session (another spell) starts clean.
  $effect(() => {
    void spellId;
    untrack(() => {
      cleared = null;
      slow = false;
      learnedAt = null;
      opened = [];
    });
  });

  let titleEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void tick().then(() => titleEl?.focus({ preventScroll: true }));
  });

  const fadeMs = $derived(reduced ? 0 : 200);
</script>

<section class="practice" aria-labelledby="practice-title" use:onEscape={back}>
  <div class="who">
    <h2 id="practice-title" tabindex="-1" bind:this={titleEl}>
      {#if name}{name}, attempt {attemptNo}{:else}Practice{/if}
    </h2>
    {#if entry}
      <p class="progress" data-status={entry.status}>
        {#if entry.status === 'learned'}
          <span class="seal" class:fresh={celebrating} class:stamp={celebrating && !reduced} aria-hidden="true">✦</span>
          <span>Learned</span>
        {:else}
          <ProgressPips accepted={entry.accepted} goal={learnAfter} tone="light" />
          <span>{progressText(entry.accepted, learnAfter)} casts to learn it</span>
        {/if}
      </p>
    {/if}
  </div>

  <div class="result" aria-live="polite" aria-atomic="true">
    {#key shown ? `a${shown.attempt}` : 'idle'}
      <div class="card" data-kind={view?.kind ?? 'idle'} in:fade={{ duration: fadeMs }}>
        <span class="mark" aria-hidden="true">{view && view.kind !== 'miss' ? '✦' : ''}</span>
        <div class="words">
          {#if view}
            <p class="line"><span class="grade">{view.grade}.</span> {view.detail}</p>
          {:else}
            <p class="line idle">{idleText}</p>
          {/if}
          {#if celebrating}
            <p class="celebrate">
              {name} is learned. Your own casts now help the mirror know it.{#if openedNames}{' '}New spells open: {openedNames}.{/if}
            </p>
          {:else if openedNames}
            <p class="celebrate">New spells open: {openedNames}.</p>
          {/if}
        </div>
      </div>
    {/key}
  </div>

  <div class="actions">
    <button type="button" class="btn" onclick={tryAgain} disabled={!entry}>Try again</button>
    <button type="button" class="btn slow" aria-pressed={slow} onclick={toggleSlow} disabled={!entry}>Show me slowly</button>
    <span class="divider" aria-hidden="true"></span>
    <button type="button" class="btn back" onclick={back}>Back to book</button>
  </div>
</section>

<style>
  .practice {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(230px, 300px) minmax(0, 1fr) auto;
    grid-template-areas: 'who result actions';
    align-items: center;
    gap: 10px 22px;
    margin: 4px clamp(10px, 2vw, 28px) 2px;
    padding: 12px 20px 12px 22px;
    border-radius: 3px;
    /* A band of dark leather under the frame, with a tooled gilt rule round it. */
    background:
      radial-gradient(80% 140% at 18% 0%, rgb(255 214 150 / 0.06), transparent 70%),
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, var(--folio-2), var(--folio));
    background-blend-mode: normal, soft-light, normal;
    border: 1px solid #0b0806;
    outline: 1px solid color-mix(in srgb, var(--gilt) 45%, transparent);
    outline-offset: -6px;
    box-shadow:
      inset 0 1px 0 rgb(255 230 180 / 0.06),
      var(--shadow-hung);
  }

  /* Where the band meets the mirror's frame: a gilt rule with a lozenge at its middle. */
  .practice::before {
    content: '';
    position: absolute;
    left: 18px;
    right: 18px;
    top: 0;
    height: 14px;
    transform: translateY(-50%);
    background:
      var(--rule-ornament) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, color-mix(in srgb, var(--gilt) 60%, transparent) 20%, color-mix(in srgb, var(--gilt) 60%, transparent) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), color-mix(in srgb, var(--gilt) 60%, transparent) calc(50% + 60px), color-mix(in srgb, var(--gilt) 60%, transparent) 80%, transparent) center / 100% 1px no-repeat;
  }

  .who {
    grid-area: who;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: 26px;
    line-height: 1.15;
    color: var(--gilt-text);
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.8);
  }

  h2:focus-visible {
    border-radius: 4px;
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 5px 0 0;
    font-size: 16px;
    color: var(--ash);
  }

  .progress[data-status='learned'] {
    color: var(--verdigris);
  }

  /* A small wax seal, stamped once when the spell becomes learned. */
  .seal {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    font-size: 13px;
    color: var(--vellum);
    background: radial-gradient(130% 160% at 28% 22%, color-mix(in srgb, var(--oxblood) 82%, #ffb4a3) 0%, var(--oxblood) 45%, var(--oxblood-2) 100%);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.16), inset 0 -2px 4px rgb(0 0 0 / 0.38), 0 2px 6px rgb(0 0 0 / 0.4);
  }

  .seal.fresh {
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.16), inset 0 -2px 4px rgb(0 0 0 / 0.38), 0 0 0 3px rgb(95 179 165 / 0.35), 0 0 18px rgb(95 179 165 / 0.35);
  }

  /* Pressed once into the wax; no animation under reduced motion (the class is not set). */
  .seal.stamp {
    animation: stamp 420ms var(--ease-out) both;
  }

  @keyframes stamp {
    0% { transform: scale(1.8); opacity: 0; }
    60% { transform: scale(0.92); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }

  .result {
    grid-area: result;
    min-width: 0;
    display: grid;
  }

  .card {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    min-height: 54px;
    padding: 7px 16px 7px 10px;
    border-radius: 3px;
    corner-shape: bevel;
    border: 1.5px solid transparent;
  }

  .card[data-kind='cast'] {
    border-color: color-mix(in srgb, var(--verdigris) 70%, transparent);
    background: color-mix(in srgb, var(--verdigris) 7%, transparent);
  }

  .card[data-kind='blocked'] {
    border-color: color-mix(in srgb, var(--candle) 60%, transparent);
    background: color-mix(in srgb, var(--candle) 5%, transparent);
  }

  .card[data-kind='miss'] {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--ash) 70%, transparent);
  }

  /* The mark says success or failure by shape: a star in a solid ring, or an empty dashed ring. */
  .mark {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    font-size: 16px;
    line-height: 1;
  }

  .card[data-kind='cast'] .mark {
    color: var(--verdigris);
    box-shadow: inset 0 0 0 2px var(--verdigris);
  }

  .card[data-kind='blocked'] .mark {
    color: var(--candle);
    box-shadow: inset 0 0 0 2px var(--candle);
  }

  .card[data-kind='miss'] .mark {
    border: 2px dashed var(--ash);
  }

  .card[data-kind='idle'] .mark::after {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--candle);
    box-shadow: 0 0 10px var(--candle);
  }

  .words {
    min-width: 0;
  }

  .line,
  .celebrate {
    margin: 0;
    font-size: 18px;
    line-height: 1.4;
  }

  .line.idle {
    color: color-mix(in srgb, var(--vellum) 88%, var(--ash));
  }

  .grade {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 21px;
    color: var(--candle);
  }

  .card[data-kind='cast'] .grade {
    color: var(--verdigris);
  }

  .celebrate {
    margin-top: 3px;
    color: var(--verdigris);
  }

  .actions {
    grid-area: actions;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px 10px;
  }

  .divider {
    width: 1px;
    height: 28px;
    margin: 0 4px;
    background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--gilt) 55%, transparent), transparent);
  }

  .btn {
    font-size: 16px;
    white-space: nowrap;
  }

  /* Pressed in: the plate sits lower, its field lit by the candle, and it carries a lit dot. */
  .slow[aria-pressed='true'] {
    filter: brightness(1.12);
    box-shadow:
      inset 0 0 0 1px rgb(12 8 4 / 0.75),
      inset 0 3px 8px rgb(0 0 0 / 0.55),
      inset 0 0 14px color-mix(in srgb, var(--candle) 30%, transparent),
      0 0 0 1px rgb(6 4 2 / 0.6);
  }

  .slow[aria-pressed='true']::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--candle);
    box-shadow: 0 0 6px var(--candle);
  }

  /* Narrower windows: the name and the buttons share the first row; the result has the second. */
  @media (max-width: 1240px) {
    .practice {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'who actions'
        'result result';
      gap: 8px 18px;
    }
  }

  @media (max-width: 760px) {
    .practice {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'who' 'result' 'actions';
    }

    .actions {
      justify-content: flex-start;
    }
  }
</style>
