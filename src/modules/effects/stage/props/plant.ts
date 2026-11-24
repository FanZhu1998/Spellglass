// The potted plant (Section 8: Engorgio "the target grows", Reducio "the target shrinks"). Everything it
// does is shared with the other small props. Its hidden detail, a brass key, lies on the shelf at the
// plant's home with its bit under the pot: it is drawn before the pot (so the pot really covers it) and
// it stays put, fully visible, when the plant flies off or shatters.

import type { FrameInfo, Layers, StageServices } from '../types';
import { drawSprite, SpriteBank, type Sprite } from './art/canvas';
import { paintShards } from './art/common';
import { LEAF_DUST, PLANT_DUST, PLANT_SECRET, PLANT_SOLID, buildPlantArt, type PlantArt } from './art/plant';
import { REVEAL_MIN, SMALL_TAGS, type PropEnv } from './base';
import { SHELF_TOP } from './geometry';
import { clamp01 } from './motion';
import { SmallProp } from './small-prop';

export class Plant extends SmallProp<PlantArt> {
  protected readonly sway = 0.3;
  protected readonly glideStyle = 'float';
  protected readonly noun = 'potted plant';
  protected readonly dust = [PLANT_DUST, LEAF_DUST];
  protected readonly bank = new SpriteBank(buildPlantArt);
  protected readonly secret = PLANT_SECRET;

  constructor(env: PropEnv) {
    super('plant', env);
  }

  /** Shards of the glazed pot, dark where the clay and the leaves tore, the fronds and bells among them. */
  protected override buildWreck(art: PlantArt): Sprite | null {
    return paintShards(this.env.canvas, art.body, art.heap, { seed: 53, pieces: 5, spread: 80, edge: 'rgba(104,60,34,0.5)', jag: 1.3, solid: PLANT_SOLID });
  }

  protected ownLabel(): string {
    return 'potted plant';
  }

  protected ownTags(): string[] {
    return [...SMALL_TAGS];
  }

  protected ownState(): Record<string, boolean | number | string> {
    return {};
  }

  override draw(layers: Layers, frame: FrameInfo, services: StageServices): void {
    const reveal = services.revealAlpha();
    if (reveal > REVEAL_MIN) {
      this.bind(services, frame.now);
      const art = this.art(frame.now);
      if (art) {
        const shade = layers.shade;
        this.beginHome(shade);
        shade.globalAlpha = clamp01(reveal);
        drawSprite(shade, art.key);
        shade.restore();
      }
    }
    super.draw(layers, frame, services);
  }

  override drawHidden(layers: Layers, frame: FrameInfo, services: StageServices, alpha: number): void {
    if (!(alpha > REVEAL_MIN)) return;
    this.bind(services, frame.now);
    const art = this.art(frame.now);
    if (!art) return;
    const light = layers.light;
    this.beginHome(light);
    light.globalAlpha = clamp01(alpha * this.shimmer(frame));
    drawSprite(light, art.hidden);
    const s = this.secret;
    this.drawSecretLight(light, frame, services, alpha, s.x, s.y, s.halo);
    light.restore();
  }

  /** The key's frame: the plant's home on the shelf line, in mH at normal size. Pair with restore(). */
  private beginHome(ctx: CanvasRenderingContext2D): void {
    const v = this.env.view;
    ctx.save();
    ctx.translate(v.px(this.home.x), v.py(SHELF_TOP));
    ctx.scale(v.pxPerMh, v.pxPerMh);
  }
}
