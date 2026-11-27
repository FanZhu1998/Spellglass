// The wooden training dummy (Section 8: Expelliarmus, Stupefy, Petrificus Totalus, Impedimenta,
// Riddikulus, and the restricted Imperio, Crucio, Avada Kedavra, "drawn as abstract light and sound on
// the wooden dummy"). It never moves from its stand: too heavy to levitate, pull or push, and never
// shattered (PROP_START comment). Tags stay [any, dummy, scalable].
//
// Its pose is a few springs and a fall:
//  - lean: it rocks on the edges of its round stand (prop.reel staggers it back; Imperio leans it);
//  - arms: both arms swing together about the shoulder block (flinches, and Imperio raises the wand arm);
//  - head: a small tilt that lags behind;
//  - fall: 0 standing, 1 lying. It topples to the right and its base skids left, so it lands on the
//    shelf rather than off the edge of the mirror. Rigid (frozen) it lands propped on its arm; limp
//    (prop.topple) its arms fold.
// Every timer and spring runs on local time (frame.dt × timeScale), so Impedimenta slows it all.

import { PROP_TAGS } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, StageServices } from '../types';
import { bool, color, durationOf, effectScale, handleOf, num, pick, type ActionHandle } from './actions';
import { drawSprite, SpriteBank, type Sprite } from './art/canvas';
import {
  COSTUMES, DUMMY_JOINTS, DummyVariants, TORSO_RIM_MASK, buildDummyArt, buildDummyExtras, type Costume, type DummyArt,
  type DummyExtras, type RimMask,
} from './art/dummy';
import { PropBase, REVEAL_MIN, type PropEnv, type Pt } from './base';
import { MH, SHELF_TOP } from './geometry';
import { clamp, clamp01, easeIn, easeInOut, easeOutBack, lerp, springSeconds, wobble } from './motion';

const T = PROP_TAGS;
const J = DUMMY_JOINTS;

/** Rest angle when toppled, radians: rigid it lands propped on its right hand; limp its arms fold. */
const DOWN_RIGID = 1.33;
const DOWN_LIMP = 1.43;
const ARM_FOLD = 0.95;
/** How far its base skids left while it falls (mH): far enough that its head lands inside the glass,
 *  not so far that its foot runs into the plant. */
const SKID = 205;
const FALL_MS = 520;
const RISE_MS = 820;
const FREEZE_TOPPLE_DELAY_MS = 220;
const WAND_FLY_MS = 800;
/** "Then it is handed back after a few seconds" (task brief). */
export const WAND_AWAY_MS = 3500;
const WAND_BACK_MS = 700;
/** The dropped wand lies pointing left, its axis tipped down toward the thin tip so that both the
 *  pommel and the tip rest on the shelf, its grip as high above the shelf as the pommel is thick. */
const WAND_LAND_ANGLE = -Math.PI / 2 - (4.2 - 1.2) / J.wandLength;
const WAND_LAND_LIFT = 4.2;
/** How high the wand flies (mirror heights) and how often it turns on the way. */
const WAND_APEX = 0.16;
const WAND_SPINS = 2;
/** Motion ghosts behind the spinning wand: how many, and how far back along the flight each lags. */
const WAND_GHOSTS = 3;
const WAND_GHOST_LAG = 0.045;
const COSTUME_POP_MS = 320;
/** Its landing bounce has died away by then (computePose). */
const LAND_SETTLE_MS = 500;
const FROST = '#BFD8FF';
const AURA = '#C9B6FF';

/** A spring at rest: still, and at its rest pose (every target is 0 unless Imperio steers it). */
const still = (s: { p: number; v: number }): boolean => Math.abs(s.p) < 0.01 && Math.abs(s.v) < 0.02;

type FallPhase = 'up' | 'falling' | 'down' | 'rising';
type WandPhase = 'hand' | 'flying' | 'dropped' | 'returning';

interface Timed {
  handle: ActionHandle | null;
  castId: string;
  /** Local ms left. */
  left: number;
}

