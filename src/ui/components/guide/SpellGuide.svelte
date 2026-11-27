<script lang="ts">
  // The spell guide: the spellbook kept open beside the mirror while the player casts, since nobody
  // knows every spell by heart at first (the full Spellbook is a modal book over the glass). A
  // complementary landmark on the Mirror screen: App.svelte places it beside the mirror on wide
  // windows and under the Mirror bar on narrow ones, and the mirror shrinks to make room, so it never
  // covers the glass. It lists the spells that can be cast now, in the book's order by pack, each with
  // its gesture (GuideCard), and one quiet line on how many more open as the player learns these.
  // It answers results from the shell's log: the cast spell's card lights briefly and shows its new
  // progress, and the card a fizzle came close to is marked for a moment. It is no live region (the
  // GlassAnnouncer says each result once), never a dialog, and never takes focus by itself.
  import { tick, untrack } from 'svelte';
  import type { AppState } from '../../app-state.svelte';
  import { focusIfLost } from '../../actions';
  import { needsLine, readableId } from '../book/words';
  import GuideCard from './GuideCard.svelte';
  import { MARK_MS, guideGroups, lockedCount, markFor, moreLine, type GuideMark } from './guide';

  let { app }: { app: AppState } = $props();

  const book = $derived(app.spellbook);
  const groups = $derived(guideGroups(book));
  const listed = $derived(new Set(groups.flatMap((g) => g.entries.map((e) => e.spell.id))));
  const more = $derived(moreLine(lockedCount(book)));
  const learnAfter = $derived(book?.learnAfter ?? 3);
  /** Spells the tier just opened, while the shell celebrates it. */
  const fresh = $derived(new Set(app.celebration?.spellIds ?? []));

  const nameOf = (id: string) => app.entry(id)?.spell.incantation ?? readableId(id);
  const entryOf = (id: string) => app.entry(id);

  // ------------------------------------------------------------------ results

  let mark = $state.raw<GuideMark | null>(null);
  let markTimer: ReturnType<typeof setTimeout> | undefined;
  /** The latest result when the guide opened is old news: only later ones mark a card. */
  let seenId: string | null = untrack(() => app.log[0]?.id ?? null);

  $effect(() => {
    const latest = app.log[0];
    if (!latest || latest.id === seenId) return;
    seenId = latest.id;
    const next = markFor(latest);
    if (next && untrack(() => listed.has(next.spellId))) untrack(() => showMark(next));
  });

  function showMark(next: GuideMark): void {
    mark = next;
    clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      if (mark?.id === next.id) mark = null;
    }, MARK_MS[next.kind]);
    void tick().then(() => reveal(next.spellId));
  }

  $effect(() => () => clearTimeout(markTimer));

  // ------------------------------------------------------------------ the list's own scrolling

  let body = $state<HTMLElement | null>(null);
  /** The list fades at its foot only while there is more of it below, and at its head only while
   *  some of it has scrolled up out of view, so no entry is ever sliced off square. */
  let moreBelow = $state(false);
  let moreAbove = $state(false);

  function measure(): void {
    const el = body;
    moreBelow = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    moreAbove = !!el && el.scrollTop > 2;
  }

  $effect(() => {
    const el = body;
    void groups;
    if (!el || typeof ResizeObserver !== 'function') return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  });

  /** Bring a marked card into view, scrolling only the guide's own list (scrollIntoView would also
   *  scroll the room, whose overflow is hidden, and shift the mirror). */
  function reveal(spellId: string): void {
    const el = body;
    if (!el || typeof el.scrollBy !== 'function') return;
    const card = [...el.querySelectorAll<HTMLElement>('[data-spell-id]')].find((c) => c.dataset.spellId === spellId);
    if (!card) return;
    const view = el.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    // A card taller than the list's view shows from its top, where its name is.
    const tall = box.height > view.height - 8;
    const dy = box.top < view.top || tall ? box.top - view.top - 6 : box.bottom > view.bottom ? box.bottom - view.bottom + 8 : 0;
    if (Math.abs(dy) > 1) el.scrollBy({ top: dy, behavior: app.reducedMotion ? 'instant' : 'smooth' });
  }

  // "Close guide" takes away the button that had focus: give focus to the Mirror bar's "Spell guide",
  // which brings the guide back. Only when focus has fallen to the page, never otherwise.
  $effect(() => () => {
    queueMicrotask(() => focusIfLost(document.querySelector('[data-guide-toggle]')));
  });

  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
