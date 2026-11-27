<script lang="ts">
  // Keepsakes (Section 10.4, 11.1): recent casts as replays, cards and clips to share, and the app's
  // own link. Nothing leaves the device unless the player shares it; clips leave the camera out unless
  // "Include my camera" is ticked (Section 11.2).
  //
  // User activation: navigator.share needs the click that asked for it, so the replay link and the card
  // are made when a cast is opened, before any button needs them, and 'share.url' / 'share.file' are
  // called straight from the click.
  import { tick, untrack } from 'svelte';
  import type { ClipState, Keepsake, ShareResult } from '../../contracts';
  import { ask, on } from '../../kernel';
  import { focusIfLost } from '../actions';
  import type { AppState } from '../app-state.svelte';
  import Drawer from '../components/Drawer.svelte';
  import QrCode from '../components/QrCode.svelte';
  import StrokePath from '../components/StrokePath.svelte';
  import CollapsedBar from '../components/tools/CollapsedBar.svelte';
  import StatusLine, { type StatusKind } from '../components/tools/StatusLine.svelte';
  import { errorCode, errorText, formatBytes, timeAgo } from '../components/tools/format';
  import { reveal } from '../components/tools/workshop/keys';

  let { app }: { app: AppState } = $props();

  const LIST_LIMIT = 40;
  /** Where Spellglass is on the web: '' in the desktop app built without one, which then makes no
   *  replay links and shows no QR code (an app:// address opens nowhere else). */
  const appUrl = $derived(app.appUrl);
  const NO_LINKS = 'This copy of Spellglass has no web address for replay links. Save a card or record a clip to share this cast.';

  // ------------------------------------------------------------------ the list
  let items = $state.raw<Keepsake[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let openId = $state<string | null>(null);
  let now = $state(Date.now());
  let announcement = $state('');
  /** The newest cast opens by itself the first time, so its card is ready before anyone asks. */
  let firstLoad = true;

  function announce(text: string): void {
    // Clear first, so the same sentence twice is read twice.
    announcement = '';
    queueMicrotask(() => (announcement = text));
  }

  async function refresh(): Promise<void> {
    try {
      const list = await ask(app.kernel, 'keepsakes.list', { limit: LIST_LIMIT });
      items = [...list].sort((a, b) => b.savedAt - a.savedAt);
      loadError = null;
      if (openId && !items.some((k) => k.id === openId)) openId = null;
      if (openId === null && items.length && firstLoad) openId = items[0].id;
    } catch (err) {
      loadError = errorText(err, 'Your keepsakes could not be read.');
    } finally {
      loading = false;
      firstLoad = false;
    }
  }

  $effect(() => {
    untrack(() => void refresh());
    const k = app.kernel;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 500);
    };
    const offCast = on(k, 'spell.cast', (c) => {
      if (!c.replay) soon();
    });
    const offStore = on(k, 'storage.changed', (c) => {
      if (c.stores.includes('keepsakes')) soon();
    });
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      offCast();
      offStore();
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    };
  });

  // ------------------------------------------------------------------ what each opened cast needs
  interface Prepared {
    link?: string;
    linkError?: string;
    card?: { blob: Blob; filename: string };
    cardUrl?: string;
    cardError?: string;
  }
  let prepared = $state.raw<Record<string, Prepared>>({});
  const urls: string[] = [];

  function patch(id: string, p: Partial<Prepared>): void {
    prepared = { ...prepared, [id]: { ...prepared[id], ...p } };
  }

  async function prepare(id: string): Promise<void> {
    if (prepared[id]) return;
    patch(id, {});
    const link = appUrl
      ? ask(app.kernel, 'share.link', { castId: id }).then(
          (r) => patch(id, { link: r.url }),
          (err) => patch(id, { linkError: errorText(err, 'The replay link could not be made.') }),
        )
      : Promise.resolve();
    const card = ask(app.kernel, 'share.card', { castId: id }).then(
      (r) => {
        const url = URL.createObjectURL(r.blob);
        urls.push(url);
        patch(id, { card: r, cardUrl: url });
      },
      (err) => patch(id, { cardError: errorText(err, 'The card could not be drawn.') }),
    );
    await Promise.allSettled([link, card]);
  }

  $effect(() => {
    const id = openId;
    if (id) untrack(() => void prepare(id));
  });

  $effect(() => () => {
    for (const u of urls) URL.revokeObjectURL(u);
  });

  // ------------------------------------------------------------------ per-cast results
  type Outcome = { kind: StatusKind; text: string };
  let shareState = $state<Record<string, { button: string; note?: Outcome }>>({});
  let cardState = $state<Record<string, { button: string; note?: Outcome }>>({});
  let confirmDelete = $state<string | null>(null);
  let itemNote = $state<Record<string, Outcome | undefined>>({});
  let drawerEl = $state<HTMLElement | null>(null);

  function nameOf(k: Keepsake): string {
    return k.cast.variant || k.spellName || app.spellName(k.cast.spellId);
  }

  function entryOf(k: Keepsake) {
    return app.entry(k.cast.spellId);
  }

  /** Why this cast cannot be replayed here, if it cannot (its pack is off or missing). */
  function blockedReason(k: Keepsake): string | null {
    const e = entryOf(k);
    if (!app.spellbook) return null;
    if (!e) return 'This cast uses a spell that is not in your spellbook here, so it cannot be replayed.';
    if (!e.available) return `This cast uses ${e.spell.incantation}, from ${e.packTitle}, a pack that is turned off here. Turn it on in the Workshop to watch it again.`;
    return null;
  }

  function shareText(k: Keepsake): { title: string; text: string } {
    const grade = app.grade(k.cast.quality, 'cast');
    return { title: `${nameOf(k)} · Spellglass`, text: `${nameOf(k)}, ${grade}. Watch the cast in Spellglass.` };
  }

  function linkOutcome(id: string, r: ShareResult, link: string): void {
    if (r.outcome === 'shared') {
      shareState = { ...shareState, [id]: { button: 'Cast shared', note: { kind: 'ok', text: 'Cast shared.' } } };
      announce('Cast shared.');
    } else if (r.outcome === 'copied') {
      shareState = { ...shareState, [id]: { button: 'Link copied', note: { kind: 'ok', text: 'Link copied. Paste it anywhere to share the cast.' } } };
      announce('Link copied.');
    } else {
      shareState = { ...shareState, [id]: { button: 'Share this cast', note: { kind: 'info', text: `Not shared. You can copy the link by hand: ${link}` } } };
    }
  }

  function shareCast(k: Keepsake): void {
    const link = prepared[k.id]?.link;
    const words = shareText(k);
    if (link) {
      // Straight from the click: no await before the request.
      ask(app.kernel, 'share.url', { url: link, ...words }).then(
        (r) => linkOutcome(k.id, r, link),
        (err) => (shareState = { ...shareState, [k.id]: { button: 'Share this cast', note: { kind: 'error', text: errorText(err) } } }),
      );
      return;
    }
    // The link was not ready yet: make it, then share (the browser may then copy instead).
    ask(app.kernel, 'share.link', { castId: k.id })
      .then(async (r) => {
        patch(k.id, { link: r.url });
        linkOutcome(k.id, await ask(app.kernel, 'share.url', { url: r.url, ...words }), r.url);
      })
      .catch((err) => (shareState = { ...shareState, [k.id]: { button: 'Share this cast', note: { kind: 'error', text: errorText(err) } } }));
  }

  function saveCard(k: Keepsake): void {
    const card = prepared[k.id]?.card;
    if (!card) return;
    ask(app.kernel, 'share.file', { blob: card.blob, filename: card.filename, title: shareText(k).title }).then(
      (r) => {
        if (r.outcome === 'cancelled') return;
        const button = r.outcome === 'shared' ? 'Card shared' : 'Card saved';
        const text = r.outcome === 'shared' ? 'Card shared.' : `Card saved to your downloads as ${card.filename}.`;
        cardState = { ...cardState, [k.id]: { button, note: { kind: 'ok', text } } };
        announce(text);
      },
      (err) => (cardState = { ...cardState, [k.id]: { button: 'Save a card', note: { kind: 'error', text: errorText(err) } } }),
    );
  }

  // Answering the confirmation removes the button that had focus, which would leave a keyboard player
  // nowhere (access, Section 10.6). "Keep it" goes back to Delete, as a pack's "Keep it" does; a deleted
  // cast hands focus to the next cast in the list, or the one before it, or the drawer's title once the
  // list is empty.
  function keep(k: Keepsake): void {
    confirmDelete = null;
    void tick().then(() => focusIfLost(document.getElementById(`keepsake-${k.id}-delete`)));
  }

  async function remove(k: Keepsake): Promise<void> {
    confirmDelete = null;
    const at = items.findIndex((x) => x.id === k.id);
    const next = items[at + 1] ?? items[at - 1] ?? null;
    try {
      await ask(app.kernel, 'keepsakes.delete', { id: k.id });
      announce(`${nameOf(k)} deleted.`);
      items = items.filter((x) => x.id !== k.id);
      if (openId === k.id) openId = null;
      await tick();
      const title = drawerEl?.querySelector<HTMLElement>('h2');
      if (title && !title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      focusIfLost((next && document.getElementById(`keepsake-${next.id}-button`)) || title);
    } catch (err) {
      itemNote = { ...itemNote, [k.id]: { kind: 'error', text: errorText(err, 'That cast could not be deleted.') } };
      await tick();
      focusIfLost(document.getElementById(`keepsake-${k.id}-delete`));
    }
  }

  // ------------------------------------------------------------------ flows that need the mirror
  type Flow =
    | { kind: 'watch'; castId: string; name: string }
    | { kind: 'clip'; castId: string; name: string };
  let flow = $state<Flow | null>(null);
  let returnFocus: HTMLElement | null = null;

  interface Clip {
    castId: string;
    name: string;
    phase: 'starting' | 'recording' | 'finishing' | 'ready' | 'error';
    elapsedMs: number;
    result?: { blob: Blob; filename: string; mime: string };
    error?: string;
    shared?: string;
  }
  let clip = $state.raw<Clip | null>(null);

  // Folded, the drawer gives the room back: the replay or the clip plays in the mirror, which then
  // takes input again (AppState.roomInert).
  $effect(() => {
    if (flow !== null) app.foldedDrawer = 'keepsakes';
    return () => {
      if (app.foldedDrawer === 'keepsakes') app.foldedDrawer = null;
    };
  });

  function fold(next: Flow, from: EventTarget | null): void {
    returnFocus = from instanceof HTMLElement ? from : null;
    flow = next;
  }

  function unfold(): void {
    flow = null;
    const el = returnFocus;
    returnFocus = null;
    // After the drawer is interactive again.
    setTimeout(() => el?.focus({ preventScroll: true }), 30);
  }

  async function watch(k: Keepsake, e: MouseEvent): Promise<void> {
    itemNote = { ...itemNote, [k.id]: undefined };
    fold({ kind: 'watch', castId: k.id, name: nameOf(k) }, e.currentTarget);
    try {
      await ask(app.kernel, 'share.replay', { castId: k.id });
    } catch (err) {
      const blocked = errorCode(err) === 'not-supported' ? blockedReason(k) : null;
      itemNote = { ...itemNote, [k.id]: { kind: 'error', text: blocked ?? errorText(err, 'The replay could not play.') } };
      announce(blocked ?? errorText(err, 'The replay could not play.'));
    } finally {
      if (flow?.kind === 'watch' && flow.castId === k.id) unfold();
    }
  }

  async function recordClip(k: Keepsake, e: MouseEvent): Promise<void> {
    if (clip && (clip.phase === 'starting' || clip.phase === 'recording' || clip.phase === 'finishing')) return;
    const name = nameOf(k);
    clip = { castId: k.id, name, phase: 'starting', elapsedMs: 0 };
    fold({ kind: 'clip', castId: k.id, name }, e.currentTarget);
    try {
      await ask(app.kernel, 'share.clip.start', { castId: k.id, includeCamera: app.settings['share.includeCamera'] === true });
      if (clip?.castId === k.id && clip.phase === 'starting') clip = { ...clip, phase: 'recording' };
    } catch (err) {
      const blocked = errorCode(err) === 'not-supported' ? blockedReason(k) : null;
      clip = { castId: k.id, name, phase: 'error', elapsedMs: 0, error: blocked ?? errorText(err, 'The clip could not be recorded.') };
      announce(clip.error ?? '');
      unfold();
    }
  }

  async function finishClip(): Promise<void> {
    const c = clip;
    if (!c || c.phase === 'finishing' || c.phase === 'ready' || c.phase === 'error') return;
    clip = { ...c, phase: 'finishing' };
    try {
      const result = await ask(app.kernel, 'share.clip.stop');
      clip = { ...c, phase: 'ready', result };
      announce(`The clip of ${c.name} is ready to share.`);
    } catch (err) {
      clip = { ...c, phase: 'error', error: errorText(err, 'The clip could not be recorded.') };
      announce(clip.error ?? '');
    } finally {
      if (flow?.kind === 'clip') unfold();
    }
  }

  // Follow the recorder: elapsed time, and its own stop when the replay is over.
  $effect(() =>
    on(app.kernel, 'share.clip.state', (s: ClipState) => {
      const c = clip;
      if (!c || (s.castId && s.castId !== c.castId)) return;
      if (s.state === 'recording') {
        if (c.phase === 'starting' || c.phase === 'recording') clip = { ...c, phase: 'recording', elapsedMs: s.elapsedMs };
      } else if (c.phase === 'starting' || c.phase === 'recording') {
        void finishClip();
      }
    }),
  );

  function shareClip(): void {
    const c = clip;
    if (!c?.result) return;
    ask(app.kernel, 'share.file', { blob: c.result.blob, filename: c.result.filename, title: `${c.name} · Spellglass` }).then(
      (r) => {
        if (r.outcome === 'cancelled' || clip !== c) return;
        const shared = r.outcome === 'shared' ? 'Clip shared' : 'Clip saved';
        clip = { ...c, shared };
        announce(r.outcome === 'shared' ? 'Clip shared.' : `Clip saved to your downloads as ${c.result!.filename}.`);
      },
      (err) => {
        if (clip === c) clip = { ...c, error: errorText(err) };
      },
    );
  }

  function close(): void {
    if (flow?.kind === 'clip') {
      void finishClip();
      return;
    }
    if (flow?.kind === 'watch') {
      unfold();
      return;
    }
    app.go('mirror');
  }

  // ------------------------------------------------------------------ the app's own link
  let appShare = $state<{ button: string; note?: Outcome }>({ button: 'Share Spellglass' });
  function shareApp(): void {
    ask(app.kernel, 'share.url', { url: appUrl, title: 'Spellglass', text: 'Trace a spell in the air with your wand and watch the mirror answer.' }).then(
      (r) => {
        if (r.outcome === 'shared') appShare = { button: 'Spellglass shared', note: { kind: 'ok', text: 'Link shared.' } };
        else if (r.outcome === 'copied') appShare = { button: 'Link copied', note: { kind: 'ok', text: 'Link copied. Paste it anywhere to share Spellglass.' } };
        else appShare = { button: 'Share Spellglass', note: { kind: 'info', text: 'Not shared. The link is above to copy by hand.' } };
        if (appShare.note) announce(appShare.note.text);
      },
      (err) => (appShare = { button: 'Share Spellglass', note: { kind: 'error', text: errorText(err) } }),
    );
  }

  function setIncludeCamera(on: boolean): void {
    void app.set('share.includeCamera', on);
  }

  const seconds = (ms: number) => `${Math.max(0, Math.floor(ms / 1000))} s`;
</script>

<div class="tool-drawer" class:folded={flow !== null} inert={flow !== null} bind:this={drawerEl}>
  <Drawer title="Keepsakes" width={620} onclose={close}>
    <div class="keepsakes">
      <p class="privacy">
        Your casts stay on this device. Nothing leaves it unless you share it, and clips leave your camera out unless you tick
        <em>Include my camera</em>.
      </p>

      {#if loading}
        <StatusLine kind="busy" text="Opening your keepsakes…" />
      {:else if loadError}
        <StatusLine kind="error" text={loadError} />
      {:else if items.length === 0}
        <div class="empty">
          <svg viewBox="0 0 120 60" width="120" height="60" aria-hidden="true">
            <path d="M10 46 C 30 6, 52 6, 60 30 S 92 56, 110 14" />
            <circle cx="10" cy="46" r="4" />
          </svg>
          <p>Cast a spell and it will appear here.</p>
        </div>
      {:else}
        <ol class="list">
          {#each items as k (k.id)}
            {@const open = openId === k.id}
            {@const p = prepared[k.id]}
            {@const blocked = blockedReason(k)}
            {@const name = nameOf(k)}
            <li class="keepsake" class:open>
              <button class="summary" type="button" id="keepsake-{k.id}-button" aria-expanded={open} aria-controls="keepsake-{k.id}" onclick={() => (openId = open ? null : k.id)}>
                <span class="thumb">
                  {#if k.points.length > 1}
                    <StrokePath points={k.points} aspect={k.aspect} size={60} tone="light" label="The stroke of this cast" />
                  {:else}
                    <span class="spoken" aria-label="Cast by voice">“ ”</span>
                  {/if}
                </span>
                <span class="who">
                  <span class="name">{name}</span>
                  <span class="meta">
                    {app.grade(k.cast.quality, 'cast')}
                    <span aria-hidden="true">·</span>
                    {timeAgo(k.savedAt, now)}
                    {#if k.cast.via === 'voice'}<span aria-hidden="true">·</span> by voice{/if}
                  </span>
                </span>
                <span class="chevron" aria-hidden="true"></span>
              </button>

              {#if open}
                <div class="details" id="keepsake-{k.id}">
                  <div class="card-preview">
                    {#if p?.cardUrl}
                      <img src={p.cardUrl} alt="Keepsake card for {name}: the stroke, the spell and its grade." width="1200" height="630" />
                    {:else if p?.cardError}
                      <p class="muted">{p.cardError}</p>
                    {:else}
                      <p class="muted">Drawing the card…</p>
                    {/if}
                  </div>

                  {#if blocked}<StatusLine kind="warn" text={blocked} />{/if}

                  <div class="actions">
                    {#if appUrl}
                      <button class="btn btn-seal" type="button" onclick={() => shareCast(k)} disabled={!!p?.linkError}>
                        {shareState[k.id]?.button ?? 'Share this cast'}
                      </button>
                    {/if}
                    <button class="btn" type="button" onclick={(e) => watch(k, e)} disabled={!!blocked || flow !== null}>Watch again</button>
                    <button class="btn" type="button" onclick={() => saveCard(k)} disabled={!p?.card}>
                      {cardState[k.id]?.button ?? 'Save a card'}
                    </button>
                  </div>
                  {#if !appUrl}<StatusLine kind="info" text={NO_LINKS} />{/if}
                  {#if p?.linkError}<StatusLine kind="error" text={p.linkError} />{/if}
                  {#if shareState[k.id]?.note}<StatusLine kind={shareState[k.id].note!.kind} text={shareState[k.id].note!.text} />{/if}
                  {#if cardState[k.id]?.note}<StatusLine kind={cardState[k.id].note!.kind} text={cardState[k.id].note!.text} />{/if}

                  <div class="clip">
                    <div class="clip-row">
                      <button
                        class="btn"
                        type="button"
                        onclick={(e) => recordClip(k, e)}
                        disabled={!!blocked || flow !== null || (clip !== null && ['starting', 'recording', 'finishing'].includes(clip.phase))}
                      >
                        Record a clip
                      </button>
                      <label class="check">
                        <input type="checkbox" class="tick" checked={app.settings['share.includeCamera'] === true} onchange={(e) => setIncludeCamera(e.currentTarget.checked)} />
                        <span>Include my camera</span>
                      </label>
                    </div>
                    <p class="help">A clip replays this cast for up to ten seconds: the trace, the effect and its sound.</p>
                    {#if clip && clip.castId === k.id}
                      {#if clip.phase === 'ready' && clip.result}
                        <div class="clip-ready">
                          <StatusLine kind="ok" text="Clip ready: {clip.result.filename}, {formatBytes(clip.result.blob.size)}." />
                          <button class="btn btn-seal" type="button" onclick={shareClip}>{clip.shared ?? 'Share the clip'}</button>
                        </div>
                      {:else if clip.phase === 'error' && clip.error}
                        <StatusLine kind="error" text={clip.error} />
                      {:else if clip.phase === 'finishing'}
                        <StatusLine kind="busy" text="Finishing the clip…" />
                      {/if}
                    {/if}
                  </div>

                  {#if itemNote[k.id]}<StatusLine kind={itemNote[k.id]!.kind} text={itemNote[k.id]!.text} />{/if}

                  <div class="delete">
                    {#if confirmDelete === k.id}
                      <!-- reveal puts focus on "Keep it", so Enter never deletes by accident. -->
                      <div class="confirm" role="group" aria-labelledby="keepsake-{k.id}-confirm" use:reveal>
                        <span class="confirm-text" id="keepsake-{k.id}-confirm">Delete this cast from your keepsakes?</span>
                        <button class="btn btn-danger" type="button" onclick={() => remove(k)}>Delete</button>
                        <button class="btn btn-ghost" type="button" onclick={() => keep(k)} data-safe>Keep it</button>
                      </div>
                    {:else}
                      <button class="btn btn-ghost" type="button" id="keepsake-{k.id}-delete" onclick={() => (confirmDelete = k.id)}>Delete</button>
                    {/if}
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      {#if appUrl}
        <section class="app-link" aria-labelledby="app-link-title">
          <div class="qr"><QrCode text={appUrl} size={132} label="QR code for the Spellglass link" /></div>
          <div class="app-link-text">
            <h3 id="app-link-title">Share Spellglass</h3>
            <p class="help">Hand the app to a phone or a friend: scan the code, or send the link.</p>
            <p class="url">{appUrl}</p>
            <button class="btn" type="button" onclick={shareApp}>{appShare.button}</button>
            {#if appShare.note}<StatusLine kind={appShare.note.kind} text={appShare.note.text} compact />{/if}
          </div>
        </section>
      {/if}
    </div>
  </Drawer>
</div>

{#if flow?.kind === 'watch'}
  <CollapsedBar label="Watching a replay">
    <strong>{flow.name}</strong>, replaying in the mirror.
    {#snippet actions()}
      <button class="btn" type="button" onclick={unfold}>Back to keepsakes</button>
    {/snippet}
  </CollapsedBar>
{:else if flow?.kind === 'clip'}
  <CollapsedBar label="Recording a clip" tone="recording">
    {#if clip?.phase === 'starting'}
      Getting ready to record <strong>{flow.name}</strong>…
    {:else if clip?.phase === 'finishing'}
      Finishing the clip of <strong>{flow.name}</strong>…
    {:else}
      Recording a clip of <strong>{flow.name}</strong> · {seconds(clip?.elapsedMs ?? 0)}
      <span class="bar-note">{app.settings['share.includeCamera'] ? 'with your camera' : 'without your camera'}</span>
    {/if}
    {#snippet actions()}
      <button class="btn" type="button" onclick={finishClip} disabled={clip?.phase !== 'recording'}>Stop</button>
    {/snippet}
  </CollapsedBar>
{/if}

<p class="visually-hidden" aria-live="polite">{announcement}</p>

<style>
  /* While a flow needs the mirror the drawer slides away but stays mounted, keeping its state. */
  .tool-drawer :global(.drawer) {
    transition: transform var(--duration) var(--ease-out);
  }

  .tool-drawer.folded :global(.drawer) {
    transform: translateX(105%);
  }

  .tool-drawer.folded :global(.drawer-scrim) {
    opacity: 0;
    pointer-events: none;
  }

  .keepsakes {
    display: grid;
    gap: 18px;
  }

  /* A note tucked into the folio, ruled down its edge in verdigris. */
  .privacy {
    margin: 0;
    padding: 12px 16px 12px 18px;
    border-radius: 2px;
    border-left: 3px double color-mix(in srgb, var(--verdigris) 75%, transparent);
    background: var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .privacy em {
    font-style: italic;
    color: var(--candle);
  }

  .empty {
    display: grid;
    justify-items: center;
    gap: 10px;
    padding: 34px 16px 30px;
    border-radius: 3px;
    border: 1px dashed color-mix(in srgb, var(--gilt) 40%, transparent);
    background: var(--inlay-bg);
    text-align: center;
  }

  .empty svg {
    fill: none;
    stroke: color-mix(in srgb, var(--candle) 70%, transparent);
    stroke-width: 2.4;
    stroke-linecap: round;
  }

  .empty svg circle {
    fill: var(--vellum);
    stroke: none;
  }

  .empty p {
    margin: 0;
    font-family: var(--font-display);
    font-size: 22px;
    font-style: italic;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }

  /* Each keepsake is a panel let into the folio; the open one has its rim gilded. */
  .keepsake {
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid var(--inlay-edge);
    background: var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
    overflow: hidden;
  }

  .keepsake.open {
    border-color: color-mix(in srgb, var(--gilt) 60%, transparent);
    background: var(--inlay-chosen-bg);
  }

  .summary {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr) 24px;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 76px;
    padding: 8px 14px 8px 8px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius);
  }

  .summary:hover {
    background: radial-gradient(80% 120% at 30% 50%, rgb(242 184 75 / 0.08), transparent 80%);
  }

  /* The cast's stroke in a little mirror of its own, silvered as the big one is (tokens.css), in a
     gilt frame. */
  .thumb {
    display: grid;
    place-items: center;
    width: 64px;
    height: 60px;
    border-radius: 2px;
    background: var(--glass-sheen), var(--glass);
    box-shadow:
      inset 0 0 0 1px rgb(0 0 0 / 0.8),
      inset 0 0 10px 1px rgb(4 3 6 / 0.6),
      0 0 0 2px #b8944c,
      0 0 0 3px #4a3514,
      0 0 0 4px rgb(201 163 86 / 0.45),
      2px 3px 6px 3px rgb(0 0 0 / 0.4);
  }

  .spoken {
    font-family: var(--font-display);
    font-size: 26px;
    color: var(--candle);
  }

  .who {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .name {
    font-family: var(--font-display);
    font-size: 24px;
    line-height: 1.15;
    color: var(--vellum);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    font-size: var(--text-small);
    color: var(--ash);
  }

  .chevron {
    width: 10px;
    height: 10px;
    justify-self: center;
    border-right: 2px solid var(--ash);
    border-bottom: 2px solid var(--ash);
    transform: rotate(45deg) translate(-2px, -2px);
    transition: transform var(--duration) var(--ease-out);
  }

  .open .chevron {
    transform: rotate(-135deg) translate(-2px, -2px);
  }

  .details {
    display: grid;
    gap: 14px;
    padding: 4px 16px 16px;
  }

  /* The share card, mounted as a print is: a mat of dark leather with a tooled gilt rule round its
     edge, the card set into it behind a gilt fillet, the whole resting on the folio. */
  .card-preview {
    position: relative;
    display: grid;
    place-items: center;
    padding: 12px;
    border-radius: 2px;
    background:
      radial-gradient(90% 120% at 18% 0%, rgb(255 214 150 / 0.07), transparent 70%),
      var(--tex-leather) 0 0 / 200px,
      linear-gradient(180deg, #2c221c, #1a1411);
    background-blend-mode: normal, soft-light, normal;
    border: 1px solid #0b0806;
    outline: 1px solid color-mix(in srgb, var(--gilt) 45%, transparent);
    outline-offset: -5px;
    box-shadow: inset 0 1px 0 rgb(255 230 180 / 0.06), 0 10px 26px rgb(0 0 0 / 0.45);
  }

  /* The card's own shape keeps the mat from jumping when the drawing arrives. */
  .card-preview > * {
    aspect-ratio: 1200 / 630;
    width: 100%;
  }

  .card-preview img {
    display: block;
    height: auto;
    box-shadow: 0 0 0 1px #3e2c12, 0 0 0 3px #c9a356, 0 0 0 4px #3e2c12, 1px 3px 8px 4px rgb(0 0 0 / 0.5);
  }

  .card-preview p {
    display: grid;
    place-items: center;
    margin: 0;
    font-size: var(--text-small);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .clip {
    display: grid;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--gilt) 24%, transparent);
  }

  .clip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 18px;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    font-size: var(--text-small);
    cursor: pointer;
  }

  .clip-ready {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .clip-ready :global(.status) {
    flex: 1 1 260px;
  }

  .help {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .delete,
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm {
    flex: 1;
  }

  .confirm-text {
    margin-right: auto;
    font-size: var(--text-small);
  }

  .btn-danger {
    border-color: color-mix(in srgb, #e8828c 60%, transparent);
    color: #f3c2c7;
  }

  .app-link {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 18px;
    align-items: center;
    margin-top: 6px;
    padding: 18px;
    border-radius: 4px;
    corner-shape: bevel;
    border: 1px solid color-mix(in srgb, var(--gilt) 45%, transparent);
    background:
      radial-gradient(120% 140% at 0% 0%, rgb(242 184 75 / 0.07), transparent 60%),
      var(--inlay-bg);
    box-shadow: var(--inlay-shadow);
  }

  .qr {
    padding: 6px;
    border-radius: 1px;
    background: var(--vellum);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brass) 60%, transparent);
  }

  .app-link-text {
    display: grid;
    gap: 8px;
    justify-items: start;
    min-width: 0;
  }

  .app-link h3 {
    margin: 0;
    font-size: 23px;
  }

  .url {
    margin: 0;
    max-width: 100%;
    font-size: var(--text-small);
    color: var(--candle);
    overflow-wrap: anywhere;
    user-select: all;
  }

  .bar-note {
    margin-left: 8px;
    font-size: var(--text-small);
    color: var(--ash);
  }

  @media (max-width: 520px) {
    .app-link {
      grid-template-columns: minmax(0, 1fr);
      justify-items: start;
    }
  }
</style>
