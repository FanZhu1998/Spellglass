// The app's other tabs and windows on this device (an installed window beside a tab, a replay link
// opened in a new tab). They share one database, but each keeps copies of some stores in memory: the
// pack service keeps progress, the recognizer samples, share the keepsakes. 'storage.changed' reaches
// only the kernel of the tab that wrote, so without telling the others a tab that is behind would
// show, and then count on from, what it read at boot. So each committed change is also posted on a
// BroadcastChannel (same origin only, like the database), and a change another tab posted is
// published here as 'storage.changed' with reason 'other-tab' (contracts/events.ts), which those
// modules take as a reason to reload.
//
// Only what reached IndexedDB is shared: a tab that runs from memory (Section 7.9) posts nothing, and
// publishes nothing of the others, whose database it no longer reads. A tab never hears its own
// posts, and what it hears is published here, never posted again, so a change never comes back.

import type { StorageChanged, StoreName } from '../../contracts';
import { newId } from '../../kernel';
import { isStoreName } from './records';

/** The part of BroadcastChannel the relay uses. */
export interface TabChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** What a tab posts. A BroadcastChannel never hands a post back to the channel that sent it; `from`
 *  makes sure of that whatever the channel is, since this tab's own change coming back as 'other-tab'
 *  would make its modules reload for nothing. */
interface TabMessage {
  from: string;
  stores: StoreName[];
  keys?: string[];
}

export interface TabRelayOptions {
  /** Opens the channel; null when the browser has none. */
  open: (name: string) => TabChannel | null;
  /** The database the tabs share: one channel per database. */
  dbName: string;
  /** Which store this tab uses now (StorageCore.mode(); null until the database is first opened). */
  mode: () => 'indexeddb' | 'memory' | null;
  /** Publish a change another tab made. */
  heard: (change: StorageChanged) => void;
  onError?: (what: string, err: unknown) => void;
}

export class TabRelay {
  private channel: TabChannel | null = null;
  private readonly id = newId('tab');

  constructor(private readonly opts: TabRelayOptions) {}

  /** Start listening and posting (init, and start after a stop). */
  open(): void {
    if (this.channel) return;
    let channel: TabChannel | null;
    try {
      channel = this.opts.open(`${this.opts.dbName}:storage`);
    } catch (err) {
      // A page that may not use BroadcastChannel still saves; it just cannot tell its other tabs.
      this.opts.onError?.('could not open the channel to the other tabs', err);
      return;
    }
    if (!channel) return;
    channel.addEventListener('message', (event) => {
      if (this.channel !== channel || this.opts.mode() === 'memory') return;
      const change = readMessage(event.data, this.id);
      if (change) this.opts.heard(change);
    });
    this.channel = channel;
  }

  /** Stop listening and posting (stop). */
  close(): void {
    const channel = this.channel;
    this.channel = null;
    try {
      channel?.close();
    } catch {
      /* already closed */
    }
  }

  /** Tell the other tabs about a change this tab committed. */
  post(change: StorageChanged): void {
    if (!this.channel || this.opts.mode() !== 'indexeddb') return;
    const message: TabMessage = { from: this.id, stores: change.stores, ...(change.keys ? { keys: change.keys } : {}) };
    try {
      this.channel.postMessage(message);
    } catch (err) {
      this.opts.onError?.('could not tell the other tabs about a change', err);
    }
  }
}

/** The change a message from another tab announces, or null for one of this tab's own posts and for
 *  anything else. Another tab may run another edition of the app, so stores this one does not know
 *  are dropped, and keys are kept only when they are all text (without them, whole stores reload). */
export function readMessage(data: unknown, ownId: string): StorageChanged | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Partial<Record<keyof TabMessage, unknown>>;
  if (typeof m.from !== 'string' || m.from === ownId || !Array.isArray(m.stores)) return null;
  const stores = [...new Set(m.stores.filter(isStoreName))];
  if (!stores.length) return null;
  const keys = Array.isArray(m.keys) && m.keys.length && m.keys.every((k) => typeof k === 'string') ? (m.keys as string[]) : undefined;
  return { stores, reason: 'other-tab', ...(keys ? { keys } : {}) };
}