</script>

<aside id="spell-guide" class="spell-guide" aria-labelledby="spell-guide-title">
  <div class="guide-sheet page on-vellum">
    <header class="guide-head">
      <h2 id="spell-guide-title" class="guide-title">Spell guide</h2>
      <p class="guide-lede">Choose one to see it on the glass.</p>
      <button type="button" class="btn btn-small btn-ghost guide-close" onclick={() => app.setSpellGuide(false)}>Close guide</button>
    </header>

    <div class="guide-body" class:more={moreBelow} class:above={moreAbove} bind:this={body} onscroll={measure}>
      {#if !book}
        <p class="guide-empty">The spellbook is still being bound. It opens in a moment.</p>
      {:else if groups.length === 0}
        <p class="guide-empty">No spells can be cast yet. Turn a pack on in the Workshop.</p>
      {:else}
        {#each groups as g (g.pack.id)}
          {@const head = `guide-pack-${safe(g.pack.id)}`}
          <div class="guide-group">
            <h3 class="guide-group-title" id={head}>{g.pack.title}</h3>
            <ul class="guide-list" aria-labelledby={head}>
              {#each g.entries as e (e.spell.id)}
                <GuideCard
                  entry={e}
                  {learnAfter}
                  needs={needsLine(e.spell, nameOf, entryOf)}
                  onGlass={app.glassGuideId === e.spell.id}
                  mark={mark?.spellId === e.spell.id ? mark : null}
                  fresh={fresh.has(e.spell.id)}
                  reducedMotion={app.reducedMotion}
                  onchoose={(id) => app.toggleGlassGuide(id)}
                />
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
      {#if more}<p class="guide-more">{more}</p>{/if}
    </div>
  </div>
</aside>

<style>
  /* The guide is the container its own layout reads: one card to a row in the column beside the mirror
     and on a phone, as many as fit in a strip under the mirror on a narrow window. */
  .spell-guide {
    container: spell-guide / inline-size;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* As tall as its spells, up to the space it is given; then the list scrolls. A narrow page of the
     spellbook laid beside the glass: parchment ruled twice in ink round its edge, resting on the
     mantel with its shadow to the lower right. It is lit as the room is, by the candle low on the
     left: an old, warm page, brightest toward its lower left and falling off toward its top and its
     right, its edges browned and its face foxed, so it never outshines the glass beside it (Section
     10.1: the cast is the event). Every ink on it is checked against the darkest paper under it: the
     ink is over 9:1, the quieter inks and the rubric over 6:1. */
  .guide-sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    min-height: 0;
    border-radius: 2px;
    background:
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(4% 2.6% at 82% 18%, rgb(168 136 84 / 0.3), transparent 70%),
      radial-gradient(2.6% 1.8% at 14% 47%, rgb(168 136 84 / 0.24), transparent 70%),
      radial-gradient(6% 3% at 66% 71%, rgb(184 154 102 / 0.22), transparent 70%),
      radial-gradient(2% 1.4% at 90% 88%, rgb(150 116 66 / 0.26), transparent 70%),
      radial-gradient(3% 2% at 34% 93%, rgb(184 154 102 / 0.2), transparent 70%),
      radial-gradient(120% 85% at 0% 100%, rgb(255 224 166 / 0.3), rgb(255 224 166 / 0) 72%),
      linear-gradient(to top right, #e4d6b5 0%, #ddcfad 50%, #d1c29f 100%);
    background-blend-mode: soft-light, normal, normal, normal, normal, normal, normal, normal;
    box-shadow:
      inset 0 0 0 1px rgb(110 76 30 / 0.34),
      inset 0 0 30px rgb(112 76 30 / 0.3),
      0 0 0 1px rgb(20 12 6 / 0.55),
      4px 12px 30px rgb(0 0 0 / 0.55),
      1px 3px 6px rgb(0 0 0 / 0.4);
  }

  /* The inked double rule a few millimetres inside the page's edge. */
  .guide-sheet::before {
    content: '';
    position: absolute;
    inset: 5px;
    border: 1px solid rgb(43 33 24 / 0.32);
    outline: 1px solid rgb(43 33 24 / 0.16);
    outline-offset: 2px;
    pointer-events: none;
  }

  .guide-head {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'title close'
      'lede  lede';
    align-items: center;
    gap: 0 8px;
    padding: 13px 13px 20px 20px;
  }

  /* An ornamental rule under the head: hairlines either side of an oxblood lozenge. It stays inside
     the head, so the list never scrolls under it. */
  .guide-head::after {
    content: '';
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 0;
    height: 14px;
    background:
      var(--rule-ornament-ink) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, rgb(43 33 24 / 0.3) 8%, rgb(43 33 24 / 0.3) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), rgb(43 33 24 / 0.3) calc(50% + 60px), rgb(43 33 24 / 0.3) 92%, transparent) center / 100% 1px no-repeat;
    pointer-events: none;
  }

  .guide-title {
    grid-area: title;
    margin: 0;
    font-size: 27px;
    color: var(--ink);
  }

  /* Its opening capital in rubric, as the Spellbook's title has. */
  .guide-title::first-letter {
    font-family: var(--font-ornate);
    font-weight: 700;
    font-size: 1.1em;
    color: var(--rubric);
  }

  .guide-lede {
    grid-area: lede;
    margin: 0;
    font-size: 16px;
    line-height: 1.35;
    font-style: italic;
    color: var(--ink-soft);
  }

  .guide-close {
    grid-area: close;
  }

  .guide-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    margin: 0 6px 6px;
    padding: 8px 8px 10px;
  }

  .guide-body.more {
    mask-image: linear-gradient(180deg, #000 calc(100% - 28px), transparent);
  }

  .guide-body.above {
    mask-image: linear-gradient(180deg, transparent, #000 22px);
  }

  .guide-body.above.more {
    mask-image: linear-gradient(180deg, transparent, #000 22px, #000 calc(100% - 28px), transparent);
  }

  .guide-group + .guide-group {
    margin-top: 16px;
  }

  /* The pack's name engraved in small capitals, in rubric, between two hairlines. */
  .guide-group-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 4px 8px;
    font-family: var(--font-label);
    font-size: 17px;
    letter-spacing: 0.08em;
    color: var(--rubric);
  }

  .guide-group-title::before,
  .guide-group-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgb(123 30 43 / 0.45));
  }

  .guide-group-title::after {
    background: linear-gradient(270deg, transparent, rgb(123 30 43 / 0.45));
  }

  .guide-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .guide-empty,
  .guide-more {
    margin: 0;
    font-size: 16px;
    line-height: 1.4;
    font-style: italic;
    color: var(--ink-soft);
  }

  /* A note at the foot of the page, after a short centred rule. */
  .guide-more {
    margin-top: 14px;
    padding: 10px 4px 0;
    text-align: center;
    background: linear-gradient(90deg, transparent 30%, rgb(43 33 24 / 0.28) 50%, transparent 70%) top / 100% 1px no-repeat;
  }

  /* A strip under the mirror: the heading on one line, the cards side by side. The column beside the
     mirror is at most 352 px wide and a phone's strip about 410, so 440 tells the strip apart. */
  @container spell-guide (min-width: 440px) {
    .guide-head {
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas: 'title lede close';
      align-items: baseline;
      gap: 0 14px;
      padding: 7px 10px 14px 20px;
    }

    .guide-title {
      font-size: 23px;
    }

    .guide-body {
      padding: 4px 6px 6px;
    }

    /* Short fades: the strip is one row of cards high, and their first and last lines must stay
       readable. */
    .guide-body.more {
      mask-image: linear-gradient(180deg, #000 calc(100% - 10px), transparent);
    }

    .guide-body.above {
      mask-image: linear-gradient(180deg, transparent, #000 8px);
    }

    .guide-body.above.more {
      mask-image: linear-gradient(180deg, transparent, #000 8px, #000 calc(100% - 10px), transparent);
    }

    /* One row of cards must fit the strip: the pack's name is kept for screen readers (it names its
       list) but not drawn; the gap between lists still shows where a pack ends. */
    .guide-group-title {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    /* Narrow enough that two cards stand side by side in a 500 px strip (a card under 230 px puts
       its words under its drawing, GuideCard). */
    .guide-list {
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    }
  }

  /* A phone: the guide is a strip there too (App.svelte), one card wide; the pack's name gives its row
     to the spells, as in the wider strip. */
  @media (max-width: 640px) {
    .guide-group-title {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  }
</style>
