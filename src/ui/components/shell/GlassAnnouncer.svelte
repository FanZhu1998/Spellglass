<script lang="ts">
  // The cast banner and a new tier's ribbon, said to a screen reader (Section 10.6). Both are drawn on
  // the glass, and the glass is in the room, which is inert while the Spellbook or an unfolded drawer
  // is open over it (AppState.roomInert). Casting goes on under them on a camera or voice route, so a
  // live region on the glass would fall silent just then. These two sit outside the room, beside the
  // toast and the captions, and are the only live regions for both: each result is said once, whatever
  // is open, and nothing is said again when a drawer opens or closes.
  import type { AppState } from '../../app-state.svelte';
  import { spokenBanner, spokenCelebration } from './spoken';

  let { app }: { app: AppState } = $props();

  // As the banner shows it: never on Practice, which says each attempt itself.
  const b = $derived(app.screen === 'practice' ? null : app.banner);
  const c = $derived(app.celebration);
</script>

<!-- A new element for each result, so the same words twice running are said twice. -->
<div class="visually-hidden" aria-live="polite" aria-atomic="true">
  {#key b?.id}{#if b}<p>{spokenBanner(b)}</p>{/if}{/key}
</div>
<div class="visually-hidden" role="status" aria-atomic="true">
  {#key c?.id}{#if c}<p>{spokenCelebration(c)}</p>{/if}{/key}
</div>