export class Dummy extends PropBase {
  private readonly lean = { p: 0, v: 0 };
  private readonly arms = { p: 0, v: 0 };
  private readonly head = { p: 0, v: 0 };
  private fallPhase: FallPhase = 'up';
  private fallAge = 0;
  private fallDelay = 0;
  private fall = 0;
  private riseFrom = 1;
  private limp = false;
  private landAge = 0;
  private toppled: (Timed & { byFreeze: boolean }) | null = null;
  private frozen: (Timed & { tint: string }) | null = null;
  private mimic: Timed | null = null;
  private costume: Costume | null = null;
  private costumeCastId: string | null = null;
  private costumeAge = COSTUME_POP_MS;
  private costumeLeaving = false;
  private wandPhase: WandPhase = 'hand';
  private wandAge = 0;
  /** How far through its flight away the wand is, 0..1. */
  private wandU = 0;
  private wandCastId: string | null = null;
  /** Scratch for sampling the flight (the motion ghosts), so drawing allocates nothing. */
  private readonly fly = { x: 0, y: 0, a: 0 };
  /** The loose wand's grip (caster space) and angle, and where its current flight began. */
  private wx = 0;
  private wy = 0;
  private wa = 0;
  private w0x = 0;
  private w0y = 0;
  private w0a = 0;
  /** The tip, and its smoothed velocity (caster units per second), for Imperio. */
  private tipX = Number.NaN;
  private tipY = 0;
  private tipVx = 0;
  private tipVy = 0;
  private readonly bank = new SpriteBank(buildDummyArt);
  /** Costumes and the chalk, painted when first wanted (most sessions never need them). */
  private readonly extras = new SpriteBank(buildDummyExtras);
  /** How much finer than normal the sprites are painted while the dummy is enlarged. */
  private sharp = 1;
  private readonly variants: DummyVariants;
  private readonly pose: { angle: number; pivot: number; skid: number; arms: number; head: number } = {
    angle: 0, pivot: J.standHalf, skid: 0, arms: 0, head: 0,
  };
  private readonly pt: Pt = { x: 0, y: 0 };

  constructor(env: PropEnv) {
    super('dummy', env);
    this.variants = new DummyVariants(env.canvas);
  }

  // ---------------------------------------------------------------- what the core reads

  label(): string {
    if (this.frozen) return 'frozen training dummy';
    if (this.toppled) return 'toppled training dummy';
    return 'training dummy';
  }

  tags(): string[] {
    return [T.any, T.dummy, T.scalable];
  }

  state(): Record<string, boolean | number | string> {
    const s: Record<string, boolean | number | string> = {};
    if (this.frozen) s.frozen = true;
    if (this.toppled) s.toppled = true;
    if (this.wandPhase !== 'hand') s.disarmed = true;
    if (this.costume && !this.costumeLeaving) s.costume = this.costume;
    if (this.mimic) s.mimicking = true;
    const scale = this.scaleState();
    if (scale !== undefined) s.scale = scale;
    return s;
  }

  /** The pose as numbers, for tests and the dev harness. */
  get debugPose(): { readonly lean: number; readonly fall: number; readonly arms: number; readonly wand: WandPhase } {
    return { lean: this.lean.p, fall: this.fall, arms: this.arms.p, wand: this.wandPhase };
  }

  // ---------------------------------------------------------------- actions

