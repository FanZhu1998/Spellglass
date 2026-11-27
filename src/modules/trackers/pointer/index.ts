// Pointer tracker (tracker.pointer): the mouse, a pen or a finger on the mirror stands in for the wand
// (Section 7.9: "offers pointer mode (mouse or touch) so the rest of the app still works"; Section 11.1:
// friends without a wand). Strokes follow the pen rule: the tip is found when the pointer goes down and
// lost when it comes up, so the segmenter needs no hold-still rhythm (TrackerStatus.pen).
//
// Caster space: pointer positions are mapped through the caster rectangle of the sticky 'stage.surface'
// (mapping.ts), so the trail lies under the pointer and pointer strokes share the camera's aspect. Until
// the stage has published a surface, the element's own box is caster space.
//
// Tip event rules (contracts/events.ts): tracker.status (with aspect and pen) goes out on start() before
// any tip event, and again whenever the aspect changes; tip.found precedes the sample of the same event
// with the same t; tip.lost goes out on pointerup, pointercancel and lostpointercapture, and on stop()
// while the pointer is down.

import type { Kernel, Module, ModuleManifest, StageSurface, TipSample, TrackerStatus } from '../../../contracts';
import { emit, lastPayload, logger, on } from '../../../kernel';
import { casterAspect, casterSize, eventTime, thinSamples, toCaster, type Rect, type SurfaceGeometry } from './mapping';

export const MANIFEST: ModuleManifest = {
  id: 'tracker.pointer',
  kind: 'tracker',
  title: 'Mouse or touch',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['tip.source'],
  requires: ['platform.pointer'],
};

const ID = MANIFEST.id;
const log = logger(ID);

/** Shell controls that may sit inside the mirror keep their own clicks. */
const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="slider"], [role="link"]';

/** The parts of a PointerEvent the tracker reads (a real PointerEvent in the browser). */
interface PointerLike {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  button: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  target: EventTarget | null;
  getCoalescedEvents?: () => PointerLike[];
  preventDefault(): void;
}

