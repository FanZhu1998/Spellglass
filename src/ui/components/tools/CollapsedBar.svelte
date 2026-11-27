<script lang="ts">
  // A drawer folded down to one bar along the bottom frame while a flow needs the mirror: watching a
  // replay, recording a clip, drawing a gesture, recording a session (Section 10.3: controls sit on the
  // frame and never cover the middle). The drawer behind it stays mounted, so nothing in it is lost.
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { focusOnMount } from '../../actions';
  import { motionMs } from '../../theme';

  let {
    label,
    children,
    actions,
    lead,
    tone = 'plain',
    wide = false,
  }: {
    /** Names the bar for assistive technology, e.g. "Drawing a gesture". */
    label: string;
    children: Snippet;
    actions?: Snippet;
    /** Shown in place of the seal, such as a small drawing of the gesture being traced. */
    lead?: Snippet;
    /** 'recording' adds a steady red seal, so a running recording is plain to see. */
    tone?: 'plain' | 'recording';
    /** Room for three buttons beside the text. */
    wide?: boolean;
  } = $props();

  /** The slide answers the fold; under reduced motion the bar simply appears (Section 10.6). */
  const slideMs = () => motionMs(200);
</script>

<div class="bar" class:wide data-tone={tone} role="region" aria-label={label} transition:fly={{ y: 24, duration: slideMs() }} use:focusOnMount>
  {#if lead}
    <div class="lead">{@render lead()}</div>
  {:else}
    <span class="seal" aria-hidden="true"></span>
  {/if}
  <div class="text">{@render children()}</div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .bar {
    position: fixed;
    left: 50%;
    bottom: max(12px, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 42;
    display: flex;
    align-items: center;
    gap: 14px;
    width: min(780px, calc(100vw - 24px));
    padding: 12px 14px 12px 18px;
    border-radius: 3px;
    /* A folded-down folio: opaque leather with its gilt rule, so the frame's own controls never show
       through its words. */
    background:
      linear-gradient(to bottom, rgb(255 230 180 / 0.05), transparent 60%),
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, var(--folio-2), var(--folio));
    background-blend-mode: normal, soft-light, normal;
    border: 1px solid #0b0806;
    outline: 1px solid color-mix(in srgb, var(--gilt) 50%, transparent);
    outline-offset: -6px;
    box-shadow: 0 14px 40px rgb(0 0 0 / 0.55), inset 0 1px 0 rgb(255 255 255 / 0.04);
  }

  .bar.wide {
    width: min(980px, calc(100vw - 24px));
  }

  .seal {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--candle);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--candle) 22%, transparent);
  }

  .bar[data-tone='recording'] .seal {
    background: #d9475a;
    box-shadow: 0 0 0 4px rgb(217 71 90 / 0.25);
  }

  .lead {
    flex: none;
    display: grid;
    place-items: center;
  }

  .text {
    flex: 1;
    min-width: 0;
    font-size: var(--text-body);
    line-height: 1.35;
  }

  .actions {
    flex: none;
    display: flex;
    gap: 8px;
  }

  @media (max-width: 640px) {
    .bar {
      flex-wrap: wrap;
    }
    .actions {
      width: 100%;
      justify-content: flex-end;
    }
  }

  /* Three buttons need a row of their own sooner. */
  @media (max-width: 860px) {
    .bar.wide {
      flex-wrap: wrap;
    }
    .bar.wide .text {
      flex-basis: calc(100% - 80px);
    }
    .bar.wide .actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
