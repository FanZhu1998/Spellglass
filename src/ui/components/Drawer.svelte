<script lang="ts">
  // A panel that slides in from an edge of the window and never covers the middle of the mirror
  // more than it must (Section 10.3). Escape and the scrim close it; focus moves in and back out, and
  // Tab goes round inside it, as a modal dialog's should (Section 10.6). The room behind it is made
  // inert by the shell (AppState.roomInert) while it is open and not folded.
  import type { Snippet } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { focusOnMount, onEscape, trapFocus } from '../actions';
  import { motionMs } from '../theme';

  let {
    title,
    side = 'right',
    width = 560,
    onclose,
    children,
    actions,
  }: {
    title: string;
    side?: 'left' | 'right';
    width?: number;
    onclose: () => void;
    children: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<!-- Under reduced motion the drawer simply appears (Section 10.6). -->
<div class="drawer-scrim" transition:fade={{ duration: motionMs(160) }} onclick={onclose} role="presentation"></div>
<div
  class="drawer {side}"
  style:width="min({width}px, 100vw)"
  role="dialog"
  aria-modal="true"
  aria-label={title}
  transition:fly={{ x: side === 'right' ? 60 : -60, duration: motionMs(240) }}
  use:focusOnMount
  use:trapFocus
  use:onEscape={onclose}
>
  <header class="drawer-head">
    <h2>{title}</h2>
    <div class="row">
      {#if actions}{@render actions()}{/if}
      <button class="btn btn-ghost btn-small" onclick={onclose}>Close</button>
    </div>
  </header>
  <div class="drawer-body">
    {@render children()}
  </div>
</div>
