<script lang="ts">
  // The diagnostics overlay (Section 10.4 Workshop, Section 13): live numbers in a corner of the room
  // while 'diagnostics.overlay' is on (session-only), and the session being recorded, if any. The shell
  // mounts it once; it renders nothing while the setting is off. It sits in the top-left corner over the
  // frame, never the middle of the glass, below drawers (z-index 30 under their 40 and 41).
  import type { AppState } from '../../app-state.svelte';
  import DiagnosticsPanel from './DiagnosticsPanel.svelte';
  import { recording } from './workshop/recording.svelte';

  let { app }: { app: AppState } = $props();

  const recordingLine = $derived.by(() => {
    if (!recording.active) return undefined;
    const name = recording.intended ? app.spellName(recording.intended) : '';
    return name ? `Recording ${name}: ${recording.forSpell} of ${recording.total}` : `Recording: ${recording.total} strokes`;
  });
</script>

{#if app.settings['diagnostics.overlay']}
  <aside class="overlay" aria-label="Diagnostics">
    <header>
      <span class="title">Diagnostics</span>
      <button class="btn btn-ghost hide" type="button" onclick={() => app.set('diagnostics.overlay', false)}>Hide</button>
    </header>
    <DiagnosticsPanel {app} compact {recordingLine} />
  </aside>
{/if}

<style>
  .overlay {
    position: fixed;
    top: calc(var(--screen-light, 0px) + 64px);
    left: max(14px, 1.2vw);
    z-index: 30;
    width: 248px;
    max-height: calc(100vh - var(--screen-light, 0px) - 140px);
    overflow: auto;
    padding: 8px 12px 12px;
    border-radius: var(--radius);
    background: rgb(12 15 27 / 0.86);
    border: 1px solid color-mix(in srgb, var(--brass) 40%, var(--line-strong));
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
    backdrop-filter: blur(3px);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .title {
    font-family: var(--font-display);
    font-size: 20px;
    color: var(--vellum);
  }

  .hide {
    min-height: 44px;
    padding: 4px 12px;
  }
</style>
