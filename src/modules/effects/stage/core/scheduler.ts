// Timed work on the kernel clock. Effect steps run at "bloom + delay_ms" (CAST_SEQUENCE); the
// animation frame polls the schedule, and a single timer wakes it when no frames come (a hidden
// tab), so effect.start/effect.end keep their timing for the shell and the replay flow. Tasks due
// at the same time run in the order they were added, which keeps a spell's steps in pack order.

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export class Scheduler {
  private tasks: Task[] = [];
  private seq = 0;
  private polling = false;

  /** Run fn at kernel time `at`. Returns a cancel function. */
  at(at: number, fn: () => void): () => void {
    const task: Task = { at, seq: this.seq++, fn, cancelled: false };
    // Keep the list sorted by (at, seq); schedules are short, so insertion is cheap.
    let i = this.tasks.length;
    while (i > 0 && this.tasks[i - 1].at > at) i--;
    this.tasks.splice(i, 0, task);
    return () => {
      task.cancelled = true;
    };
  }

  /** Run every task due by `now`, including tasks that due tasks add for `now` or earlier. */
  poll(now: number): number {
    if (this.polling) return 0;
    this.polling = true;
    let ran = 0;
    try {
      while (this.tasks.length && this.tasks[0].at <= now) {
        const task = this.tasks.shift()!;
        if (task.cancelled) continue;
        ran++;
        task.fn();
      }
    } finally {
      this.polling = false;
    }
    return ran;
  }

  /** Time of the earliest pending task, or null. */
  next(): number | null {
    while (this.tasks.length && this.tasks[0].cancelled) this.tasks.shift();
    return this.tasks.length ? this.tasks[0].at : null;
  }

  get size(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  clear(): void {
    for (const t of this.tasks) t.cancelled = true;
    this.tasks = [];
  }
}
