<script lang="ts">
  // The session log (Section 10.4 Mirror): recent casts and fizzles written quietly in the glass's top
  // right corner, fading with age. Obliviate fades it away (app.logFading, then the list clears).
  // Hidden in narrow windows, where the side of the glass is the player's reflection. It keeps to the
  // top half of the glass, clear of the props on the shelf: the training dummy's head and wand, which
  // Stupefy and Expelliarmus land on, stand in the bottom half at the right.
  import type { AppState } from '../../app-state.svelte';

  let { app }: { app: AppState } = $props();

  const VISIBLE = 6;
  const entries = $derived(app.log.slice(0, VISIBLE));
</script>

{#if entries.length}
  <section class="session-log" class:fading={app.logFading} aria-label="Recent casts">
    <h2 class="label">This session</h2>
    <ol>
      {#each entries as e, i (e.id)}
        <li data-kind={e.kind} style:--age={i}>
          <span class="mark" aria-hidden="true">{e.kind === 'cast' ? '✦' : '◌'}</span>
          <span class="what">
            {#if e.kind === 'cast'}
              <span class="name">{e.name}</span>
              <span class="visually-hidden">cast,</span>
            {:else}
              <!-- A rule fizzle (no grade: a locked spell, a needed spell, a cooldown) was the right shape. -->
              <span class="name fizzled">{e.name ? (e.grade ? `Close to ${e.name}` : e.name) : 'Fizzled'}</span>
              <span class="visually-hidden">fizzled,</span>
            {/if}
            <span class="grade">{e.grade || 'Not cast'}{#if e.via === 'voice'}<span class="aside"> · by voice</span>{/if}{#if e.replay}<span class="aside"> · replay</span>{/if}{#if e.practice}<span class="aside"> · practice</span>{/if}</span>
          </span>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  /* Notes written in the glass's margin, as a reader writes in a book's top corner: a ruled margin
     line in gilt down their left, the entries in an italic hand, the newest first. The glass is
     darkened a little behind them so they read over a reflection. They hang from the glass's top
     edge, level with the notes and the cast banner (App.svelte keeps those clear of this corner), so a
     longer log grows down into empty glass, never onto the shelf. */
  .session-log {
    /* Each entry is two lines (the name, then its grade) and every entry the same height, so the list
       below shows whole entries only (the glass's height is App.svelte's --glass-h). */
    --entry-h: 45px;
    position: absolute;
    z-index: 2;
    top: calc(var(--pad) + 12px);
    right: calc(var(--pad) + 12px);
    width: var(--log-w, 224px);
    padding: 10px 14px 12px 20px;
    border-radius: 2px;
    background:
      linear-gradient(90deg, transparent 5px, rgb(201 163 86 / 0.55) 5px, rgb(201 163 86 / 0.55) 6px, transparent 6px, transparent 8px, rgb(201 163 86 / 0.3) 8px, rgb(201 163 86 / 0.3) 9px, transparent 9px) 0 0 / 100% 100% no-repeat,
      linear-gradient(to left, rgb(6 8 16 / 0.66), rgb(6 8 16 / 0.4) 70%, rgb(6 8 16 / 0.12));
    pointer-events: none;
    opacity: 1;
    transition: opacity calc(var(--duration) * 5) ease-in, filter calc(var(--duration) * 5) ease-in;
  }

  /* Obliviate: the log fades and blurs away like breath on glass. */
  .session-log.fading {
    opacity: 0;
    filter: blur(3px);
  }

  .label {
    margin: 0 0 7px;
    font-family: var(--font-label);
    font-size: 16px;
    line-height: 1.2;
    color: color-mix(in srgb, var(--gilt-text) 80%, var(--ash));
    letter-spacing: 0.08em;
    text-shadow: 0 1px 3px rgb(0 0 0 / 0.9);
  }

  /* As many whole entries as fit above the middle of the glass: the log's foot never passes half the
     glass's height (its top inset, its padding and its label take the 62 px). The rows repeat as far
     as that height allows and the newest fill them first; older entries flow into a second column,
     out of sight, so no entry is ever cut in half. A screen reader still hears every entry. */
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-rows: repeat(auto-fit, var(--entry-h));
    grid-auto-flow: column;
    grid-auto-columns: 100%;
    gap: 6px 40px;
    max-height: max(var(--entry-h), calc(var(--glass-h, 480px) / 2 - 62px));
    overflow: hidden;
  }

  li {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    align-items: baseline;
    height: var(--entry-h);
    opacity: calc(1 - var(--age) * 0.13);
    text-shadow: 0 1px 3px rgb(0 0 0 / 0.9);
    animation: log-in calc(var(--duration) * 1.4) var(--ease-out);
  }

  li:first-child {
    animation-delay: 0ms;
  }

  @keyframes log-in {
    from {
      opacity: 0;
      transform: translateX(8px);
    }
  }

  .mark {
    font-size: 14px;
    line-height: 1;
  }

  li[data-kind='cast'] .mark {
    color: var(--verdigris);
  }

  li[data-kind='fizzle'] .mark {
    color: var(--ash);
  }

  .what {
    display: grid;
    min-width: 0;
    line-height: 1.25;
  }

  /* The hand: italic, as if written quickly beside the glass. */
  .name {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 20px;
    color: var(--vellum);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name.fizzled {
    color: color-mix(in srgb, var(--vellum) 78%, var(--ash));
  }

  .grade {
    font-family: var(--font-label);
    font-size: 16px;
    letter-spacing: 0.04em;
    color: var(--ash);
  }

  li[data-kind='cast'] .grade {
    color: color-mix(in srgb, var(--candle) 85%, var(--vellum));
  }

  .aside {
    color: var(--ash);
  }

  /* Narrow mirrors: the side of the glass is the player's reflection. */
  @container (max-width: 980px) {
    .session-log {
      display: none;
    }
  }
</style>