  apply(use: string, action: PropAction, services: StageServices): boolean {
    this.bind(services, services.now());
    const step = action.step;
    switch (use) {
      case 'prop.reel':
        return this.reel(num(step.intensity, 0.7, 0, 1) * effectScale(action));
      case 'prop.disarm':
        if (this.wandPhase === 'hand') this.launchWand(action.cast.id);
        this.reel(0.35);
        return true;
      case 'prop.freeze': {
        if (this.mimic) this.stopMimic(true);
        if (this.frozen) this.complete(this.frozen.handle);
        this.frozen = { handle: handleOf(action), castId: action.cast.id, left: durationOf(action, 6000), tint: color(step.tint, FROST) };
        if (bool(step.topple, false) && !this.toppled) {
          this.toppled = { handle: null, castId: action.cast.id, left: Number.POSITIVE_INFINITY, byFreeze: true };
          this.fallOver(this.reduced ? 0 : FREEZE_TOPPLE_DELAY_MS, false);
        }
        this.changed();
        return true;
      }
      case 'prop.topple': {
        if (this.mimic) this.stopMimic(true);
        if (this.toppled) this.complete(this.toppled.handle);
        this.toppled = { handle: handleOf(action), castId: action.cast.id, left: durationOf(action, 5000), byFreeze: false };
        this.fallOver(0, !this.frozen);
        this.changed();
        return true;
      }
      case 'prop.costume': {
        const asked = pick(step.costume, ['hat', 'ruff', 'bow', 'random'] as const, 'random');
        let kind: Costume;
        if (asked === 'random') {
          // Always something new, so the spell visibly does something.
          const choices = COSTUMES.filter((c) => c !== this.costume || this.costumeLeaving);
          kind = choices[Math.min(choices.length - 1, Math.floor(services.random() * choices.length))];
        } else {
          kind = asked;
        }
        this.costume = kind;
        this.costumeCastId = action.cast.id;
        this.costumeAge = 0;
        this.costumeLeaving = false;
        if (!this.reduced && !this.frozen) {
          this.arms.v += 2.5;
          this.head.v += 2;
        }
        this.changed();
        return true;
      }
      case 'prop.mimic': {
        if (this.frozen || this.toppled) return false;
        if (this.mimic) this.complete(this.mimic.handle);
        this.mimic = { handle: handleOf(action), castId: action.cast.id, left: durationOf(action, 5000) };
        this.tipX = Number.NaN;
        this.changed();
        return true;
      }
      case 'prop.scale': {
        const factor = num(step.factor, 1, 0, 10);
        if (factor <= 0.05 || step.mode === 'shatter') return false;
        return this.startScale(action);
      }
      case 'prop.douse':
        return true;
      default:
        // Too heavy to levitate, pull or push; nothing to unlock, mend or light.
        return false;
    }
  }

  private reel(intensity: number): boolean {
    const i = clamp01(intensity);
    if (this.fallPhase !== 'up') {
      // Knocked about where it lies: a shudder.
      this.head.v += 3 * i;
      return true;
    }
    const k = this.reduced ? 0.5 : 1;
    const rigid = !!this.frozen;
    this.lean.v += i * 3.4 * k * (rigid ? 0.6 : 1);
    if (!rigid) {
      this.arms.v -= i * 4.5 * k;
      this.head.v -= i * 6 * k;
    }
    return true;
  }

  private fallOver(delay: number, limp: boolean): void {
    if (this.fallPhase === 'falling' || this.fallPhase === 'down') {
      this.limp = this.limp && limp;
      return;
    }
    // From standing, or caught half-way up: carry on down from where it is.
    const u = Math.cbrt(clamp01(this.fall));
    this.fallPhase = 'falling';
    this.fallAge = u * (this.reduced ? 260 : FALL_MS);
    this.fallDelay = this.fall > 0 ? 0 : delay;
    this.limp = limp;
  }

  private rise(): void {
    this.toppled = null;
    if (this.fallPhase === 'up' || this.fallPhase === 'rising') return;
    if (this.fallPhase === 'falling' && this.fall === 0) {
      this.fallPhase = 'up';
      this.fallDelay = 0;
      return;
    }
    this.fallPhase = 'rising';
    this.fallAge = 0;
    this.riseFrom = this.fall;
  }

  private unfreeze(): void {
    const byFreeze = this.toppled?.byFreeze ?? false;
    this.frozen = null;
    if (byFreeze) this.rise();
    this.changed();
  }

  private stopMimic(superseded: boolean): void {
    if (!this.mimic) return;
    if (superseded) this.complete(this.mimic.handle);
    else this.mimic.handle?.drop();
    this.mimic = null;
    this.changed();
  }

