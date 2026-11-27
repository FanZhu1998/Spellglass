// The candle (Section 7.8, 8: Incendio "the candle catches", Aguamenti "flames go out").
// Starts unlit (PROP_START: { lit: false }, tags + 'prop.flammable'). prop.ignite lights it and swaps
// 'flammable' for 'burning'; prop.douse puts it out with smoke and steam; end(castId) for the igniting
// cast, or end('*'), puts it out with a wisp of smoke (contract review: the core may hold a release
// until the ending cast's douse runs). Going out, the wick also trails a thin curl of smoke of its own
// for a moment: motion that answers the action. Its flicker is the only ambient motion on the stage
// (Section 10.6); it runs on the candle's local clock, so Arresto Momentum stills it too.

import { EFFECT_LIMITS, PROP_TAGS } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, StageServices } from '../types';
import { bool, handleOf, num, type ActionHandle } from './actions';
import { drawSprite, SpriteBank, type Sprite } from './art/canvas';
import { paintShards } from './art/common';
import { CANDLE_DUST, CANDLE_SECRET, CANDLE_SOLID, WAX_TOP_Y, WICK_TOP, buildCandleArt, type CandleArt } from './art/candle';
import { PAL } from './art/paint';
import { SMALL_TAGS, type PropEnv } from './base';
import { SHELF_TOP } from './geometry';
import { clamp, clamp01, easeOut } from './motion';
import { SmallProp } from './small-prop';

const T = PROP_TAGS;
const FLAME_GLOW = '#FFB860';
/** How long the curl of smoke from a snuffed wick takes to rise and fade (local ms). */
const WISP_MS = 1900;
/** Pieces the curl is drawn in, fainter toward its top (no gradient per frame). */
const WISP_PIECES = 4;
const WISP_POINTS = 5;

export class Candle extends SmallProp<CandleArt> {
  protected readonly sway = 0.35;
  protected readonly glideStyle = 'float';
  protected readonly noun = 'candle';
  protected readonly dust = [CANDLE_DUST, PAL.brass];
  protected readonly bank = new SpriteBank(buildCandleArt);
  protected readonly secret = CANDLE_SECRET;

  private lit = false;
  /** The cast that lit it: end() for that cast puts it out. */
  private litCastId: string | null = null;
  /** A timed ignite (duration_ms without hold) goes out on its own and reports done(). */
  private litHandle: ActionHandle | null = null;
  private litLeft = 0;
  /** Drawn flame size 0..1 (it grows on lighting and shrinks going out). */
  private flame = 0;
  /** Extra brightness just after lighting. */
  private flare = 0;
  /** Local ms driving the flicker. */
  private flicker = 0;
  /** Local ms since the flame went out, while its smoke rises; WISP_MS or more when there is none. */
  private wisp = WISP_MS;
  /** Water put it out: the smoke is thicker, with steam in it. */
  private wispSteam = false;

  constructor(env: PropEnv) {
    super('candle', env);
  }

  get isLit(): boolean {
    return this.lit;
  }

  /** Broken lengths of wax and pieces of the brass stick, pale where they snapped. */
  protected override buildWreck(art: CandleArt): Sprite | null {
    return paintShards(this.env.canvas, art.body, art.heap, { seed: 11, pieces: 4, spread: 70, edge: 'rgba(236,224,194,0.6)', jag: 1.1, solid: CANDLE_SOLID });
  }

  protected ownLabel(): string {
    return this.lit ? 'lit candle' : 'candle';
  }

  protected ownTags(): string[] {
    return [...SMALL_TAGS, this.lit ? T.burning : T.flammable];
  }

  protected ownState(): Record<string, boolean | number | string> {
    return { lit: this.lit };
  }

  protected override applyOwn(use: string, action: PropAction, services: StageServices): boolean {
    if (use === 'prop.ignite') {
      // Lighting a lit candle (Incendio cast again) adopts the new cast, so ending the earlier cast
      // no longer puts the flame out; the flame flares up again.
      this.litHandle?.drop();
      this.lit = true;
      this.litCastId = action.cast.id;
      this.flare = 1;
      const held = bool(action.step.hold, false);
      const duration = num(action.step.duration_ms, 0, 0, EFFECT_LIMITS.maxStepMs);
      this.litHandle = !held && duration > 0 ? handleOf(action) : null;
      this.litLeft = this.litHandle ? duration : 0;
      this.changed();
      return true;
    }
    if (use === 'prop.douse') {
      if (this.lit) this.putOut('douse');
      return true;
    }
    return super.applyOwn(use, action, services);
  }

