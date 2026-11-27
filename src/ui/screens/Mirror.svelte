<script lang="ts">
  // Mirror: free casting, the home screen (Sections 10.1, 10.3, 10.4). Its controls sit on the frame
  // below the glass and never cover the middle: the spellbook and practice on the left, tuning and
  // sharing on the right, and quieter entries between them (the spell guide beside the mirror, the
  // Workshop, the way the app sees the wand, and a QR code that hands the app's link to a phone or a
  // friend, Section 11.1).
  // The glass itself carries the notes, the session log and the cast banner (App.svelte places them).
  import type { AppState } from '../app-state.svelte';
  import Icon from '../components/shell/Icon.svelte';
  import AppLink from '../components/shell/AppLink.svelte';

  let { app }: { app: AppState } = $props();

  const practiceLabel = $derived.by(() => {
    const selected = app.selectedEntry;
    if (selected?.enabled) return `Practice ${selected.spell.incantation}`;
    const next = app.nextSpell;
    return next ? `Practice: open the spellbook at ${next.spell.incantation}` : 'Practice: open the spellbook';
  });
</script>

<nav class="mirror-bar" aria-label="Mirror">
  <div class="group lead">
    <!-- Where focus lands when the control that had it is gone (actions.ts restoreFocus). -->
    <button class="btn bar-btn" onclick={() => app.go('spellbook')} data-focus-home>
      <Icon name="book" />Open spellbook
    </button>
    <button class="btn bar-btn" onclick={() => app.practiceNext()} aria-label={practiceLabel} title={practiceLabel}>
      <Icon name="practice" />Practice
    </button>
  </div>

  <div class="group quiet">
    <!-- Shows and hides the spell guide (App.svelte places it); it starts open. Focus comes here
         when the guide's own "Close guide" takes the guide away. -->
    <button
      class="btn btn-ghost quiet-btn guide-toggle"
      aria-expanded={app.spellGuideOpen}
      aria-controls={app.spellGuideOpen ? 'spell-guide' : undefined}
      onclick={() => app.setSpellGuide(!app.spellGuideOpen)}
      data-guide-toggle
    >
      <Icon name="guide" size={20} />Spell guide
    </button>
    <button class="btn btn-ghost quiet-btn" onclick={() => app.go('workshop')}>
      <Icon name="workshop" size={20} />Workshop
    </button>
    <button class="btn btn-ghost quiet-btn" onclick={() => app.go('threshold')}>
      <Icon name="eye" size={20} />Change how the app sees your wand
    </button>
    <!-- The desktop app has no web address to hand on unless it was built with one. -->
    {#if app.appUrl}<AppLink {app} />{/if}
  </div>

  <div class="group trail">
    <button class="btn bar-btn" onclick={() => app.go('tuning')}>
      <Icon name="tune" />Tune wand
    </button>
    <button class="btn bar-btn" onclick={() => app.go('keepsakes')}>
      <Icon name="share" />Share
    </button>
  </div>
</nav>

<style>
  /* As wide as the mirror's frame (App.svelte gives --frame-w), so the controls line up with it. */
  .mirror-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 20px;
    width: min(calc(100% - 2 * var(--stage-pr, 20px)), var(--frame-w, 100%));
    margin-inline: auto;
    padding: 6px 0 4px;
    container-type: inline-size;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .quiet {
    gap: 4px;
  }

  /* The four main controls are plaques of aged brass screwed to the wall under the frame, as a
     museum labels a painting: a polished face lit from the upper left, a bevelled edge, and the words
     and the small drawing engraved into it and filled with dark wax (the cut catches the light on its
     lower lip). The ink on the brass's darkest tone under the words is over 6.5:1. */
  .bar-btn {
    position: relative;
    gap: 9px;
    padding: 8px 23px 8px 22px;
    border: 1px solid #3a2a12;
    color: var(--ink);
    font-size: var(--text-small);
    text-shadow: 0 1px 0 rgb(255 240 205 / 0.5);
    background:
      linear-gradient(180deg, rgb(255 250 228 / 0.38), rgb(255 248 220 / 0) 44%, rgb(70 46 12 / 0.16)),
      radial-gradient(120% 140% at 18% 0%, rgb(255 236 180 / 0.22), transparent 60%),
      var(--tex-grain) 0 0 / 180px,
      linear-gradient(180deg, #dcc283, #c8a862 52%, #b8964f);
    background-blend-mode: normal, normal, soft-light, normal;
    box-shadow:
      inset 0 1px 0 rgb(255 246 215 / 0.65),
      inset 0 0 0 1px rgb(255 240 200 / 0.28),
      inset 0 -2px 3px rgb(70 46 12 / 0.4),
      0 0 0 1px rgb(8 5 2 / 0.55),
      2px 4px 8px rgb(0 0 0 / 0.5);
  }

  .bar-btn:hover {
    filter: brightness(1.07) saturate(1.04);
  }

  .bar-btn:active {
    box-shadow:
      inset 0 2px 4px rgb(70 46 12 / 0.5),
      0 0 0 1px rgb(8 5 2 / 0.55),
      1px 2px 4px rgb(0 0 0 / 0.5);
  }

  .bar-btn:focus-visible {
    box-shadow: var(--focus), 2px 4px 8px rgb(0 0 0 / 0.5);
  }

  /* A slotted brass screw at either end, holding the plaque to the wall, set well clear of the words.
     The slots lie at different angles, as screws are never driven home alike. */
  .bar-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cdefs%3E%3CradialGradient id='g' cx='.36' cy='.3' r='.8'%3E%3Cstop offset='0' stop-color='%23fff2c8'/%3E%3Cstop offset='.5' stop-color='%23c9a356'/%3E%3Cstop offset='1' stop-color='%235a4019'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='4' cy='4' r='3.3' fill='url(%23g)' stroke='%232e2009' stroke-width='.7'/%3E%3Cpath d='M1.9 5.6 6.1 2.4' stroke='%232b1d08' stroke-width='1' stroke-linecap='round'/%3E%3Cpath d='M2.2 6.1 6.4 2.9' stroke='%23fff3c4' stroke-opacity='.55' stroke-width='.45' stroke-linecap='round'/%3E%3C/svg%3E") 7px 50% / 8px 8px no-repeat,
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cdefs%3E%3CradialGradient id='g' cx='.36' cy='.3' r='.8'%3E%3Cstop offset='0' stop-color='%23fff2c8'/%3E%3Cstop offset='.5' stop-color='%23c9a356'/%3E%3Cstop offset='1' stop-color='%235a4019'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='4' cy='4' r='3.3' fill='url(%23g)' stroke='%232e2009' stroke-width='.7'/%3E%3Cpath d='M2.1 2.6 5.9 5.4' stroke='%232b1d08' stroke-width='1' stroke-linecap='round'/%3E%3Cpath d='M2.4 3.1 6.2 5.9' stroke='%23fff3c4' stroke-opacity='.55' stroke-width='.45' stroke-linecap='round'/%3E%3C/svg%3E") calc(100% - 7px) 50% / 8px 8px no-repeat;
  }

  /* The drawing engraved like the words: dark in the cut, a lit lip under it. */
  .bar-btn :global(.icon) {
    color: color-mix(in srgb, var(--ink) 92%, #6b440c);
    filter: drop-shadow(0 1px 0 rgb(255 240 205 / 0.5));
  }

  /* The quieter entries are words lettered on the wall, without plates. */
  .quiet-btn {
    gap: 8px;
    padding: 8px 12px;
    color: color-mix(in srgb, var(--vellum) 78%, var(--ash));
    font-size: var(--text-small);
  }

  .quiet-btn:hover {
    color: var(--vellum);
  }

  /* Open: the slip is lit and underlined, so the state shows by more than a color. */
  .guide-toggle[aria-expanded='true'] {
    color: var(--vellum);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--candle) 70%, transparent);
    text-decoration-thickness: 1.5px;
    text-underline-offset: 5px;
  }

  .guide-toggle[aria-expanded='true'] :global(.icon) {
    color: var(--candle);
  }

  /* Too narrow for one row (the main four and the quiet entries need about 1260 px): the quiet entries
     take a row of their own under the main four, and wrap when even that row is too narrow (a phone). */
  @container (max-width: 1280px) {
    .quiet {
      order: 3;
      flex-basis: 100%;
      flex-wrap: wrap;
      row-gap: 0;
      justify-content: center;
    }

    .trail {
      margin-left: auto;
    }
  }

  @container (max-width: 620px) {
    .lead,
    .trail {
      flex-basis: 100%;
      justify-content: center;
      margin-left: 0;
    }
  }

  /* A column beside the mirror (a short window, App.svelte): one control a row, the four plates first
     and as wide as the column, then the quieter entries. Everything is drawn a little shorter than
     the 44 px target and the target reaches into the gap beside it (Section 10.6), so the whole column
     fits a phone held on its side. */
  @container (max-width: 320px) {
    .group,
    .lead,
    .trail {
      flex-direction: column;
      flex-basis: 100%;
      align-items: stretch;
      gap: 6px;
      margin-left: 0;
    }

    .quiet {
      align-items: flex-start;
      gap: 4px;
    }

    .bar-btn {
      justify-content: flex-start;
      min-height: 38px;
      padding: 5px 21px 5px 22px;
    }

    .quiet-btn {
      position: relative;
      justify-content: flex-start;
      min-height: 38px;
      padding: 4px 10px;
      line-height: 1.2;
      text-align: left;
    }

    .bar-btn::after,
    .quiet-btn::after {
      content: '';
      position: absolute;
      inset: -3px 0;
    }
  }
</style>