  private launchWand(castId: string): void {
    this.computePose();
    this.handCaster(this.pt);
    this.w0x = this.wx = this.pt.x;
    this.w0y = this.wy = this.pt.y;
    this.w0a = this.wa = this.handAngle();
    this.wandPhase = 'flying';
    this.wandAge = 0;
    this.wandU = 0;
    this.wandCastId = castId;
    this.changed();
  }

  /** The loose wand's grip (caster space) and angle at fraction u of its flight away: an arc up and
   *  over to the shelf on the dummy's left, turning end over end as it goes. */
  private flightAt(u: number, out: { x: number; y: number; a: number }): void {
    const v = this.env.view;
    const lx = this.home.x - 0.052;
    const ly = SHELF_TOP - WAND_LAND_LIFT * MH * v.hToY;
    const apex = (this.reduced ? 0.05 : WAND_APEX) * v.hToY;
    const spins = this.reduced ? 0 : WAND_SPINS;
    out.x = lerp(this.w0x, lx, u);
    out.y = lerp(this.w0y, ly, u) - apex * 4 * u * (1 - u);
    out.a = lerp(this.w0a, WAND_LAND_ANGLE - spins * Math.PI * 2, u);
  }

  private returnWand(): void {
    this.w0x = this.wx;
    this.w0y = this.wy;
    this.w0a = this.wa;
    this.wandPhase = 'returning';
    this.wandAge = 0;
  }

  end(castId: string): void {
    const all = castId === '*';
    if (this.frozen && (all || castId === this.frozen.castId)) {
      this.frozen.handle?.drop();
      this.unfreeze();
    }
    if (this.toppled && !this.toppled.byFreeze && (all || castId === this.toppled.castId)) {
      this.toppled.handle?.drop();
      this.rise();
      this.changed();
    }
    if (this.mimic && (all || castId === this.mimic.castId)) this.stopMimic(false);
    if (this.costume && !this.costumeLeaving && (all || castId === this.costumeCastId)) {
      this.costumeLeaving = true;
      this.costumeAge = 0;
      this.changed();
    }
    if ((this.wandPhase === 'flying' || this.wandPhase === 'dropped') && (all || castId === this.wandCastId)) this.returnWand();
    this.endScale(castId);
  }

  reset(): void {
    this.frozen?.handle?.drop();
    this.toppled?.handle?.drop();
    this.mimic?.handle?.drop();
    this.frozen = null;
    this.toppled = null;
    this.mimic = null;
    this.fallPhase = 'up';
    this.fall = 0;
    this.fallAge = 0;
    this.fallDelay = 0;
    this.limp = false;
    this.lean.p = this.lean.v = 0;
    this.arms.p = this.arms.v = 0;
    this.head.p = this.head.v = 0;
    this.costume = null;
    this.costumeCastId = null;
    this.costumeLeaving = false;
    this.costumeAge = COSTUME_POP_MS;
    this.wandPhase = 'hand';
    this.wandCastId = null;
    this.scaler.reset();
    this.timeScale = 1;
    this.clearDone();
    this.changed();
  }

  /** Standing or lying still, its wand in its hand or on the shelf, a new costume in place, and no
   *  longer rocking (types.ts PropView.settled). */
  override settled(): boolean {
    if (!super.settled() || this.mimic) return false;
    if (this.fallPhase === 'falling' || this.fallPhase === 'rising') return false;
    if (this.fallPhase === 'down' && this.landAge < LAND_SETTLE_MS) return false;
    if (this.wandPhase === 'flying' || this.wandPhase === 'returning') return false;
    if (this.costumeAge < COSTUME_POP_MS) return false;
    return still(this.lean) && still(this.arms) && still(this.head);
  }

  // ---------------------------------------------------------------- frames

