// Pure parts of the pointer tracker: where a pointer lands in caster space, the aspect it reports, and
// which samples of a burst of coalesced pointer events are worth publishing.
//
// Caster space (contracts/v1.ts TipSample) is the whole camera frame as shown in the mirror. The stage
// publishes where that frame sits on screen as StageSurface.caster, a rectangle in CSS px relative to
// the mirror element; it is letterboxed when the mirror does not have the camera's aspect. Mapping the
// pointer through the same rectangle puts a mouse stroke exactly under the ink the stage draws, and
// gives pointer strokes the camera's aspect, like every other tracker. There is no x flip: the pointer
// already lives in the mirror view (Section 6, "Caster space").

/** A rectangle in CSS px. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the mapping needs from the sticky 'stage.surface' (contracts/events.ts StageSurface). */
export interface SurfaceGeometry {
  /** Caster rectangle, CSS px relative to the mirror element. */
  caster: Rect;
  /** Mirror size in CSS px as the stage measured it. */
  width: number;
  height: number;
}

/** Points dragged far past the mirror are held inside the range the session schema accepts
 *  (session-1.json "position": -1..2). Consumers clamp further where they need to. */
const MIN_POS = -1;
const MAX_POS = 2;

/** Default aspect when nothing has a size yet (most webcams). */
export const DEFAULT_ASPECT = 16 / 9;

/** Coalesced pointer events closer together than this are thinned out, so a 1000 Hz gaming mouse
 *  does not flood the filter and segmenter with samples no stroke needs. 8 ms keeps up to 125
 *  samples a second, well above any camera tracker. */
export const MIN_SAMPLE_SPACING_MS = 8;

/** A usable caster rectangle from the surface, or null when the stage has none (yet). */
function usableCaster(surface: SurfaceGeometry | null): Rect | null {
  const c = surface?.caster;
  return c && c.width > 0 && c.height > 0 ? c : null;
}

/**
 * Map a pointer position (client px) into caster space.
 *
 * `element` is the mirror element's getBoundingClientRect(). When the stage has published its surface,
 * its caster rectangle is used; until then the whole element is caster space. If the stage measured
 * the mirror at a different size than the element shows on screen (a CSS transform scaling the mirror),
 * client px are first scaled into the stage's px so the rectangle still lines up.
 */
export function toCaster(clientX: number, clientY: number, element: Rect, surface: SurfaceGeometry | null): [number, number] {
  const caster = usableCaster(surface);
  const localX = clientX - element.x;
  const localY = clientY - element.y;
  let x: number;
  let y: number;
  if (caster && surface) {
    const sx = surface.width > 0 && element.width > 0 ? element.width / surface.width : 1;
    const sy = surface.height > 0 && element.height > 0 ? element.height / surface.height : 1;
    x = (localX / sx - caster.x) / caster.width;
    y = (localY / sy - caster.y) / caster.height;
  } else {
    x = element.width > 0 ? localX / element.width : 0.5;
    y = element.height > 0 ? localY / element.height : 0.5;
  }
  return [clampPos(x), clampPos(y)];
}

/** Width ÷ height of caster space for the pointer: the caster rectangle when the stage has one,
 *  else the element, else 16:9 (contracts/events.ts StageSurface.aspect). */
export function casterAspect(element: Rect | null, surface: SurfaceGeometry | null): number {
  const caster = usableCaster(surface);
  if (caster) return caster.width / caster.height;
  if (element && element.width > 0 && element.height > 0) return element.width / element.height;
  return DEFAULT_ASPECT;
}

/** Caster rectangle size in CSS px, for TrackerStatus.width and height. */
export function casterSize(element: Rect | null, surface: SurfaceGeometry | null): { width: number; height: number } | null {
  const caster = usableCaster(surface);
  if (caster) return { width: Math.round(caster.width), height: Math.round(caster.height) };
  if (element && element.width > 0 && element.height > 0) return { width: Math.round(element.width), height: Math.round(element.height) };
  return null;
}

/**
 * The capture time to use for a pointer event. Event.timeStamp is on the performance.now() clock in
 * current browsers, which is the kernel clock in the main thread (contracts/v1.ts TipSample). Older
 * engines stamped events with epoch milliseconds, and test environments may use their own clocks, so a
 * stamp more than a few seconds away from the kernel's "now" is replaced by "now".
 */
export function eventTime(timeStamp: number, now: number, toleranceMs = 5000): number {
  if (Number.isFinite(timeStamp) && timeStamp > 0 && Math.abs(timeStamp - now) <= toleranceMs) return timeStamp;
  return now;
}

/**
 * Of a burst of coalesced samples (in time order), the ones to publish: never one closer than
 * MIN_SAMPLE_SPACING_MS to the previous published sample, but always the last one, so the trail ends
 * where the pointer is. Returns indices into `times`.
 */
export function thinSamples(times: readonly number[], lastPublishedT: number | null, spacingMs = MIN_SAMPLE_SPACING_MS): number[] {
  const keep: number[] = [];
  let last = lastPublishedT;
  for (let i = 0; i < times.length; i++) {
    const isLast = i === times.length - 1;
    if (last === null || times[i] - last >= spacingMs || isLast) {
      keep.push(i);
      last = times[i];
    }
  }
  return keep;
}

function clampPos(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(MAX_POS, Math.max(MIN_POS, v));
}
