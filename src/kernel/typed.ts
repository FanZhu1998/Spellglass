// Typed helpers over the Kernel contract. Modules may import these (modules depend on kernel).

import type {
  Envelope, EventMap, EventType, Kernel, RequestName, RequestPayload, RequestResult, SettingKey, SettingsMap,
} from '../contracts';
import { DEFAULT_SETTINGS, eventVersion } from '../contracts';

/** Publish a typed event. `t` defaults to now on the kernel clock; pass capture time for tip data. */
export function emit<K extends EventType>(kernel: Kernel, source: string, type: K, payload: EventMap[K], t?: number): void {
  kernel.publish<EventMap[K]>({ type, v: eventVersion(type), t: t ?? kernel.now(), source, payload });
}

/** Subscribe to a typed event. Returns the unsubscribe function. */
export function on<K extends EventType>(
  kernel: Kernel,
  type: K,
  fn: (payload: EventMap[K], envelope: Envelope<EventMap[K]>) => void,
): () => void {
  return kernel.subscribe<EventMap[K]>(type, (e) => fn(e.payload, e));
}

/** The payload of the most recent event of a type, if any. */
export function lastPayload<K extends EventType>(kernel: Kernel, type: K): EventMap[K] | undefined {
  return kernel.last<EventMap[K]>(type)?.payload;
}

type PayloadArgs<N extends RequestName> = undefined extends RequestPayload<N> ? [payload?: RequestPayload<N>] : [payload: RequestPayload<N>];

/** Make a typed request. */
export function ask<N extends RequestName>(kernel: Kernel, name: N, ...args: PayloadArgs<N>): Promise<RequestResult<N>> {
  return kernel.request<RequestResult<N>>(name, args[0]);
}

/** Handle a typed request. */
export function serve<N extends RequestName>(
  kernel: Kernel,
  name: N,
  fn: (payload: RequestPayload<N>, from?: string) => RequestResult<N> | Promise<RequestResult<N>>,
): () => void {
  return kernel.handle(name, fn as (p: unknown, from?: string) => unknown);
}

/** Read a typed setting, falling back to the contract default. */
export function setting<K extends SettingKey>(kernel: Kernel, key: K): SettingsMap[K] {
  return kernel.setting<SettingsMap[K]>(key, DEFAULT_SETTINGS[key]);
}

/** Write a typed setting through the kernel. */
export function setSetting<K extends SettingKey>(kernel: Kernel, key: K, value: SettingsMap[K]): Promise<void> {
  return kernel.request<void>('settings.set', { key, value });
}

/** Call fn now and whenever any of the keys change. Returns the unsubscribe function. */
export function watchSettings(kernel: Kernel, keys: readonly SettingKey[], fn: () => void): () => void {
  fn();
  return on(kernel, 'settings.changed', ({ key }) => {
    if ((keys as readonly string[]).includes(key)) fn();
  });
}
