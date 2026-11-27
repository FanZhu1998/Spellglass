// What the storage module says when IndexedDB cannot be used (Section 7.9: "Storage is blocked or
// full: runs without saving and says so"), and how it tells a storage failure from a bad request.
// Pure: no browser API is touched here.

import type { StorageStatus } from '../../contracts';
import { RefusedWrite } from './backend';

export type MemoryReason = NonNullable<StorageStatus['reason']>;

/** One plain sentence each for the status area (Section 10.5: instructions stay plain). */
export const STORAGE_MESSAGES = {
  unsupported: 'This browser offers no storage, so Spellglass runs without saving.',
  blocked: 'Storage is blocked, so Spellglass runs without saving.',
  /** The open neither finished nor reported a problem in time. */
  noAnswer: 'Storage did not respond, so Spellglass runs without saving.',
  full: 'Storage is full, so Spellglass runs without saving.',
  /** The browser closed the connection (site data cleared, storage evicted, a disk error). */
  closed: 'Storage was closed, so Spellglass runs without saving until you reload.',
  /** Another tab asked for a newer database layout, so this tab let go of it. */
  otherTab: 'Another Spellglass tab took over storage, so this tab runs without saving.',
  /** A request whose own value or key the store would not take ('invalid-payload'). */
  refused: 'This value or key cannot be saved.',
} as const;

/** A request that cannot be stored as asked (a value that cannot be cloned, a bad key, a write a store
 *  refused). These are the caller's problem: the module rejects them with 'invalid-payload' instead
 *  of giving up on IndexedDB. */
export function isCallerError(err: unknown): boolean {
  if (err instanceof RefusedWrite) return true;
  const name = errorName(err);
  return name === 'DataCloneError' || name === 'DataError';
}

/** Why an operation on an open database failed, as a StorageStatus reason. */
export function reasonForOperationError(err: unknown): MemoryReason {
  const name = errorName(err);
  if (name === 'QuotaExceededError') return 'full';
  // InvalidStateError (the connection is closing), TransactionInactiveError, AbortError without a
  // quota cause, UnknownError (Chromium reports disk trouble this way), NotFoundError, a timeout:
  // the database cannot be trusted for the rest of the session.
  return 'closed';
}

/** Why opening the database failed. */
export function reasonForOpenError(err: unknown): MemoryReason {
  const name = errorName(err);
  if (name === 'QuotaExceededError') return 'full';
  // SecurityError (sandboxed frames, blocked cookies), InvalidStateError (older private modes),
  // UnknownError, VersionError and anything else: storage is not available to this page.
  return 'blocked';
}

export function messageFor(reason: MemoryReason): string {
  switch (reason) {
    case 'unsupported': return STORAGE_MESSAGES.unsupported;
    case 'full': return STORAGE_MESSAGES.full;
    case 'closed': return STORAGE_MESSAGES.closed;
    default: return STORAGE_MESSAGES.blocked;
  }
}

export function errorName(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string') return (err as { name: string }).name;
  return '';
}

/** Thrown by the module's own timeouts, so they classify like any other failure. */
export class StorageTimeout extends Error {
  constructor(what: string) {
    super(`${what} did not finish in time`);
    this.name = 'TimeoutError';
  }
}

/** Resolve or reject with `p`, or reject with StorageTimeout after `ms`. The timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StorageTimeout(what)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
