// creature.summon (Expecto Patronum): "A silver creature bursts out and circles the frame"
// (Section 8). An original silver hare of light, drawn procedurally (Section 10.7: original art, no
// assets). It bursts from the tip, runs a loop round the frame that reads as circling in depth
// (larger and brighter along the bottom, smaller along the top), trails silver motes and mist, and
// leaps away in a shower of stars when its time is up.
//
// The hare is a creature of light: a translucent body with a bright core inside a misty aura, its
// form drawn by fine flowing strands that follow the anatomy (the line of the back, fur flowing over
// the shoulder and round the haunch, down the legs and along the long ears), with wisps of light
// peeling off its ears, back, tail and paws and streaming behind it as it runs. The drawing is a
// rest pose bound to a small skeleton: every frame the skeleton is posed for the gallop and each
// point of the drawing follows its one or two bones (skinning), so the strands flow across the
// joints. A wisp is traced through where its anchor was over the last moments, so it trails the
// stride the way light shed by a running animal would. At its entry the strands draw themselves in.
//
// Motion runs on the stage's scaled clock, so Arresto Momentum freezes the hare mid-stride.
//
// Cost (Section 2 targets): the strands are three filled paths and the wisps one, drawn straight
// onto the light layer; the glow is the silhouette drawn at a quarter of the resolution and blurred
// there; sprites and gradients are made once per color, and nothing is allocated per frame.

import { scaleParticleCount, type CreatureParams } from './limits';
import type { XY } from './anchors';
import { mixRgb, parseColor, rgba, type Rgb } from './color';
import type { ParticleSystem } from './particles';
import { makeCanvas } from './sprites';
import type { View } from './view';

const ENTRY_MS = 750;
const EXIT_MS = 850;
const LAP_MS = 3600;
const STRIDE_MS = 340;
/** Body length as a fraction of the mirror height, at the front of the loop. */
const BODY = 0.2;
/** Trail rates per second, before reduced motion cuts them (scaleParticleCount). */
const TRAIL_STARS = 30;
const TRAIL_MIST = 10;
/** Where the trail leaves the hare, in its own units (body length 1, facing +x, y down): the tail,
 *  the rump, an ear tip, the haunch, a hind paw, the back, a forepaw. */
const TRAIL_FROM: readonly (readonly [number, number])[] = [
  [-0.43, -0.16], [-0.28, -0.2], [0.08, -0.46], [-0.41, -0.01], [-0.12, 0.19], [-0.06, -0.21], [0.2, 0.19],
];

export interface Pose {
  /** Caster space. */
  x: number;
  y: number;
  /** Size multiplier (depth). */
  scale: number;
  alpha: number;
}

export class Creature {
  /** Scaled time since it appeared. */
  clock = 0;
  endedAt: number | null = null;
  /** Scaled clock when the exit began. */
  private exitClock: number | null = null;
  private exitFrom: Pose | null = null;
  private exitVel: XY = { x: 0, y: 0 };
  private trailAcc = 0;
  private mistAcc = 0;
  private trailN = 0;
  private burstDone = false;
  /** Loop angle where the hare joins the run (set on first placement, from the tip). */
  private phase0 = Math.PI / 2;
  private phaseSet = false;
  pose: Pose = { x: 0, y: 0, scale: 0.3, alpha: 0 };
  facing = 1;
  tilt = 0;
  /** `facing`, eased: when the hare turns at the ends of its loop it is drawn narrowing through
   *  the turn rather than flipping in one frame. Drawing only. */
  turn = 1;
  /** Reduced motion, as of the last update: the drawing sheds fewer motes. */
  reduced = false;

  constructor(
    readonly castId: string,
    readonly params: CreatureParams,
    /** Where it bursts out (the tip), caster space. */
    readonly from: XY,
    readonly born: number,
  ) {}

  /** When its time is up; a held creature (hold: true) stays until its spell ends. */
  get until(): number {
    return this.params.duration_ms !== undefined ? this.born + this.params.duration_ms : Number.POSITIVE_INFINITY;
  }

  end(now: number): void {
    if (this.endedAt === null) this.endedAt = Math.min(now, this.until);
  }

  gone(): boolean {
    return this.exitClock !== null && this.clock - this.exitClock >= EXIT_MS;
  }

  /** 0 before the leap away, rising to 1 as it ends. */
  get leaving(): number {
    return this.exitClock === null ? 0 : Math.min(1, (this.clock - this.exitClock) / EXIT_MS);
  }

  /** Where the loop puts the hare after `t` ms of running (isotropic units, y down). */
  static loop(t: number, aspect: number, phase0: number): { x: number; y: number; depth: number } {
    // Counter-clockwise on screen: along the bottom it runs to the right, toward you.
    const theta = phase0 - (t / LAP_MS) * Math.PI * 2;
    const cx = 0.5 * aspect, cy = 0.5;
    const rx = 0.34 * aspect, ry = 0.2;
    return { x: cx + Math.cos(theta) * rx, y: cy + Math.sin(theta) * ry, depth: Math.sin(theta) };
  }

  /** Position (caster space), scale and alpha at scaled time t, before any exit. */
  private place(t: number, aspect: number): Pose {
    if (!this.phaseSet) {
      // Join the loop at the point nearest the tip, so the burst flows straight into the run.
      const cx = 0.5 * aspect, cy = 0.5, rx = 0.34 * aspect, ry = 0.2;
      this.phase0 = Math.atan2((this.from.y - cy) / ry, (this.from.x * aspect - cx) / rx);
      this.phaseSet = true;
    }
    const p = Creature.loop(t, aspect, this.phase0);
    const loopScale = 0.78 + 0.26 * p.depth;
    const loopAlpha = 0.72 + 0.28 * (0.5 + 0.5 * p.depth);
    if (t >= ENTRY_MS) return { x: p.x / aspect, y: p.y, scale: loopScale, alpha: loopAlpha };
    const k = t / ENTRY_MS;
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const tx = this.from.x * aspect, ty = this.from.y;
    const x = tx + (p.x - tx) * e;
    const y = ty + (p.y - ty) * e - 0.14 * Math.sin(Math.PI * e);
    return { x: x / aspect, y, scale: 0.3 + (loopScale - 0.3) * e, alpha: Math.min(1, k * 2.5) * loopAlpha };
  }

  update(now: number, dt: number, aspect: number, particles: ParticleSystem, reducedMotion: boolean): void {
    this.clock += dt;
    this.reduced = reducedMotion;
    const t = this.clock;
    // It leaps away when it is ended, or when its time is up: then the director has already sent its
    // effect.end ('done') and will not end it again, so nothing else would ever send it off.
    if (this.exitClock === null && now >= (this.endedAt ?? this.until)) {
      this.exitClock = t;
      this.exitFrom = this.place(t, aspect);
      const ahead = this.place(t + 60, aspect);
      this.exitVel = { x: (ahead.x - this.exitFrom.x) / 60, y: (ahead.y - this.exitFrom.y) / 60 };
    }
    const prev = this.pose;
    let next: Pose;
    if (this.exitClock !== null && this.exitFrom) {
      // The leap away: carry on, rise, shrink and fade.
      const k = Math.min(1, (t - this.exitClock) / EXIT_MS);
      const s = t - this.exitClock;
      next = {
        x: this.exitFrom.x + this.exitVel.x * s,
        y: this.exitFrom.y + this.exitVel.y * s - 0.25 * k * k,
        scale: this.exitFrom.scale * (1 - 0.35 * k),
        alpha: this.exitFrom.alpha * (1 - k) ** 1.5,
      };
      if (!this.burstDone) {
        this.burstDone = true;
        particles.spawn({
          preset: 'stars', x: this.exitFrom.x, y: this.exitFrom.y, count: scaleParticleCount(40, reducedMotion), color: this.params.color, speed: 1.2,
        });
        particles.spawn({
          preset: 'mist', x: this.exitFrom.x, y: this.exitFrom.y, count: scaleParticleCount(8, reducedMotion), color: this.params.color, speed: 0.8,
          size: 0.45 * this.exitFrom.scale * this.params.size, lifeMs: 1300,
        });
      }
    } else {
      next = this.place(t, aspect);
    }
    // Facing and tilt follow the direction of travel; the hare flips rather than running upside down.
    const vx = (next.x - prev.x) * aspect, vy = next.y - prev.y;
    if (Math.abs(vx) > 1e-5) this.facing = vx < 0 ? -1 : 1;
    if (Math.abs(vx) + Math.abs(vy) > 1e-5) {
      const tilt = Math.atan2(vy, Math.abs(vx));
      this.tilt += (Math.max(-0.45, Math.min(0.45, tilt)) - this.tilt) * Math.min(1, dt / 90);
    }
    // Before it shows, it simply faces its way; after, it turns in about a tenth of a second (on the
    // scaled clock, so a frozen turn stays frozen).
    if (next.alpha < 0.08) this.turn = this.facing;
    else this.turn += (this.facing - this.turn) * Math.min(1, dt / 55);
    this.pose = next;

    // A trail of silver light behind it: motes shed from the tail, ears, back and paws, and a faint
    // mist along its path.
    if (dt > 0 && next.alpha > 0.05) {
      const len = BODY * next.scale * this.params.size;
      this.trailAcc += (dt / 1000) * scaleParticleCount(TRAIL_STARS, reducedMotion);
      while (this.trailAcc >= 1) {
        this.trailAcc -= 1;
        const from = TRAIL_FROM[this.trailN++ % TRAIL_FROM.length];
        const tiny = this.trailN % 3 === 0;
        particles.spawn({
          preset: 'stars', x: this.offX(next, from[0], from[1], len, aspect), y: this.offY(next, from[0], from[1], len), count: 1,
          color: this.params.color, speed: 0.22, size: (tiny ? 0.35 : 0.55) + next.scale * 0.35, lifeMs: tiny ? 700 : 1000,
        });
      }
      this.mistAcc += (dt / 1000) * scaleParticleCount(TRAIL_MIST, reducedMotion);
      while (this.mistAcc >= 1) {
        this.mistAcc -= 1;
        particles.spawn({
          preset: 'mist', x: this.offX(next, -0.25, -0.05, len, aspect), y: this.offY(next, -0.25, -0.05, len), count: 1,
          color: this.params.color, speed: 0.3, size: 0.45 + 0.45 * next.scale * this.params.size, lifeMs: 1700,
        });
      }
    }
  }

