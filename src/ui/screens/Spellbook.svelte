<script lang="ts">
  // The Spellbook (Section 10.3, second layout; Section 10.4: "Browse spells by pack; watch the
  // stroke; see what each spell does"). It opens from the left edge like a book, as two facing
  // vellum pages, and leaves the mirror's frame in view at the right edge on wide windows. Left page:
  // the enabled spell packs with their spells in order and each one's status and progress. Right
  // page: the selected spell. The arrow keys move through the list; Escape, the scrim or "Close
  // book" return to the mirror. Turning to another spell plays the 'page-turn' cue.
  import { tick, untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import type { SpellbookEntry } from '../../contracts';
  import { ask, isReducedMotion, watchReducedMotion } from '../../kernel';
  import { onEscape, restoreFocus } from '../actions';
  import type { AppState } from '../app-state.svelte';
  import SpellList, { type PackGroup } from '../components/book/SpellList.svelte';
  import SpellPage from '../components/book/SpellPage.svelte';
  import { readableId, tierOf } from '../components/book/words';
  import { workshopView } from '../components/tools/session-state.svelte';

  let { app }: { app: AppState } = $props();

  /** Open the Workshop on the tab that answers the page: Settings holds "Open every spell", Packs the
   *  switches for packs that are off. */
  function toWorkshop(tab: 'settings' | 'packs'): void {
    workshopView.tab = tab;
    app.go('workshop');
  }

  // Read once for the opening transition, then kept current for the animated stroke.
  let reduced = $state(untrack(() => isReducedMotion(app.kernel)));
  $effect(() => watchReducedMotion(app.kernel, (r) => (reduced = r)));
  const openMs = untrack(() => (isReducedMotion(app.kernel) ? 0 : 280));

  const book = $derived(app.spellbook);

  /** Enabled spell packs only, in spellbook order, each with its spells in pack order. */
  const groups = $derived.by((): PackGroup[] => {
    const b = book;
    if (!b) return [];
    return b.packs
      .filter((p) => p.kind === 'spellpack' && p.enabled)
      .map((pack) => ({ pack, entries: b.spells.filter((e) => e.packId === pack.id) }))
      .filter((g) => g.entries.length > 0 || !!g.pack.error);
  });
  const visible = $derived(groups.flatMap((g) => g.entries));
  const learned = $derived(visible.filter((e) => e.status === 'learned').length);

  /** The spell on the right page: the one asked for, else the first open spell, else the first. */
  const selected = $derived.by((): SpellbookEntry | null => {
    const id = app.selectedSpellId;
    return (
      visible.find((e) => e.spell.id === id) ??
      visible.find((e) => e.status === 'open' && e.available) ??
      visible.find((e) => e.status === 'open') ??
      visible[0] ??
      null
    );
  });

  const nameOf = (id: string) => app.entry(id)?.spell.incantation ?? readableId(id);
  const entryOf = (id: string) => app.entry(id);

  let list = $state<SpellList | null>(null);
  let bookEl = $state<HTMLElement | null>(null);
  let lastTurn = 0;

  // The list fades at the page's foot only while there are more spells below, and under the title
  // only while some have scrolled up out of view.
  let bodyEl = $state<HTMLElement | null>(null);
  let bodyMore = $state(false);
  let bodyAbove = $state(false);
  function measureBody(): void {
    const el = bodyEl;
    bodyMore = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    bodyAbove = !!el && el.scrollTop > 2;
  }
  $effect(() => {
    const el = bodyEl;
    void groups.length;
    if (!el) return;
    measureBody();
    const ro = new ResizeObserver(measureBody);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  });

  function select(spellId: string): void {
    if (spellId === selected?.spell.id) return;
    app.selectedSpellId = spellId;
    // A held arrow key turns many pages: one rustle at a time is enough.
    const now = performance.now();
    if (now - lastTurn > 200) {
      lastTurn = now;
      void ask(app.kernel, 'audio.play', { cue: 'page-turn' }).catch(() => {});
    }
  }

  function close(): void {
    app.go('mirror');
  }

  function practice(spellId: string): void {
    app.startPractice(spellId);
  }

  // Focus moves to the selected spell when the book opens, and back where it was when it closes. This
  // teardown runs only once the book has flown out (280 ms), and by then the screen a page opened, such
  // as the Workshop from "Go to the Workshop", has focused its own title: restoreFocus leaves that be,
  // and falls back to the Mirror bar when the button that opened the book is gone (Practice's "Back to
  // book").
  $effect(() => {
    const previous = document.activeElement;
    void tick().then(() => {
      if (list && selected) void list.focusOption(selected.spell.id, false);
      else bookEl?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    });
    return () => restoreFocus(previous);
  });

  /** Keep Tab inside the open book (it is a modal dialog). */
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !bookEl) return;
    const focusable = [...bookEl.querySelectorAll<HTMLElement>('button, [href], [tabindex="0"], input, select, textarea')].filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<div class="book-scrim" role="presentation" onclick={close} transition:fade={{ duration: openMs * 0.7 }}></div>

