// What keeps a pack from a friend safe to open, beside the size limit in contracts/packs.ts (Section
// 9.2: "a size limit. That is what makes a pack from a friend safe to open"): how deeply a pack may
// nest, and how many gesture templates it may ask the recognizer to build. checkPack applies both to
// every pack, bundled, stored or imported, so a pack over either is skipped with the reason (Section
// 7.9). The player's drawings take their spells' places too, and a data file can bring them in, so
// they have a template limit of their own (drawingReason). Pure functions.

import type { Gesture, GesturePack, PackKind, SpellPack, ThemePack } from '../../contracts';
import { DEFAULT_START_POINTS } from '../../contracts';
import { KIND_NAMES } from './types';

/** How deeply a pack may nest lists and objects. The deepest thing a pack needs is a point of a
 *  gesture path, seven levels down, and unknown fields may add a few. A file far under the size limit
 *  can nest thousands deep, and then everything that copies, hashes or saves it recursively overflows
 *  the stack: the gesture key, structured cloning, IndexedDB. The bound leaves room for the levels a
 *  pack gains when it is saved (a stored record adds one, a data export five), so a pack that is
 *  accepted can always be saved and exported. */
export const PACK_DEPTH_LIMIT = 32;

/** How deeply `value` nests lists and objects: 0 for a plain value, 1 for {} or [], and so on. The
 *  walk keeps its own stack, so measuring a hostile file cannot overflow the call stack, and it stops
 *  as soon as it passes `limit`, so the answer is then just "more than limit". */
export function nestingDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth > deepest) {
      deepest = depth;
      if (deepest > limit) return deepest;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return deepest;
}

/** Why a parsed pack file nests too deeply, or null. */
export function depthReason(json: unknown): string | null {
  return nestingDepth(json, PACK_DEPTH_LIMIT) > PACK_DEPTH_LIMIT
    ? `The file is nested too deeply: a pack may nest lists and objects at most ${PACK_DEPTH_LIMIT} levels deep.`
    : null;
}

/** Template budget (Section 13: no main-thread task over 50 ms while casting). The recognizer builds
 *  the templates of every available spell, locked ones too, whenever the spellbook changes, and
 *  compares every stroke with those of the enabled ones. The schema's limits multiply: 200 spells,
 *  16 paths each, up to 32 start points per path, so a pack of a few hundred KB could ask for 51,200
 *  templates, over a second of work at every launch and a slow match for every stroke. A budget in
 *  the checks refuses such a pack and leaves spellpack/1 as it is, so no pack that is valid today
 *  becomes invalid (Section 9.1 rule 2). The shipped packs use at most 12 per spell and 23 per pack. */
export const TEMPLATES_PER_SPELL = 64;
export const TEMPLATES_PER_PACK = 2000;

/** The template recognizer expands a path into at most this many start points, whatever the pack
 *  asks for, so more are not counted. */
const START_POINTS_COUNTED = 16;

/** How many templates a gesture becomes, at most: one line for a flick, else one per path, times its
 *  start points when any_start is set (a path that turns out not to be a closed loop gets just one).
 *  `inherits`: the gesture is a gesture pack's, so any_start and start_points it leaves unset come
 *  from the spell's own gesture (drawing.ts inheritFromPack), which a pack check cannot see; they are
 *  counted at the most they could be, or a layer could multiply its paths past the budget. */
export function templateCount(g: Gesture, inherits = false): number {
  if ('flick' in g) return 1;
  const paths = 'paths' in g && Array.isArray(g.paths) ? g.paths.length : 1;
  if (g.any_start === false || (g.any_start === undefined && !inherits)) return paths;
  const asked = g.start_points ?? (inherits ? START_POINTS_COUNTED : DEFAULT_START_POINTS);
  return paths * Math.min(START_POINTS_COUNTED, Math.max(1, Math.floor(asked)));
}

/** Why a checked pack asks for too many templates, or null. A gesture pack's gestures are counted at
 *  the most they can become once they take the spell's start points ("can have up to"). */
export function templateReason(kind: PackKind, pack: SpellPack | ThemePack | GesturePack): string | null {
  const inherits = kind === 'gesturepack';
  const gestures: [label: string, gesture: Gesture][] =
    kind === 'spellpack' ? (pack as SpellPack).spells.map((s) => [`spell "${s.id}"`, s.gesture])
      : kind === 'gesturepack' ? Object.entries((pack as GesturePack).gestures).map(([id, g]) => [`the gesture for "${id}"`, g])
        : [];
  const kindName = KIND_NAMES[kind];
  const has = inherits ? 'can have up to' : 'has';
  let total = 0;
  for (const [label, gesture] of gestures) {
    const n = templateCount(gesture, inherits);
    if (n > TEMPLATES_PER_SPELL) {
      return `This ${kindName} is too complex to match quickly: ${label} ${has} ${n} gesture templates, and a spell may have at most ${TEMPLATES_PER_SPELL}.`;
    }
    total += n;
  }
  return total > TEMPLATES_PER_PACK
    ? `This ${kindName} is too complex to match quickly: it ${has} ${total} gesture templates, and a pack may have at most ${TEMPLATES_PER_PACK}.`
    : null;
}

/** The most templates a drawing of the player's (store 'overrides') may have: what one stroke becomes,
 *  one path with at most 16 start points. A drawing takes its spell's place, and the Workshop saves
 *  one stroke, so a player never draws more. A data file (Import) brings drawings in as untrusted as a
 *  pack, and no pack budget covers them: 16 loops with 16 start points are 256 templates for one
 *  spell. Even a spell's share (64) would let a file of drawings for a friend's pack of 200 cheap
 *  spells ask for 12,800, about a second of work at every launch; this keeps it to 3,200. */
export const TEMPLATES_PER_DRAWING = START_POINTS_COUNTED;

/** Why a drawing has more templates than one stroke makes, or null. It is counted at the most it can
 *  become: the start points it leaves unset come from whichever pack has its spell when the spellbook
 *  is built (spellbook.ts effectiveGesture). */
export function drawingReason(g: Gesture): string | null {
  const n = templateCount(g, true);
  return n > TEMPLATES_PER_DRAWING
    ? `This drawing is too complex to match quickly: it can have up to ${n} gesture templates, and a drawing, which is one stroke, may have at most ${TEMPLATES_PER_DRAWING}.`
    : null;
}
