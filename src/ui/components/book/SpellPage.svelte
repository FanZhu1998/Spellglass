<script lang="ts">
  // The right page of the Spellbook: one spell. Its incantation in the display face, what it is
  // known as, its status and progress, the gesture drawing itself at its pace with a start dot, the
  // gesture in words, what happens on screen, where the gesture comes from, how it works with other
  // spells, and the way into practice. Pack strings are rendered as text only.
  import type { Spellbook, SpellbookEntry } from '../../../contracts';
  import GesturePlate from './GesturePlate.svelte';
  import ProgressPips from './ProgressPips.svelte';
  import type { EntryOf, NameOf } from './words';
  import { STATUS_WORD, basisText, interactionLines, joinNames, practiceBlock, progressText, stillToLearn, tierOf, typeset } from './words';

  let {
    entry,
    book,
    nameOf,
    entryOf,
    reducedMotion = false,
    onpractice,
    onworkshop,
    idPrefix = 'spellbook',
  }: {
    entry: SpellbookEntry;
    book: Spellbook;
    nameOf: NameOf;
    entryOf: EntryOf;
    reducedMotion?: boolean;
    onpractice: (spellId: string) => void;
    onworkshop: () => void;
    idPrefix?: string;
  } = $props();

  const FLICK_TEXT = { up: 'Flick straight up.', down: 'Flick straight down.', left: 'Flick right to left.', right: 'Flick left to right.' } as const;
  const TAG = { learned: 'tag-learned', open: 'tag-open', locked: 'tag-locked' } as const;

  const spell = $derived(entry.spell);
  const gesture = $derived(spell.gesture);

  /** The gesture in words, for the hand it is shown for. A mirrored flick is described from its
   *  (already mirrored) direction; a mirrored path uses the pack's mirrored words when it has them. */
  const gestureText = $derived.by(() => {
    if ('flick' in gesture) return entry.mirrored || !spell.gesture_text ? FLICK_TEXT[gesture.flick] : typeset(spell.gesture_text);
    if (entry.mirrored && spell.gesture_text_mirrored) return typeset(spell.gesture_text_mirrored);
    return typeset(spell.gesture_text);
  });
  const mirroredNote = $derived.by(() => {
    if (!entry.mirrored) return '';
    if ('flick' in gesture || spell.gesture_text_mirrored || !spell.gesture_text) return 'Mirrored for your left hand.';
    return 'Mirrored for your left hand: follow the drawing, which runs the other way.';
  });

  const basis = $derived(basisText(spell.basis));
  const works = $derived(interactionLines(entry, nameOf, entryOf));
  const blocked = $derived(practiceBlock(entry, book));
  const waiting = $derived(entry.status === 'locked' ? stillToLearn(book).filter((e) => e.spell.id !== spell.id) : []);
  const waitingText = $derived(waiting.length ? `Still to learn: ${joinNames(waiting.map((e) => e.spell.incantation), 'and')}.` : '');

  // The bottom of the page fades only while there is more of it to scroll to.
  let scroller = $state<HTMLElement | null>(null);
  let more = $state(false);
  function measure(): void {
    const el = scroller;
    more = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
  }
  $effect(() => {
    const el = scroller;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  });

  const statusText = $derived.by(() => {
    switch (entry.status) {
      case 'learned':
        return 'Your own casts now help the mirror know it.';
      case 'open':
        return `${progressText(entry.accepted, book.learnAfter)} casts to learn it`;
      default:
        return `Tier ${tierOf(entry)}`;
    }
  });

  const titleId = $derived(`${idPrefix}-spell-title`);
  const reasonId = $derived(`${idPrefix}-practice-reason`);
</script>

