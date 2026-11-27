// Small shared types for the Workshop.

import type { StatusKind } from '../status';

export type { StatusKind };

/** A result in words and in shape (StatusLine), never by color alone (Section 10.6). */
export interface Note {
  kind: StatusKind;
  text: string;
}

export type WorkshopTab = 'settings' | 'packs' | 'gestures' | 'bindings' | 'data' | 'diagnostics';

export const WORKSHOP_TABS: readonly WorkshopTab[] = ['settings', 'packs', 'gestures', 'bindings', 'data', 'diagnostics'];

export function isWorkshopTab(value: unknown): value is WorkshopTab {
  return typeof value === 'string' && (WORKSHOP_TABS as readonly string[]).includes(value);
}

/** Speaks a result through the Workshop's live region. */
export type Announce = (text: string) => void;