  /** Caster x of a point in the hare's own units (see TRAIL_FROM), for a body `len` caster heights long. */
  private offX(p: Pose, lx: number, ly: number, len: number, aspect: number): number {
    const a = this.tilt * this.facing;
    return p.x + (Math.cos(a) * lx * this.facing - Math.sin(a) * ly) * len / aspect;
  }

  private offY(p: Pose, lx: number, ly: number, len: number): number {
    const a = this.tilt * this.facing;
    return p.y + (Math.sin(a) * lx * this.facing + Math.cos(a) * ly) * len;
  }
}

// ---------------------------------------------------------------- the rig

// Bones. Every parent comes before its children, so one pass poses them all.
const ROOT = 0, FRONT = 1, REAR = 2, NECK = 3, HEAD = 4, EAR_N = 5, EAR_F = 6, TAIL = 7;
const FU_N = 8, FL_N = 9, FP_N = 10, FU_F = 11, FL_F = 12, FP_F = 13; // forelegs: upper, forearm, paw
const HT_N = 14, HS_N = 15, HF_N = 16, HT_F = 17, HS_F = 18, HF_F = 19; // hind legs: thigh, shin, foot
const BONES = 20;
const PARENT = [-1, ROOT, ROOT, FRONT, NECK, HEAD, HEAD, REAR, FRONT, FU_N, FL_N, FRONT, FU_F, FL_F, REAR, HT_N, HS_N, REAR, HT_F, HS_F];

type P = readonly [number, number];
type Bind = readonly [number, number, number];
type Binder = (x: number, y: number) => Bind;

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const smooth = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

// The rest pose: a hare mid-stride, body length 1 (nose to tail), facing +x, y down, origin in the
// middle of the body. The far legs sit a little behind and above the near ones.
const CENTRE: P = [0, -0.07];
const MID_BACK: P = [-0.02, -0.12];
const NECK_AT: P = [0.25, -0.13];
const ATLAS: P = [0.35, -0.175];
const EAR_BASE_N: P = [0.378, -0.24], EAR_TIP_N: P = [0.1, -0.47];
const EAR_BASE_F: P = [0.356, -0.232], EAR_TIP_F: P = [0.035, -0.425];
const TAIL_AT: P = [-0.37, -0.12];
const SHOULDER: P = [0.18, -0.02], ELBOW: P = [0.15, 0.08], WRIST: P = [0.17, 0.168], PAW: P = [0.228, 0.196];
const HIP: P = [-0.235, -0.05], KNEE: P = [-0.105, 0.06], HOCK: P = [-0.245, 0.15], TOES: P = [-0.005, 0.196];
const FAR: P = [-0.032, -0.014];

const PIVOT: P[] = [
  CENTRE, MID_BACK, MID_BACK, NECK_AT, ATLAS, EAR_BASE_N, EAR_BASE_F, TAIL_AT,
  SHOULDER, ELBOW, WRIST, add(SHOULDER, FAR), add(ELBOW, FAR), add(WRIST, FAR),
  HIP, KNEE, HOCK, add(HIP, FAR), add(KNEE, FAR), add(HOCK, FAR),
];

const dir = (a: P, b: P): number => Math.atan2(b[1] - a[1], b[0] - a[0]);
const DEG = Math.PI / 180;
/** Rest directions of the leg bones, and where the gallop takes them (radians, in the body's frame;
 *  0 points forward, a quarter turn points down). Extension: forepaws reach forward, hind feet push
 *  far back. Gather: the hind feet swing forward past the folded forelegs, the back arched. Each
 *  bone lags its parent a little, so a leg whips rather than swinging stiffly. */
const FORE_REST = [dir(SHOULDER, ELBOW), dir(ELBOW, WRIST), dir(WRIST, PAW)];
const HIND_REST = [dir(HIP, KNEE), dir(KNEE, HOCK), dir(HOCK, TOES)];
const FORE_EXT = [38 * DEG, 14 * DEG, 2 * DEG], FORE_GATHER = [126 * DEG, 150 * DEG, 196 * DEG];
const HIND_EXT = [126 * DEG, 166 * DEG, 176 * DEG], HIND_GATHER = [10 * DEG, 114 * DEG, 24 * DEG];
const FORE_LAG = [0, 0.045, 0.09], HIND_LAG = [0, 0.07, 0.15];

/** Bind points along a chain of joints: each to the bone of its nearest segment, blended across a
 *  joint within `blend` of it, so the drawing bends smoothly there. */
