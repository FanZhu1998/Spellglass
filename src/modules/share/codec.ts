// Replay links (Section 11.1 "A cast: a replay link", Section 9.4 "The first byte of a replay link is
// its format version, so old links keep opening"). A link is  <app>#cast=<base64url bytes>.
//
// Format 1, byte by byte:
//   0      format version (1)
//   1      flags: bits 0-1 via (0 gesture, 1 voice, 2 both), bit 2 the cast was a pack variant,
//          bit 3 the stroke's 64 points follow; bits 4-7 are reserved and ignored when reading
//   2      quality, in steps of 1/200 (0..200)
//   3      power, in steps of 1/200 (0..200)
//   4      duration of the stroke, in units of 32 ms (0..8160 ms; the stage replays at most 8 s)
//   5      aspect (width ÷ height of caster space), in steps of 1/64 (up to 3.98)
//   6      target prop: its index in PROP_IDS, or 255 for none
//   7..    the spell id, three characters in every two bytes (below)
//   last 128 bytes, when flag bit 3 is set: 64 points, x then y, one byte each (0..255 = 0..1)
//
// Why it is packed this tightly: Section 11.1 wants the stroke, the spell and the grade "in about 180
// characters after the #". 64 points at a byte per coordinate are 128 bytes, already 171 characters,
// so the rest has to be small. The id takes 2 bytes per 3 characters in base 40 (a-z, 0-9 and the
// hyphen are all an id may hold); the header is one byte per field. The longest seed id,
// 'petrificus-totalus' (18 characters), gives 147 bytes: 196 characters of data, 201 after the '#'.
//
// Quality and power are stored floored to a multiple of 1/200, so any grade boundary that is a
// multiple of 0.005 (the seed theme's 0.9, 0.8, 0.6 and 0.45) gives the same grade after the round trip.

import type { Point, PropId, ReplayData } from '../../contracts';
import { PROP_IDS, REPLAY_FORMAT_VERSION, REPLAY_HASH_KEY } from '../../contracts';
import { geometry } from '../../kernel';

/** Every link problem, as one plain sentence for the player (Section 10.5). */
export const LINK_MESSAGES = {
  empty: 'This link has no cast in it.',
  damaged: 'This replay link is incomplete or damaged. Copy the whole link and try again.',
  newer: 'This replay link comes from a newer edition of Spellglass. Reload the page to update, then open the link again.',
  badSpell: 'This cast cannot be put in a link: its spell id is not a plain id.',
} as const;

/** A link that cannot be read or made; the message is meant for the player. */
export class ReplayLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayLinkError';
  }
}

export const POINT_COUNT = 64;
const HEADER_BYTES = 7;
const POINT_BYTES = POINT_COUNT * 2;
const FRACTION_STEPS = 200;
const DURATION_UNIT_MS = 32;
const ASPECT_STEPS = 64;
const NO_TARGET = 255;
const VIAS = ['gesture', 'voice', 'both'] as const;
const FLAG_VARIANT = 4;
const FLAG_POINTS = 8;
const SPELL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;

// ------------------------------------------------------------------------------------- base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 base64url, without padding: safe in a URL fragment and in URLSearchParams. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

/** The bytes, or null for text that is not base64. Padding and the standard alphabet's '+' and '/'
 *  are accepted too, in case a link was re-encoded on the way. */