<div
  class="book"
  role="dialog"
  aria-modal="true"
  aria-labelledby="spellbook-title"
  tabindex="-1"
  bind:this={bookEl}
  onkeydown={trapTab}
  use:onEscape={close}
  transition:fly={{ x: -72, duration: openMs, opacity: 0.2 }}
>
  <section class="leaf leaf-left page on-vellum" aria-labelledby="spellbook-title">
    <header class="leaf-head">
      <h2 id="spellbook-title">Spellbook</h2>
      {#if visible.length}
        <p class="summary">{learned} of {visible.length} spells learned</p>
      {/if}
    </header>

    <div class="leaf-body" class:more={bodyMore} class:above={bodyAbove} bind:this={bodyEl} onscroll={measureBody}>
      {#if book?.indexError}
        <p class="notice">{book.indexError} The spells that ship with Spellglass are missing until it can be read.</p>
      {/if}

      {#if !book}
        <p class="empty">The spellbook is still being bound. It opens in a moment.</p>
      {:else if groups.length === 0}
        <p class="empty">No spell packs are turned on, so these pages are blank. Turn a pack on in the Workshop.</p>
      {:else}
        <SpellList
          bind:this={list}
          {groups}
          selectedId={selected?.spell.id ?? null}
          learnAfter={book.learnAfter}
          onselect={(id) => select(id)}
        />
      {/if}
    </div>
  </section>

  <section class="leaf leaf-right page on-vellum" aria-label={selected ? selected.spell.incantation : 'Spell'}>
    <header class="running-head">
      <span class="head-text">
        {#if selected}{selected.packTitle}<span class="dot" aria-hidden="true">·</span>Tier {tierOf(selected)}{/if}
      </span>
      <button type="button" class="btn btn-small close" onclick={close}>Close book</button>
    </header>

    <div class="leaf-turn">
      {#if selected && book}
        {#key selected.spell.id}
          <div class="turn" in:fly={{ x: 22, duration: reduced ? 0 : 240, opacity: 0 }}>
            <SpellPage
              entry={selected}
              {book}
              {nameOf}
              {entryOf}
              reducedMotion={reduced}
              onpractice={practice}
              onworkshop={() => toWorkshop('settings')}
            />
          </div>
        {/key}
      {:else}
        <div class="blank">
          <p>Spells you can learn appear here, with the way to draw each one.</p>
          {#if book}<button type="button" class="btn" onclick={() => toWorkshop('packs')}>Go to the Workshop</button>{/if}
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .book-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    /* Darkest behind the book; the mirror at the right edge stays in view. */
    background: linear-gradient(90deg, rgb(5 7 14 / 0.7) 0%, rgb(5 7 14 / 0.55) 55%, rgb(5 7 14 / 0.3) 100%);
  }

  /* A book bound in oxblood morocco: grained leather over boards, a gilt double rule tooled round
     each board with a small flower at its corners, the pages' edges gilt where they stack. */
  .book {
    position: fixed;
    z-index: 41;
    left: 0;
    /* Under route A's screen light (App.svelte sets --screen-light), which sits above everything:
       the heading and "Close book" stay in view and take their own clicks. */
    top: calc(10px + var(--screen-light, 0px));
    bottom: 10px;
    width: clamp(880px, 74vw, 1320px);
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    padding: 16px 18px 16px 12px;
    border-radius: 0 10px 10px 0;
    background:
      radial-gradient(110% 80% at 72% 12%, rgb(255 200 160 / 0.1), transparent 60%),
      radial-gradient(140% 120% at 18% 110%, rgb(0 0 0 / 0.45), transparent 60%),
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, color-mix(in srgb, var(--leather) 90%, #c08060), var(--leather) 30%, var(--leather-dark));
    background-blend-mode: normal, normal, soft-light, normal;
    box-shadow:
      inset 0 0 0 1px rgb(0 0 0 / 0.65),
      inset 0 1px 0 1px rgb(255 190 170 / 0.08),
      22px 0 70px rgb(0 0 0 / 0.6),
      6px 0 18px rgb(0 0 0 / 0.45);
    outline: none;
  }

  /* The tooling: two gilt rules round the board, outside the pages, and the corner flowers. */
  .book::before {
    content: '';
    position: absolute;
    inset: 4px 5px 4px 3px;
    border: 1px solid rgb(201 163 86 / 0.7);
    outline: 1px solid rgb(201 163 86 / 0.38);
    outline-offset: -4px;
    border-radius: 0 7px 7px 0;
    background:
      var(--tool-corner) 100% 0 / 34px no-repeat,
      var(--tool-corner) 100% 100% / 34px no-repeat;
    pointer-events: none;
  }

  /* The spine's crease between the pages: the paper curving down into the binding. */
  .book::after {
    content: '';
    position: absolute;
    top: 16px;
    bottom: 16px;
    left: calc(50% - 5px);
    width: 10px;
    background: linear-gradient(90deg, rgb(43 33 24 / 0), rgb(43 33 24 / 0.42) 50%, rgb(43 33 24 / 0));
    pointer-events: none;
  }

  .leaf {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: clamp(18px, 3.2vh, 30px) clamp(20px, 2.2vw, 36px) clamp(16px, 2.6vh, 26px);
    color: var(--ink);
  }

  /* Parchment with fibre and age: lighter where text sits, the gutter's shadow toward the spine, a
     little foxing, browner at the outer edge, and the leaves' gilt edges stacked at the outer side. */
  .leaf-left {
    border-radius: 4px 2px 2px 4px;
    background:
      linear-gradient(270deg, rgb(43 33 24 / 0.3), rgb(43 33 24 / 0.08) 4%, transparent 11%),
      linear-gradient(90deg, rgb(130 92 40 / 0.2), transparent 6%),
      var(--tex-fibre) 0 0 / 260px,
      radial-gradient(7% 5% at 16% 88%, rgb(184 154 102 / 0.22), transparent 70%),
      radial-gradient(5% 4% at 78% 7%, rgb(184 154 102 / 0.2), transparent 70%),
      radial-gradient(130% 100% at 45% 10%, color-mix(in srgb, var(--vellum) 86%, white), var(--vellum) 55%, var(--vellum-2) 100%);
    background-blend-mode: normal, normal, soft-light, normal, normal, normal;
    box-shadow:
      inset 0 0 18px rgb(120 84 36 / 0.16),
      -1px 0 0 #e1c98c, -2px 1px 0 #b8954d, -3px 1px 0 #dcc283, -4px 2px 0 #a8843f, -5px 2px 0 #d6ba78,
      -6px 3px 0 rgb(0 0 0 / 0.3);
  }

  .leaf-right {
    border-radius: 2px 4px 4px 2px;
    background:
      linear-gradient(90deg, rgb(43 33 24 / 0.3), rgb(43 33 24 / 0.08) 4%, transparent 11%),
      linear-gradient(270deg, rgb(130 92 40 / 0.2), transparent 6%),
      var(--tex-fibre) 130px 60px / 260px,
      radial-gradient(6% 4% at 88% 82%, rgb(184 154 102 / 0.22), transparent 70%),
      radial-gradient(9% 6% at 30% 96%, rgb(184 154 102 / 0.16), transparent 70%),
      radial-gradient(130% 100% at 55% 10%, color-mix(in srgb, var(--vellum) 86%, white), var(--vellum) 55%, var(--vellum-2) 100%);
    background-blend-mode: normal, normal, soft-light, normal, normal, normal;
    box-shadow:
      inset 0 0 18px rgb(120 84 36 / 0.16),
      1px 0 0 #e1c98c, 2px 1px 0 #b8954d, 3px 1px 0 #dcc283, 4px 2px 0 #a8843f, 5px 2px 0 #d6ba78,
      6px 3px 0 rgb(0 0 0 / 0.3);
  }

  .leaf-head {
    position: relative;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 16px;
    padding: 0 6px 16px 33px;
    margin-bottom: 6px;
  }

  /* An ornamental rule under the book's title. */
  .leaf-head::after {
    content: '';
    position: absolute;
    left: 20px;
    right: 0;
    bottom: 0;
    height: 14px;
    background:
      var(--rule-ornament-ink) center / 120px 14px no-repeat,
      linear-gradient(90deg, transparent, rgb(43 33 24 / 0.3) 10%, rgb(43 33 24 / 0.3) calc(50% - 60px), transparent calc(50% - 58px), transparent calc(50% + 58px), rgb(43 33 24 / 0.3) calc(50% + 60px), rgb(43 33 24 / 0.3) 90%, transparent) center / 100% 1px no-repeat;
    pointer-events: none;
  }

  .leaf-head h2 {
    margin: 0;
    font-size: clamp(32px, 4vh, 42px);
    color: var(--ink);
  }

  /* The book's title opens with a rubricated capital. */
  .leaf-head h2::first-letter {
    font-family: var(--font-ornate);
    font-weight: 700;
    font-size: 1.12em;
    color: var(--rubric);
  }

  .leaf-head h2:focus-visible {
    box-shadow: none;
  }

  .summary {
    margin: 0;
    font-size: 16px;
    font-style: italic;
    color: var(--ink-soft);
  }

  .leaf-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0 -10px 0 -6px;
    padding: 4px 10px 12px 6px;
    scrollbar-color: rgb(43 33 24 / 0.3) transparent;
  }

  .leaf-body.more {
    mask-image: linear-gradient(180deg, #000 calc(100% - 36px), transparent);
  }

  .leaf-body.above {
    mask-image: linear-gradient(180deg, transparent, #000 24px);
  }

  .leaf-body.above.more {
    mask-image: linear-gradient(180deg, transparent, #000 24px, #000 calc(100% - 36px), transparent);
  }

  .notice,
  .empty {
    margin: 0 0 16px 33px;
    font-size: 18px;
    line-height: 1.5;
  }

  .notice {
    padding: 10px 14px;
    border-left: 3px solid var(--oxblood);
    background: rgb(123 30 43 / 0.06);
  }

  .running-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: -6px -10px 8px 0;
    min-height: 44px;
  }

  /* The running head, in small capitals as a printer sets it. */
  .head-text {
    font-family: var(--font-label);
    font-size: 17px;
    letter-spacing: 0.07em;
    color: var(--ink-soft);
  }

  .dot {
    margin: 0 0.45em;
  }

  .close {
    min-height: 44px;
    padding: 6px 16px;
    font-size: 16px;
  }

  .leaf-turn {
    flex: 1;
    min-height: 0;
    display: grid;
  }

  .turn {
    min-height: 0;
    display: grid;
  }

  .blank {
    align-self: center;
    justify-self: center;
    max-width: 30ch;
    text-align: center;
    font-style: italic;
    color: var(--ink-soft);
  }

  /* Narrow windows: the book takes the full width. */
  @media (max-width: 1000px) {
    .book {
      top: var(--screen-light, 0px);
      bottom: 0;
      width: 100vw;
      padding: 10px 12px;
      border-radius: 0;
    }

    .book::after {
      top: 10px;
      bottom: 10px;
    }
  }

  /* Very narrow: one page above the other. */
  @media (max-width: 760px) {
    .book {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 0.42fr) minmax(0, 0.58fr);
      gap: 10px;
    }

    .book::after {
      display: none;
    }
  }
</style>