  protected override endOwn(castId: string): void {
    if (this.lit && (castId === '*' || castId === this.litCastId)) this.putOut('end');
  }

  protected override onShatter(): void {
    if (this.lit) this.putOut('shatter');
  }

  /** The flame has finished catching or going out, and the flare of lighting has died down. Its
   *  flicker is ambient and never counts. */
  protected override ownSettled(): boolean {
    return this.flare <= 0 && this.flame === (this.lit ? 1 : 0) && this.wisp >= WISP_MS;
  }

  protected override resetOwn(): void {
    this.lit = false;
    this.litCastId = null;
    this.litHandle?.drop();
    this.litHandle = null;
    this.litLeft = 0;
    this.flame = 0;
    this.flare = 0;
    this.wisp = WISP_MS;
  }

  private putOut(how: 'douse' | 'end' | 'shatter'): void {
    this.lit = false;
    this.litCastId = null;
    this.litHandle?.drop();
    this.litHandle = null;
    this.litLeft = 0;
    if (how !== 'shatter') {
      this.smoke(how === 'douse');
      this.wisp = 0;
      this.wispSteam = how === 'douse';
    }
    this.changed();
  }

  /** Smoke from the wick: a thin wisp when the spell ends, smoke and steam when water hits it. */
  private smoke(steam: boolean): void {
    const s = this.services;
    if (!s) return;
    const p = this.localToCaster(WICK_TOP.x, WICK_TOP.y - 4, this.scaler.value, this.pt);
    s.particles.burst({
      preset: 'smoke', x: p.x, y: p.y, count: this.count(steam ? 16 : 7), speed: steam ? 0.7 : 0.45,
      spreadDeg: steam ? 40 : 18, directionDeg: -90, lifeMs: 1700,
    });
    if (steam) {
      s.particles.burst({ preset: 'mist', x: p.x, y: p.y, count: this.count(10), speed: 0.8, spreadDeg: 80, directionDeg: -90 });
    }
  }

  protected override advanceOwn(dt: number): void {
    this.flicker += dt;
    if (this.wisp < WISP_MS) this.wisp = Math.min(WISP_MS, this.wisp + dt);
    if (this.lit && this.flame < 1) this.flame = Math.min(1, this.flame + dt / (this.reduced ? 120 : 320));
    else if (!this.lit && this.flame > 0) this.flame = Math.max(0, this.flame - dt / 170);
    if (this.flare > 0) this.flare = Math.max(0, this.flare - dt / 650);
    if (this.lit && this.litHandle) {
      this.litLeft -= dt;
      if (this.litLeft <= 0) {
        const h = this.litHandle;
        this.litHandle = null;
        this.putOut('end');
        this.complete(h);
      }
    }
  }

  protected override drawBody(layers: Layers, frame: FrameInfo, services: StageServices, art: CandleArt, size: number, alpha: number): void {
    super.drawBody(layers, frame, services, art, size, alpha);
    if (this.flame > 0.002) this.drawFlame(layers.light, services, art, size, alpha);
    if (this.wisp < WISP_MS) this.drawWisp(layers.shade, size, alpha);
  }

