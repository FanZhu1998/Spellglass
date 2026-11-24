// Tells the core when a prop changed, so it republishes 'scene.props' (the engine targets spells with it).
// Task brief: "Every change to position, tags or state calls services.propsChanged() (not every frame:
// only when something changes, and at most a few times per second while moving)."
//  - Tags, state and label changes are published at once: the next cast must see an open box as open.
//  - Movement is published at most every MOVE_NOTIFY_MS, and once more after the prop comes to rest
//    (the pending flag survives until it is published).

import type { StageServices } from '../types';

export const MOVE_NOTIFY_MS = 250;

export class ChangeNotifier {
  private services: StageServices | null = null;
  /** A discrete change is waiting for services (it happened before the first frame). */
  private pending = false;
  /** The position or size changed since the last publish. */
  private moving = false;
  private lastAt = Number.NEGATIVE_INFINITY;
  /** Times propsChanged() was called, for tests and diagnostics. */
  count = 0;

  bind(services: StageServices): void {
    this.services = services;
    if (this.pending) this.publish(services.now());
  }

  /** Tags, state or label changed. */
  changed(now: number): void {
    this.pending = true;
    if (this.services) this.publish(now);
  }

  /** Position or size changed while moving. */
  moved(): void {
    this.moving = true;
  }

  /** Once per frame, with the kernel clock (real time, so throttling works even when time is stopped). */
  tick(now: number): void {
    if (this.moving && this.services && now - this.lastAt >= MOVE_NOTIFY_MS) this.publish(now);
  }

  private publish(now: number): void {
    const services = this.services;
    if (!services) return;
    this.pending = false;
    this.moving = false;
    this.lastAt = now;
    this.count++;
    services.propsChanged();
  }
}
