// The feather (Section 8: Wingardium Leviosa, "the feather lifts and follows your tip"). Everything it
// does is shared with the other small props; it differs in how it moves: it rocks freely in the air
// (sway 1) and drifts home the way a feather falls, side to side.

import { PROP_TAGS } from '../../../../contracts';
import { SpriteBank, type Sprite } from './art/canvas';
import { paintShards } from './art/common';
import { FEATHER_DUST, FEATHER_HEIGHT, FEATHER_SECRET, FEATHER_SOLID, buildFeatherArt, type FeatherArt } from './art/feather';
import { SMALL_TAGS, type PropEnv } from './base';
import { SmallProp } from './small-prop';

export class Feather extends SmallProp<FeatherArt> {
  protected readonly sway = 1;
  protected readonly glideStyle = 'feather';
  protected readonly noun = 'feather';
  protected readonly dust = [FEATHER_DUST];
  protected readonly bank = new SpriteBank(buildFeatherArt);
  protected readonly secret = FEATHER_SECRET;

  constructor(env: PropEnv) {
    super('feather', env);
  }

  /** Torn apart: its own vane and shaft in pieces on the shelf, over the down that came off it. */
  protected override buildWreck(art: FeatherArt): Sprite | null {
    return paintShards(this.env.canvas, art.body, art.heap, { seed: 23, pieces: 4, spread: 96, edge: null, jag: 1, solid: FEATHER_SOLID });
  }

  /** The feather lies flat, so it pivots and hangs from its own measured height. */
  protected override get pivot(): number {
    return FEATHER_HEIGHT / 2;
  }

  protected ownLabel(): string {
    return 'feather';
  }

  /** As PROP_START has it: 'prop.feather' as well, which Wingardium Leviosa asks for first. Shattered,
   *  it has only 'any' and 'mendable' (SmallProp.tags), and mending brings these back. */
  protected ownTags(): string[] {
    return [...SMALL_TAGS, PROP_TAGS.feather];
  }

  protected ownState(): Record<string, boolean | number | string> {
    return {};
  }
}