  /** A thin curl of smoke rising from the wick and thinning as it goes, upright whatever the candle
   *  does. Drawn in a few pieces, each fainter than the one below, so it fades upward without a
   *  gradient made every frame. Under reduced motion it rises straight and simply fades. */
  private drawWisp(shade: CanvasRenderingContext2D, size: number, alpha: number): void {
    const v = this.env.view;
    const m = v.pxPerMh * size;
    const u = this.wisp / WISP_MS;
    const wick = this.localToPx(WICK_TOP.x, WICK_TOP.y, size, this.pt);
    const wx = wick.x;
    const wy = wick.y;
    const rise = (this.reduced ? 46 : 60 + 110 * Math.sqrt(u)) * m;
    const fade = (1 - u) * (1 - u) * alpha * (this.wispSteam ? 1.25 : 1);
    const t = this.wisp / 1000;
    const total = WISP_PIECES * WISP_POINTS;
    shade.save();
    shade.lineCap = 'round';
    shade.lineJoin = 'round';
    for (let strand = 0; strand < 2; strand++) {
      shade.strokeStyle = strand === 0 ? '#C9C7CC' : '#8E8E98';
      let px = wx;
      let py = wy;
      for (let piece = 0; piece < WISP_PIECES; piece++) {
        shade.beginPath();
        shade.moveTo(px, py);
        for (let i = 1; i <= WISP_POINTS; i++) {
          const f = (piece * WISP_POINTS + i) / total;
          const curl = this.reduced ? 0 : Math.sin(f * 6.2 - t * 2.6 + strand * 1.9) * (2 + 15 * f * f) * m;
          const drift = (strand === 0 ? 1 : -0.7) * f * f * 12 * m;
          px = wx + curl + drift;
          py = wy - rise * f;
          shade.lineTo(px, py);
        }
        const k = 1 - piece / WISP_PIECES;
        shade.globalAlpha = (strand === 0 ? 0.42 : 0.2) * fade * k * k;
        shade.lineWidth = (strand === 0 ? 1.3 : 3.4) * m * (1 + 1.6 * u) * (1 + piece * 0.35);
        shade.stroke();
      }
    }
    shade.restore();
  }

  /** The flame stays upright whatever the candle does, and leans away from its motion. */
  private drawFlame(light: CanvasRenderingContext2D, services: StageServices, art: CandleArt, size: number, alpha: number): void {
    const v = this.env.view;
    const m = v.pxPerMh * size;
    const t = this.flicker / 1000;
    const amp = this.reduced ? 0.35 : 1;
    const f1 = 0.5 * Math.sin(t * 7.3) + 0.3 * Math.sin(t * 12.9 + 1.3) + 0.2 * Math.sin(t * 23.1 + 0.4);
    const f2 = 0.6 * Math.sin(t * 5.1 + 2.1) + 0.4 * Math.sin(t * 9.7 + 0.2);
    const level = easeOut(this.flame) * (1 + 0.3 * this.flare);
    const glow = (0.87 + 0.13 * f1 * amp) * this.flame * alpha;
    const warm = services.glow(FLAME_GLOW);

    // The melted pool glows through the wax.
    const pool = this.localToPx(0, WAX_TOP_Y + 5, size, this.pt);
    light.save();
    light.globalAlpha = 0.5 * glow;
    light.drawImage(warm, pool.x - 22 * m, pool.y - 17 * m, 44 * m, 34 * m);

    const wick = this.localToPx(WICK_TOP.x, WICK_TOP.y + 0.5, size, this.pt);
    // A halo, and the faint warm light the candle throws over the shelf and the room.
    light.globalAlpha = Math.min(1, (0.6 + 0.35 * this.flare) * glow);
    const halo = 190 * m;
    light.drawImage(warm, wick.x - halo / 2, wick.y - halo * 0.62, halo, halo);
    if (this.quality === 'high') {
      light.globalAlpha = 0.17 * glow;
      const room = 900 * v.pxPerMh;
      light.drawImage(warm, wick.x - room / 2, wick.y - room * 0.45, room, room);
    }
    // A warm pool on the shelf around its foot (Section 10.1: a dark study lit by one candle). It fades
    // as the candle is lifted away from the shelf, and follows it when it is pushed along.
    const lift = clamp01((this.home.y - this.y) / v.hToY / 0.12);
    if (lift < 1) {
      const k = (1 - lift) * glow;
      const poolW = 420 * v.pxPerMh;
      const poolH = 60 * v.pxPerMh;
      const shelfY = v.py(SHELF_TOP) - 2 * v.pxPerMh;
      light.globalAlpha = 0.3 * k;
      light.drawImage(warm, this.baseX() - poolW / 2, shelfY - poolH / 2, poolW, poolH);
    }
    light.globalAlpha = Math.min(1, this.flame * 1.15) * alpha;
    const lean = clamp(-this.vx * 0.9, -0.5, 0.5) + 0.06 * f2 * amp;
    light.translate(wick.x, wick.y);
    light.transform(1, 0, -lean, 1, 0, 0);
    light.scale(m * (1 - 0.045 * f1 * amp) * Math.min(1, level * 1.4), m * (1 + 0.08 * f1 * amp) * level);
    drawSprite(light, art.flame);
    light.restore();
  }
}