<article class="spell-page" aria-labelledby={titleId}>
  <div class="scroll" class:more bind:this={scroller} onscroll={measure}>
    <header class="title-block">
      <h2 id={titleId}>{spell.incantation}</h2>
      {#if spell.known_as}<p class="known">{typeset(spell.known_as)}</p>{/if}
      <p class="status" data-status={entry.status}>
        <span class="tag {TAG[entry.status]}">{STATUS_WORD[entry.status]}</span>
        <span class="status-text">{statusText}</span>
        {#if entry.status === 'open'}<ProgressPips accepted={entry.accepted} goal={book.learnAfter} />{/if}
      </p>
    </header>

    <div class="figure-row">
      <figure class="figure">
        <GesturePlate {entry} {reducedMotion} label="The {spell.incantation} gesture, drawn from its start dot" />
        <figcaption>
          Begin at the dot.
          {#if entry.overridden}<span class="own">Drawn your way</span>{/if}
        </figcaption>
      </figure>
      <div class="gesture">
        <p class="lead"><span class="run-in">Gesture.</span> {gestureText}</p>
        {#if mirroredNote}<p class="note">{mirroredNote}</p>{/if}
      </div>
    </div>

    <dl class="facts">
      {#if spell.description}
        <div><dt>On screen</dt><dd>{typeset(spell.description)}</dd></div>
      {/if}
      {#if works.length}
        <div><dt>With other spells</dt><dd>{works.join(' ')}</dd></div>
      {/if}
      {#if basis}
        <div><dt>Basis</dt><dd>{basis.label}: {basis.text}</dd></div>
      {/if}
    </dl>
  </div>

  <footer class="action">
    <div class="buttons">
      <button
        type="button"
        class="btn btn-seal practice"
        aria-disabled={blocked ? 'true' : undefined}
        aria-describedby={blocked ? reasonId : undefined}
        onclick={() => {
          if (!blocked) onpractice(spell.id);
        }}
      >
        Practice this spell
      </button>
      {#if blocked && entry.status === 'locked'}
        <button type="button" class="btn workshop" onclick={onworkshop}>Go to the Workshop</button>
      {/if}
    </div>
    {#if blocked}
      <p class="reason" id={reasonId}>
        {blocked}{#if waitingText}{' '}<span class="waiting">{waitingText}</span>{/if}
      </p>
    {/if}
  </footer>
</article>

<style>
  .spell-page {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    container-type: inline-size;
  }

  /* When a long spell overflows a short page, its last lines fade into the page edge, so it reads
     as more to scroll rather than cut off. */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px 8px 0;
    margin-right: -6px;
  }

  .scroll.more {
    mask-image: linear-gradient(180deg, #000 calc(100% - 30px), transparent);
  }

  h2 {
    margin: 0;
    font-size: clamp(34px, 4.2vh, 44px);
    line-height: 1.05;
    color: var(--ink);
  }

  /* The spell's name stays one word in one hand, so a player learning it reads it whole: its first
     letter in rubric, as the guide sets it. The page's drop cap opens its text instead (.facts). */
  h2::first-letter {
    color: var(--rubric);
  }

  .known {
    margin: 2px 0 0;
    font-family: var(--font-display);
    font-style: italic;
    font-size: 22px;
    color: var(--ink-soft);
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 10px 0 0;
    font-size: 18px;
  }

  .status-text {
    color: var(--ink-soft);
  }

  .status .tag {
    font-size: 17px;
    line-height: 1.3;
    min-width: 5.4em;
    text-align: center;
    background: rgb(255 252 240 / 0.5);
  }

  .status .tag-learned {
    color: var(--ink-green);
  }

  .status .tag-open {
    color: var(--ink-brown);
  }

  .status .tag-locked {
    color: var(--ink-faint);
    border-style: dashed;
    background: transparent;
  }

  .figure-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 20px;
    margin: clamp(12px, 2.2vh, 22px) 0 clamp(10px, 1.8vh, 18px);
  }

  .figure {
    margin: 0;
    display: grid;
    justify-items: center;
    gap: 6px;
    /* As large as the page allows: by its width beside the words, and by the window's height. */
    --plate-size: clamp(128px, min(23vh, 44cqw), 250px);
  }

  .gesture {
    padding-top: 6px;
  }

  figcaption {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 4px 10px;
    font-size: 16px;
    font-style: italic;
    color: var(--ink-soft);
  }

  .own {
    font-style: normal;
    padding: 0 9px;
    border-radius: 3px;
    corner-shape: bevel;
    color: var(--oxblood);
    border: 1px solid color-mix(in srgb, var(--oxblood) 60%, transparent);
    font-family: var(--font-label);
    letter-spacing: 0.04em;
  }

  .gesture p {
    margin: 0;
  }

  .lead {
    font-size: 19px;
    line-height: 1.5;
  }

  /* Rubrics: each paragraph's lead word in red, as a scribe would set it. */
  .run-in,
  dt {
    font-family: var(--font-label);
    letter-spacing: 0.03em;
    color: var(--rubric);
  }

  .run-in {
    font-size: 21px;
    margin-right: 2px;
  }

  .note {
    margin-top: 8px !important;
    font-size: 16px;
    font-style: italic;
    color: var(--ink-soft);
  }

  .facts {
    margin: 0;
    display: grid;
    gap: 8px;
  }

  .facts div {
    line-height: 1.5;
  }

  /* The page's text opens with a drop cap, as a scribe begins a chapter: an ornate capital in rubric
     sunk two lines, the rest of its first word running on in the rubric's small capitals. */
  .facts > div:first-child::first-letter {
    initial-letter: 2;
    margin-right: 0.06em;
    font-family: var(--font-ornate);
    font-weight: 700;
    color: var(--rubric);
    text-shadow: 1px 1px 0 rgb(255 246 225 / 0.7);
  }

  dt {
    display: inline;
    font-size: 21px;
  }

  dt::after {
    content: '.';
  }

  dd {
    display: inline;
    margin: 0 0 0 4px;
  }

  /* The foot of the page, under an ornamental rule (inside the foot, so the page above never scrolls
     under it). */
  .action {
    position: relative;
    display: grid;
    gap: 8px;
    padding-top: 22px;
    margin-top: 2px;
  }

  .action::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 14px;
    background:
      var(--rule-ornament-ink) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, rgb(43 33 24 / 0.28) 8%, rgb(43 33 24 / 0.28) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), rgb(43 33 24 / 0.28) calc(50% + 60px), rgb(43 33 24 / 0.28) 92%, transparent) center / 100% 1px no-repeat;
    pointer-events: none;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .practice {
    min-height: 48px;
    padding: 10px 24px;
    font-size: 18px;
  }

  /* Not yet: the seal's place outlined in a dashed line like the "locked" tag, its disc an empty
     ring, the words still legible. */
  .practice[aria-disabled='true'] {
    opacity: 1;
    filter: none;
    background: transparent;
    color: var(--ink-faint);
    border: 1.5px dashed color-mix(in srgb, var(--oxblood) 55%, var(--vellum));
    box-shadow: none;
    text-shadow: none;
  }

  .practice[aria-disabled='true']::before {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--oxblood) 45%, var(--vellum));
  }

  .practice[aria-disabled='true']:focus-visible {
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--candle);
  }

  .reason {
    margin: 0;
    font-size: 16px;
    line-height: 1.45;
    color: var(--ink-soft);
  }

  .waiting {
    font-style: italic;
  }

  .workshop {
    min-height: 44px;
    padding: 6px 16px;
    font-size: 16px;
  }

  @container (max-width: 340px) {
    .figure-row {
      grid-template-columns: minmax(0, 1fr);
      justify-items: center;
      gap: 10px;
    }

    .gesture {
      justify-self: stretch;
      padding-top: 0;
    }
  }
</style>
