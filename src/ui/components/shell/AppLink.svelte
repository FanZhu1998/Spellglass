<script lang="ts">
  // "A QR code on the Mirror screen hands the link to a phone or a friend" (Section 11.1). A small
  // button on the frame opens a card with the code, the address and a way to send it.
  import type { AppState } from '../../app-state.svelte';
  import { ask } from '../../../kernel';
  import { focusOnMount, onEscape } from '../../actions';
  import QrCode from '../QrCode.svelte';
  import Icon from './Icon.svelte';

  let { app, placement = 'up' }: { app: AppState; placement?: 'up' | 'down' } = $props();

  let open = $state(false);
  let sent = $state<'idle' | 'shared' | 'copied' | 'failed'>('idle');
  let root: HTMLElement | undefined = $state();

  // The Mirror shows this only when there is an address (the desktop app may have none).
  const url = $derived(app.appUrl);
  /** localhost and loopback addresses open nothing on a phone: say so. */
  const local = $derived.by(() => {
    try {
      const host = new URL(url).hostname;
      return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
    } catch {
      return false;
    }
  });

  function toggle() {
    open = !open;
    sent = 'idle';
  }

  // A click outside the card closes it.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });

  // So does the Spellbook or a drawer coming over the room (a keyboard can reach one with the card
  // still open): the card is drawn above everything, and would hang over it.
  $effect(() => {
    if (app.roomInert) open = false;
  });

  /** Where the browser can, the card is shown in the top layer, anchored to its button, so a bar that
   *  scrolls (the column beside a short window's mirror) never cuts it off; elsewhere it hangs from
   *  its button as an ordinary box. */
  const topLayer =
    typeof HTMLElement !== 'undefined' &&
    'showPopover' in HTMLElement.prototype &&
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('position-area', 'top');

  function showOnTop(node: HTMLElement): void {
    if (topLayer) node.showPopover();
  }

  function send() {
    // Straight from the click: the share sheet needs its user activation.
    ask(app.kernel, 'share.url', { url, title: 'Spellglass', text: 'Trace a spell in the air and watch the mirror answer.' }).then(
      (r) => (sent = r.outcome === 'shared' ? 'shared' : r.outcome === 'copied' ? 'copied' : 'idle'),
      () => (sent = 'failed'),
    );
  }
</script>

<div class="app-link" bind:this={root}>
  <button
    class="btn btn-ghost btn-icon qr-button"
    aria-expanded={open}
    aria-controls="app-link-card"
    aria-label="QR code for this app"
    title="QR code for this app"
    onclick={toggle}
  >
    <Icon name="qr" />
  </button>
  {#if open}
    <div
      id="app-link-card"
      class="card panel"
      data-placement={placement}
      role="dialog"
      aria-labelledby="app-link-title"
      popover={topLayer ? 'manual' : undefined}
      use:showOnTop
      use:focusOnMount
      use:onEscape={() => (open = false)}
    >
      <h2 id="app-link-title">Open on a phone</h2>
      <div class="code">
        <QrCode text={url} size={176} label="QR code for {url}" />
      </div>
      <p class="url">{url}</p>
      <p class="help">Scan it with a phone camera, or send the link to a friend.</p>
      {#if local}
        <p class="note"><span class="glyph" aria-hidden="true">!</span>This address only works on this computer. Use the app's public link to share it.</p>
      {/if}
      <div class="row">
        <button class="btn btn-small" onclick={send}>
          {sent === 'shared' ? 'Link sent' : sent === 'copied' ? 'Link copied' : 'Send the link'}
        </button>
        <button class="btn btn-small btn-ghost" onclick={() => (open = false)}>Close</button>
      </div>
      {#if sent === 'failed'}<p class="help" role="status">The link could not be sent. Copy the address above instead.</p>{/if}
    </div>
  {/if}
</div>

<style>
  .app-link {
    position: relative;
  }

  .qr-button {
    color: var(--ash);
    anchor-name: --app-link;
  }

  .qr-button:hover,
  .qr-button[aria-expanded='true'] {
    color: var(--vellum);
  }

  .card {
    position: absolute;
    z-index: 30;
    left: 50%;
    width: 300px;
    padding: 18px 20px 16px;
    transform: translateX(-50%);
    display: grid;
    justify-items: center;
    gap: 10px;
    text-align: center;
  }

  .card[data-placement='up'] {
    bottom: calc(100% + 12px);
  }

  .card[data-placement='down'] {
    top: calc(100% + 12px);
  }

  /* In the top layer: above its button and centred on it; where the window has no room above (a
     short window, its bar in a column at the side), beside the button instead, rising from its foot.
     Never taller than the window: the card scrolls inside. */
  .card[popover] {
    position: fixed;
    inset: auto;
    margin: 0 12px 12px;
    transform: none;
    position-anchor: --app-link;
    position-area: top;
    position-try-fallbacks: left span-top, bottom;
    /* Room for its margin beside the button, so the place beside it always fits. */
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
  }

  .card[popover][data-placement='down'] {
    margin: 12px 12px 0;
    position-area: bottom;
    position-try-fallbacks: left span-bottom, top;
  }

  h2 {
    margin: 0;
    font-size: 24px;
  }

  .code {
    padding: 8px;
    border-radius: 1px;
    background: var(--vellum);
    box-shadow: inset 0 0 0 1px rgb(43 33 24 / 0.2), 0 6px 20px rgb(0 0 0 / 0.35);
  }

  .url {
    margin: 0;
    font-size: var(--text-small);
    color: var(--candle);
    word-break: break-all;
    user-select: all;
  }

  .help {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .note {
    display: flex;
    gap: 8px;
    margin: 0;
    padding: 8px 10px;
    border-radius: 2px;
    border: 1px dashed color-mix(in srgb, var(--candle) 55%, transparent);
    font-size: var(--text-small);
    text-align: left;
    color: var(--vellum);
  }

  .glyph {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-top: 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--night);
    background: var(--candle);
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }
</style>