  protected advance(dt: number, frame: FrameInfo, services: StageServices): void {
    if (this.frozen) {
      this.frozen.left -= dt;
      if (this.frozen.left <= 0) {
        const h = this.frozen.handle;
        this.unfreeze();
        this.complete(h);
      }
    }
    if (this.toppled && !this.toppled.byFreeze) {
      this.toppled.left -= dt;
      if (this.toppled.left <= 0) {
        const h = this.toppled.handle;
        this.rise();
        this.changed();
        this.complete(h);
      }
    }
    if (this.mimic) {
      this.mimic.left -= dt;
      if (this.mimic.left <= 0) {
        const h = this.mimic.handle;
        this.mimic = null;
        this.changed();
        this.complete(h);
      }
    }
    this.stepFall(dt, services);

    let leanTo = 0;
    let armsTo = 0;
    let headTo = 0;
    if (this.mimic && this.trackTip(frame.rawDt, services)) {
      // Imperio: it leans toward the tip and with its motion; its wand arm rises with the tip.
      leanTo = clamp((this.tipX - this.home.x) * 1.4 + this.tipVx * 0.1, -0.32, 0.32);
      armsTo = clamp((0.5 - this.tipY) * 0.9 - this.tipVy * 0.12, -0.55, 0.55);
      headTo = clamp(leanTo * 0.5 + this.tipVx * 0.05, -0.3, 0.3);
    }
    const dtS = springSeconds(dt);
    const rigid = !!this.frozen;
    const calm = this.reduced || !!this.mimic;
    wobble(this.lean, this.fallPhase === 'up' ? leanTo : 0, rigid ? 16 : 9, rigid ? 1 : calm ? 0.9 : 0.22, dtS);
    wobble(this.arms, this.fallPhase === 'up' ? armsTo : 0, rigid ? 20 : 8, rigid ? 1 : calm ? 0.9 : 0.3, dtS);
    wobble(this.head, headTo, rigid ? 20 : 10, rigid ? 1 : calm ? 0.9 : 0.35, dtS);
    // On its stand it can only rock so far before it would fall.
    this.lean.p = clamp(this.lean.p, -0.45, 0.45);

    this.stepWand(dt, services);

    if (this.costumeAge < COSTUME_POP_MS) {
      this.costumeAge += dt;
      if (this.costumeLeaving && this.costumeAge >= COSTUME_POP_MS) {
        this.costume = null;
        this.costumeCastId = null;
        this.costumeLeaving = false;
      }
    }
  }

  private stepFall(dt: number, services: StageServices): void {
    switch (this.fallPhase) {
      case 'falling': {
        if (this.fallDelay > 0) {
          this.fallDelay -= dt;
          return;
        }
        this.fallAge += dt;
        const u = clamp01(this.fallAge / (this.reduced ? 260 : FALL_MS));
        this.fall = easeIn(u);
        if (u >= 1) {
          this.fallPhase = 'down';
          this.landAge = 0;
          this.thud(services);
        }
        break;
      }
      case 'down':
        this.fall = 1;
        this.landAge += dt;
        break;
      case 'rising': {
        this.fallAge += dt;
        const u = clamp01(this.fallAge / (this.reduced ? 300 : RISE_MS));
        this.fall = this.riseFrom * (1 - easeInOut(u));
        if (u >= 1) {
          this.fallPhase = 'up';
          this.fall = 0;
          this.limp = false;
          // It rocks once as it settles back on its stand.
          if (!this.reduced) this.lean.v -= 1.2;
        }
        break;
      }
      case 'up':
        break;
    }
  }

  /** Dust where it lands. */
  private thud(services: StageServices): void {
    this.computePose();
    this.bodyToCaster(J.head.x, J.head.y, this.pt);
    services.particles.burst({
      preset: 'dust', x: this.pt.x, y: SHELF_TOP, count: this.count(10), speed: 0.6, spreadDeg: 150,
      directionDeg: -90, color: '#8A7350',
    });
  }

