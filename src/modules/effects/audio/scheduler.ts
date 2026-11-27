// Timed work on the kernel clock: step starts (bloom + delay_ms), cue ends, timed muffles. One
// timer, set for the earliest task; it only wakes the scheduler, which compares task times with
// kernel.now() itself, so a late wake-up runs what is due and nothing early. Tasks due at the same
// time run in the order they were added, which keeps a spell's steps in pack order (as the stage's
// scheduler does).

import { logger } from '../../../kernel';

const log = logger('audio');

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Scheduler {
  private tasks: Task[] = [];
  private seq = 0;
  private timer: unknown = null;
  private timerAt = Infinity;
  private running = false;

  constructor(private readonly now: () => number, private readonly timers: Timers = defaultTimers) {}

  /** Run fn at kernel time `at` (at once, asynchronously, if that has passed). Returns a cancel function. */
  at(at: number, fn: () => void): () => void {
    const task: Task = { at: Number.isFinite(at) ? at : this.now(), seq: this.seq++, fn, cancelled: false };
    let i = this.tasks.length;
    while (i > 0 && this.tasks[i - 1].at > task.at) i--;
    this.tasks.splice(i, 0, task);
    this.arm();
    return () => {
      task.cancelled = true;
    };
  }

  get size(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  clear(): void {
    for (const t of this.tasks) t.cancelled = true;
    this.tasks = [];
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private arm(): void {
    if (this.running) return; // run() re-arms when it is done
    while (this.tasks.length && this.tasks[0].cancelled) this.tasks.shift();
    const next = this.tasks[0]?.at;
    if (next === undefined) {
      if (this.timer !== null) this.timers.clear(this.timer);
      this.timer = null;
      this.timerAt = Infinity;
      return;
    }
    if (this.timer !== null && this.timerAt <= next) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timerAt = next;
    this.timer = this.timers.set(() => this.run(), Math.max(0, Math.ceil(next - this.now())));
  }

  private run(): void {
    this.timer = null;
    this.timerAt = Infinity;
    this.running = true;
    try {
      const now = this.now();
      while (this.tasks.length && this.tasks[0].at <= now) {
        const task = this.tasks.shift()!;
        if (task.cancelled) continue;
        try {
          task.fn();
        } catch (err) {
          log.warn('a scheduled sound task failed', err);
        }
      }
    } finally {
      this.running = false;
    }
    this.arm();
  }
}
