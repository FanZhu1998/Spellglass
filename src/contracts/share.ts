// contracts/share.ts
//
// A cast as a replay link (Section 11.1): the stroke (64 points, one byte per coordinate), the
// spell and the grade fit in about 180 characters after the '#'. The first byte of the encoded
// data is its format version, so old links keep opening (Section 9.4).

import type { Point } from './packs';

export const REPLAY_FORMAT_VERSION = 1;

/** Links look like  https://host/app/#cast=<base64url>  */
export const REPLAY_HASH_KEY = 'cast';

export interface ReplayData {
  format: number;
  spellId: string;
  via: 'gesture' | 'voice' | 'both';
  quality: number;        // 0..1
  power: number;          // 0..1
  /** True when the cast was a pack variant (such as Lumos Maxima). */
  variant: boolean;
  durationMs: number;
  aspect: number;
  /** 64 points in caster space; empty for voice-only casts. */
  points: Point[];
  /** The prop the cast acted on (one byte: its index in PROP_IDS), so the replay hits the same prop. */
  target?: string;
}

export interface ShareResult {
  /** 'shared' through the system share sheet, 'downloaded' as a file, or 'copied' to the clipboard. */
  outcome: 'shared' | 'downloaded' | 'copied' | 'cancelled';
}
