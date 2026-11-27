// The event bus: synchronous, in-process, run to completion (contracts/module.ts).
//
// A top-level publish() delivers the event to every subscriber, then delivers whatever those
// subscribers published, first in first out, and returns when the cascade is done. An event
// published from inside a handler is queued, never delivered re-entrantly. So when the segmenter
// publishes 'stroke.end', every subscriber sees it before the recognizer's 'recognition.result',
// whatever order the modules were registered in.

import type { Envelope } from '../contracts';
import { NON_STICKY_EVENTS } from '../contracts';
import { logger } from './log';

const log = logger('bus');

type Handler = (e: Envelope<any>) => void;

/** A cascade longer than this is a feedback loop: drop the rest and say so. */
const MAX_CASCADE = 10_000;

export class Bus {
  private handlers = new Map<string, Set<Handler>>();
  private lastByType = new Map<string, Envelope<unknown>>();
  private nonSticky = new Set(NON_STICKY_EVENTS);
  private queue: Envelope<unknown>[] = [];
  private draining = false;

  publish<T>(e: Envelope<T>): void {
    if (!this.nonSticky.has(e.type)) this.lastByType.set(e.type, e);
    this.queue.push(e);
    if (this.draining) return;
    this.draining = true;
    let delivered = 0;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if (++delivered > MAX_CASCADE) {
          log.error(`event cascade over ${MAX_CASCADE} at ${next.type}; dropping ${this.queue.length + 1} events`);
          this.queue.length = 0;
          break;
        }
        this.dispatch(this.handlers.get(next.type), next);
        this.dispatch(this.handlers.get('*'), next);
      }
    } finally {
      this.draining = false;
    }
  }

  subscribe<T>(type: string, fn: (e: Envelope<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler);
    return () => {
      set!.delete(fn as Handler);
    };
  }

  last<T>(type: string): Envelope<T> | undefined {
    return this.lastByType.get(type) as Envelope<T> | undefined;
  }

  clear(): void {
    this.handlers.clear();
    this.lastByType.clear();
    this.queue.length = 0;
  }

  private dispatch(set: Set<Handler> | undefined, e: Envelope<unknown>): void {
    if (!set || set.size === 0) return;
    // Copy so handlers may unsubscribe while being called.
    for (const fn of [...set]) {
      try {
        fn(e);
      } catch (err) {
        log.error(`handler for ${e.type} threw`, err);
      }
    }
  }
}