  private trackTip(rawDt: number, services: StageServices): boolean {
    // The tip of Imperio's own cast (a replayed Imperio copies the replayed stroke).
    const tip = services.tip(this.mimic?.castId);
    if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)) {
      this.tipX = Number.NaN;
      return false;
    }
    if (Number.isNaN(this.tipX)) {
      this.tipVx = this.tipVy = 0;
    } else {
      // The tip moves in real time even when the dummy is slowed, so its speed uses the raw frame time.
      const s = Math.max(1e-3, rawDt / 1000);
      const k = clamp01(rawDt / 120);
      this.tipVx += ((tip.x - this.tipX) / s - this.tipVx) * k;
      this.tipVy += ((tip.y - this.tipY) / s - this.tipVy) * k;
    }
    this.tipX = tip.x;
    this.tipY = tip.y;
    return true;
  }

  private stepWand(dt: number, services: StageServices): void {
    const v = this.env.view;
    switch (this.wandPhase) {
      case 'flying': {
        this.wandAge += dt;
        const u = clamp01(this.wandAge / (this.reduced ? 350 : WAND_FLY_MS));
        this.wandU = u;
        this.flightAt(u, this.fly);
        this.wx = this.fly.x;
        this.wy = this.fly.y;
        this.wa = this.fly.a;
        if (u >= 1) {
          this.wa = WAND_LAND_ANGLE;
          this.wandPhase = 'dropped';
          this.wandAge = 0;
          services.particles.burst({ preset: 'dust', x: this.wx - 0.012, y: SHELF_TOP, count: this.count(4), speed: 0.4, spreadDeg: 120, directionDeg: -90, color: '#8A7350' });
        }
        break;
      }
      case 'dropped':
        this.wandAge += dt;
        if (this.wandAge >= WAND_AWAY_MS) this.returnWand();
        break;
      case 'returning': {
        this.wandAge += dt;
        const u = clamp01(this.wandAge / (this.reduced ? 300 : WAND_BACK_MS));
        const e = easeInOut(u);
        this.computePose();
        this.handCaster(this.pt);
        this.wx = lerp(this.w0x, this.pt.x, e);
        this.wy = lerp(this.w0y, this.pt.y, e) - (this.reduced ? 0 : 0.05 * v.hToY * Math.sin(Math.PI * u));
        this.wa = lerp(this.w0a, this.handAngle(), e);
        if (u >= 1) {
          this.wandPhase = 'hand';
          this.wandCastId = null;
          this.changed();
        }
        break;
      }
      case 'hand':
        break;
    }
  }

  // ---------------------------------------------------------------- pose and transforms

  private computePose(): void {
    const p = this.pose;
    const bounce = this.fallPhase === 'down' && !this.reduced
      ? 0.07 * Math.exp(-this.landAge / 110) * Math.abs(Math.sin(this.landAge / 45))
      : 0;
    p.angle = (this.limp ? DOWN_LIMP : DOWN_RIGID) * this.fall - bounce + this.lean.p;
    // It rocks on whichever edge of the stand it leans toward.
    p.pivot = p.angle >= 0 ? J.standHalf : -J.standHalf;
    p.skid = -SKID * easeInOut(this.fall);
    p.arms = this.arms.p + (this.limp ? ARM_FOLD * this.fall : 0);
    p.head = this.head.p;
  }

  /** A point of the dummy's body frame (mH from the base) in caster space, in the current pose. */
  private bodyToCaster(lx: number, ly: number, out: Pt): Pt {
    const v = this.env.view;
    const p = this.pose;
    const m = v.pxPerMh * this.scaler.value;
    const c = Math.cos(p.angle);
    const s = Math.sin(p.angle);
    const dx = lx - p.pivot;
    const qx = p.skid + p.pivot + dx * c - ly * s;
    const qy = dx * s + ly * c;
    out.x = (this.baseX() + m * qx - v.ox) / v.sx;
    out.y = (this.baseY() + m * qy - v.oy) / v.sy;
    return out;
  }

  private handCaster(out: Pt): Pt {
    const a = this.pose.arms;
    const lx = J.shoulder.x + Math.cos(a) * J.hand.x - Math.sin(a) * J.hand.y;
    const ly = J.shoulder.y + Math.sin(a) * J.hand.x + Math.cos(a) * J.hand.y;
    return this.bodyToCaster(lx, ly, out);
  }

  private handAngle(): number {
    return this.pose.angle + this.pose.arms + J.wandAngle;
  }

  // ---------------------------------------------------------------- drawing

  /** The sprites' resolution: finer while it is enlarged so Engorgio stays crisp, as fine as it is
   *  growing to (up to twice), held for the whole growth and the ease back so they are painted once. */
  private res(): number {
    const s = this.scaler;
    if (s.target > 1.1) this.sharp = Math.min(2, Math.max(1.25, s.target));
    else if (s.value <= 1.1) this.sharp = 1;
    return this.env.view.pxPerMh * this.sharp;
  }

  private artNow(now: number): DummyArt | null {
    return this.bank.get(this.env.canvas, this.res(), now, this.env.repaints);
  }

  draw(layers: Layers, frame: FrameInfo, services: StageServices): void {
    this.bind(services, frame.now);
    const art = this.artNow(frame.now);
    if (!art) return;
    this.computePose();
    const size = this.scaler.value;
    const rv = services.revealAlpha();
    const reveal = Number.isFinite(rv) ? rv : 0;
    const extras = this.costume || reveal > REVEAL_MIN ? this.extras.get(this.env.canvas, this.res(), frame.now, this.env.repaints) : null;
    // Lying down it casts a longer shadow, under its middle.
    this.drawShadow(layers.shade, size * (1 + 1.8 * this.fall), 1, 20 * this.fall);
    const tint = this.frozen ? this.frozen.tint : null;
    this.drawParts(layers.shade, art, extras, size, tint, null, reveal);
    if (this.frozen) this.drawParts(layers.light, art, null, size, null, FROST, 0);
    else if (this.mimic) this.drawParts(layers.light, art, null, size, null, AURA, 0);
    if (this.wandPhase !== 'hand') this.drawLooseWand(layers.shade, art, size, tint);
  }

  /** The wand out of its hand: its shadow on the shelf, a few fading ghosts while it spins away (they
   *  make the flight readable at a glance; none under reduced motion), and the wand itself. */
  private drawLooseWand(shade: CanvasRenderingContext2D, art: DummyArt, size: number, tint: string | null): void {
    const v = this.env.view;
    const m = v.pxPerMh * size;
    const common = this.env.common.get(this.env.canvas);
    const above = (SHELF_TOP - this.wy) / (MH * v.hToY) - WAND_LAND_LIFT;
    const near = clamp01(1 - above / 40);
    if (common && near > 0) {
      const len = J.wandLength * m;
      const along = Math.sin(this.wa);
      const w = Math.abs(along) * len + 14 * m;
      const h = 5 * m;
      shade.globalAlpha = 0.55 * near;
      shade.drawImage(common.shadow.canvas, v.px(this.wx) + (along * len) / 2 - w / 2, v.py(SHELF_TOP) - h / 2, w, h);
      shade.globalAlpha = 1;
    }
    if (this.wandPhase === 'flying' && !this.reduced) {
      for (let k = WAND_GHOSTS; k >= 1; k--) {
        const u = this.wandU - k * WAND_GHOST_LAG;
        if (u <= 0) continue;
        this.flightAt(u, this.fly);
        shade.save();
        shade.translate(v.px(this.fly.x), v.py(this.fly.y));
        shade.rotate(this.fly.a);
        shade.scale(m, m);
        shade.globalAlpha = 0.32 * (1 - k / (WAND_GHOSTS + 1));
        this.drawPart(shade, art.wand, tint, null);
        shade.restore();
      }
    }
    shade.save();
    shade.translate(v.px(this.wx), v.py(this.wy));
    shade.rotate(this.wa);
    shade.scale(m, m);
    this.drawPart(shade, art.wand, tint, null);
    shade.restore();
  }

  /** Enter the dummy's body frame (mH, base centre at 0, 0) in the current pose. Pair with restore(). */
  private beginPose(ctx: CanvasRenderingContext2D, size: number): void {
    const p = this.pose;
    const m = this.env.view.pxPerMh * size;
    ctx.save();
    ctx.translate(this.baseX(), this.baseY());
    ctx.scale(m, m);
    ctx.translate(p.skid + p.pivot, 0);
    ctx.rotate(p.angle);
    ctx.translate(-p.pivot, 0);
  }

  private drawPart(ctx: CanvasRenderingContext2D, s: Sprite, tint: string | null, rim: string | null, mask?: RimMask): void {
    const part = rim ? this.variants.rim(s, rim, mask) : tint ? this.variants.tinted(s, tint) : s;
    if (part) drawSprite(ctx, part);
  }

  /** The costume's pop: it springs into place, or shrinks away when Finite ends it. */
  private costumeScale(): number {
    const u = clamp01(this.costumeAge / COSTUME_POP_MS);
    if (this.costumeLeaving) return 1 - easeIn(u);
    return this.reduced ? 1 : Math.max(0, easeOutBack(u, 2.2));
  }

  private drawCostumePart(ctx: CanvasRenderingContext2D, s: Sprite, tint: string | null): void {
    const k = this.costumeScale();
    if (k <= 0.01) return;
    ctx.scale(k, k);
    this.drawPart(ctx, s, tint, null);
  }

  /** Every part in the current pose: washed with `tint` (frozen), or as a glowing `rim` on the light
   *  layer. `reveal` > 0 shows the chalk on the torso, under the arms (Revelio). Costumes and chalk come
   *  from `extras`, when they have been painted. */
  private drawParts(ctx: CanvasRenderingContext2D, art: DummyArt, extras: DummyExtras | null, size: number, tint: string | null,
    rim: string | null, reveal: number): void {
    const p = this.pose;
    this.beginPose(ctx, size);
    if (rim) ctx.globalAlpha = rim === FROST ? 0.55 : 0.4;
    this.drawPart(ctx, art.stand, tint, rim);
    this.drawPart(ctx, art.torso, tint, rim, TORSO_RIM_MASK);
    if (extras && !rim && reveal > REVEAL_MIN) {
      ctx.save();
      ctx.translate(J.chest.x, J.chest.y);
      ctx.globalAlpha = clamp01(reveal);
      drawSprite(ctx, extras.chalk);
      ctx.restore();
    }
    if (extras && !rim && this.costume === 'ruff') {
      ctx.save();
      ctx.translate(J.neck.x, J.neck.y);
      this.drawCostumePart(ctx, extras.ruff, tint);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(J.head.x, J.head.y);
    ctx.rotate(p.head);
    this.drawPart(ctx, art.head, tint, rim);
    if (extras && !rim && this.costume === 'hat') {
      ctx.translate(2, -J.headRadius + 3);
      ctx.rotate(0.24);
      this.drawCostumePart(ctx, extras.hat, tint);
    }
    ctx.restore();
    if (extras && !rim && this.costume === 'bow') {
      ctx.save();
      ctx.translate(J.neck.x, J.neck.y - 1);
      this.drawCostumePart(ctx, extras.bow, tint);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(J.shoulder.x, J.shoulder.y);
    ctx.rotate(p.arms);
    if (!rim && this.wandPhase === 'hand') {
      ctx.save();
      ctx.translate(J.hand.x, J.hand.y);
      ctx.rotate(J.wandAngle);
      this.drawPart(ctx, art.wand, tint, null);
      ctx.restore();
    }
    this.drawPart(ctx, art.arms, tint, rim);
    ctx.restore();
    ctx.restore();
  }

  /** The chalk itself is drawn with the body (under the arms); this adds its halo and glint. */
  drawHidden(layers: Layers, frame: FrameInfo, services: StageServices, alpha: number): void {
    if (!(alpha > REVEAL_MIN)) return;
    this.bind(services, frame.now);
    this.computePose();
    const light = layers.light;
    this.beginPose(light, this.scaler.value);
    this.drawSecretLight(light, frame, services, alpha, J.chest.x, J.chest.y, 100);
    light.restore();
  }
}