export function createPointerTracker(opts: { element: HTMLElement }): Module {
  const element = opts.element;
  let kernel: Kernel;
  let active = false;
  let offs: (() => void)[] = [];

  /** The pointer currently drawing, or null. */
  let pointerId: number | null = null;
  /** Pointer capture holds for the drawing pointer, so its pointerup arrives even outside the element. */
  let captured = false;
  let lastT: number | null = null;
  let lastXY: [number, number] | null = null;
  /** Recent sample times (kernel clock), for TrackerStatus.fps. */
  let recent: number[] = [];

  let surface: SurfaceGeometry | null = null;
  let lastAspect: number | null = null;
  let restoreTouchAction: string | null = null;

  const now = () => kernel.now();

  // ---------------------------------------------------------------------------------- geometry

  function elementRect(): Rect {
    const r = element.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** The stage's surface counts only when it describes this element (src/main.ts gives both the same one). */
  function adoptSurface(s: StageSurface | undefined): void {
    surface = s && s.mirror === element ? { caster: { ...s.caster }, width: s.width, height: s.height } : null;
  }

  function sample(e: PointerLike, rect: Rect, t: number): TipSample {
    const [x, y] = toCaster(e.clientX, e.clientY, rect, surface);
    return { t, x: round5(x), y: round5(y), conf: 1, src: ID };
  }

  // ---------------------------------------------------------------------------------- status

  function publishStatus(state: TrackerStatus['state']): void {
    const rect = element.isConnected ? elementRect() : null;
    const aspect = casterAspect(rect, surface);
    const size = casterSize(rect, surface);
    const k = now();
    recent = recent.filter((t) => k - t <= 1000);
    lastAspect = aspect;
    emit(kernel, ID, 'tracker.status', {
      tracker: ID,
      state,
      lock: state === 'tracking' ? 1 : 0,
      // Pointer events are not camera frames: this is the rate of published samples over the last second.
      fps: recent.length,
      aspect,
      width: size?.width,
      height: size?.height,
      pen: true,
      // Pointer trackers never set the "not found" hint (contracts/events.ts TrackerStatus.hint).
      hint: null,
    });
  }

  /** Rule 1: republish whenever the aspect changes (a resize, a camera with another shape). */
  function checkAspect(): void {
    if (!active) return;
    const aspect = casterAspect(element.isConnected ? elementRect() : null, surface);
    if (lastAspect === null || Math.abs(aspect - lastAspect) > 1e-4) publishStatus(pointerId !== null ? 'tracking' : 'searching');
  }

  // ---------------------------------------------------------------------------------- events

  function isInteractive(target: EventTarget | null): boolean {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function' || el === element) return false;
    const hit = el.closest(INTERACTIVE);
    return !!hit && element.contains(hit);
  }

  function onDown(e: PointerLike): void {
    if (!active || pointerId !== null) return;
    // Mouse: the main button only. Touch and pen: the first finger or pen only.
    if (e.pointerType === 'mouse' ? e.button !== 0 : !e.isPrimary) return;
    if (isInteractive(e.target)) return;
    pointerId = e.pointerId;
    // A drag on the mirror is a stroke, not a text selection or a native drag.
    e.preventDefault();
    captured = false;
    try {
      if (typeof element.setPointerCapture === 'function') {
        element.setPointerCapture(e.pointerId);
        captured = true;
      }
    } catch (err) {
      // InvalidStateError when the pointer is already gone; the stroke still works inside the element.
      log.debug('pointer capture refused', err);
    }
    const t = monotonic(eventTime(e.timeStamp, now()));
    const s = sample(e, elementRect(), t);
    publishStatus('tracking');
    // Rule 2: tip.found is a state change sent just before the sample of the same event, with the same t.
    emit(kernel, ID, 'tip.found', s, t);
    publishSample(s);
  }

  function onMove(e: PointerLike): void {
    if (!active || pointerId === null || e.pointerId !== pointerId) return;
    const burst = coalesced(e);
    const rect = elementRect();
    const k = now();
    const times = burst.map((c) => monotonic(eventTime(c.timeStamp, k)));
    for (const i of thinSamples(times, lastT)) {
      const s = sample(burst[i], rect, monotonic(times[i]));
      publishSample(s);
    }
  }

  /** Without pointer capture (very old engines, test environments) a pointer released outside the
   *  element sends no pointerup here, so leaving the element ends the stroke instead. */
  function onLeave(e: PointerLike): void {
    if (!active || captured || pointerId === null || e.pointerId !== pointerId) return;
    loseTip(monotonic(eventTime(e.timeStamp, now())));
  }

  function onUp(e: PointerLike): void {
    if (!active || pointerId === null || e.pointerId !== pointerId) return;
    const t = monotonic(eventTime(e.timeStamp, now()));
    // The release point ends the trail when the pointer moved since the last move event.
    const s = sample(e, elementRect(), t);
    if (!lastXY || Math.abs(s.x - lastXY[0]) > 1e-5 || Math.abs(s.y - lastXY[1]) > 1e-5) publishSample(s);
    loseTip(t);
  }

  /** pointercancel (the browser took the touch for scrolling, the pen left range) and lostpointercapture
   *  (capture was taken away, or released after pointerup, when the tip is already lost). */
  function onCancel(e: PointerLike): void {
    if (!active || pointerId === null || e.pointerId !== pointerId) return;
    loseTip(monotonic(eventTime(e.timeStamp, now())));
  }

  function publishSample(s: TipSample): void {
    lastT = s.t;
    lastXY = [s.x, s.y];
    recent.push(now());
    emit(kernel, ID, 'tip.sample', s, s.t);
  }

  function loseTip(t: number): void {
    if (pointerId === null) return;
    const id = pointerId;
    pointerId = null;
    captured = false;
    emit(kernel, ID, 'tip.lost', { t, src: ID, lastSeen: lastT ?? undefined }, t);
    try {
      if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(id)) element.releasePointerCapture(id);
    } catch {
      /* already released */
    }
    if (active) publishStatus('searching');
  }

  /** Capture times never run backwards within this tracker's stream. */
  function monotonic(t: number): number {
    return lastT !== null && t < lastT ? lastT : t;
  }

  // ---------------------------------------------------------------------------------- touch-action

  /** Touch strokes need the browser not to pan or zoom. The shell normally sets touch-action: none on the
   *  mirror's container (src/ui/App.svelte), which also covers the element; only when nothing above sets
   *  it does the tracker set it on the element itself, and it puts the old value back on stop(). */
  function ensureTouchAction(): void {
    if (typeof getComputedStyle !== 'function') return;
    for (let el: Element | null = element; el; el = el.parentElement) {
      try {
        if (getComputedStyle(el).touchAction === 'none') return;
      } catch {
        return;
      }
    }
    restoreTouchAction = element.style.touchAction;
    element.style.touchAction = 'none';
  }

  function restoreTouch(): void {
    if (restoreTouchAction === null) return;
    element.style.touchAction = restoreTouchAction;
    restoreTouchAction = null;
  }

  // ---------------------------------------------------------------------------------- lifecycle

  function listen<K extends 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture' | 'pointerleave'>(type: K, fn: (e: PointerLike) => void): () => void {
    const handler = (e: Event) => fn(e as unknown as PointerLike);
    element.addEventListener(type, handler);
    return () => element.removeEventListener(type, handler);
  }

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
    },

    async start() {
      if (active) return;
      active = true;
      pointerId = null;
      lastT = null;
      lastXY = null;
      recent = [];
      adoptSurface(lastPayload(kernel, 'stage.surface'));
      // Rule 1: status (aspect and pen) before any tip event.
      publishStatus('searching');
      ensureTouchAction();
      offs = [
        listen('pointerdown', onDown),
        listen('pointermove', onMove),
        listen('pointerup', onUp),
        listen('pointercancel', onCancel),
        listen('lostpointercapture', onCancel),
        listen('pointerleave', onLeave),
        on(kernel, 'stage.surface', (s) => {
          adoptSurface(s);
          checkAspect();
        }),
      ];
      // Without a stage surface, the element's own shape is the aspect: follow its size.
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => checkAspect());
        ro.observe(element);
        offs.push(() => ro.disconnect());
      } else if (typeof addEventListener === 'function') {
        const onResize = () => checkAspect();
        addEventListener('resize', onResize);
        offs.push(() => removeEventListener('resize', onResize));
      }
    },

    async stop() {
      if (!active) return;
      active = false;
      // Rule 3: a tracker holding the tip publishes tip.lost when it stops (then 'stopped', below).
      if (pointerId !== null) loseTip(monotonic(now()));
      for (const off of offs) off();
      offs = [];
      restoreTouch();
      publishStatus('stopped');
    },
  };
}

function coalesced(e: PointerLike): PointerLike[] {
  if (typeof e.getCoalescedEvents === 'function') {
    try {
      const list = e.getCoalescedEvents();
      if (list && list.length) return list;
    } catch {
      /* fall through: the event alone */
    }
  }
  return [e];
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}
