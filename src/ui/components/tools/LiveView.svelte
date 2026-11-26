<script lang="ts">
  // What the tracker sees (Wand tuning, Section 10.4). Each 'tracker.debug' image is copied onto a
  // canvas inside the event handler: the bitmap stays valid only until the next one, and it is never
  // closed here. Candidate blobs, the chosen tip, hand landmarks and a short trail of the tip are drawn
  // over it. Frames and samples never enter $state; only coarse facts do, a few times a second.
  //
  // The play area (setting 'playArea', caster space) is a box over the view: drag it, drag a corner, or
  // use the size slider. It is committed on pointerup (or slider release) only.
  import { untrack } from 'svelte';
  import type { PlayArea, TrackerDebugFrame } from '../../../contracts';
  import { on } from '../../../kernel';
  import type { AppState } from '../../app-state.svelte';
  import { TEXT } from '../shell/routes';

  let { app }: { app: AppState } = $props();

  /** MediaPipe's hand topology: 21 landmarks, wrist first. */
  const HAND_LINKS: readonly [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  const MIN_SIDE = 0.2;
  const TRAIL_MS = 900;
  const STALE_MS = 1600;

  const trackerId = $derived(app.tracker?.tracker ?? app.settings['tracker.active']);
  const isBrightTip = $derived(trackerId === 'tracker.bright-tip');
  const isHand = $derived(trackerId === 'tracker.hand');
  /** The hand tracker in wand mode: it finds the wand in the hand, and draws it. */
  const isWand = $derived(isHand && app.settings['hand.mode'] === 'wand');
  const isCamera = $derived(isBrightTip || isHand);

  let glass = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();

  // ------------------------------------------------------------------ coarse, reactive facts
  let imageAspect = $state<number | null>(null);
  let framesSeen = $state(false);
  let stale = $state(false);
  let tipPx = $state<number | null>(null);
  let candidates = $state(0);

  const aspect = $derived.by(() => {
    if (imageAspect) return imageAspect;
    const c = app.cameraReady;
    if (c && c.width > 0 && c.height > 0) return c.width / c.height;
    return app.tracker?.aspect && app.tracker.aspect > 0 ? app.tracker.aspect : 16 / 9;
  });

  // ------------------------------------------------------------------ plain drawing state
  let copy: HTMLCanvasElement | null = null;
  let haveImage = false;
  let latest: { tracker: string; blobs: TrackerDebugFrame['blobs']; landmarks?: [number, number][]; wand?: TrackerDebugFrame['wand'] } | null = null;
  let lastFrameAt = 0;
  let lastReadoutAt = 0;
  let trail: { x: number; y: number; t: number }[] = [];
  let palette = { candle: '#F2B84B', vellum: '#E9DFC7', ash: '#9A9DB0', night: '#0F1424' };

  function readPalette(): void {
    if (!glass) return;
    const cs = getComputedStyle(glass);
    const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    palette = { candle: pick('--candle', palette.candle), vellum: pick('--vellum', palette.vellum), ash: pick('--ash', palette.ash), night: pick('--night', palette.night) };
  }

  function onDebug(d: TrackerDebugFrame): void {
    if (d.image) {
      // Copy now: the bitmap is only valid until the next frame (contracts/events.ts).
      const w = d.image.width || d.width;
      const h = d.image.height || d.height;
      if (w > 0 && h > 0) {
        copy ??= document.createElement('canvas');
        if (copy.width !== w || copy.height !== h) {
          copy.width = w;
          copy.height = h;
        }
        const cctx = copy.getContext('2d');
        if (cctx) {
          cctx.drawImage(d.image, 0, 0, w, h);
          haveImage = true;
        }
        const a = w / h;
        if (!imageAspect || Math.abs(imageAspect - a) > 0.01) imageAspect = a;
      }
    }
    latest = { tracker: d.tracker, blobs: Array.isArray(d.blobs) ? d.blobs : [], landmarks: d.landmarks, wand: d.wand };
    lastFrameAt = performance.now();
    paint();

    // Readouts a few times a second, not per frame.
    if (lastFrameAt - lastReadoutAt > 250) {
      lastReadoutAt = lastFrameAt;
      if (!framesSeen) framesSeen = true;
      if (stale) stale = false;
      const chosen = latest.blobs.find((b) => b.chosen);
      const camW = app.cameraReady?.width ?? 0;
      const px = chosen && camW > 0 ? Math.round(chosen.r * 2 * camW) : null;
      if (px !== tipPx) tipPx = px;
      const n = latest.blobs.filter((b) => !b.chosen).length;
      if (n !== candidates) candidates = n;
    }
  }

  function clearView(): void {
    haveImage = false;
    latest = null;
    trail = [];
    imageAspect = null;
    framesSeen = false;
    tipPx = null;
    candidates = 0;
    paint();
  }

  function paint(): void {
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (W === 0 || H === 0) return;
    const dpr = W / Math.max(1, c.clientWidth || W);
    if (copy && haveImage) ctx.drawImage(copy, 0, 0, W, H);

    // The tip's recent path.
    const now = performance.now();
    trail = trail.filter((p) => now - p.t < TRAIL_MS);
    if (trail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        ctx.globalAlpha = 0.25 + 0.65 * (i / trail.length);
        ctx.strokeStyle = palette.candle;
        ctx.lineWidth = 2.2 * dpr;
        ctx.beginPath();
        ctx.moveTo(a.x * W, a.y * H);
        ctx.lineTo(b.x * W, b.y * H);
        ctx.stroke();
      }
      ctx.restore();
    }

    const f = latest;
    if (!f) return;

    // Other bright spots: dashed rings. The chosen tip: a solid ring with sighting ticks.
    ctx.save();
    for (const b of f.blobs) {
      if (b.chosen) continue;
      const r = Math.max(5 * dpr, b.r * W) + 3 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.lineWidth = 1.3 * dpr;
      ctx.strokeStyle = palette.vellum;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(b.x * W, b.y * H, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    for (const b of f.blobs) {
      if (!b.chosen) continue;
      const x = b.x * W;
      const y = b.y * H;
      const r = Math.max(6 * dpr, b.r * W) + 5 * dpr;
      ctx.lineWidth = 2.4 * dpr;
      ctx.strokeStyle = palette.night;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = palette.candle;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * (r + 3 * dpr), y + dy * (r + 3 * dpr));
        ctx.lineTo(x + dx * (r + 10 * dpr), y + dy * (r + 10 * dpr));
        ctx.stroke();
      }
    }
    ctx.restore();

    // Hand landmarks.
    const lm = f.landmarks;
    if (lm && lm.length >= 21) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = palette.vellum;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 2 * dpr;
      for (const [a, b] of HAND_LINKS) {
        ctx.beginPath();
        ctx.moveTo(lm[a][0] * W, lm[a][1] * H);
        ctx.lineTo(lm[b][0] * W, lm[b][1] * H);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i < lm.length; i++) {
        // The index fingertip is the tip in finger mode; in wand mode the wand's own tip is drawn below.
        const tipJoint = i === 8 && !f.wand;
        ctx.fillStyle = tipJoint ? palette.candle : palette.vellum;
        ctx.beginPath();
        ctx.arc(lm[i][0] * W, lm[i][1] * H, (tipJoint ? 4.5 : 2.8) * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Wand mode: the shaft found in this frame, from where it leaves the hand to its tip.
    const wand = f.wand;
    if (wand?.base) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = palette.night;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 5 * dpr;
      ctx.beginPath();
      ctx.moveTo(wand.base[0] * W, wand.base[1] * H);
      ctx.lineTo(wand.tip[0] * W, wand.tip[1] * H);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = palette.candle;
      ctx.lineWidth = 2.4 * dpr;
      ctx.stroke();
      ctx.restore();
    }

    // Where the tracker puts the tip now (for the hand: the fingertip, the grip projection or the wand's tip).
    const last = trail[trail.length - 1];
    if (last && now - last.t < 300) {
      ctx.save();
      ctx.fillStyle = palette.candle;
      ctx.strokeStyle = palette.night;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(last.x * W, last.y * H, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Size the canvas to its box at the screen's pixel density, and repaint.
  $effect(() => {
    const el = glass;
    const c = canvas;
    if (!el || !c) return;
    readPalette();
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(el.clientWidth * dpr));
      const h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      paint();
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Theme accents restyle the candle color.
  $effect(() => {
    void app.settings['theme.accent'];
    void app.spellbook?.theme;
    queueMicrotask(() => {
      readPalette();
      paint();
    });
  });

  // Debug frames and tip samples for the drawing; a slow timer for the "no picture" state.
  $effect(() => {
    const k = app.kernel;
    const offDebug = on(k, 'tracker.debug', onDebug);
    const offSample = on(k, 'tip.sample', (s) => {
      trail.push({ x: s.x, y: s.y, t: performance.now() });
      if (trail.length > 90) trail.splice(0, trail.length - 90);
    });
    const offLost = on(k, 'tip.lost', () => {
      trail = [];
    });
    const timer = setInterval(() => {
      const isStale = framesSeen && performance.now() - lastFrameAt > STALE_MS;
      if (isStale !== stale) stale = isStale;
    }, 500);
    return () => {
      offDebug();
      offSample();
      offLost();
      clearInterval(timer);
    };
  });

  // A tracker switch starts the view afresh.
  let shownTracker: string | undefined;
  $effect(() => {
    const id = trackerId;
    if (shownTracker !== undefined && shownTracker !== id) untrack(clearView);
    shownTracker = id;
  });

  // ------------------------------------------------------------------ the veil over an empty view
  const veil = $derived.by((): { title: string; line?: string } | null => {
    if (!isCamera) return { title: 'Mouse or touch needs no camera.', line: 'Choose a camera route to see what the tracker sees.' };
    const cam = app.camera;
    if (cam && cam.state !== 'on') {
      if (cam.state === 'requesting') return { title: 'Opening the camera…' };
      if (cam.state === 'off') return { title: 'The camera is off.', line: 'Choose a camera route to turn it on.' };
      // The desktop app has no address bar: the block comes from the computer's privacy settings.
      if (cam.state === 'blocked' && app.desktop) return { title: 'No picture from the camera.', line: TEXT.blockedDesktop };
      return { title: 'No picture from the camera.', line: cam.error?.message ?? cam.message };
    }
    const t = app.tracker;
    if (t?.state === 'loading') {
      const pct = typeof t.progress === 'number' ? ` ${Math.round(t.progress * 100)}%` : '';
      return { title: `${t.message || 'Getting the tracker ready'}${pct}` };
    }
    if (t?.state === 'error') return { title: 'The tracker stopped.', line: t.message };
    if (!framesSeen) return { title: 'Waiting for the tracker’s view…' };
    if (stale) return { title: 'The view has paused.', line: 'No new pictures are arriving from the tracker.' };
    return null;
  });

  // ------------------------------------------------------------------ play area
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const tidy = (a: PlayArea): PlayArea => ({
    x: Math.round(a.x * 1000) / 1000,
    y: Math.round(a.y * 1000) / 1000,
    w: Math.round(a.w * 1000) / 1000,
    h: Math.round(a.h * 1000) / 1000,
  });

  let area = $state<PlayArea>({ x: 0, y: 0, w: 1, h: 1 });
  let editing = false;
  $effect(() => {
    const pa = app.settings.playArea;
    if (!editing && pa) area = { x: pa.x, y: pa.y, w: pa.w, h: pa.h };
  });

  type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se';
  const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
  let drag: { grip: Grip; id: number; x0: number; y0: number; start: PlayArea; w: number; h: number } | null = null;

  function reshape(s: PlayArea, grip: Grip, dx: number, dy: number): PlayArea {
    if (grip === 'move') return { x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h), w: s.w, h: s.h };
    let { x, y, w, h } = s;
    const right = s.x + s.w;
    const bottom = s.y + s.h;
    if (grip[1] === 'w') {
      x = clamp(s.x + dx, 0, right - MIN_SIDE);
      w = right - x;
    } else {
      w = clamp(s.w + dx, MIN_SIDE, 1 - s.x);
    }
    if (grip[0] === 'n') {
      y = clamp(s.y + dy, 0, bottom - MIN_SIDE);
      h = bottom - y;
    } else {
      h = clamp(s.h + dy, MIN_SIDE, 1 - s.y);
    }
    return { x, y, w, h };
  }

  function grab(e: PointerEvent, grip: Grip): void {
    if (!glass || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = glass.getBoundingClientRect();
    drag = { grip, id: e.pointerId, x0: e.clientX, y0: e.clientY, start: { ...area }, w: rect.width, h: rect.height };
    editing = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function pull(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return;
    area = reshape(drag.start, drag.grip, (e.clientX - drag.x0) / drag.w, (e.clientY - drag.y0) / drag.h);
  }

  function release(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    commit();
  }

  function commit(): void {
    const next = tidy(area);
    area = next;
    void app.set('playArea', next).finally(() => (editing = false));
  }

  let keyTimer: ReturnType<typeof setTimeout> | null = null;
  function nudge(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    editing = true;
    area = reshape(area, 'move', m[0], m[1]);
    if (keyTimer) clearTimeout(keyTimer);
    keyTimer = setTimeout(commit, 400);
  }

  const size = $derived(Math.round(Math.max(area.w, area.h) * 100));

  function resizeTo(pct: number): void {
    editing = true;
    const target = clamp(pct / 100, MIN_SIDE, 1);
    const current = Math.max(area.w, area.h) || 1;
    const f = target / current;
    const w = clamp(area.w * f, MIN_SIDE * 0.5, 1);
    const h = clamp(area.h * f, MIN_SIDE * 0.5, 1);
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    area = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }

  function wholeView(): void {
    editing = true;
    area = { x: 0, y: 0, w: 1, h: 1 };
    commit();
  }

  const areaLabel = $derived(
    `Play area, ${size}% of the view. Drag it to move it, drag a corner to resize it, or use the arrow keys to move it.`,
  );

  // ------------------------------------------------------------------ readouts
  const status = $derived(app.tracker);
  const contrast = $derived(isBrightTip ? status?.contrast : undefined);
  const contrastWord = $derived(contrast === undefined ? 'No tip in view' : contrast >= 3 ? 'Clear' : 'Too faint');
  const meterPos = $derived(contrast === undefined ? 0 : Math.min(1, Math.max(0, (contrast - 1) / 5)));
  /** Time a frame may take: the bright tip's budget (Section 13, 4 ms), or for the hand model (and the wand
   *  in the hand) one frame of a 30 fps camera, past which it drops frames (it takes 17 to 35 ms). */
  const stepBudget = $derived(isHand ? 33 : 4);
  const stepOver = $derived(typeof status?.stepMs === 'number' && status.stepMs > stepBudget);
</script>

<div class="live">
  <div class="frame">
    <div class="glass" bind:this={glass} style:aspect-ratio={aspect}>
      <canvas bind:this={canvas} aria-hidden="true"></canvas>

      {#if veil}
        <div class="veil">
          <p class="veil-title">{veil.title}</p>
          {#if veil.line}<p class="veil-line">{veil.line}</p>{/if}
        </div>
      {/if}

      {#if isCamera}
        <button
          type="button"
          class="area"
          class:full={area.w >= 0.999 && area.h >= 0.999}
          style:left="{area.x * 100}%"
          style:top="{area.y * 100}%"
          style:width="{area.w * 100}%"
          style:height="{area.h * 100}%"
          aria-roledescription="movable box"
          aria-label={areaLabel}
          onpointerdown={(e) => grab(e, 'move')}
          onpointermove={pull}
          onpointerup={release}
          onpointercancel={release}
          onkeydown={nudge}
        >
          <span class="area-tag" aria-hidden="true">Play area</span>
          {#each CORNERS as g (g)}
            <span
              class="grip {g}"
              aria-hidden="true"
              onpointerdown={(e) => grab(e, g)}
              onpointermove={pull}
              onpointerup={release}
              onpointercancel={release}
            ></span>
          {/each}
        </button>
      {/if}
    </div>
  </div>

  {#if isCamera}
    <p class="legend">
      {#if isBrightTip}
        <span class="key"><span class="ring chosen" aria-hidden="true"></span>the tip it chose</span>
        <span class="key"><span class="ring" aria-hidden="true"></span>other bright spots{candidates ? ` (${candidates})` : ''}</span>
      {:else}
        <span class="key"><span class="bone" aria-hidden="true"></span>hand landmarks</span>
        {#if isWand}<span class="key"><span class="shaft" aria-hidden="true"></span>the wand it found</span>{/if}
        <span class="key"><span class="dot" aria-hidden="true"></span>the tip it follows</span>
      {/if}
    </p>

    {#if isBrightTip}
      <div class="contrast" data-ok={contrast !== undefined && contrast >= 3}>
        <span class="label" id="contrast-label">Contrast</span>
        <span class="value">{contrast === undefined ? '–' : `${contrast.toFixed(1)}×`}</span>
        <div
          class="meter"
          role="meter"
          aria-labelledby="contrast-label"
          aria-valuemin={1}
          aria-valuemax={6}
          aria-valuenow={contrast ?? 1}
          aria-valuetext={contrast === undefined ? 'No tip in view' : `${contrast.toFixed(1)} times the brightest background, ${contrastWord.toLowerCase()}`}
        >
          <span class="fill" style:width="{meterPos * 100}%"></span>
          <span class="target" style:left="{(2 / 5) * 100}%"><span>3×</span></span>
        </div>
        <span class="word">{contrastWord}</span>
      </div>
    {/if}

    <dl class="readouts">
      <div>
        <dt>Lock</dt>
        <dd>{status ? `${Math.round(status.lock * 100)}%` : '–'}</dd>
      </div>
      <div>
        <dt>Frame rate</dt>
        <dd>{status ? `${Math.round(status.fps)} fps` : '–'}</dd>
      </div>
      <div data-over={stepOver}>
        <dt>Per frame</dt>
        <dd>{typeof status?.stepMs === 'number' ? `${status.stepMs.toFixed(1)} ms` : '–'}</dd>
      </div>
      <div>
        <dt>Tip size</dt>
        <dd>{isBrightTip && tipPx !== null ? `${tipPx} px` : '–'}</dd>
      </div>
    </dl>
    <p class="help">
      {#if isBrightTip}Contrast is the tip’s brightness against the brightest background; aim for 3×.{/if}
      Lock is the share of frames with a confident tip.
      {#if isHand}Per frame is the hand model’s time{stepOver ? ', now over' : ', best under'} 33 ms, one frame of a 30 fps camera.{:else}Per frame is the tracker’s time{stepOver ? ', now over' : ', best under'} 4 ms.{/if}
    </p>

    <div class="area-controls">
      <label class="area-label" for="play-area-size">Play area</label>
      <input
        id="play-area-size"
        type="range"
        min="20"
        max="100"
        step="1"
        value={size}
        aria-valuetext="{size}% of the view"
        oninput={(e) => resizeTo(Number(e.currentTarget.value))}
        onchange={commit}
      />
      <output for="play-area-size" class="area-value">{size}%</output>
      <button class="btn btn-ghost" type="button" onclick={wholeView} disabled={area.w >= 0.999 && area.h >= 0.999}>Whole view</button>
    </div>
    <p class="help">Cast inside the box: spell power and the smallest stroke are measured against it. Drag it or a corner to change it.</p>
  {/if}
</div>

<style>
  .live {
    display: grid;
    gap: 12px;
    container-type: inline-size;
  }

  /* A small looking-glass on the workbench, in a gilt frame like the mirror's: a burnished rail
     between a dark outer edge and a beaded sight edge. */
  .frame {
    padding: 8px;
    border-radius: 2px;
    background: linear-gradient(160deg, #f1dc9f 0%, #c9a356 22%, #6e5222 48%, #b8944c 70%, #e3c67f 86%, #8a6a2c 100%);
    box-shadow:
      0 0 0 1px #150f08,
      inset 0 0 0 1px rgb(255 240 200 / 0.45),
      inset 0 0 0 2px #5a4019,
      inset 0 0 0 5px rgb(0 0 0 / 0.08),
      inset 0 0 0 6px #3e2c12,
      inset 0 0 0 7px rgb(233 207 138 / 0.6),
      3px 10px 26px rgb(0 0 0 / 0.5);
  }

  .glass {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: 1px;
    /* Behind the camera's picture, the mirror's own glass (tokens.css). */
    background: var(--glass);
    box-shadow: var(--glass-rim);
    touch-action: none;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .veil {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 4px;
    padding: 18px 24px;
    text-align: center;
    pointer-events: none;
  }

  .veil-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 21px;
    color: var(--vellum);
  }

  .veil-line {
    margin: 0;
    max-width: 34ch;
    justify-self: center;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .area {
    position: absolute;
    margin: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    border: 1.5px dashed color-mix(in srgb, var(--candle) 85%, transparent);
    border-radius: 3px;
    box-shadow: 0 0 0 9999px rgb(5 7 14 / 0.38);
    cursor: move;
    touch-action: none;
  }

  .area.full {
    box-shadow: none;
    border-color: color-mix(in srgb, var(--candle) 55%, transparent);
  }

  .area:focus-visible {
    outline: none;
    box-shadow: 0 0 0 9999px rgb(5 7 14 / 0.38), inset 0 0 0 2px var(--candle);
  }

  .area-tag {
    position: absolute;
    left: 50%;
    top: 6px;
    transform: translateX(-50%);
    padding: 0 8px;
    border-radius: 4px;
    background: rgb(10 13 24 / 0.72);
    color: var(--candle);
    font-size: var(--text-small);
    line-height: 1.5;
    white-space: nowrap;
    pointer-events: none;
  }

  /* 44 px targets inside each corner, drawn as a viewfinder bracket. */
  .grip {
    position: absolute;
    width: 44px;
    height: 44px;
  }

  .grip::after {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    border: 0 solid var(--candle);
  }

  .grip.nw { left: 0; top: 0; cursor: nwse-resize; }
  .grip.ne { right: 0; top: 0; cursor: nesw-resize; }
  .grip.sw { left: 0; bottom: 0; cursor: nesw-resize; }
  .grip.se { right: 0; bottom: 0; cursor: nwse-resize; }
  .grip.nw::after { left: 3px; top: 3px; border-left-width: 3px; border-top-width: 3px; }
  .grip.ne::after { right: 3px; top: 3px; border-right-width: 3px; border-top-width: 3px; }
  .grip.sw::after { left: 3px; bottom: 3px; border-left-width: 3px; border-bottom-width: 3px; }
  .grip.se::after { right: 3px; bottom: 3px; border-right-width: 3px; border-bottom-width: 3px; }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .ring {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px dashed var(--vellum);
  }

  .ring.chosen {
    border: 2px solid var(--candle);
  }

  .bone {
    width: 18px;
    height: 2px;
    background: var(--vellum);
    border-radius: 2px;
  }

  .shaft {
    width: 20px;
    height: 3px;
    background: var(--candle);
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgb(15 20 36 / 0.7);
    transform: rotate(-35deg);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--candle);
    box-shadow: 0 0 0 2px var(--night);
  }

  .contrast {
    display: grid;
    grid-template-columns: auto auto minmax(80px, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 10px 14px 22px;
    border-radius: var(--radius-small);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 50%, transparent);
  }

  .contrast .label {
    font-size: var(--text-small);
    color: var(--ash);
  }

  .contrast .value {
    min-width: 3.2ch;
    font-size: 22px;
    line-height: 1;
    color: var(--vellum);
    font-variant-numeric: lining-nums tabular-nums;
  }

  .contrast .word {
    font-size: var(--text-small);
    color: var(--ash);
    white-space: nowrap;
  }

  .contrast[data-ok='true'] .word {
    color: var(--verdigris);
  }

  .contrast[data-ok='true'] .word::before {
    content: '✓ ';
  }

  /* A groove cut into the bench, filling with candlelight. */
  .meter {
    position: relative;
    height: 10px;
    border-radius: 1px;
    background: linear-gradient(180deg, #0b0907, #17120d);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.7), 0 0 0 1px color-mix(in srgb, var(--brass) 45%, black);
  }

  .meter .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--candle) 40%, transparent), var(--candle));
    transition: width var(--duration) var(--ease-out);
  }

  .meter .target {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 2px;
    background: var(--vellum);
    border-radius: 1px;
  }

  .meter .target span {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    font-size: var(--text-small);
    line-height: 1.2;
    color: var(--vellum);
  }

  .help {
    margin: 0;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .readouts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }

  .readouts > div {
    padding: 6px 10px 7px;
    border-radius: var(--radius-small);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 50%, transparent);
    min-width: 0;
  }

  .readouts dt {
    font-size: var(--text-small);
    color: var(--ash);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .readouts dd {
    margin: 0;
    font-size: var(--text-body);
    color: var(--vellum);
    white-space: nowrap;
    font-variant-numeric: lining-nums tabular-nums;
  }

  .readouts > div[data-over='true'] {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--candle) 50%, transparent);
  }

  .readouts > div[data-over='true'] dd::after {
    content: ' !';
    color: var(--candle);
  }

  .area-controls {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 4.5ch auto;
    align-items: center;
    gap: 6px 12px;
  }

  .area-label {
    font-size: var(--text-body);
    white-space: nowrap;
  }

  .area-value {
    font-size: var(--text-small);
    color: var(--candle);
    text-align: right;
    font-variant-numeric: lining-nums tabular-nums;
  }

  .area-controls input {
    min-height: 44px;
  }

  @container (max-width: 400px) {
    .readouts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .contrast {
      grid-template-columns: auto auto minmax(60px, 1fr);
    }
    .contrast .word {
      grid-column: 1 / -1;
      margin-top: 8px;
    }
  }
</style>
