<script lang="ts">
  // One spell in the spell guide: its incantation, a small drawing of its gesture with the start dot,
  // the gesture in one short sentence, and progress toward learning it. The drawing draws itself once
  // at the gesture's pace when the card is hovered or its button focused, never on its own (Section
  // 10.6: no ambient motion), and is drawn whole at once under reduced motion. The incantation is the
  // card's one button and the whole card is its click area: choosing it draws the gesture faintly on
  // the glass, and choosing it again takes it away (aria-pressed). For a moment after a result the
  // card carries a word (Cast, Close, Right shape); the shell's announcer says the result itself, so
  // nothing here is a live region.
  import type { Point, SpellbookEntry } from '../../../contracts';
  import { geometry, gesturePaceMs } from '../../../kernel';
  import StrokePath from '../StrokePath.svelte';
  import ProgressPips from '../book/ProgressPips.svelte';
  import { gestureHint, statusWords, type GuideMark } from './guide';

  let {
    entry,
    learnAfter,
    needs = null,
    onGlass = false,
    mark = null,
    fresh = false,
    reducedMotion = false,
    onchoose,
    idPrefix = 'guide',
  }: {
    entry: SpellbookEntry;
    learnAfter: number;
    /** "Needs Lumos lit first.", for a spell that needs another one active. */
    needs?: string | null;
    /** Its gesture is drawn on the glass now. */
    onGlass?: boolean;
    /** The latest result's mark, when it is this spell's. */
    mark?: GuideMark | null;
    /** It opened with the tier just celebrated. */
    fresh?: boolean;
    reducedMotion?: boolean;
    onchoose: (spellId: string) => void;
    idPrefix?: string;
  } = $props();

  /** StrokePath draws during the first 80% of a pass and holds the finished stroke after
   *  (GesturePlate's pace). */
  const DRAW_SHARE = 0.8;

  const spell = $derived(entry.spell);
  // The entry's templates and flick are already mirrored for a left-handed caster: what is drawn is
  // what is matched.
  const points = $derived.by((): Point[] => {
    const g = spell.gesture;
    if (g && 'flick' in g) return geometry.flickPath(g.flick);
    return entry.templates[0] ?? [];
  });
  const passMs = $derived(Math.round(gesturePaceMs(spell.gesture) / DRAW_SHARE));
  const hint = $derived(gestureHint(entry));
  const learned = $derived(entry.status === 'learned');

  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = $derived(`${idPrefix}-${safe(spell.id)}`);
  const describedBy = $derived([hint || needs ? `${base}-hint` : '', `${base}-status`].filter(Boolean).join(' '));

  /** The word on the card now: a result first, then the glass, then a page just opened. */
  const tag = $derived.by((): { kind: string; text: string } | null => {
    if (mark) return { kind: mark.kind, text: mark.text };
    if (onGlass) return { kind: 'glass', text: 'On the glass' };
    if (fresh) return { kind: 'new', text: 'New' };
    return null;
  });

  // One pass of the drawing for each hover or focus. A new pass is a new StrokePath ({#key}), so the
  // stroke always starts again from its start dot.
  let pass = $state(0);
  let drawing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function play(): void {
    if (reducedMotion || points.length < 2) return;
    clearTimeout(timer);
    pass += 1;
    drawing = true;
    // Back to the still drawing, with its arrowhead, in the hold at the end of the pass, before the
    // dash animation would end and hide the ink for a frame.
    timer = setTimeout(() => (drawing = false), Math.round(passMs * (DRAW_SHARE + 0.12)));
  }

  function rest(): void {
    clearTimeout(timer);
    drawing = false;
  }

  $effect(() => () => clearTimeout(timer));
</script>

<li
  class="guide-card"
  data-spell-id={spell.id}
  data-status={entry.status}
  data-mark={mark?.kind}
  data-glass={onGlass ? 'true' : undefined}
  data-new={fresh ? 'true' : undefined}
  onpointerenter={play}
  onpointerleave={(e) => {
    // A finger leaves as it lifts, at the end of its tap: its pass draws on to the end.
    if (e.pointerType !== 'touch') rest();
  }}
