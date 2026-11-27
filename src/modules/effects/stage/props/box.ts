// The box (Section 8: Alohomora, "the box unlatches and opens"). Starts locked (PROP_START: 'locked box',
// tags + 'prop.lockable', { locked: true }). prop.unlock pops the hasp, swings the lid back and lights
// a faint glow inside; the box relocks with a click (the hasp drops and glints) after RELOCK_MS so
// Alohomora can be practised again (task brief). Locking state changes at the start of the relock, so
// a cast during the closing animation reopens it.

import { PROP_TAGS } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, StageServices } from '../types';
import { drawSprite, drawSpriteIn, SpriteBank, type Sprite } from './art/canvas';
import { BOX_DUST, BOX_GEOMETRY, buildBoxArt, buildBoxWreck, lidFaces, type BoxArt, type LidFaces } from './art/box';
import { PAL } from './art/paint';
import { REVEAL_MIN, SMALL_TAGS, type PropEnv } from './base';
import { clamp01, easeIn, easeOut, easeOutBack, lerp } from './motion';
import { SmallProp } from './small-prop';

const T = PROP_TAGS;
const G = BOX_GEOMETRY;

/** How long the box stays open before it relocks (local ms). */
export const RELOCK_MS = 25000;
const INNER_GLOW = '#FFD58A';

type Phase = 'closed' | 'opening' | 'open' | 'closing';

export class BoxProp extends SmallProp<BoxArt> {
  protected readonly sway = 0.3;
  protected readonly glideStyle = 'float';
  protected readonly noun = 'box';
  protected readonly dust = [BOX_DUST, PAL.brass];
  protected readonly bank = new SpriteBank(buildBoxArt);
  /** The rune in the middle of the shut lid (drawHidden follows the lid as it opens). */
  protected readonly secret = { x: 0, y: -(G.rim + G.band) - (G.e * G.depth) / 2, halo: 64 };

  private locked = true;
  private phase: Phase = 'closed';
  private phaseAge = 0;
  /** Lid angle, radians (0 shut, G.open fully back). */
  private lid = 0;
  private lidFrom = 0;
  /** 0 the hasp hangs on the lock, 1 it is popped free. */
  private hasp = 0;
  private glow = 0;
  private relockLeft = 0;
  /** Ms left of the click's glint. */
  private click = 0;
  private readonly faces: LidFaces = { hingeY: 0, frontBottomY: 0, frontTopY: 0, backTopY: 0 };