function chain(joints: P[], bones: number[], blend: number[]): Binder {
  const cum = [0];
  for (let i = 1; i < joints.length; i++) cum.push(cum[i - 1] + Math.hypot(joints[i][0] - joints[i - 1][0], joints[i][1] - joints[i - 1][1]));
  return (x, y) => {
    let best = Infinity, sigma = 0, seg = 0;
    for (let i = 0; i < bones.length; i++) {
      const [ax, ay] = joints[i], [bx, by] = joints[i + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (d < best - 1e-9) {
        best = d;
        sigma = cum[i] + t * Math.sqrt(len2);
        seg = i;
      }
    }
    for (let k = 1; k < bones.length; k++) {
      const r = blend[k - 1], off = sigma - cum[k];
      if (Math.abs(off) < r) return [bones[k - 1], bones[k], smooth((off + r) / (2 * r))];
    }
    return [bones[seg], bones[seg], 0];
  };
}

const bindBody = chain([[-0.6, -0.09], MID_BACK, NECK_AT, ATLAS, [0.7, -0.14]], [REAR, FRONT, NECK, HEAD], [0.17, 0.05, 0.03]);
const bindHead = chain([[0.3, -0.15], ATLAS, [0.7, -0.14]], [NECK, HEAD], [0.025]);
const bindEarN = chain([[0.4, -0.2], EAR_BASE_N, EAR_TIP_N], [HEAD, EAR_N], [0.025]);
const bindEarF = chain([[0.38, -0.19], EAR_BASE_F, EAR_TIP_F], [HEAD, EAR_F], [0.025]);
const bindTail = chain([[-0.3, -0.12], TAIL_AT, [-0.5, -0.17]], [REAR, TAIL], [0.03]);
const foreChain = (o: P, bones: number[]): Binder =>
  chain([add([0.18, -0.12], o), add(SHOULDER, o), add(ELBOW, o), add(WRIST, o), add(PAW, o)], [FRONT, ...bones], [0.05, 0.022, 0.016]);
const hindChain = (o: P, bones: number[]): Binder =>
  chain([add([-0.235, -0.17], o), add(HIP, o), add(KNEE, o), add(HOCK, o), add(TOES, o)], [REAR, ...bones], [0.06, 0.03, 0.025]);
const bindForeN = foreChain([0, 0], [FU_N, FL_N, FP_N]), bindForeF = foreChain(FAR, [FU_F, FL_F, FP_F]);
const bindHindN = hindChain([0, 0], [HT_N, HS_N, HF_N]), bindHindF = hindChain(FAR, [HT_F, HS_F, HF_F]);
/** The haunch is the thigh's muscle: its top rides with the pelvis, its lower part more with the thigh. */
const bindHaunch: Binder = (_x, y) => [REAR, HT_N, 0.18 + 0.44 * smooth((y + 0.16) / 0.3)];
const bindShoulder: Binder = () => [FRONT, FU_N, 0.32];
/** The bones posed for the wisps' past moments (see poseSkeleton). */
const posedInPast = (bone: number): boolean => bone <= TAIL || bone === HT_N;

/** A strand: a run of rest points drawn as a tapered ribbon of light. */
interface Strand {
  start: number;
  count: number;
  /** 0 the bright rim (contours), 1 fur flow, 2 fine inner and far-side detail. */
  tier: number;
  /** Width at its widest, device px for a body 300 px long. */
  width: number;
  /** Share of its length over which it swells from its start, and thins to its end. */
  rampIn: number;
  rampOut: number;
  /** When it begins to draw itself in during the entry (share of the entry). */
  delay: number;
  seed: number;
}

/** A wisp of light peeling off the hare at a skinned anchor point. */
interface Wisp {
  anchor: number;
  /** Length in body lengths, and width (px for a 300 px body). */
  len: number;
  width: number;
  /** Sideways flutter, body lengths. */
  amp: number;
  /** How much it drifts up as it trails (negative sinks). */
  rise: number;
  /** Traced through where its anchor was (the body), or streaming straight back from where it is
   *  now (the paws, whose swing would trace loops). */
  trail: boolean;
  seed: number;
}

/** A leg's axis, filled thick and tapering into the glow. */
interface LegAxis {
  start: number;
  count: number;
  /** Width at the top and at the paw, body lengths. */
  w0: number;
  w1: number;
}

interface Rig {
  points: number;
  rx: Float32Array;
  ry: Float32Array;
  ba: Uint8Array;
  bb: Uint8Array;
  bw: Float32Array;
  /** By tier. */
  strands: Strand[][];
  maxRun: number;
  outline: { start: number; count: number };
  ears: { start: number; count: number }[];
  legs: LegAxis[];
  wisps: Wisp[];
  tail: number;
  eye: number;
  nose: number;
  earTips: number[];
  /** The near hind toes and forepaw. */
  toes: number;
  paw: number;
  motes: number[];
  dust: number[];
}

/** Uniform Catmull-Rom through `pts`, one sample about every `step` body lengths. */
function spline(pts: P[], step = 0.026): P[] {
  const out: P[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const per = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/** Points on an ellipse round (cx, cy), from angle a0 to a1 (degrees; 0 forward, 90 down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, step = 0.026): P[] {
  const span = Math.abs(a1 - a0) * DEG * Math.max(rx, ry);
  const n = Math.max(3, Math.ceil(span / step) + 1);
  const out: P[] = [];
  for (let k = 0; k < n; k++) {
    const a = (a0 + ((a1 - a0) * k) / (n - 1)) * DEG;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

/** Offset a sampled curve sideways by `off(s)` (s 0..1 along it), along its normal. */
function offset(curve: P[], off: (s: number) => number): P[] {
  const n = curve.length;
  return curve.map((p, i) => {
    const a = curve[Math.max(0, i - 1)], b = curve[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const o = off(i / (n - 1));
    return [p[0] - (dy / len) * o, p[1] + (dx / len) * o] as P;
  });
}

/** The part of a sampled curve between s0 and s1 (0..1). */
function part(curve: P[], s0: number, s1: number): P[] {
  const n = curve.length - 1;
  return curve.slice(Math.round(s0 * n), Math.round(s1 * n) + 1);
}

/** A long ear: its axis bows up from base to tip; it is widest about a third of the way out. */
function leaf(base: P, tip: P, width: number, bow: number): { edgeA: P[]; edgeB: P[]; axis: P[]; w: (s: number) => number } {
  const mx = (base[0] + tip[0]) / 2, my = (base[1] + tip[1]) / 2;
  const dx = tip[0] - base[0], dy = tip[1] - base[1], len = Math.hypot(dx, dy);
  const nx = dy / len, ny = -dx / len; // toward the front and top of the ear
  const c: P = [mx + nx * bow, my + ny * bow];
  const axis: P[] = [];
  const n = 16;
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    axis.push([u * u * base[0] + 2 * u * t * c[0] + t * t * tip[0], u * u * base[1] + 2 * u * t * c[1] + t * t * tip[1]]);
  }
  const w = (s: number) => width * Math.sin(Math.PI * (0.2 + 0.8 * s)) ** 0.7 * (1 - 0.3 * s);
  return { edgeA: offset(axis, (s) => -w(s) / 2), edgeB: offset(axis, (s) => w(s) / 2), axis, w };
}

function buildRig(): Rig {
  const rx: number[] = [], ry: number[] = [], ba: number[] = [], bb: number[] = [], bw: number[] = [];
  const strands: Strand[][] = [[], [], []];
  let seed = 9001;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const point = (p: P, bind: Binder): number => {
    const [a, b, w] = bind(p[0], p[1]);
    rx.push(p[0]); ry.push(p[1]); ba.push(a); bb.push(b); bw.push(w);
    return rx.length - 1;
  };
  const run = (pts: P[], bind: Binder): { start: number; count: number } => {
    const start = rx.length;
    for (const p of pts) point(p, bind);
    return { start, count: pts.length };
  };
  /** Add a strand. How far forward it reaches sets when it draws itself in: front first, so the
   *  hare forms from the head back as it bursts out. */
  const strand = (pts: P[], bind: Binder, tier: number, width: number, rampIn = 0.3, rampOut = 0.5): void => {
    if (pts.length < 2) return;
    const { start, count } = run(pts, bind);
    const front = Math.max(...pts.map((p) => p[0]));
    const delay = Math.min(0.5, Math.max(0, (0.55 - front) * 0.4 + rnd() * 0.12));
    strands[tier].push({ start, count, tier, width, rampIn, rampOut, delay, seed: rnd() * Math.PI * 2 });
  };
  const wavy = (curve: P[], amp: number, waves: number): P[] => {
    const ph = rnd() * Math.PI * 2;
    return offset(curve, (s) => amp * Math.sin(s * waves * Math.PI * 2 + ph));
  };

  // The line of the back, from the poll to the tail: the brightest strands, laid as two long strokes
  // that overlap over the loin like brush strokes, with a finer one beside them.
  const back = spline([
    [0.338, -0.216], [0.302, -0.188], [0.25, -0.172], [0.18, -0.169], [0.1, -0.18], [0.02, -0.195], [-0.07, -0.206],
    [-0.16, -0.21], [-0.24, -0.2], [-0.3, -0.181], [-0.345, -0.153], [-0.373, -0.12],
  ]);
  strand(part(back, 0, 0.62), bindBody, 0, 2.4, 0.06, 0.3);
  strand(part(offset(back, () => -0.007), 0.4, 1), bindBody, 0, 2.2, 0.3, 0.15);
  strand(spline([[0.25, -0.16], [0.16, -0.162], [0.06, -0.176], [-0.04, -0.19], [-0.14, -0.196], [-0.23, -0.188], [-0.29, -0.17], [-0.33, -0.145]]), bindBody, 1, 1.25);

  // Head: the profile from the brow to the lip, the line under the jaw, the cheek sweeping back from
  // under the eye, the bridge of the nose, the split lip, the back of the skull, and the eye.
  strand(spline([[0.392, -0.247], [0.44, -0.249], [0.488, -0.229], [0.522, -0.193], [0.545, -0.155], [0.548, -0.131], [0.536, -0.114]], 0.015), bindHead, 0, 2, 0.15, 0.25);
  strand(spline([[0.52, -0.103], [0.492, -0.092], [0.455, -0.088], [0.41, -0.097], [0.377, -0.118], [0.356, -0.15]], 0.015), bindHead, 1, 1.3, 0.25, 0.45);
  strand(spline([[0.44, -0.186], [0.415, -0.17], [0.395, -0.145], [0.385, -0.118]], 0.012), bindHead, 2, 0.9, 0.3, 0.5);
  strand(spline([[0.425, -0.224], [0.46, -0.216], [0.493, -0.2]], 0.012), bindHead, 2, 1);
  strand(spline([[0.532, -0.168], [0.506, -0.18], [0.478, -0.196]], 0.012), bindHead, 2, 0.9);
  strand(spline([[0.546, -0.14], [0.538, -0.124], [0.526, -0.114]], 0.008), bindHead, 2, 0.8);
  strand(spline([[0.354, -0.228], [0.342, -0.19], [0.348, -0.152], [0.368, -0.12]], 0.015), bindHead, 2, 0.9);
  const eyeRing: P[] = [];
  for (let k = 0; k <= 14; k++) {
    const a = (k / 14) * Math.PI * 2, c = Math.cos(-0.25), s = Math.sin(-0.25);
    const ex = Math.cos(a) * 0.021, ey = Math.sin(a) * 0.0125;
    eyeRing.push([0.463 + ex * c - ey * s, -0.192 + ex * s + ey * c]);
  }
  strand(eyeRing, bindHead, 0, 1.3, 0.12, 0.12);

  // The long ears, swept back by the run: an outline, two inner lines and a faint vein each.
  const ears: { start: number; count: number }[] = [];
  const earTips: number[] = [];
  for (const [base, tip, width, bow, bind, near] of [
    [EAR_BASE_N, EAR_TIP_N, 0.082, 0.035, bindEarN, true],
    [EAR_BASE_F, EAR_TIP_F, 0.07, 0.03, bindEarF, false],
  ] as const) {
    const e = leaf(base, tip, width, bow);
    const outline = [...e.edgeB, ...[...e.edgeA].reverse()];
    const startAt = rx.length;
    strand(outline, bind, near ? 0 : 2, near ? 1.7 : 1.1, 0.08, 0.08);
    ears.push({ start: startAt, count: outline.length });
    const inner = (k: number) => part(offset(e.axis, (s) => (k * e.w(s)) / 2), 0.08, 0.9);
    strand(inner(0.45), bind, near ? 1 : 2, near ? 1.1 : 0.8);
    if (near) strand(inner(-0.42), bind, 1, 1);
    strand(part(e.axis, 0.05, 0.95), bind, 2, near ? 0.9 : 0.7);
    earTips.push(point(e.axis[e.axis.length - 1], bind));
  }

  // Throat and chest, and the belly (fainter: the light falls on the back).
  strand(spline([[0.372, -0.112], [0.345, -0.077], [0.312, -0.032], [0.278, 0.016], [0.24, 0.058], [0.196, 0.08]]), bindBody, 0, 1.6, 0.15, 0.45);
  strand(spline([[0.196, 0.082], [0.13, 0.087], [0.05, 0.081], [-0.03, 0.067], [-0.1, 0.048], [-0.125, 0.04]]), bindBody, 1, 1.15, 0.3, 0.4);

  // Fur flowing along the flank, from the shoulder back toward the haunch: long lines laid between
  // the back and the belly, gently curved, starting and ending at different places, and the lower
  // ones bending down toward the thigh.
  const upper = spline([[0.25, -0.158], [0.15, -0.162], [0.05, -0.176], [-0.05, -0.19], [-0.15, -0.195], [-0.24, -0.183]], 0.02);
  const lower = spline([[0.25, 0.03], [0.16, 0.072], [0.06, 0.076], [-0.04, 0.062], [-0.12, 0.042], [-0.19, 0.02]], 0.02);
  const m = Math.min(upper.length, lower.length);
  const flank = (d: number, s0: number, s1: number): P[] => {
    const line: P[] = [];
    for (let k = 0; k < m; k++) {
      const u = k / (m - 1), dd = d + 0.12 * d * Math.max(0, u - 0.55) / 0.45;
      line.push([upper[k][0] + (lower[k][0] - upper[k][0]) * dd, upper[k][1] + (lower[k][1] - upper[k][1]) * dd]);
    }
    return wavy(part(line, s0, s1), 0.0025, 0.7);
  };
  for (const [d, s0, s1, tier, width] of [
    [0.17, 0, 0.97, 1, 1.15], [0.29, 0.12, 0.8, 2, 0.85], [0.4, 0.03, 0.88, 1, 1.05], [0.52, 0.2, 0.7, 2, 0.8],
    [0.62, 0.06, 0.78, 1, 1], [0.74, 0.16, 0.62, 2, 0.8], [0.85, 0.1, 0.55, 2, 0.85],
  ] as const) {
    strand(flank(d, s0, s1), bindBody, tier, width, 0.35, 0.45);
  }
  // Short hairs scattered along the flow, for texture.
  for (let k = 0; k < 26; k++) {
    const u = 0.08 + 0.78 * rnd(), d = 0.12 + 0.8 * rnd();
    const i = Math.min(m - 2, Math.floor(u * (m - 1)));
    const ax = upper[i][0] + (lower[i][0] - upper[i][0]) * d, ay = upper[i][1] + (lower[i][1] - upper[i][1]) * d;
    const len = 0.035 + 0.035 * rnd(), droop = 0.25 + 0.5 * d * u;
    strand([[ax, ay], [ax - len * 0.5, ay + len * droop * 0.25], [ax - len, ay + len * droop * 0.6]], bindBody, 2, 0.75, 0.4, 0.6);
  }

  // The neck, flowing down into the shoulder; nested arcs over the shoulder blade, opening toward
  // the elbow like the contour of a muscle.
  strand(spline([[0.348, -0.205], [0.312, -0.162], [0.272, -0.122], [0.234, -0.082], [0.208, -0.038]]), bindBody, 1, 1.1);
  strand(spline([[0.362, -0.152], [0.332, -0.105], [0.294, -0.062], [0.258, -0.014], [0.232, 0.03]]), bindBody, 2, 0.9);
  for (const [r, a0, a1, tier, width] of [[0.08, -170, 20, 1, 1.15], [0.058, -160, 32, 2, 0.95], [0.037, -145, 45, 2, 0.85]] as const) {
    const shift = 0.08 - r;
    strand(arc(0.172 + shift * 0.2, -0.04 + shift * 0.45, r, r * 0.9, a0, a1), bindShoulder, tier, width, 0.25, 0.35);
  }

  // The haunch: its outline down to the hock (bright over the rump, fading below), and nested arcs
  // round the hip that open toward the knee: the rounded mass of the thigh.
  strand(spline([[-0.373, -0.12], [-0.392, -0.093], [-0.406, -0.048], [-0.404, 0.003], [-0.388, 0.052], [-0.356, 0.094], [-0.31, 0.123], [-0.262, 0.142]]), bindHaunch, 0, 2, 0.1, 0.65);
  for (const [r, a0, a1, tier, width] of [
    [0.132, -165, 35, 1, 1.25], [0.108, -158, 48, 2, 0.95], [0.084, -150, 60, 1, 1.1], [0.06, -140, 70, 2, 0.9], [0.037, -125, 80, 2, 0.85],
  ] as const) {
    const shift = 0.132 - r;
    strand(arc(-0.228 + shift * 0.32, -0.058 + shift * 0.42, r, r * 0.92, a0, a1), bindHaunch, tier, width, 0.2, 0.4);
  }

  // The tail: a soft puff (a glow, drawn with the glints) with a few tufts curling back off it.
  const tc: P = [-0.405, -0.142];
  for (const [a, len, curl, tier] of [[200, 0.075, 0.022, 0], [232, 0.07, 0.02, 1], [168, 0.06, -0.018, 1], [258, 0.05, 0.016, 2], [185, 0.045, -0.012, 2]] as const) {
    const ca = Math.cos(a * DEG), sa = Math.sin(a * DEG), cb = -sa, sb = ca;
    strand(spline([
      [tc[0] + ca * 0.01, tc[1] + sa * 0.01], [tc[0] + ca * len * 0.55 + cb * curl, tc[1] + sa * len * 0.55 + sb * curl], [tc[0] + ca * len + cb * curl * 0.4, tc[1] + sa * len + sb * curl * 0.4],
    ], 0.01), bindTail, tier, tier === 0 ? 1.5 : 1.1, 0.2, 0.65);
  }

  // Legs: a bright stroke down the front of each, a finer one behind, converging at the paw; the
  // far legs fainter.
  const legs: LegAxis[] = [];
  for (const [o, bindFore, bindHind, near] of [[[0, 0] as P, bindForeN, bindHindN, true], [FAR, bindForeF, bindHindF, false]] as const) {
    const fore = spline([add(SHOULDER, o), add(ELBOW, o), add(WRIST, o), add(PAW, o)], 0.018);
    const fw = (s: number) => 0.05 - 0.04 * s;
    strand(part(offset(fore, (s) => -fw(s) / 2), 0.1, 1), bindFore, near ? 0 : 2, near ? 1.5 : 1, 0.2, 0.3);
    strand(part(offset(fore, (s) => fw(s) * 0.3), 0.2, 0.97), bindFore, near ? 1 : 2, near ? 1.1 : 0.8, 0.25, 0.3);
    const shin = spline([add(KNEE, o), add([-0.18, 0.112], o), add(HOCK, o)], 0.018);
    const foot = spline([add([-0.262, 0.158], o), add([-0.13, 0.18], o), add(TOES, o)], 0.018);
    const sw = (s: number) => 0.05 - 0.022 * s, pw = (s: number) => 0.03 - 0.02 * s;
    strand(offset(shin, (s) => sw(s) / 2), bindHind, near ? 0 : 2, near ? 1.45 : 0.95, 0.3, 0.2);
    strand(offset(shin, (s) => -sw(s) * 0.3), bindHind, near ? 1 : 2, near ? 1.05 : 0.8, 0.3, 0.25);
    strand(offset(foot, (s) => pw(s) / 2), bindHind, near ? 0 : 2, near ? 1.4 : 0.95, 0.15, 0.3);
    strand(offset(foot, (s) => -pw(s) * 0.3), bindHind, near ? 1 : 2, near ? 1 : 0.8, 0.2, 0.3);
    // Axes for the glow.
    legs.push({ ...run([add(SHOULDER, o), add(ELBOW, o), add(WRIST, o), add(PAW, o)], bindFore), w0: 0.06, w1: 0.018 });
    legs.push({ ...run([add(HIP, o), add(KNEE, o), add(HOCK, o), add([-0.13, 0.18], o), add(TOES, o)], bindHind), w0: 0.13, w1: 0.016 });
  }

  // The silhouette, for the glow: back, haunch, belly, chest, jaw and face.
  const outline = run([
    [0.338, -0.216], [0.25, -0.172], [0.18, -0.169], [0.1, -0.18], [0.02, -0.195], [-0.07, -0.206], [-0.16, -0.21], [-0.24, -0.2], [-0.3, -0.181],
    [-0.345, -0.153], [-0.373, -0.12],
  ], bindBody);
  run([[-0.392, -0.093], [-0.406, -0.048], [-0.404, 0.003], [-0.388, 0.052], [-0.356, 0.094], [-0.31, 0.123], [-0.262, 0.142], [-0.215, 0.12], [-0.165, 0.097], [-0.125, 0.076], [-0.105, 0.05]], bindHaunch);
  run([[-0.12, 0.04], [-0.03, 0.068], [0.05, 0.082], [0.13, 0.088], [0.196, 0.082], [0.24, 0.058], [0.278, 0.016], [0.312, -0.032], [0.345, -0.077], [0.372, -0.112]], bindBody);
  run([[0.41, -0.097], [0.455, -0.088], [0.5, -0.094], [0.528, -0.108], [0.548, -0.131], [0.545, -0.155], [0.522, -0.193], [0.488, -0.229], [0.44, -0.249], [0.392, -0.247]], bindHead);
  outline.count = rx.length - outline.start;

  // Where the wisps leave the body, and the glints.
  const wisps: Wisp[] = [];
  const wisp = (p: P, bind: Binder, len: number, width: number, amp: number, rise: number): number => {
    const anchor = point(p, bind);
    // A long wisp is traced through its anchor's past, when the past poses include its bones.
    const [a, b] = bind(p[0], p[1]);
    wisps.push({ anchor, len, width, amp, rise, trail: len > 0.2 && posedInPast(a) && posedInPast(b), seed: rnd() * Math.PI * 2 });
    return anchor;
  };
  // The ears and the back shed long threads that lift as they trail; the tail the longest
  // streamers; the paws only short flicks (a longer trail would trace the stride as extra legs).
  wisp(EAR_TIP_N, bindEarN, 0.5, 1.2, 0.03, 1.2);
  wisp([0.2, -0.385], bindEarN, 0.34, 0.85, 0.025, 0.8);
  wisp(EAR_TIP_F, bindEarF, 0.38, 0.9, 0.025, 1);
  wisp([0.29, -0.183], bindBody, 0.28, 0.9, 0.02, 1.4);
  wisp([0.15, -0.172], bindBody, 0.36, 1, 0.025, 1.5);
  wisp([-0.06, -0.206], bindBody, 0.42, 1.1, 0.03, 1.3);
  wisp([-0.13, -0.209], bindBody, 0.3, 0.8, 0.02, 2);
  wisp([-0.26, -0.196], bindBody, 0.48, 1.2, 0.035, 1);
  wisp([-0.43, -0.175], bindTail, 0.72, 1.5, 0.045, 0.6);
  wisp([-0.455, -0.13], bindTail, 0.6, 1.3, 0.04, 0.3);
  wisp([-0.44, -0.1], bindTail, 0.5, 1, 0.035, -0.2);
  wisp([-0.404, 0.0], bindHaunch, 0.36, 1, 0.03, 0.2);
  const toes = wisp(TOES, bindHindN, 0.18, 1, 0.015, 0);
  wisp(add(TOES, FAR), bindHindF, 0.14, 0.8, 0.012, 0);
  const paw = wisp(PAW, bindForeN, 0.15, 0.9, 0.012, 0);
  wisp(add(PAW, FAR), bindForeF, 0.12, 0.7, 0.01, 0);
  wisp([0.03, 0.08], bindBody, 0.28, 0.8, 0.02, -0.3);
  const tail = point(tc, bindTail);
  const eye = point([0.465, -0.193], bindHead);
  const nose = point([0.546, -0.142], bindHead);
  // Points on the body that glint now and then.
  const motes = [
    point([0.08, -0.181], bindBody), point([-0.19, -0.206], bindBody), point([-0.39, -0.04], bindHaunch), point([0.25, -0.03], bindBody),
    point([0.26, -0.37], bindEarN), point([-0.2, -0.13], bindHaunch), point([0.0, 0.0], bindBody), point([0.2, 0.12], bindForeN),
    point([-0.16, 0.17], bindHindN),
  ];

  // Stardust inside the translucent body: points scattered through the flank, haunch, chest and head.
  const dust: number[] = [];
  for (let k = 0; k < 18; k++) {
    const u = 0.05 + 0.85 * rnd(), d = 0.15 + 0.7 * rnd();
    const i = Math.min(m - 1, Math.floor(u * (m - 1)));
    const p: P = [upper[i][0] + (lower[i][0] - upper[i][0]) * d, upper[i][1] + (lower[i][1] - upper[i][1]) * d];
    dust.push(point(p, p[0] < -0.12 ? bindHaunch : bindBody));
  }
  for (const p of [[-0.3, -0.08], [-0.25, 0.02], [-0.34, -0.02], [0.44, -0.16], [0.49, -0.2], [0.3, -0.36], [0.2, -0.41]] as P[]) {
    dust.push(point(p, p[0] > 0.38 ? bindHead : p[1] < -0.3 ? bindEarN : bindHaunch));
  }

  let maxRun = 2;
  for (const tier of strands) for (const s of tier) maxRun = Math.max(maxRun, s.count);
  return {
    points: rx.length, rx: Float32Array.from(rx), ry: Float32Array.from(ry), ba: Uint8Array.from(ba), bb: Uint8Array.from(bb), bw: Float32Array.from(bw),
    strands, maxRun, outline, ears, legs, wisps, tail, eye, nose, earTips, toes, paw, motes, dust,
  };
}

/** Built once at load (pure arithmetic, no canvas). */
const RIG = buildRig();

/** One bone's transform: its parent's, then a turn of `theta` about its pivot, after a shift. */
function boneMatrix(m: Float32Array, o: number, po: number, pivot: P, theta: number, tx: number, ty: number): void {
  const c = Math.cos(theta), s = Math.sin(theta);
  const px = pivot[0], py = pivot[1];
  const le = px + tx - (c * px - s * py), lf = py + ty - (s * px + c * py);
  if (po < 0) {
    m[o] = c; m[o + 1] = s; m[o + 2] = -s; m[o + 3] = c; m[o + 4] = le; m[o + 5] = lf;
    return;
  }
  const a = m[po], b = m[po + 1], cc = m[po + 2], d = m[po + 3], e = m[po + 4], f = m[po + 5];
  m[o] = a * c + cc * s;
  m[o + 1] = b * c + d * s;
  m[o + 2] = cc * c - a * s;
  m[o + 3] = d * c - b * s;
  m[o + 4] = a * le + cc * lf + e;
  m[o + 5] = b * le + d * lf + f;
}

const TAU = Math.PI * 2;
/** Scratch for the leg angles (no allocation per pose). */
const ANG = new Float32Array(BONES);

function legAngles(phase: number, first: number, rest: number[], ext: number[], gather: number[], lag: number[]): void {
  let prev = 0;
  for (let k = 0; k < 3; k++) {
    const mid = (ext[k] + gather[k]) / 2, amp = (ext[k] - gather[k]) / 2;
    const turn = mid + amp * Math.cos(TAU * (phase - lag[k])) - rest[k];
    ANG[first + k] = turn - prev;
    prev = turn;
  }
}

/** Pose the skeleton at gallop phase 0..1 (0 extended, 0.5 gathered) into m at offset o. Without
 *  `legs`, only the body, head, ears, tail and the near thigh (the haunch) are posed: all that the
 *  past poses the wisps are traced through need. */
export function poseSkeleton(phase: number, m: Float32Array, o = 0, legs = true): void {
  const g = Math.cos(TAU * phase); // 1 extended, -1 gathered
  const arch = 0.12 - 0.19 * g;
  const bob = -0.035 * Math.cos(TAU * (phase - 0.12));
  const pitch = -0.06 * Math.sin(TAU * (phase + 0.05));
  ANG[FRONT] = arch * 0.45;
  ANG[REAR] = -arch * 0.95;
  ANG[NECK] = -arch * 0.35 + 0.05 * Math.sin(TAU * (phase + 0.1));
  ANG[HEAD] = 0.07 * Math.sin(TAU * (phase + 0.18)) - arch * 0.15;
  ANG[EAR_N] = -0.06 - 0.13 * Math.cos(TAU * (phase - 0.12));
  ANG[EAR_F] = -0.04 - 0.12 * Math.cos(TAU * (phase - 0.17));
  ANG[TAIL] = 0.3 * Math.cos(TAU * (phase - 0.08));
  legAngles(phase, HT_N, HIND_REST, HIND_EXT, HIND_GATHER, HIND_LAG);
  if (legs) {
    legAngles(phase, FU_N, FORE_REST, FORE_EXT, FORE_GATHER, FORE_LAG);
    legAngles(phase + 0.08, FU_F, FORE_REST, FORE_EXT, FORE_GATHER, FORE_LAG);
    legAngles(phase + 0.05, HT_F, HIND_REST, HIND_EXT, HIND_GATHER, HIND_LAG);
  }
  // The root carries the bob and the pitch of the stride; the rear closes up on the gather.
  boneMatrix(m, o, -1, CENTRE, pitch, 0, bob);
  const shift = 0.022 - 0.042 * g;
  for (let b = 1; b < BONES; b++) {
    if (legs || posedInPast(b)) boneMatrix(m, o + b * 6, o + PARENT[b] * 6, PIVOT[b], ANG[b], b === REAR ? shift : 0, 0);
  }
}

/** Where rest point i goes under the skeleton posed in m at offset o. */
function skinX(m: Float32Array, o: number, i: number): number {
  const x = RIG.rx[i], y = RIG.ry[i];
  const a = o + RIG.ba[i] * 6, b = o + RIG.bb[i] * 6, w = RIG.bw[i];
  const ax = m[a] * x + m[a + 2] * y + m[a + 4];
  return w > 0 ? ax + (m[b] * x + m[b + 2] * y + m[b + 4] - ax) * w : ax;
}

function skinY(m: Float32Array, o: number, i: number): number {
  const x = RIG.rx[i], y = RIG.ry[i];
  const a = o + RIG.ba[i] * 6, b = o + RIG.bb[i] * 6, w = RIG.bw[i];
  const ay = m[a + 1] * x + m[a + 3] * y + m[a + 5];
  return w > 0 ? ay + (m[b + 1] * x + m[b + 3] * y + m[b + 5] - ay) * w : ay;
}

/** The whole drawing, posed at gallop phase `phase` (local units). For tests and the harness. */
export function poseHare(phase: number): { x: Float32Array; y: Float32Array } {
  const m = new Float32Array(BONES * 6);
  poseSkeleton(phase, m);
  const x = new Float32Array(RIG.points), y = new Float32Array(RIG.points);
  for (let i = 0; i < RIG.points; i++) {
    x[i] = skinX(m, 0, i);
    y[i] = skinY(m, 0, i);
  }
  return { x, y };
}

/** Indices into poseHare's points, for tests. */
export const HARE_LANDMARKS = { eye: RIG.eye, nose: RIG.nose, tail: RIG.tail, earTips: RIG.earTips, toes: RIG.toes, paw: RIG.paw } as const;

// ---------------------------------------------------------------- drawing

/** The wisps are traced through where their anchors were over this many past moments. */
const LAG_STEPS = 18;
const LAG_MS = 14;
/** How fast light shed by the hare falls behind it, body lengths per ms, and how fast it rises. */
const SHED_SPEED = 0.0034;
const SHED_RISE = 0.00045;
/** The glow is drawn at a quarter of the resolution, over a square this many body lengths across,
 *  centred on this point of the hare. */
const GLOW_DOWN = 4;
const GLOW_SPAN = 2.5;
const GLOW_AT: P = [-0.2, -0.12];
/** The largest the loop draws the hare (Creature.place: 0.78 + 0.26 at the front). */
const FRONT_SCALE = 1.04;

interface Look {
  color: string;
  tiers: [string, string, string];
  tierAlpha: [number, number, number];
  wispCss: string;
  deepCss: string;
  glowCss: string;
  core: Rgb;
  base: Rgb;
  deep: Rgb;
  /** Sprites, made once. */
  aura: HTMLCanvasElement | null;
  heart: HTMLCanvasElement | null;
  dot: HTMLCanvasElement | null;
  star: HTMLCanvasElement | null;
  /** The body's fill in the glow canvas (local units), and the wisps' fade on the light layer. */
  body: CanvasGradient | null;
  bodyCtx: CanvasRenderingContext2D | null;
  wisp: CanvasGradient | null;
  /** The strands' fills, fading a little from head to tail, so the hare thins into its trail. */
  tierFill: (CanvasGradient | null)[];
  wispCtx: CanvasRenderingContext2D | null;
}

/** A deeper, more saturated shade of the same hue, for the aura and the glow's edge. */
function deepen(c: Rgb): Rgb {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + 360) % 360;
  const s = Math.max(d / (max || 1), 0.55), v = Math.max(0.6, max) * 0.95;
  const C = v * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m0 = v - C;
  const [rr, gg, bb] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return { r: (rr + m0) * 255, g: (gg + m0) * 255, b: (bb + m0) * 255 };
}

function sprite(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement | null {
  const c = makeCanvas(size, size);
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return null;
  paint(ctx, size);
  return c;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** How many of a strand's points show at entry progress `entry`: it draws itself in from its front. */
function shown(s: Strand, entry: number): number {
  if (entry >= 1) return s.count;
  const f = Math.min(1, Math.max(0, (entry - s.delay) / 0.5));
  return f <= 0 ? 0 : Math.max(2, Math.ceil(f * (s.count - 1)) + 1);
}

/**
 * Draws hares onto the light layer. Back to front: a misty aura; the silhouette, drawn small and
 * blurred, as the glow; the same unblurred as the translucent body with its bright core; the
 * strands at full resolution in three tiers (fine, fur, rim); the wisps; the glints.
 */
export class CreatureRenderer {
  private src: HTMLCanvasElement | null = null;
  private soft: HTMLCanvasElement | null = null;
  private mid: HTMLCanvasElement | null = null;
  private filters: boolean | null = null;
  /** Pixels of src and soft in use this frame (a square from their top left). */
  private used = 0;
  private blurPx = -1;
  private blurCss = 'none';
  /** By color, so creatures of different colors on the stage together each keep theirs. */
  private readonly looks = new Map<string, Look>();
  private readonly m = new Float32Array((LAG_STEPS + 1) * BONES * 6);
  private readonly px = new Float32Array(RIG.points);
  private readonly py = new Float32Array(RIG.points);
  private readonly nx = new Float32Array(Math.max(RIG.maxRun, LAG_STEPS + 1));
  private readonly ny = new Float32Array(Math.max(RIG.maxRun, LAG_STEPS + 1));
  private readonly wx = new Float32Array(RIG.wisps.length * (LAG_STEPS + 1));
  private readonly wy = new Float32Array(RIG.wisps.length * (LAG_STEPS + 1));
  private readonly wn = new Uint8Array(RIG.wisps.length);

  /** `low`: the stage's low quality (a slow machine, or chosen): no fine strands and no blurred glow
   *  (redrawn and blurred every frame, it is most of what the hare costs on a large mirror). */
  draw(ctx: CanvasRenderingContext2D, c: Creature, view: View, low = false): void {
    const H = view.height * view.dpr;
    const L = BODY * H * c.pose.scale * c.params.size;
    const A = Math.min(1, c.pose.alpha);
    if (A <= 0.01 || L < 2) return;
    const look = this.lookFor(c.params.color, ctx);
    const t = c.clock;
    // Entry: 0..1 as it bursts out (the strands draw in); exit: 0..1 as it leaps away.
    const entry = Math.min(1, t / (ENTRY_MS * 1.1));
    const leaving = c.leaving;
    this.pose(t, entry, leaving, c.reduced);

    // Local units to device px: the hare's place, its tilt, its facing. Through a turn it narrows
    // to 40% of its width and flips there, so it never thins to a sliver.
    const side = c.turn < 0 ? -1 : 1;
    const turn = side * Math.max(0.4, Math.abs(c.turn));
    const ang = c.tilt * side;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const ma = cs * turn * L, mb = sn * turn * L, mc = -sn * L, md = cs * L;
    const me = view.px(c.pose.x), mf = view.py(c.pose.y);
    const px = L / 300;
    // Strands thin less than the body as it shrinks into the distance, so it stays legible; and a
    // small hare glows a little more (it covers little of the frame).
    const widthK = (1.1 * Math.min(1.4, Math.max(0.72, Math.sqrt(px)))) / L;
    const lift = Math.min(1.3, Math.max(1, Math.sqrt(1 / px)));

    // The glow: the silhouette (and the wisps) at a quarter of the resolution, then blurred.
    const glow = !low && this.drawGlow(look, L, BODY * H * FRONT_SCALE * c.params.size, ma / L, mb / L, mc / L, md / L, entry);
    const src = this.src, soft = this.soft;

    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    // A faint misty aura round it, fading in with the entry (never a flash).
    if (look.aura) {
      ctx.setTransform(ma, mb, mc, md, me, mf);
      ctx.globalAlpha = 0.2 * A * entry;
      ctx.drawImage(look.aura, GLOW_AT[0] - 1.5, GLOW_AT[1] - 0.85, 3, 1.7);
    }
    if (glow && src && soft) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const gx = ma * GLOW_AT[0] + mc * GLOW_AT[1] + me, gy = mb * GLOW_AT[0] + md * GLOW_AT[1] + mf;
      const gs = this.used, size = gs * GLOW_DOWN;
      // The glow, a wider halo of it (only when it could be blurred properly: a sharper copy drawn
      // larger would read as a ghost), and the translucent body with its brighter core.
      if (this.filters && !low) {
        ctx.globalAlpha = 0.2 * A * lift;
        ctx.drawImage(soft, 0, 0, gs, gs, gx - size * 0.68, gy - size * 0.68, size * 1.36, size * 1.36);
      }
      ctx.globalAlpha = Math.min(1, 0.42 * A * lift);
      ctx.drawImage(soft, 0, 0, gs, gs, gx - size / 2, gy - size / 2, size, size);
      ctx.globalAlpha = Math.min(1, 0.22 * A * lift);
      ctx.drawImage(src, 0, 0, gs, gs, gx - size / 2, gy - size / 2, size, size);
    }
    // The bright heart of it, in the chest, and the soft puff of the tail.
    ctx.setTransform(ma, mb, mc, md, me, mf);
    if (look.heart) {
      ctx.globalAlpha = Math.min(1, 0.2 * A * entry * lift);
      ctx.drawImage(look.heart, 0.12 - 0.36, -0.08 - 0.23, 0.72, 0.46);
      // The head lit from within too, so the face reads.
      const hx = this.px[RIG.eye] - 0.02, hy = this.py[RIG.eye] + 0.025;
      ctx.globalAlpha = Math.min(1, 0.26 * A * entry * lift);
      ctx.drawImage(look.heart, hx - 0.12, hy - 0.09, 0.24, 0.18);
      const tx = this.px[RIG.tail], ty = this.py[RIG.tail];
      ctx.globalAlpha = Math.min(1, 0.45 * A * entry);
      ctx.drawImage(look.heart, tx - 0.07, ty - 0.065, 0.14, 0.13);
    }

    // The strands, fine to bright, then the wisps, at full resolution. Under reduced motion no light
    // runs along them (the beads stay where they are).
    const pulse = c.reduced ? 0 : t / 700;
    for (let tier = L < 110 || low ? 1 : 0; tier < 3; tier++) {
      const k = 2 - tier; // fine first, the rim last
      ctx.globalAlpha = Math.min(1, look.tierAlpha[k] * A * (k ? lift : 1));
      ctx.fillStyle = look.tierFill[k] ?? look.tiers[k];
      ctx.beginPath();
      for (const s of RIG.strands[k]) this.ribbon(ctx, s, s.width * widthK, entry, pulse);
      ctx.fill();
    }
    ctx.globalAlpha = 0.85 * A;
    ctx.fillStyle = look.wisp ?? look.wispCss;
    ctx.beginPath();
    for (let w = 0; w < RIG.wisps.length; w++) this.wispRibbon(ctx, w, RIG.wisps[w].width * widthK * (1 + 0.5 * leaving));
    ctx.fill();

    // Glints: the eye, the nose, the ear tips and the tail, motes on the body that catch the light
    // now and then, and motes running out along the wisps.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const r = Math.max(3, 7 * Math.min(1.6, Math.sqrt(px)));
    this.glint(ctx, look.dot, RIG.eye, ma, mb, mc, md, me, mf, r * 0.9, 0.95 * A * entry);
    this.glint(ctx, look.dot, RIG.nose, ma, mb, mc, md, me, mf, r * 0.55, 0.6 * A * entry);
    for (let e = 0; e < RIG.earTips.length; e++) {
      this.glint(ctx, look.star, RIG.earTips[e], ma, mb, mc, md, me, mf, r * (e ? 0.8 : 1.15), (0.55 + 0.4 * Math.sin(t / 160 + e * 2.1)) * A * entry);
    }
    this.glint(ctx, look.star, RIG.tail, ma, mb, mc, md, me, mf, r * 1.1, (0.6 + 0.35 * Math.sin(t / 190 + 1)) * A * entry);
    for (let k = 0; k < RIG.motes.length; k++) {
      const tw = Math.max(0, Math.sin(t / (230 + 37 * k) + k * 2.4));
      const tw2 = tw * tw;
      this.glint(ctx, look.star, RIG.motes[k], ma, mb, mc, md, me, mf, r * (0.55 + 0.1 * (k % 3)), tw2 * tw2 * 0.9 * A * entry);
    }
    for (let k = 0; k < RIG.dust.length; k++) {
      const tw = 0.5 + 0.5 * Math.sin(t / (380 + 29 * k) + k * 1.7);
      this.glint(ctx, look.dot, RIG.dust[k], ma, mb, mc, md, me, mf, r * (0.28 + 0.06 * (k % 4)), (0.25 + 0.6 * tw * tw * tw) * A * entry);
    }
    if (look.star) {
      const running = c.reduced ? 0 : 7;
      for (let k = 0; k < running; k++) {
        const w = (k * 5 + 3) % RIG.wisps.length, n = this.wn[w];
        if (n < 3) continue;
        const s = (t / (620 + k * 70) + k * 0.37) % 1;
        const j = Math.min(n - 1, Math.floor(s * (n - 1))), base = w * (LAG_STEPS + 1);
        const lx = this.wx[base + j], ly = this.wy[base + j];
        const x = ma * lx + mc * ly + me, y = mb * lx + md * ly + mf;
        const size = r * (0.5 + 0.5 * (1 - s)) * (k % 2 ? 0.8 : 1.2);
        ctx.globalAlpha = Math.min(1, 0.9 * A * (1 - s) * Math.min(1, s * 6));
        ctx.drawImage(look.star, x - size, y - size, size * 2, size * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Pose the skeleton now and over the last moments, skin the drawing, and trace the wisps. */
  private pose(t: number, entry: number, leaving: number, still: boolean): void {
    const m = this.m;
    for (let j = 0; j <= LAG_STEPS; j++) {
      const ph = ((t - j * LAG_MS) / STRIDE_MS) % 1;
      poseSkeleton(ph < 0 ? ph + 1 : ph, m, j * BONES * 6, j === 0);
    }
    const rx = RIG.rx, ry = RIG.ry, ba = RIG.ba, bb = RIG.bb, bw = RIG.bw, px = this.px, py = this.py;
    for (let i = 0; i < RIG.points; i++) {
      const x = rx[i], y = ry[i], a = ba[i] * 6, w = bw[i];
      let X = m[a] * x + m[a + 2] * y + m[a + 4], Y = m[a + 1] * x + m[a + 3] * y + m[a + 5];
      if (w > 0) {
        const b = bb[i] * 6;
        X += (m[b] * x + m[b + 2] * y + m[b + 4] - X) * w;
        Y += (m[b + 1] * x + m[b + 3] * y + m[b + 5] - Y) * w;
      }
      px[i] = X;
      py[i] = Y;
    }
    // A wisp's point j is where its anchor was j steps ago, carried back by the run (longer as it
    // grows in with the entry and as it streams out in the leap away) and drifting up.
    const stretch = (0.35 + 0.65 * entry) * (1 + 0.9 * leaving);
    for (let w = 0; w < RIG.wisps.length; w++) {
      const wd = RIG.wisps[w];
      const n = Math.min(LAG_STEPS + 1, Math.max(2, Math.round(wd.len / (SHED_SPEED * LAG_MS)) + 1));
      this.wn[w] = n;
      const base = w * (LAG_STEPS + 1);
      for (let j = 0; j < n; j++) {
        const tau = j * LAG_MS, s = j / (n - 1), o = wd.trail ? j * BONES * 6 : 0;
        const flutter = still ? 0 : wd.amp * s * Math.sin(TAU * (1.4 * s - t / 520) + wd.seed);
        this.wx[base + j] = skinX(m, o, wd.anchor) - SHED_SPEED * tau * stretch;
        this.wy[base + j] = skinY(m, o, wd.anchor) - SHED_RISE * wd.rise * tau * stretch + flutter;
      }
    }
  }

  /** One strand as a tapered ribbon (a closed subpath of the current path), in local units. During
   *  the entry it draws itself in from its front end; light pulses run back along it. */
  private ribbon(ctx: CanvasRenderingContext2D, s: Strand, width: number, entry: number, pulse: number): void {
    const n = shown(s, entry);
    if (n < 2) return;
    const X = this.px, Y = this.py, NX = this.nx, NY = this.ny, i0 = s.start, last = n - 1;
    for (let k = 0; k < n; k++) {
      const a = i0 + (k > 0 ? k - 1 : 0), b = i0 + (k < last ? k + 1 : last);
      const dx = X[b] - X[a], dy = Y[b] - Y[a];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const u = k / last;
      const taper = smooth(u / s.rampIn) * smooth((1 - u) / s.rampOut);
      // A bead of light running back along the strand now and then.
      const wave = Math.max(0, Math.sin(TAU * (u * 0.9 - pulse) + s.seed));
      const w2 = wave * wave, w4 = w2 * w2;
      const hw = 0.5 * width * taper * (1 + 1.1 * w4 * w4);
      NX[k] = (-dy / len) * hw;
      NY[k] = (dx / len) * hw;
    }
    ctx.moveTo(X[i0] + NX[0], Y[i0] + NY[0]);
    for (let k = 1; k < n; k++) ctx.lineTo(X[i0 + k] + NX[k], Y[i0 + k] + NY[k]);
    for (let k = last; k >= 0; k--) ctx.lineTo(X[i0 + k] - NX[k], Y[i0 + k] - NY[k]);
    ctx.closePath();
  }

  /** A wisp as a ribbon: thin where it peels off, swelling, then thinning away to nothing. */
  private wispRibbon(ctx: CanvasRenderingContext2D, w: number, width: number): void {
    const n = this.wn[w];
    if (n < 2) return;
    const base = w * (LAG_STEPS + 1), X = this.wx, Y = this.wy, NX = this.nx, NY = this.ny, last = n - 1;
    for (let k = 0; k < n; k++) {
      const a = base + (k > 0 ? k - 1 : 0), b = base + (k < last ? k + 1 : last);
      const dx = X[b] - X[a], dy = Y[b] - Y[a];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const u = k / last;
      const hw = 0.5 * width * smooth(u / 0.18) * (1 - u) ** 1.3;
      NX[k] = (-dy / len) * hw;
      NY[k] = (dx / len) * hw;
    }
    ctx.moveTo(X[base] + NX[0], Y[base] + NY[0]);
    for (let k = 1; k < n; k++) ctx.lineTo(X[base + k] + NX[k], Y[base + k] + NY[k]);
    for (let k = last; k >= 0; k--) ctx.lineTo(X[base + k] - NX[k], Y[base + k] - NY[k]);
    ctx.closePath();
  }

  private glint(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | null, i: number, ma: number, mb: number, mc: number, md: number, me: number, mf: number, r: number, alpha: number): void {
    if (!img || alpha <= 0.01) return;
    const lx = this.px[i], ly = this.py[i];
    const x = ma * lx + mc * ly + me, y = mb * lx + md * ly + mf;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  }

  /** The silhouette and the wisps, small, into src for the glow, and blurred into soft. False outside a browser. */
  private drawGlow(look: Look, L: number, Lmax: number, ra: number, rb: number, rc: number, rd: number, entry: number): boolean {
    const used = Math.max(8, Math.ceil((GLOW_SPAN * L) / GLOW_DOWN));
    this.used = used;
    // Sized once for the largest the loop draws it at this view size, so the canvases are not
    // made again as it runs nearer and farther (only after a resize).
    const need = Math.max(used, Math.ceil((GLOW_SPAN * Lmax) / GLOW_DOWN) + 2);
    if (!this.src || !this.soft || !this.mid || this.src.width < need || this.src.width > need * 2) {
      const size = need;
      this.src = makeCanvas(size, size);
      this.soft = makeCanvas(size, size);
      this.mid = makeCanvas(Math.max(4, Math.ceil(size / 3)), Math.max(4, Math.ceil(size / 3)));
      look.body = null;
    }
    const src = this.src, soft = this.soft, mid = this.mid;
    const g = src?.getContext('2d'), sg = soft?.getContext('2d');
    if (!src || !soft || !mid || !g || !sg) return false;
    if (!look.body || look.bodyCtx !== g) {
      // The core is brightest in the chest, fading to the deeper hue toward the haunch and paws.
      const grad = g.createRadialGradient(0.13, -0.08, 0, 0.13, -0.08, 0.75);
      grad.addColorStop(0, rgba(look.base, 1));
      grad.addColorStop(0.22, rgba(look.base, 1));
      grad.addColorStop(0.5, rgba(mixRgb(look.base, look.deep, 0.65), 1));
      grad.addColorStop(0.8, rgba(mixRgb(look.deep, BLACK, 0.3), 1));
      grad.addColorStop(1, rgba(mixRgb(look.deep, BLACK, 0.55), 1));
      look.body = grad;
      look.bodyCtx = g;
    }
    const k = L / GLOW_DOWN;
    const a = ra * k, b = rb * k, c = rc * k, d = rd * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, src.width, src.height);
    g.setTransform(a, b, c, d, used / 2 - (a * GLOW_AT[0] + c * GLOW_AT[1]), used / 2 - (b * GLOW_AT[0] + d * GLOW_AT[1]));
    const X = this.px, Y = this.py;
    g.fillStyle = look.body;
    g.globalAlpha = 0.35 + 0.65 * entry;
    // Body and head.
    const o = RIG.outline;
    g.beginPath();
    g.moveTo(X[o.start], Y[o.start]);
    for (let i = 1; i < o.count; i++) g.lineTo(X[o.start + i], Y[o.start + i]);
    g.closePath();
    g.fill();
    // Ears, each its own fill (their outlines may wind either way).
    for (const e of RIG.ears) {
      g.beginPath();
      g.moveTo(X[e.start], Y[e.start]);
      for (let i = 1; i < e.count; i++) g.lineTo(X[e.start + i], Y[e.start + i]);
      g.closePath();
      g.fill();
    }
    // Legs, thick at the top and fine at the paw, and the tail's puff: one fill.
    const NX = this.nx, NY = this.ny;
    g.beginPath();
    for (const leg of RIG.legs) {
      const s0 = leg.start, last = leg.count - 1;
      for (let i = 0; i <= last; i++) {
        const p = s0 + (i > 0 ? i - 1 : 0), q = s0 + (i < last ? i + 1 : last);
        const dx = X[q] - X[p], dy = Y[q] - Y[p], len = Math.sqrt(dx * dx + dy * dy) || 1;
        const hw = 0.5 * (leg.w0 + ((leg.w1 - leg.w0) * i) / last);
        NX[i] = (-dy / len) * hw;
        NY[i] = (dx / len) * hw;
      }
      g.moveTo(X[s0] + NX[0], Y[s0] + NY[0]);
      for (let i = 1; i <= last; i++) g.lineTo(X[s0 + i] + NX[i], Y[s0 + i] + NY[i]);
      for (let i = last; i >= 0; i--) g.lineTo(X[s0 + i] - NX[i], Y[s0 + i] - NY[i]);
      g.closePath();
    }
    g.moveTo(X[RIG.tail] + 0.055, Y[RIG.tail]);
    g.arc(X[RIG.tail], Y[RIG.tail], 0.055, 0, TAU);
    g.fill();
    // The rim and fur strands, so each glows (every other point is plenty at this size); then the
    // wisps, broad, so they blur into soft veils of light.
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = look.glowCss;
    g.globalAlpha = 0.5;
    g.lineWidth = Math.max(0.006, 1.1 / k);
    g.beginPath();
    for (let tier = 0; tier < 2; tier++) {
      for (const s of RIG.strands[tier]) {
        const n = shown(s, entry);
        if (n < 2) continue;
        g.moveTo(X[s.start], Y[s.start]);
        for (let i = 2; i < n - 1; i += 2) g.lineTo(X[s.start + i], Y[s.start + i]);
        g.lineTo(X[s.start + n - 1], Y[s.start + n - 1]);
      }
    }
    g.stroke();
    g.strokeStyle = look.deepCss;
    g.globalAlpha = 0.4;
    g.lineWidth = Math.max(0.01, 2 / k);
    g.beginPath();
    for (let w = 0; w < RIG.wisps.length; w++) {
      const n = this.wn[w], base = w * (LAG_STEPS + 1);
      if (n < 2) continue;
      g.moveTo(this.wx[base], this.wy[base]);
      for (let j = 1; j < n - 1; j++) g.lineTo(this.wx[base + j], this.wy[base + j]);
    }
    g.stroke();
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    // Blur it into `soft`.
    if (this.filters === null) {
      // A browser without canvas filters (an older Safari) keeps the assignment as a plain property
      // and reads it back unchanged, so ask the context's prototype first.
      const proto = Object.getPrototypeOf(sg) as object | null;
      if (proto && 'filter' in proto) {
        sg.filter = 'blur(2px)';
        this.filters = sg.filter === 'blur(2px)';
        sg.filter = 'none';
      } else {
        this.filters = false;
      }
    }
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    sg.globalAlpha = 1;
    sg.clearRect(0, 0, soft.width, soft.height);
    sg.imageSmoothingEnabled = true;
    if (this.filters) {
      const blur = Math.max(1.5, Math.round(used * 0.032 * 2) / 2);
      if (blur !== this.blurPx) {
        this.blurPx = blur;
        this.blurCss = `blur(${blur}px)`;
      }
      sg.filter = this.blurCss;
      sg.drawImage(src, 0, 0, used, used, 0, 0, used, used);
      sg.filter = 'none';
    } else {
      // No canvas filters: down to a quarter and back up blurs it well enough.
      const mg = mid.getContext('2d');
      if (!mg) return false;
      const third = Math.max(2, Math.ceil(used / 4));
      mg.setTransform(1, 0, 0, 1, 0, 0);
      mg.clearRect(0, 0, mid.width, mid.height);
      mg.imageSmoothingEnabled = true;
      mg.drawImage(src, 0, 0, used, used, 0, 0, third, third);
      sg.drawImage(mid, 0, 0, third, third, 0, 0, used, used);
    }
    return true;
  }

  private lookFor(color: string, ctx: CanvasRenderingContext2D): Look {
    let look = this.looks.get(color);
    if (!look) {
      const base = parseColor(color, '#DDE8FF');
      const core = mixRgb(base, WHITE, 0.7);
      const silver = mixRgb(base, WHITE, 0.35);
      const deep = deepen(base);
      look = {
        color, base, core, deep,
        tiers: [rgba(core, 1), rgba(silver, 1), rgba(base, 1)],
        tierAlpha: [1, 0.75, 0.5],
        wispCss: rgba(silver, 0.8),
        deepCss: rgba(deep, 1),
        glowCss: rgba(silver, 1),
        aura: sprite(128, (s, n) => {
          const gr = s.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
          gr.addColorStop(0, rgba(mixRgb(deep, base, 0.3), 0.9));
          gr.addColorStop(0.35, rgba(deep, 0.45));
          gr.addColorStop(0.7, rgba(deep, 0.12));
          gr.addColorStop(1, rgba(deep, 0));
          s.fillStyle = gr;
          s.fillRect(0, 0, n, n);
        }),
        heart: sprite(96, (s, n) => {
          const gr = s.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
          gr.addColorStop(0, rgba(core, 0.85));
          gr.addColorStop(0.3, rgba(base, 0.45));
          gr.addColorStop(0.65, rgba(mixRgb(base, deep, 0.5), 0.12));
          gr.addColorStop(1, rgba(deep, 0));
          s.fillStyle = gr;
          s.fillRect(0, 0, n, n);
        }),
        dot: sprite(48, (s, n) => {
          const gr = s.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
          gr.addColorStop(0, rgba(WHITE, 1));
          gr.addColorStop(0.2, rgba(core, 0.85));
          gr.addColorStop(0.5, rgba(base, 0.25));
          gr.addColorStop(1, rgba(base, 0));
          s.fillStyle = gr;
          s.fillRect(0, 0, n, n);
        }),
        star: sprite(64, (s, n) => {
          const h = n / 2;
          const gr = s.createRadialGradient(h, h, 0, h, h, h * 0.5);
          gr.addColorStop(0, rgba(core, 0.9));
          gr.addColorStop(0.4, rgba(base, 0.3));
          gr.addColorStop(1, rgba(base, 0));
          s.fillStyle = gr;
          s.fillRect(0, 0, n, n);
          s.fillStyle = rgba(WHITE, 0.95);
          for (let q = 0; q < 4; q++) {
            const len = q % 2 === 0 ? h * 0.98 : h * 0.62;
            s.setTransform(1, 0, 0, 1, h, h);
            s.rotate((q * Math.PI) / 2);
            s.beginPath();
            s.moveTo(0, -n * 0.03);
            s.quadraticCurveTo(len * 0.22, 0, len, 0);
            s.quadraticCurveTo(len * 0.22, 0, 0, n * 0.03);
            s.closePath();
            s.fill();
          }
          s.setTransform(1, 0, 0, 1, 0, 0);
        }),
        body: null, bodyCtx: null, wisp: null, tierFill: [null, null, null], wispCtx: null,
      };
      if (this.looks.size >= 8) this.looks.clear();
      this.looks.set(color, look);
    }
    if (!look.wisp || look.wispCtx !== ctx) {
      // The wisps fade with the distance from the body (local units).
      const gr = ctx.createRadialGradient(-0.05, -0.12, 0.28, -0.05, -0.12, 1.15);
      gr.addColorStop(0, rgba(look.core, 0.95));
      gr.addColorStop(0.35, rgba(mixRgb(look.base, look.deep, 0.3), 0.65));
      gr.addColorStop(0.75, rgba(look.deep, 0.22));
      gr.addColorStop(1, rgba(look.deep, 0));
      look.wisp = gr;
      const silver = mixRgb(look.base, WHITE, 0.35), deep = look.deep;
      look.tierFill = [look.core, silver, look.base].map((col) => {
        const lin = ctx.createLinearGradient(0.6, 0, -0.9, 0);
        lin.addColorStop(0, rgba(col, 1));
        lin.addColorStop(0.4, rgba(col, 0.95));
        lin.addColorStop(0.72, rgba(mixRgb(col, deep, 0.25), 0.75));
        lin.addColorStop(1, rgba(mixRgb(col, deep, 0.5), 0.5));
        return lin;
      });
      look.wispCtx = ctx;
    }
    return look;
  }
}
