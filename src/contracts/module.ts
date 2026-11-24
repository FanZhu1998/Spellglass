// contracts/module.ts
//
// How modules plug into the kernel. A module declares what it provides and needs, and speaks
// only through events (publish/subscribe) and named requests. Modules never import each other.

export type ModuleKind =
  | 'tracker' | 'segmenter' | 'recognizer' | 'voice'
  | 'engine' | 'effect' | 'scene' | 'share' | 'storage'
  /** @since 1.1 */ | 'capture'
  /** @since 1.1 */ | 'diagnostics';

export interface ModuleManifest {
  id: string;              // 'tracker.bright-tip'
  kind: ModuleKind;
  version: string;         // semantic version of this module
  contract: string;        // contract range it speaks, e.g. '^1.0'
  provides: string[];      // capabilities, e.g. ['tip.source']
  requires?: string[];     // e.g. ['platform.camera']
  //                          @since 1.1: requirements may name other modules' capabilities; the kernel
  //                          resolves availability to a fixpoint over platform features and provides.
  /** @since 1.1 Effect step `use` names this module implements (effect modules only),
   *  e.g. ['light.orb', 'scene.dim']. The pack loader skips steps no module implements. */
  effects?: string[];
  /** @since 1.1 Short human-readable name for the Workshop and Threshold screens. */
  title?: string;
  /** @since 1.1 Offer this module as a choice (trackers on the Threshold screen). Default true;
   *  the replay tracker sets false. */
  selectable?: boolean;
}

export interface Envelope<T = unknown> {
  type: string;            // 'tip.sample', 'spell.cast', ...
  v: number;               // payload version for this type
  t: number;
  source: string;          // module id
  payload: T;
}

/**
 * @since 1.1 delivery rules:
 * - Run to completion. publish() from inside a handler queues the event; it is delivered, first in
 *   first out, after the current event has reached every subscriber. A top-level publish() delivers
 *   the whole cascade before it returns. So 'stroke.end' reaches every subscriber before the
 *   'recognition.result' a recognizer publishes in response, whatever the registration order.
 * - last(type) is updated when an event is published, before it is delivered.
 * - Keep handlers short: record state and schedule work; draw in requestAnimationFrame.
 */
export interface Kernel {
  publish<T>(e: Envelope<T>): void;
  /** Subscribe to one event type. The type '*' receives every envelope (diagnostics only). */
  subscribe<T>(type: string, fn: (e: Envelope<T>) => void): () => void;
  /** Capability check. 'fx.light@1' is met by any provider of 'fx.light@1' or a higher version. */
  has(capability: string): boolean;
  setting<T>(key: string, fallback: T): T;

  /** @since 1.1 The most recent envelope of a type, for state-like events (all but NON_STICKY_EVENTS). */
  last<T>(type: string): Envelope<T> | undefined;
  /** @since 1.1 Ask whichever module handles `name` (see RequestMap). Rejects with KernelError
   *  code 'no-handler' when nothing handles it. The handler runs synchronously up to its first
   *  await, so a request made straight from a click keeps the click's user activation. */
  request<R = unknown>(name: string, payload?: unknown): Promise<R>;
  /** @since 1.1 Handle a named request. One handler per name; returns an unregister function.
   *  Register in init() so other modules can ask from their start() on (requests made during
   *  another module's init() may find no handler yet). Trackers register their 'tracker.*'
   *  handlers in start() and remove them in stop(), so those requests reach the active tracker. */
  handle(name: string, fn: (payload: any, from?: string) => unknown | Promise<unknown>): () => void;
  /** @since 1.1 The clock that capture times use (performance.now() in the browser). Modules derive
   *  decisions from event capture times; timers (setTimeout/setInterval) are only wake-ups. */
  now(): number;
}

export interface Module {
  manifest: ModuleManifest;
  /** Register request handlers and subscriptions. Runs once, before packs load. */
  init(kernel: Kernel): Promise<void>;
  /** Begin work: open devices, start loops. May run again after stop().
   *  @since 1.1: start() resolves promptly. It never waits on a permission prompt, a download or a
   *  device opening: that work continues in the background and is reported through the module's
   *  status events. stop() cancels it. A camera.start that resolves after stop() is released at once.
   *  A module whose camera or other device is unavailable does not fail start(); it reports the
   *  problem and recovers when the device becomes available. The kernel gives up on a start() or
   *  stop() that has not settled after a few seconds and marks the module 'error'. */
  start(): Promise<void>;
  /** Release devices and timers. The module may be started again later. */
  stop(): Promise<void>;
}

/** @since 1.1 Lifecycle state reported in `module.status`. */
export type ModuleState = 'registered' | 'initialized' | 'running' | 'stopped' | 'unavailable' | 'error';

/** @since 1.1 Error codes the kernel uses when rejecting requests. */
export type KernelErrorCode = 'no-handler' | 'handler-failed' | 'invalid-payload' | 'not-supported' | 'timeout';
