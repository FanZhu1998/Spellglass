// Whole scene (fx.scene@1): time.slow, screen.shake and scene.reveal. effects.end and log.fade are
// bookkeeping in the core; they draw nothing of their own here.

import type { ShakeParams, SlowParams } from './limits';
import type { Random } from './random';

// ------------------------------------------------------------------ time

interface Slow {
  castId: string;
  params: SlowParams;
  /** The prop it slows (scope target), or null for everything. */
  propId: string | null;
  born: number;
  /** Real time it ends on its own. */
  until: number;
  endedAt: number | null;
  /** Factor at the moment it ended, to ease back from. */
  endFactor: number;
}

const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * Time scales. Impedimenta slows one prop ("the dummy moves in slow motion"); Arresto Momentum
 * eases everything in motion to a stop and back ("everything in motion slows to a stop"). Several
 * slows combine by taking the slowest. Step durations stay in real time, like the engine's spell
 * durations, so a stopped scene still ends on schedule.
 */
export class TimeControl {
  private slows: Slow[] = [];

  /** A held slow (no duration_ms: hold: true) lasts until it is ended. */
  add(castId: string, params: SlowParams, propId: string | null, now: number): Slow {
    const until = params.duration_ms !== undefined ? now + params.duration_ms : Number.POSITIVE_INFINITY;
    const s: Slow = { castId, params, propId, born: now, until, endedAt: null, endFactor: 1 };
    this.slows.push(s);
    return s;
  }

  end(s: Slow, now: number): void {
    if (s.endedAt !== null) return;
    s.endFactor = this.factor(s, now);
    s.endedAt = now;
  }

  /** True once its time has run out (it then eases back). */
  expired(s: Slow, now: number): boolean {
    return s.endedAt !== null || now >= s.until;
  }

  factor(s: Slow, now: number): number {
    const rampIn = s.params.to_stop ? 900 : 450;
    const rampOut = s.params.to_stop ? 750 : 450;
    if (s.endedAt === null && now >= s.until) {
      s.endFactor = this.factorBefore(s, s.until, rampIn);
      s.endedAt = s.until;
    }
    if (s.endedAt !== null) {
      const k = ease((now - s.endedAt) / rampOut);
      return s.endFactor + (1 - s.endFactor) * k;
    }
    return this.factorBefore(s, now, rampIn);
  }

  private factorBefore(s: Slow, now: number, rampIn: number): number {
    return 1 + (s.params.factor - 1) * ease((now - s.born) / rampIn);
  }

  /** The global time scale (scope 'all'). */
  global(now: number): number {
    let f = 1;
    for (const s of this.slows) if (s.propId === null) f = Math.min(f, this.factor(s, now));
    return f;
  }

  /** A prop's own time scale (scope 'target'). */
  forProp(propId: string, now: number): number {
    let f = 1;
    for (const s of this.slows) if (s.propId === propId) f = Math.min(f, this.factor(s, now));
    return f;
  }

  /** Drop slows that have fully eased back. */
  update(now: number): void {
    let done = false;
    for (const s of this.slows) {
      this.factor(s, now);
      if (s.endedAt !== null && now - s.endedAt > 1000) done = true;
    }
    if (done) this.slows = this.slows.filter((s) => !(s.endedAt !== null && now - s.endedAt > 1000));
  }

  clear(): void {
    this.slows = [];
  }
}

// ------------------------------------------------------------------ shake

interface Shake {
  born: number;
  duration: number;
  px: number;
  phaseX: number;
  phaseY: number;
}

/** screen.shake: short and small (EFFECT_LIMITS.shakeMaxPx, shakeMaxMs), never held, off with reduced motion. */
export class ShakeControl {
  private shakes: Shake[] = [];
  /** Reused by offset(), which runs every frame. */
  private readonly out = { dx: 0, dy: 0 };

  constructor(private readonly random: Random) {}

  add(params: ShakeParams, now: number): void {
    if (params.px <= 0 || params.duration_ms <= 0) return;
    this.shakes.push({ born: now, duration: params.duration_ms, px: params.px, phaseX: this.random() * 6.28, phaseY: this.random() * 6.28 });
  }

  /** Offset in CSS px at `now`; never more than the largest shake's px. The returned object is
   *  reused by the next call. */
  offset(now: number, reducedMotion: boolean): { readonly dx: number; readonly dy: number } {
    const out = this.out;
    out.dx = 0;
    out.dy = 0;
    if (reducedMotion || this.shakes.length === 0) return out;
    let dx = 0, dy = 0, cap = 0;
    for (const s of this.shakes) {
      const t = now - s.born;
      if (t < 0 || t >= s.duration) continue;
      const a = s.px * (1 - t / s.duration) ** 2;
      cap = Math.max(cap, s.px);
      dx += a * Math.sin((t / 1000) * Math.PI * 2 * 23 + s.phaseX);
      dy += a * 0.8 * Math.sin((t / 1000) * Math.PI * 2 * 17 + s.phaseY);
    }
    const m = Math.hypot(dx, dy);
    if (m > cap && m > 0) {
      dx = (dx / m) * cap;
      dy = (dy / m) * cap;
    }
    out.dx = dx;
    out.dy = dy;
    return out;
  }

  active(now: number): boolean {
    return this.shakes.some((s) => now - s.born < s.duration);
  }

  update(now: number): void {
    if (this.shakes.some((s) => now - s.born >= s.duration)) this.shakes = this.shakes.filter((s) => now - s.born < s.duration);
  }

  clear(): void {
    this.shakes = [];
  }
}

// ------------------------------------------------------------------ reveal

export interface Reveal {
  castId: string;
  born: number;
  until: number;
  endedAt: number | null;
}

const REVEAL_IN_MS = 700;
const REVEAL_OUT_MS = 900;

/** scene.reveal: hidden ink and hidden details shimmer into view, then fade (Revelio). */
export class RevealControl {
  reveals: Reveal[] = [];

  /** durationMs undefined: held (hold: true), until it is ended. */
  add(castId: string, durationMs: number | undefined, now: number): Reveal {
    const r: Reveal = { castId, born: now, until: durationMs !== undefined ? now + durationMs : Number.POSITIVE_INFINITY, endedAt: null };
    this.reveals.push(r);
    return r;
  }

  end(r: Reveal, now: number): void {
    if (r.endedAt === null) r.endedAt = Math.min(now, r.until);
  }

  static alphaOf(r: Reveal, now: number): number {
    const end = r.endedAt ?? r.until;
    const up = ease((now - r.born) / REVEAL_IN_MS);
    if (now <= end) return up;
    return up * (1 - ease((now - end) / REVEAL_OUT_MS));
  }

  /** StageServices.revealAlpha(): 0..1. */
  alpha(now: number): number {
    let a = 0;
    for (const r of this.reveals) a = Math.max(a, RevealControl.alphaOf(r, now));
    return a;
  }

  update(now: number): void {
    if (this.reveals.some((r) => now > (r.endedAt ?? r.until) + REVEAL_OUT_MS)) {
      this.reveals = this.reveals.filter((r) => now <= (r.endedAt ?? r.until) + REVEAL_OUT_MS);
    }
  }

  clear(): void {
    this.reveals = [];
  }
}