  constructor(env: PropEnv) {
    super('box', env);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  protected ownLabel(): string {
    return this.locked ? 'locked box' : 'open box';
  }

  protected ownTags(): string[] {
    return this.locked ? [...SMALL_TAGS, T.lockable] : [...SMALL_TAGS];
  }

  protected ownState(): Record<string, boolean | number | string> {
    return { locked: this.locked };
  }

  protected override applyOwn(use: string, action: PropAction, services: StageServices): boolean {
    if (use === 'prop.unlock') {
      if (!this.locked) return false;
      this.locked = false;
      this.phase = 'opening';
      this.phaseAge = 0;
      this.lidFrom = this.lid;
      this.relockLeft = RELOCK_MS;
      this.changed();
      return true;
    }
    return super.applyOwn(use, action, services);
  }

  /** Reducto leaves broken staves, iron and brass on the shelf rather than a heap of dust. */
  protected override buildWreck(art: BoxArt): Sprite | null {
    return buildBoxWreck(this.env.canvas, art.body.res);
  }

  /** Shut, or fully open with its glow lit, and the click of relocking has rung out. */
  protected override ownSettled(): boolean {
    return (this.phase === 'closed' || this.phase === 'open') && this.click <= 0;
  }

  protected override resetOwn(): void {
    this.locked = true;
    this.phase = 'closed';
    this.phaseAge = 0;
    this.lid = this.lidFrom = 0;
    this.hasp = 0;
    this.glow = 0;
    this.relockLeft = 0;
    this.click = 0;
  }

  protected override advanceOwn(dt: number): void {
    this.phaseAge += dt;
    if (this.click > 0) this.click = Math.max(0, this.click - dt);
    const age = this.phaseAge;
    const r = this.reduced;
    switch (this.phase) {
      case 'opening': {
        const pop = r ? 60 : 140;
        const start = r ? 30 : 110;
        const swing = r ? 220 : 580;
        this.hasp = r ? clamp01(age / pop) : Math.min(1.15, easeOutBack(clamp01(age / pop), 2));
        const u = clamp01((age - start) / swing);
        this.lid = lerp(this.lidFrom, G.open, r ? easeOut(u) : easeOutBack(u, 1.1));
        this.glow = clamp01((age - start - (r ? 0 : 150)) / (r ? 200 : 600));
        if (u >= 1 && this.glow >= 1) {
          this.hasp = 1;
          this.phase = 'open';
          this.phaseAge = 0;
        }
        break;
      }
      case 'open':
        this.relockLeft -= dt;
        if (this.relockLeft <= 0) {
          this.locked = true;
          this.phase = 'closing';
          this.phaseAge = 0;
          this.lidFrom = this.lid;
          this.changed();
        }
        break;
      case 'closing': {
        const shut = r ? 200 : 380;
        const drop = r ? 40 : 90;
        this.lid = lerp(this.lidFrom, 0, easeIn(clamp01(age / shut)));
        this.glow = 1 - clamp01(age / (shut * 0.7));
        this.hasp = age < shut ? 1 : 1 - clamp01((age - shut) / drop);
        if (age >= shut + drop) {
          this.lid = 0;
          this.hasp = 0;
          this.glow = 0;
          this.click = 300;
          this.phase = 'closed';
          this.phaseAge = 0;
        }
        break;
      }
      case 'closed':
        break;
    }
  }

  /** Screen y (mH) of the hasp's hinge: on the lid's front band, a little above its lower edge. */
  private haspY(): number {
    const c = Math.cos(this.lid);
    const s = Math.sin(this.lid);
    const h = 6;
    return -(G.rim + h * c + G.depth * s) + G.e * (-h * s + G.depth * c - G.depth);
  }

  protected override drawBody(layers: Layers, _frame: FrameInfo, services: StageServices, art: BoxArt, size: number, alpha: number): void {
    const shade = layers.shade;
    const hw = G.hw;
    const f = lidFaces(this.lid, this.faces);
    this.beginBody(shade, size);
    if (alpha < 1) shade.globalAlpha = alpha;
    drawSprite(shade, art.front);
    if (this.lid > 0.002) drawSprite(shade, art.opening);
    // Lid faces, back to front: the velvet underside, the top, the front band.
    if (f.hingeY - f.frontBottomY > 0.05) drawSpriteIn(shade, art.lidInner, -hw, f.frontBottomY, hw * 2, f.hingeY - f.frontBottomY);
    if (f.frontTopY - f.backTopY > 0.05) drawSpriteIn(shade, art.lidTop, -hw, f.backTopY, hw * 2, f.frontTopY - f.backTopY);
    if (f.frontBottomY - f.frontTopY > 0.05) drawSpriteIn(shade, art.lidBand, -hw, f.frontTopY, hw * 2, f.frontBottomY - f.frontTopY);
    // The hasp hangs straight down from its hinge; popped free it tips toward us and looks shorter.
    shade.translate(0, this.haspY() - 2.5 * this.hasp);
    shade.scale(1, 1 - 0.38 * Math.min(1, this.hasp));
    drawSprite(shade, art.hasp);
    shade.restore();

    if (this.glow <= 0.01 && this.click <= 0) return;
    const light = layers.light;
    this.beginBody(light, size);
    if (this.glow > 0.01) {
      const warm = services.glow(INNER_GLOW);
      const midY = (f.hingeY - G.rim) / 2;
      light.globalAlpha = 0.6 * this.glow * alpha;
      light.drawImage(warm, -hw * 0.95, midY - 20, hw * 1.9, 40);
      light.globalAlpha = 0.16 * this.glow * alpha;
      light.drawImage(warm, -hw * 0.75, midY - 100, hw * 1.5, 120);
    }
    const common = this.env.common.get(this.env.canvas);
    if (this.click > 0 && common) {
      const k = Math.sin(Math.PI * (1 - this.click / 300));
      light.globalAlpha = k;
      light.translate(0, -G.rim + 14);
      light.scale(0.8 * k + 0.01, 0.8 * k + 0.01);
      drawSprite(light, common.glint);
    }
    light.restore();
  }

  override drawHidden(layers: Layers, frame: FrameInfo, services: StageServices, alpha: number): void {
    if (this.shattered || !(alpha > REVEAL_MIN)) return;
    this.bind(services, frame.now);
    const art = this.art(frame.now);
    if (!art) return;
    const light = layers.light;
    const hw = G.hw;
    const f = lidFaces(this.lid, this.faces);
    this.beginBody(light, this.scaler.value);
    light.globalAlpha = clamp01(alpha * this.shimmer(frame));
    // The rune is set into the lid: on its top while shut, on its velvet underside while open.
    let cy = Number.NaN;
    if (f.frontTopY - f.backTopY > 0.5) {
      drawSpriteIn(light, art.runeTop, -hw, f.backTopY, hw * 2, f.frontTopY - f.backTopY);
      cy = (f.backTopY + f.frontTopY) / 2;
    } else if (f.hingeY - f.frontBottomY > 0.5) {
      drawSpriteIn(light, art.runeInner, -hw, f.frontBottomY, hw * 2, f.hingeY - f.frontBottomY);
      cy = (f.frontBottomY + f.hingeY) / 2;
    }
    if (Number.isFinite(cy)) this.drawSecretLight(light, frame, services, alpha, 0, cy, this.secret.halo);
    light.restore();
  }
}
