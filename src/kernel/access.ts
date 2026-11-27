// Access settings that several modules must read the same way (Section 10.6).

import type { Kernel } from '../contracts';
import { on } from './typed';

function systemPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Reduced motion is on when the setting says 'on', or 'system' and the system asks for it. */
export function isReducedMotion(kernel: Kernel): boolean {
  const m = kernel.setting<'system' | 'on' | 'off'>('access.reducedMotion', 'system');
  if (m === 'on') return true;
  if (m === 'off') return false;
  return systemPrefersReducedMotion();
}

/** Call fn(now) at once and whenever reduced motion changes (setting or system). Returns unsubscribe. */
export function watchReducedMotion(kernel: Kernel, fn: (reduced: boolean) => void): () => void {
  let last = isReducedMotion(kernel);
  fn(last);
  const check = () => {
    const now = isReducedMotion(kernel);
    if (now !== last) {
      last = now;
      fn(now);
    }
  };
  const off = on(kernel, 'settings.changed', ({ key }) => {
    if (key === 'access.reducedMotion') check();
  });
  let mql: MediaQueryList | null = null;
  try {
    mql = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    mql?.addEventListener?.('change', check);
  } catch {
    mql = null;
  }
  return () => {
    off();
    mql?.removeEventListener?.('change', check);
  };
}