>
  <div class="guide-card-body">
    <span class="guide-figure" aria-hidden="true">
      {#key pass}
        <StrokePath {points} size={64} animate={drawing} durationMs={passMs} loop={false} {reducedMotion} tone="ink" />
      {/key}
    </span>
    <button
      type="button"
      class="guide-name"
      aria-pressed={onGlass}
      aria-describedby={describedBy}
      onclick={() => onchoose(spell.id)}
      onfocus={play}
      onblur={rest}
    >
      {spell.incantation}<span class="visually-hidden">, show on the glass</span>
    </button>
    {#if hint || needs}
      <!-- One paragraph, so a compact strip can cut both to two lines together. -->
      <p class="guide-hint" id="{base}-hint">{hint}{#if needs}{' '}<span class="guide-needs">{needs}</span>{/if}</p>
    {/if}
    <div class="guide-foot">
      <p class="guide-status" id="{base}-status">
        {#if learned}
          <span class="guide-seal" aria-hidden="true">✦</span>
        {:else}
          <ProgressPips accepted={entry.accepted} goal={learnAfter} />
        {/if}
        <!-- The space is an expression: Svelte drops white space at the start of an element. -->
        <span class="guide-count">{statusWords(entry, learnAfter)}</span>{#if !learned}<span class="visually-hidden">{' casts to learn it'}</span>{/if}
      </p>
      {#if tag}<span class="guide-tag" data-kind={tag.kind}>{tag.text}</span>{/if}
    </div>
  </div>
</li>

<style>
  /* The card is the container its own layout reads: cards keep the drawing beside the words, and only
     very narrow ones put the words under it. */
  /* An entry inked on the page: a leaf of paper only a shade lighter than the page, with a hairline
     edge in ink, so a card a cast lights is what stands out. The edge is what a result changes
     (solid and lit, dashed, dotted), so its meaning never rests on color. */
  .guide-card {
    position: relative;
    container-type: inline-size;
    border-radius: 2px;
    border: 1px solid rgb(43 33 24 / 0.24);
    background: linear-gradient(180deg, rgb(255 248 228 / 0.2), rgb(255 248 228 / 0.08));
    box-shadow: 0 1px 0 rgb(255 250 235 / 0.22), 1px 2px 3px rgb(90 60 24 / 0.12);
    color: var(--ink);
    cursor: pointer;
    transition: background var(--duration) var(--ease-out), border-color var(--duration) var(--ease-out),
      box-shadow var(--duration) var(--ease-out);
  }

  .guide-card:hover {
    background: linear-gradient(180deg, rgb(255 248 228 / 0.42), rgb(255 246 222 / 0.24));
    border-color: rgb(43 33 24 / 0.42);
  }

  /* The focus ring goes round the whole card, which is the button's click area. */
  .guide-card:has(.guide-name:focus-visible) {
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--candle);
  }

  .guide-card-body {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    grid-template-areas:
      'fig name'
      'fig hint'
      'fig foot';
    column-gap: 12px;
    align-items: start;
    padding: 7px 10px 7px 8px;
  }

  /* The gesture in a small inked frame, ruled twice like the book's plates. */
  .guide-figure {
    grid-area: fig;
    display: grid;
    place-items: center;
    width: 56px;
    aspect-ratio: 1;
    border-radius: 1px;
    background: radial-gradient(80% 80% at 50% 45%, rgb(255 250 234 / 0.42), rgb(255 248 228 / 0.14));
    box-shadow:
      inset 0 0 0 1px rgb(43 33 24 / 0.42),
      inset 0 0 0 3px rgb(255 248 230 / 0.32),
      inset 0 0 0 4px rgb(43 33 24 / 0.18);
  }

  .guide-figure :global(.stroke-path) {
    width: 100%;
    height: 100%;
  }

  .guide-name {
    grid-area: name;
    justify-self: start;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font-family: var(--font-display);
    font-size: 22px;
    line-height: 1.15;
    text-align: left;
    color: var(--ink);
    cursor: pointer;
  }

  /* The incantation's first letter in rubric, as the book sets its spell names. */
  .guide-name::first-letter {
    color: var(--rubric);
  }

  /* The whole card answers a click on it, so a small name is never a small target. */
  .guide-name::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }

  .guide-name:focus-visible {
    box-shadow: none;
  }

  .guide-hint {
    grid-area: hint;
    margin: 3px 0 0;
    font-size: 16px;
    line-height: 1.35;
    color: color-mix(in srgb, var(--ink) 90%, var(--vellum));
  }

  /* Its own line in the column; run on after the gesture in the strip. */
  .guide-needs {
    display: block;
    margin-top: 3px;
    font-style: italic;
    color: var(--ink-soft);
  }

  /* Progress, and the word a result leaves at the end of the line; the word goes under it when the
     card is too narrow for both, and the progress never breaks. */
  .guide-foot {
    grid-area: foot;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-top: 5px;
  }

  .guide-status {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    min-height: 22px;
    font-size: 16px;
    line-height: 1.3;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
  }

  .guide-card[data-status='learned'] .guide-status {
    color: var(--ink-green);
  }

  .guide-seal {
    font-size: 14px;
  }

  /* The word a result leaves, at the end of the status line: a small inked label with cut corners.
     Each kind has its own edge as well as its words: solid for a cast, dashed for a near miss, dotted
     for a rule that stopped the spell. */
  .guide-tag {
    margin-left: auto;
    padding: 0 8px;
    border-radius: 3px;
    corner-shape: bevel;
    border: 1px solid currentColor;
    font-family: var(--font-label);
    font-size: 17px;
    letter-spacing: 0.04em;
    line-height: 1.3;
    white-space: nowrap;
    color: var(--ink-soft);
    background: rgb(255 251 238 / 0.55);
  }

  .guide-tag[data-kind='cast'] {
    color: var(--ink-brown);
    background: rgb(242 184 75 / 0.26);
  }

  .guide-tag[data-kind='close'] {
    color: var(--oxblood);
    border-style: dashed;
  }

  .guide-tag[data-kind='blocked'] {
    color: var(--ink-brown);
    border-style: dotted;
  }

  .guide-tag[data-kind='glass'] {
    color: var(--oxblood);
  }

  .guide-tag[data-kind='new'] {
    color: var(--ink-green);
  }

  /* Lit by a cast, for a moment: the candle's light falls on the entry and gilds its edge. */
  .guide-card[data-mark='cast'] {
    border-color: color-mix(in srgb, var(--candle) 65%, var(--ink));
    background:
      radial-gradient(90% 120% at 20% 30%, rgb(255 236 186 / 0.95), rgb(255 244 214 / 0.75) 60%, rgb(250 230 180 / 0.6));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--candle) 70%, transparent),
      0 0 18px rgb(242 184 75 / 0.55),
      0 0 40px rgb(242 160 60 / 0.25);
  }

  .guide-card[data-mark='close'] {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--oxblood) 75%, transparent);
  }

  .guide-card[data-mark='blocked'] {
    border-style: dotted;
    border-width: 1.5px;
    border-color: color-mix(in srgb, #6b440c 75%, transparent);
  }

  /* On the glass: a silk bookmark ribbon laid down the entry's edge, its end cut in a swallowtail
     below the card: a shape, not only a tint. */
  .guide-card[data-glass='true']::before {
    content: '';
    position: absolute;
    z-index: 1;
    top: -3px;
    bottom: -9px;
    left: -3px;
    width: 9px;
    pointer-events: none;
    background:
      linear-gradient(90deg, rgb(255 210 200 / 0.28), transparent 45%, rgb(0 0 0 / 0.25)),
      linear-gradient(180deg, color-mix(in srgb, var(--oxblood) 88%, white), var(--oxblood) 30%, var(--oxblood-2));
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 5px), 0 100%);
    filter: drop-shadow(1px 1px 1px rgb(0 0 0 / 0.35));
  }

  /* A strip under the mirror (the guide is wide and short): every card one row of the strip high, so
     the words are cut to two lines; the drawing and the Spellbook carry the rest. */
  @container spell-guide (min-width: 440px) {
    /* The longest seed names ("Wingardium Leviosa", "Petrificus Totalus") still take one line. */
    .guide-name {
      font-size: 19px;
    }

    .guide-hint {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }

    .guide-needs {
      display: inline;
    }
  }

  /* Very narrow cards (a small phone): the drawing beside the name, the words under both, cut to three
     lines. */
  @container (max-width: 230px) {
    .guide-card-body {
      grid-template-columns: 40px minmax(0, 1fr);
      grid-template-areas:
        'fig  name'
        'hint hint'
        'foot foot';
      column-gap: 8px;
      align-items: center;
    }

    .guide-figure {
      width: 40px;
    }

    .guide-name {
      font-size: 19px;
    }

    .guide-hint {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      overflow: hidden;
    }

    .guide-needs {
      display: inline;
    }
  }
</style>
