// contracts/scene.ts
//
// The shelf of props along the bottom of the mirror (Section 7.8). The stage publishes the
// current props as the sticky event `scene.props`; the spell engine reads it to pick a target
// ("a spell that acts on something picks the prop nearest to where the stroke ended").

export type PropId = 'candle' | 'feather' | 'box' | 'teacup' | 'plant' | 'dummy';
export const PROP_IDS: readonly PropId[] = ['candle', 'feather', 'box', 'teacup', 'plant', 'dummy'];

export interface PropInfo {
  id: PropId | string;
  label: string;               // 'candle', 'locked box', 'cracked teacup'
  /** Centre of the prop in caster space. Props move when levitated, pulled or pushed. */
  x: number;
  y: number;
  /** Rough radius in caster-x units, for hit tests and target highlights. */
  r: number;
  /** Current tags. They change with state: an open box is no longer 'prop.lockable'. */
  tags: string[];
  /** Small, display-only state flags such as { lit: true } or { locked: false }. */
  state: Record<string, boolean | number | string>;
}

export interface SceneProps {
  revision: number;
  /** Width ÷ height of caster space, so consumers can compare distances isotropically. */
  aspect: number;
  props: PropInfo[];
}

/** Tags packs may target. A prop can carry several. */
export const PROP_TAGS = {
  any: 'prop.any',                    // every prop
  movable: 'prop.movable',
  levitatable: 'prop.levitatable',
  lockable: 'prop.lockable',          // the box while locked
  mendable: 'prop.mendable',          // the cracked teacup, and any prop that was blasted
  breakable: 'prop.breakable',        // can be blasted by Reducto
  flammable: 'prop.flammable',        // the candle while unlit
  burning: 'prop.burning',            // the candle while lit
  scalable: 'prop.scalable',
  dummy: 'prop.dummy',                // the wooden training dummy
  /** @since 1.1 The feather, so a spell can ask for it first ("The feather lifts", Section 8). */
  feather: 'prop.feather',
} as const;

/** Where each prop rests on the shelf, in caster space (left to right as seen in the mirror). */
export const SHELF_LAYOUT: Record<PropId, { x: number; y: number }> = {
  candle: { x: 0.12, y: 0.86 },
  feather: { x: 0.27, y: 0.9 },
  box: { x: 0.42, y: 0.87 },
  teacup: { x: 0.57, y: 0.89 },
  plant: { x: 0.72, y: 0.85 },
  dummy: { x: 0.88, y: 0.8 },
};

const T = PROP_TAGS;
const SMALL = [T.any, T.movable, T.levitatable, T.scalable, T.breakable];

/** How each prop starts. Tag changes: unlocking removes 'lockable' (relocking adds it back);
 *  igniting swaps 'flammable' for 'burning' and dousing swaps back; mending a cracked teacup removes
 *  'mendable'; shattering (prop.scale factor 0) leaves only 'any' and 'mendable' until mended, then
 *  restores the prop's tags. The dummy is too heavy to move or levitate and is never shattered. */
export const PROP_START: Record<PropId, { label: string; tags: string[]; state: Record<string, boolean | number | string> }> = {
  candle: { label: 'candle', tags: [...SMALL, T.flammable], state: { lit: false } },
  feather: { label: 'feather', tags: [...SMALL, T.feather], state: {} },
  box: { label: 'locked box', tags: [...SMALL, T.lockable], state: { locked: true } },
  teacup: { label: 'cracked teacup', tags: [...SMALL, T.mendable], state: { cracked: true } },
  plant: { label: 'potted plant', tags: [...SMALL], state: {} },
  dummy: { label: 'training dummy', tags: [T.any, T.dummy, T.scalable], state: {} },
};
