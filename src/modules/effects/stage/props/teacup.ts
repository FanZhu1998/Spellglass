// The teacup (Section 8: Reparo, "the cracked teacup knits together"). Starts cracked (PROP_START:
// 'cracked teacup', tags + 'prop.mendable', { cracked: true }). prop.mend knits the crack from its foot
// up to the chip in the rim: the knitted part turns to a line of gold, the mending edge glows, a glint
// closes it, and the glow fades a moment later into a fine gold seam that stays, as mended china
// keeps its seams. Mending a whole cup does nothing (false: the core plays its sparkle); Reducto then
// Reparo still works on it. reset() brings back the crack.

import { PROP_TAGS } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, StageServices } from '../types';
import { drawSprite, SpriteBank, type Sprite } from './art/canvas';
import { paintShards } from './art/common';
import { PAL } from './art/paint';
import {
  CHIP_AT, CRACK_BOTTOM, CRACK_BOX, CRACK_TOP, TEACUP_DUST, TEACUP_SECRET, TEACUP_SOLID, buildTeacupArt, crackXAt, type TeacupArt,
} from './art/teacup';
import { SMALL_TAGS, type PropEnv } from './base';
import { clamp01, easeInOut, lerp } from './motion';
import { SmallProp } from './small-prop';

const T = PROP_TAGS;
/** The knit itself, then its glow fading into the seam (local ms; three times quicker under reduced
 *  motion). */
const KNIT_MS = 900;
const SEAM_MS = 700;
export const MEND_MS = KNIT_MS + SEAM_MS;
const REDUCED_SPEEDUP = 3;
const KNIT_GLOW = '#FFD27A';

export class Teacup extends SmallProp<TeacupArt> {
  protected readonly sway = 0.4;
  protected readonly glideStyle = 'float';
  protected readonly noun = 'teacup';
  protected readonly dust = [TEACUP_DUST, PAL.gilt];
  protected readonly bank = new SpriteBank(buildTeacupArt);
  protected readonly secret = TEACUP_SECRET;

  private cracked = true;
  /** Local ms since the mend began; MEND_MS or more when not mending. */
  private knitAge = MEND_MS;

  constructor(env: PropEnv) {
    super('teacup', env);
  }

  /** Shards of china, cup and saucer, white where they broke through the glaze. */
  protected override buildWreck(art: TeacupArt): Sprite | null {
    return paintShards(this.env.canvas, art.body, art.heap, { seed: 47, pieces: 6, spread: 76, edge: 'rgba(251,248,242,0.95)', solid: TEACUP_SOLID });
  }

  get isCracked(): boolean {
    return this.cracked;
  }

  protected ownLabel(): string {
    return this.cracked ? 'cracked teacup' : 'teacup';
  }

  protected ownTags(): string[] {
    return this.cracked ? [...SMALL_TAGS, T.mendable] : [...SMALL_TAGS];
  }

  protected ownState(): Record<string, boolean | number | string> {
    return { cracked: this.cracked };
  }

  protected override applyOwn(use: string, action: PropAction, services: StageServices): boolean {
    if (use === 'prop.mend') {
      if (!this.cracked) return false;
      this.cracked = false;
      this.knitAge = 0;
      this.changed();
      return true;
    }
    return super.applyOwn(use, action, services);
  }

  protected override resetOwn(): void {
    this.cracked = true;
    this.knitAge = MEND_MS;
  }

  /** The crack has knitted and the glow of its gold seam has faded. */
  protected override ownSettled(): boolean {
    return this.knitAge >= MEND_MS;
  }

  protected override advanceOwn(dt: number): void {
    if (this.knitAge < MEND_MS) this.knitAge = Math.min(MEND_MS, this.knitAge + dt * (this.reduced ? REDUCED_SPEEDUP : 1));
  }

  protected override drawBody(layers: Layers, _frame: FrameInfo, services: StageServices, art: TeacupArt, size: number, alpha: number): void {
    const shade = layers.shade;
    const mending = !this.cracked && this.knitAge < MEND_MS;
    const knitting = mending && this.knitAge < KNIT_MS;
    const u = clamp01(this.knitAge / KNIT_MS);
    // The mending edge climbs from the crack's foot to the rim, past the chip.
    const edgeY = lerp(CRACK_BOTTOM, CRACK_TOP - 8, easeInOut(u));
    const bw = CRACK_BOX.x1 - CRACK_BOX.x0;
    this.beginBody(shade, size);
    if (alpha < 1) shade.globalAlpha = alpha;
    drawSprite(shade, art.body);
    if (this.cracked) drawSprite(shade, art.crack);
    else if (knitting) {
      // Still cracked above the mending edge; the gold seam has set below it.
      shade.save();
      shade.beginPath();
      shade.rect(CRACK_BOX.x0, CRACK_BOX.y0, bw, edgeY - CRACK_BOX.y0);
      shade.clip();
      drawSprite(shade, art.crack);
      shade.restore();
      shade.save();
      shade.beginPath();
      shade.rect(CRACK_BOX.x0, edgeY, bw, CRACK_BOX.y1 - edgeY);
      shade.clip();
      drawSprite(shade, art.seam);
      shade.restore();
    } else {
      drawSprite(shade, art.seam);
    }
    this.drawInk(shade, art.ink, alpha);
    shade.restore();
    if (!mending) return;

    const light = layers.light;
    this.beginBody(light, size);
    if (knitting) {
      // Gold along what has knitted so far, brightest at the mending edge.
      light.save();
      light.beginPath();
      light.rect(CRACK_BOX.x0, edgeY, bw, CRACK_BOX.y1 - edgeY);
      light.clip();
      light.globalAlpha = 0.6 * alpha;
      drawSprite(light, art.crackGold);
      light.restore();
      light.save();
      light.beginPath();
      light.rect(CRACK_BOX.x0, edgeY - 6, bw, 9);
      light.clip();
      light.globalAlpha = alpha;
      drawSprite(light, art.crackGold);
      light.restore();
      const gx = crackXAt(edgeY);
      light.globalAlpha = 0.95 * alpha;
      light.drawImage(services.glow(KNIT_GLOW), gx - 21, edgeY - 21, 42, 42);
    } else {
      // The seam glows a moment, then settles into plain gold on the china.
      const v = clamp01((this.knitAge - KNIT_MS) / SEAM_MS);
      light.globalAlpha = 0.6 * (1 - v) * (1 - v) * alpha;
      drawSprite(light, art.crackGold);
    }
    const common = this.env.common.get(this.env.canvas);
    // The glint that closes the crack, at the chip in the rim, as the edge arrives.
    const g = clamp01((this.knitAge - KNIT_MS * 0.7) / (KNIT_MS * 0.55));
    if (common && g > 0 && g < 1) {
      const k = Math.sin(Math.PI * g);
      light.globalAlpha = k * alpha;
      light.translate(CHIP_AT.x, CHIP_AT.y);
      light.scale(1.5 * k + 0.01, 1.5 * k + 0.01);
      drawSprite(light, common.glint);
    }
    light.restore();
  }
}
