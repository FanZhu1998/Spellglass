// The keepsake shelf: the 50 newest keepsakes, newest first. The list lives in memory, so links,
// cards and clips work when there is no storage at all, and in the 'keepsakes' store, so it survives
// a reload. Storage is another module and every request to it may fail (Section 7.9): the shelf then
// carries on in memory.

import type { Kernel, Keepsake, StorageChanged } from '../../contracts';
import { ask, type Logger } from '../../kernel';
import { KEEPSAKE_LIMIT, isKeepsake, newestFirst, overLimit } from './keepsakes';

/** A 'storage.changed' for keys this shelf wrote this recently is the echo of its own write. */
const ECHO_WINDOW_MS = 10_000;

export class KeepsakeShelf {
  private list: Keepsake[] = [];
  private loading: Promise<void> | null = null;
  private loadedOnce = false;
  private reloadQueued = false;
  /** Keys this shelf wrote or deleted, with when (kernel clock). */
  private ownWrites = new Map<string, number>();
  /** Keepsakes whose put has not been confirmed yet: a reload must not lose them. */
  private unconfirmed = new Map<string, Keepsake>();
  private warned = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly log: Logger,
  ) {}

  /** Newest first, as copies (callers may hand them to Svelte state or change them). */
  all(limit?: number): Keepsake[] {
    const n = limit === undefined ? this.list.length : Math.max(0, Math.floor(limit));
    return this.list.slice(0, n).map((k) => structuredClone(k));
  }

  /** A keepsake by cast id: from memory, else from storage (before the first load has finished). */
  async find(id: string): Promise<Keepsake | undefined> {
    const here = this.list.find((k) => k.id === id);
    if (here) return here;
    try {
      const stored = await ask(this.kernel, 'storage.get', { store: 'keepsakes', key: id });
      return isKeepsake(stored) && stored.id === id ? stored : undefined;
    } catch (err) {
      this.problem(err);
      return undefined;
    }
  }

  /** Keep a new keepsake: first in the list, then in storage; the oldest beyond the limit go. */
  add(k: Keepsake): void {
    const { keep, drop } = overLimit(newestFirst([k, ...this.list.filter((x) => x.id !== k.id)]), KEEPSAKE_LIMIT);
    this.list = keep;
    if (!keep.includes(k)) return;
    this.unconfirmed.set(k.id, k);
    this.noteOwn(k.id);
    ask(this.kernel, 'storage.put', { store: 'keepsakes', key: k.id, value: k })
      .catch((err) => this.problem(err))
      .finally(() => this.unconfirmed.delete(k.id));
    for (const d of drop) void this.deleteStored(d.id);
  }

  async remove(id: string): Promise<void> {
    this.list = this.list.filter((k) => k.id !== id);
    this.unconfirmed.delete(id);
    await this.deleteStored(id);
  }

  /** Read the store again (start, and after another writer changed it). Never rejects. */
  load(): Promise<void> {
    const run = this.readStore();
    this.loading = run;
    return run;
  }

  /** Wait for the load in progress, but not longer than `ms`. */
  async whenLoaded(ms: number): Promise<void> {
    if (!this.loading) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([this.loading, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    if (timer !== null) clearTimeout(timer);
  }

  /** Reload after an import, a clear or another writer; our own writes come back and are ignored. */
  onStorageChanged(change: StorageChanged): void {
    if (!change || !Array.isArray(change.stores) || !change.stores.includes('keepsakes')) return;
    if ((change.reason === 'put' || change.reason === 'delete') && Array.isArray(change.keys) && change.keys.length && change.keys.every((key) => this.isOwn(key))) return;
    if (this.reloadQueued) return;
    this.reloadQueued = true;
    queueMicrotask(() => {
      this.reloadQueued = false;
      void this.load();
    });
  }

  private async readStore(): Promise<void> {
    let rows: unknown;
    try {
      rows = await ask(this.kernel, 'storage.list', { store: 'keepsakes' });
    } catch (err) {
      this.problem(err);
      return;
    }
    const stored = (Array.isArray(rows) ? rows : []).map((r: { value?: unknown }) => r?.value).filter(isKeepsake);
    const merged = new Map<string, Keepsake>(stored.map((k) => [k.id, k]));
    for (const k of this.unconfirmed.values()) merged.set(k.id, k);
    // The first load also keeps what was cast while it was running.
    if (!this.loadedOnce) for (const k of this.list) if (!merged.has(k.id)) merged.set(k.id, k);
    this.loadedOnce = true;
    const { keep, drop } = overLimit(newestFirst([...merged.values()]), KEEPSAKE_LIMIT);
    this.list = keep;
    for (const d of drop) void this.deleteStored(d.id);
  }

  private async deleteStored(id: string): Promise<void> {
    this.noteOwn(id);
    try {
      await ask(this.kernel, 'storage.delete', { store: 'keepsakes', key: id });
    } catch (err) {
      this.problem(err);
    }
  }

  private noteOwn(key: string): void {
    const now = this.kernel.now();
    for (const [k, t] of this.ownWrites) if (now - t > ECHO_WINDOW_MS) this.ownWrites.delete(k);
    this.ownWrites.set(key, now);
  }

  private isOwn(key: string): boolean {
    const t = this.ownWrites.get(key);
    return t !== undefined && this.kernel.now() - t <= ECHO_WINDOW_MS;
  }

  private problem(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    if ((err as { code?: unknown } | null)?.code === 'no-handler') this.log.info('no storage module: keepsakes last only this session');
    else this.log.warn('a storage request failed; keepsakes carry on in memory', err);
  }
}
