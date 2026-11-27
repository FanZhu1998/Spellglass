// prop.scale grow and shrink (Engorgio 1.6, Reducio 0.55): ease to the factor, hold it for
// duration_ms, then ease back to normal size (task brief). Shatter (factor 0) is not a size change and
// lives in SmallProp. Pure: advanced by the prop's local ms.

import type { ActionHandle } from './actions';
import { clamp01, easeInOut, easeOut, easeOutBack } from './motion';

/** Sizes a pack may ask for, after effectScale (a 2.2× teacup would swallow its neighbours). */
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 2.2;

export class ScaleChannel {
  /** Current size multiplier. */
  value = 1;
  /** The size being eased toward, or held. */
  target = 1;
  /** The action holding the size, until its duration ends. */
  handle: ActionHandle | null = null;
  private from = 1;
  private t = 0;
  private dur = 0;
  private holdLeft = 0;
  private overshoot = false;

  get active(): boolean {
    return this.handle !== null || this.value !== 1 || this.target !== 1;
  }

  /** Easing toward a size: growing, shrinking, or going back to normal. Holding a size is not. */
  get easing(): boolean {
    return this.t < this.dur;
  }

  /** Begin a grow or shrink. The caller completes any previous handle first. */
  start(factor: number, holdMs: number, handle: ActionHandle | null, reduced: boolean): void {
    this.from = this.value;
    this.target = factor;
    this.t = 0;
    this.dur = reduced ? 220 : 650;
    this.holdLeft = Math.max(1, holdMs);
    this.handle = handle;
    this.overshoot = !reduced && factor > this.value;
  }

  /** Advance by local ms. `complete` receives the handle when the hold ends on its own. The hold counts
   *  from the start of the step, ease included: the size change lasts duration_ms, as the core's effect does. */
  step(dt: number, reduced: boolean, complete: (h: ActionHandle | null) => void): void {
    if (this.t < this.dur) {
      this.t += dt;
      const u = clamp01(this.t / this.dur);
      const e = this.overshoot ? easeOutBack(u, 1.2) : this.target === 1 ? easeInOut(u) : easeOut(u);
      this.value = this.from + (this.target - this.from) * e;
      if (u >= 1) this.value = this.target;
    }
    if (this.holdLeft > 0) {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0) {
        const h = this.handle;
        this.handle = null;
        complete(h);
        this.easeBack(reduced);
      }
    }
  }

  /** end(castId): ease back now; the core already knows. */
  release(reduced: boolean): void {
    this.handle?.drop();
    this.handle = null;
    this.easeBack(reduced);
  }

  /** Back to normal size at once (reset, shatter). */
  reset(): void {
    this.handle?.drop();
    this.handle = null;
    this.value = 1;
    this.target = 1;
    this.from = 1;
    this.t = 0;
    this.dur = 0;
    this.holdLeft = 0;
  }

  private easeBack(reduced: boolean): void {
    this.from = this.value;
    this.target = 1;
    this.t = 0;
    this.dur = reduced ? 240 : 800;
    this.holdLeft = 0;
    this.overshoot = false;
  }
}