export function fromBase64Url(text: string): Uint8Array | null {
  const s = text.replace(/=+$/, '');
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ch === '+' ? 62 : ch === '/' ? 63 : B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

// ------------------------------------------------------------------------------------- spell ids

/** Index 0 ends an id that does not fill its last group; 38 and 39 are spare. */
const ID_CHARS = '\0abcdefghijklmnopqrstuvwxyz0123456789-';

/** Three id characters in two bytes: c0 × 1600 + c1 × 40 + c2 (at most 63999). */
export function packId(id: string): Uint8Array | null {
  if (id.length === 0 || id.length > MAX_ID_LENGTH || !SPELL_ID.test(id)) return null;
  const groups = Math.ceil(id.length / 3);
  const out = new Uint8Array(groups * 2);
  for (let g = 0; g < groups; g++) {
    let v = 0;
    for (let j = 0; j < 3; j++) {
      const ch = id[g * 3 + j];
      v = v * 40 + (ch === undefined ? 0 : ID_CHARS.indexOf(ch));
    }
    out[g * 2] = v >> 8;
    out[g * 2 + 1] = v & 0xff;
  }
  return out;
}

export function unpackId(bytes: Uint8Array): string | null {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return null;
  let id = '';
  let ended = false;
  for (let i = 0; i < bytes.length; i += 2) {
    const v = (bytes[i] << 8) | bytes[i + 1];
    if (v >= 64000 || ended) return null;
    const codes = [Math.floor(v / 1600), Math.floor(v / 40) % 40, v % 40];
    // A group never starts with the end mark: the encoder makes no empty groups.
    if (codes[0] === 0) return null;
    for (const c of codes) {
      if (c === 0) {
        ended = true;
        continue;
      }
      if (ended || c >= ID_CHARS.length) return null;
      id += ID_CHARS[c];
    }
  }
  return id.length <= MAX_ID_LENGTH && SPELL_ID.test(id) ? id : null;
}

// ---------------------------------------------------------------------------------------- points

/** Exactly 64 points: as given when there are 64, otherwise resampled evenly in isotropic space
 *  (x × aspect), so a replay keeps an even speed along the stroke. */
export function sixtyFour(points: readonly Point[], aspect: number): Point[] {
  if (points.length === POINT_COUNT) return points.map((p) => [p[0], p[1]] as Point);
  if (points.length === 0) return [];
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return geometry.fromIsotropic(geometry.resample(geometry.toIsotropic(points, a), POINT_COUNT), a);
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const toByte = (v: number) => Math.round(clamp01(v) * 255);
const fractionByte = (v: number) => Math.floor(clamp01(v) * FRACTION_STEPS + 1e-9);

// ----------------------------------------------------------------------------------- the formats

/** Encode as the current format (REPLAY_FORMAT_VERSION). */
export function encodeReplay(data: ReplayData): string {
  return toBase64Url(encodeV1(data));
}

function encodeV1(d: ReplayData): Uint8Array {
  const id = packId(d.spellId);
  if (!id) throw new ReplayLinkError(LINK_MESSAGES.badSpell);
  const aspect = d.aspect > 0 && Number.isFinite(d.aspect) ? d.aspect : 16 / 9;
  const points = sixtyFour(d.points, aspect);
  const bytes = new Uint8Array(HEADER_BYTES + id.length + (points.length ? POINT_BYTES : 0));
  const via = Math.max(0, VIAS.indexOf(d.via));
  bytes[0] = 1;
  bytes[1] = via | (d.variant ? FLAG_VARIANT : 0) | (points.length ? FLAG_POINTS : 0);
  bytes[2] = fractionByte(d.quality);
  bytes[3] = fractionByte(d.power);
  bytes[4] = Math.min(255, Math.max(0, Math.round((Number.isFinite(d.durationMs) ? d.durationMs : 0) / DURATION_UNIT_MS)));
  bytes[5] = Math.min(255, Math.max(1, Math.round(aspect * ASPECT_STEPS)));
  const target = d.target ? PROP_IDS.indexOf(d.target as PropId) : -1;
  bytes[6] = target >= 0 ? target : NO_TARGET;
  bytes.set(id, HEADER_BYTES);
  const at = HEADER_BYTES + id.length;
  points.forEach((p, i) => {
    bytes[at + i * 2] = toByte(p[0]);
    bytes[at + i * 2 + 1] = toByte(p[1]);
  });
  return bytes;
}

function decodeV1(bytes: Uint8Array): ReplayData {
  const damaged = () => new ReplayLinkError(LINK_MESSAGES.damaged);
  if (bytes.length < HEADER_BYTES + 2) throw damaged();
  const flags = bytes[1];
  const via = VIAS[flags & 3];
  if (!via) throw damaged();
  const hasPoints = (flags & FLAG_POINTS) !== 0;
  const [quality, power] = [bytes[2], bytes[3]];
  if (quality > FRACTION_STEPS || power > FRACTION_STEPS || bytes[5] === 0) throw damaged();
  const idEnd = bytes.length - (hasPoints ? POINT_BYTES : 0);
  if (idEnd < HEADER_BYTES + 2) throw damaged();
  const spellId = unpackId(bytes.subarray(HEADER_BYTES, idEnd));
  if (!spellId) throw damaged();
  const points: Point[] = [];
  if (hasPoints) for (let i = 0; i < POINT_COUNT; i++) points.push([bytes[idEnd + i * 2] / 255, bytes[idEnd + i * 2 + 1] / 255]);
  // An index past today's shelf comes from a newer shelf: the replay simply picks its own target.
  const target = bytes[6] === NO_TARGET ? undefined : PROP_IDS[bytes[6]];
  return {
    format: 1,
    spellId,
    via,
    quality: quality / FRACTION_STEPS,
    power: power / FRACTION_STEPS,
    variant: (flags & FLAG_VARIANT) !== 0,
    durationMs: bytes[4] * DURATION_UNIT_MS,
    aspect: bytes[5] / ASPECT_STEPS,
    points,
    ...(target ? { target } : {}),
  };
}

/** Readers for every format ever written, by their first byte. Old links keep opening: a new format
 *  adds a decoder here and leaves the old ones alone. */
export const DECODERS: Readonly<Record<number, (bytes: Uint8Array) => ReplayData>> = { 1: decodeV1 };

/** Decode the data part of a link (after 'cast='). Throws ReplayLinkError with a plain message. */
export function decodeReplay(data: string): ReplayData {
  if (!data) throw new ReplayLinkError(LINK_MESSAGES.empty);
  const bytes = fromBase64Url(data);
  if (!bytes || bytes.length === 0) throw new ReplayLinkError(LINK_MESSAGES.damaged);
  const decoder = DECODERS[bytes[0]];
  if (!decoder) throw new ReplayLinkError(bytes[0] > REPLAY_FORMAT_VERSION ? LINK_MESSAGES.newer : LINK_MESSAGES.damaged);
  return decoder(bytes);
}

// ----------------------------------------------------------------------------------------- links

/**
 * The data of a replay link from what the player has: a whole URL, the fragment with or without its
 * '#', 'cast=…' among other parameters, or the bare data. Null when there is no cast in it.
 */
export function replayParam(input: string): string | null {
  let s = String(input ?? '').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  if (!s) return null;
  for (const part of s.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && decodeSafe(part.slice(0, eq)) === REPLAY_HASH_KEY) return decodeSafe(part.slice(eq + 1)).trim();
  }
  return /^[A-Za-z0-9_\-+/]+=*$/.test(s) ? s : null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Read a link (any form replayParam takes). Throws ReplayLinkError with a plain message. */
export function parseLink(input: string): ReplayData {
  const data = replayParam(input);
  if (data === null) throw new ReplayLinkError(LINK_MESSAGES.empty);
  return decodeReplay(data);
}

/** The link for a cast: the app's address with '#cast=<data>'. `hash` is the part after the '#'. */
export function linkFor(appUrl: string, data: ReplayData): { url: string; hash: string } {
  const hash = `${REPLAY_HASH_KEY}=${encodeReplay(data)}`;
  return { url: `${appUrl.split('#')[0]}#${hash}`, hash };
}

// ------------------------------------------------------------------------------- checking a replay

/**
 * ReplayData handed to 'share.replay' from outside (normally share.parse's result), checked and
 * tidied: numbers clamped, points cleaned. Throws ReplayLinkError when it cannot be played.
 */
export function checkReplayData(input: unknown): ReplayData {
  const bad = () => new ReplayLinkError(LINK_MESSAGES.damaged);
  if (typeof input !== 'object' || input === null) throw bad();
  const d = input as Partial<Record<keyof ReplayData, unknown>>;
  if (typeof d.spellId !== 'string' || !SPELL_ID.test(d.spellId) || d.spellId.length > MAX_ID_LENGTH) throw bad();
  const via = d.via === undefined ? 'gesture' : d.via;
  if (via !== 'gesture' && via !== 'voice' && via !== 'both') throw bad();
  const points: Point[] = [];
  if (d.points !== undefined) {
    if (!Array.isArray(d.points) || d.points.length > 256) throw bad();
    for (const p of d.points) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw bad();
      points.push([Number(p[0]), Number(p[1])]);
    }
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const aspect = num(d.aspect, 16 / 9);
  const target = typeof d.target === 'string' && (PROP_IDS as readonly string[]).includes(d.target) ? d.target : undefined;
  return {
    format: num(d.format, REPLAY_FORMAT_VERSION),
    spellId: d.spellId,
    via,
    quality: clamp01(num(d.quality, 0)),
    power: clamp01(num(d.power, 0)),
    variant: d.variant === true,
    durationMs: Math.max(0, num(d.durationMs, 0)),
    aspect: aspect > 0 ? aspect : 16 / 9,
    points,
    ...(target ? { target } : {}),
  };
}
