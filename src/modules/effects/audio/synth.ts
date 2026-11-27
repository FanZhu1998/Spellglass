// The Web Audio side of sound: turns cue recipes (cues.ts) into nodes, and owns the master bus.
//
//   cue voices → cue gain ─┬──────────────────────────────→ muffle (low-pass) → post ─→ limiter → volume → speakers
//                          └→ reverb send → room (convolver) ↗                 buzzing bed ↗   └→ clip capture
//
//  - The room is a light reverb from an impulse response synthesized here (decaying, darkening
//    noise with a short pre-delay): no files.
//  - Muffle (Muffliato, "until Finite"): the low-pass closes over every sound, a soft buzzing bed
//    fades in after it, and both release when the last muffle ends.
//  - The limiter keeps overlapping cues from clipping. The player's volume and mute come after it.
//  - Clip capture taps the bus after the muffle and the limiter, before the player's volume, so a
//    clip sounds the same whatever the speaker volume (never the microphone: nothing here records).
//
// Envelopes are written as explicit automation points (envelopePoints, pure and tested): a linear
// attack, an exponential decay to a positive floor (exponential ramps cannot reach 0), then a linear
// release to silence. Every time is on ctx.currentTime.

import type { Envelope, NoiseColor, Recipe, Voice } from './cues';
import { MAX_HZ, seededRandom } from './cues';

/** Overall level, applied with the player's volume. Rendered in Chrome 158 (OfflineAudioContext) at
 *  the default volume 0.8: spell cues peak between about -23 and -6 dBFS (most -16 to -9), interface
 *  cues between -26 and -12 dBFS (the arm tick at -21), and nothing clips. */
export const MASTER_LEVEL = 0.8;
/** Where the muffle's low-pass settles. */
export const MUFFLE_HZ = 650;
/** Level of the buzzing bed under a muffle. */
export const BED_LEVEL = 0.05;
const REVERB_RETURN = 0.6;
const NOISE_SECONDS = 2;
const ROOM_SECONDS = 1.6;
/** Smallest gain an exponential ramp may aim for. */
export const FLOOR = 0.0001;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------------- envelopes

export interface EnvPoint {
  /** Seconds from the voice's start. */
  t: number;
  v: number;
  ramp: 'set' | 'linear' | 'exp';
}

/** Automation points for one voice's gain: times non-decreasing, ending at silence at `dur`. */
export function envelopePoints(e: Envelope, peak: number, dur: number): EnvPoint[] {
  const p = Math.max(FLOOR * 10, peak);
  const D = Math.max(0.005, dur);
  const r = clamp(e.release ?? 0.03, 0.002, D / 2);
  const end = D - r;
  const a = clamp(e.attack, 0.0005, Math.max(0.0005, end));
  const holdEnd = Math.min(end, a + Math.max(0, e.hold ?? 0));
  const decayEnd = Math.min(end, holdEnd + Math.max(0, e.decay));
  const sustain = Math.max(FLOOR, p * clamp(e.sustain ?? 0, 0.001, 1));
  const pts: EnvPoint[] = [{ t: 0, v: 0, ramp: 'set' }, { t: a, v: p, ramp: 'linear' }];
  // An explicit point anchors each ramp that follows a plateau (a ramp starts at the previous event).
  if (holdEnd > a) pts.push({ t: holdEnd, v: p, ramp: 'set' });
  let level = p;
  if (decayEnd > holdEnd) {
    pts.push({ t: decayEnd, v: sustain, ramp: 'exp' });
    level = sustain;
  }
  if (end > Math.max(decayEnd, a)) pts.push({ t: end, v: level, ramp: 'set' });
  pts.push({ t: D, v: 0, ramp: 'linear' });
  return pts;
}

function applyEnvelope(param: AudioParam, pts: readonly EnvPoint[], t0: number): void {
  for (const pt of pts) {
    const t = t0 + pt.t;
    if (pt.ramp === 'set') param.setValueAtTime(pt.v, t);
    else if (pt.ramp === 'linear') param.linearRampToValueAtTime(pt.v, t);
    else param.exponentialRampToValueAtTime(pt.v, t);
  }
}

/** Bigger casts (effectScale) ring longer: holds and decays stretch, attacks stay crisp. */
function stretch(e: Envelope, ts: number): Envelope {
  return { ...e, hold: (e.hold ?? 0) * ts, decay: e.decay * ts };
}

// ------------------------------------------------------------------------------- buffers

/** Two seconds of looping noise. Pink after Paul Kellet's filter; brown is leaky integrated white. */
export function makeNoise(ctx: BaseAudioContext, color: NoiseColor, random: () => number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const white = random() * 2 - 1;
    if (color === 'white') d[i] = white;
    else if (color === 'pink') {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/** A light room: 12 ms of pre-delay, then noise that decays (about 1.2 s to silence) and darkens. */
export function makeRoom(ctx: BaseAudioContext, random: () => number): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.max(1, Math.floor(rate * ROOM_SECONDS));
  const buf = ctx.createBuffer(2, n, rate);
  const pre = 0.012;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      if (t < pre) {
        d[i] = 0;
        continue;
      }
      const age = t - pre;
      // A one-pole low-pass whose cutoff falls with age: high frequencies die first, as in a room.
      lp += (random() * 2 - 1 - lp) * (0.25 + 0.6 * Math.exp(-age * 4));
      d[i] = lp * Math.exp(-age / 0.18);
    }
  }
  return buf;
}

// ------------------------------------------------------------------------------- the graph

export interface CueOptions {
  /** Linear gain for the whole cue (the step's gain, scaled). */
  gain: number;
  /** Cents for every voice (noise follows by playback rate). */
  detune: number;
  /** Stretch for holds, decays, glides and sweeps (bigger casts ring longer). */
  timeScale: number;
  seed: number;
}

/** A cue that is sounding. */
export interface Sounding {
  /** ctx time when its last voice ends. */
  readonly endsAt: number;
  /** Fade it out from `at` over `fade` seconds. */
  stop(at: number, fade: number): void;
}

interface Bed {
  out: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

export class AudioGraph {
  private readonly input: GainNode;
  private readonly send: GainNode;
  private readonly muffleFilter: BiquadFilterNode;
  private readonly post: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly volume: GainNode;
  private readonly noise = new Map<NoiseColor, AudioBuffer>();
  private readonly random: () => number;
  private bed: Bed | null = null;
  private capture: MediaStreamAudioDestinationNode | null = null;
  private muffled = false;

  constructor(readonly ctx: AudioContext, opts: { volume: number; muted: boolean; muffled: boolean; seed?: number }) {
    this.random = seededRandom(opts.seed ?? 0x5eed);
    this.input = ctx.createGain();
    this.send = ctx.createGain();
    const room = ctx.createConvolver();
    room.buffer = makeRoom(ctx, this.random);
    const wet = ctx.createGain();
    wet.gain.value = REVERB_RETURN;
    this.muffleFilter = ctx.createBiquadFilter();
    this.muffleFilter.type = 'lowpass';
    this.muffleFilter.frequency.value = this.openHz();
    this.muffleFilter.Q.value = 0;
    this.post = ctx.createGain();
    // A peak limiter, not a compressor: Web Audio's compressor adds makeup gain that grows as the
    // threshold drops (about +5 dB at -10 dB, measured in Chrome), which would pump after every loud
    // cue. Near 0 dB it only catches the peaks of overlapping cues.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 1;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.volume = ctx.createGain();

    this.input.connect(this.muffleFilter);
    this.send.connect(room);
    room.connect(wet);
    wet.connect(this.muffleFilter);
    this.muffleFilter.connect(this.post);
    this.post.connect(this.limiter);
    this.limiter.connect(this.volume);
    this.volume.connect(ctx.destination);

    this.setVolume(opts.volume, opts.muted, true);
    // Built during a muffle (the context was made after Muffliato): closed from the first sample.
    if (opts.muffled) this.setMuffled(true, true);
  }

  /** The player's volume (0..1) and mute. */
  setVolume(volume: number, muted: boolean, immediate = false): void {
    const target = muted ? 0 : MASTER_LEVEL * clamp(Number.isFinite(volume) ? volume : 0.8, 0, 1);
    const p = this.volume.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    if (immediate) p.setValueAtTime(target, now);
    else p.setTargetAtTime(target, now, 0.03);
  }

  get isMuffled(): boolean {
    return this.muffled;
  }

  /** Close or open the muffle over the whole bus: over about a third of a second, so the cast's own
   *  sound is heard closing in, or at once (immediate). */
  setMuffled(on: boolean, immediate = false): void {
    if (on === this.muffled) return;
    this.muffled = on;
    const now = this.ctx.currentTime;
    const f = this.muffleFilter.frequency;
    const g = this.post.gain;
    f.cancelScheduledValues(now);
    g.cancelScheduledValues(now);
    if (immediate) {
      f.setValueAtTime(on ? MUFFLE_HZ : this.openHz(), now);
      g.setValueAtTime(on ? 0.85 : 1, now);
    } else {
      f.setTargetAtTime(on ? MUFFLE_HZ : this.openHz(), now, on ? 0.12 : 0.15);
      g.setTargetAtTime(on ? 0.85 : 1, now, 0.12);
    }
    if (on) this.startBed(now);
    else this.stopBed(now);
  }

  /** Play a recipe at ctx time `when`. */
  play(recipe: Recipe, when: number, o: CueOptions): Sounding {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = o.gain;
    out.connect(this.input);
    const nodes: AudioNode[] = [out];
    if (recipe.reverb > 0) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = clamp(recipe.reverb, 0, 1);
      out.connect(sendGain);
      sendGain.connect(this.send);
      nodes.push(sendGain);
    }
    const sources: { node: AudioScheduledSourceNode; stopAt: number }[] = [];
    const ctxOf = { rate: 2 ** (o.detune / 1200), detune: o.detune, ts: o.timeScale, random: seededRandom(o.seed), nodes, sources };
    let endsAt = when;
    for (const v of recipe.voices) endsAt = Math.max(endsAt, this.voice(v, when, out, ctxOf));

    // Disconnect everything once every source has ended.
    let left = sources.length;
    const cleanup = () => {
      if (--left > 0) return;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
    for (const s of sources) s.node.onended = cleanup;

    let stopped = false;
    return {
      endsAt,
      stop: (at, fade) => {
        if (stopped) return;
        stopped = true;
        const t = Math.max(at, ctx.currentTime);
        const f = Math.max(0.005, fade);
        const g = out.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(o.gain, t);
        g.linearRampToValueAtTime(0, t + f);
        for (const s of sources) {
          // Only ever bring a stop forward: a later stop() would replace the natural one.
          if (s.stopAt <= t + f) continue;
          try {
            s.node.stop(t + f + 0.01);
          } catch {
            /* not started or already stopped */
          }
        }
      },
    };
  }

  /** A stream of the effect sound for clips: after the muffle and limiter, before the volume. */
  startCapture(): MediaStream | null {
    if (this.capture) return this.capture.stream;
    if (typeof this.ctx.createMediaStreamDestination !== 'function') return null;
    try {
      this.capture = this.ctx.createMediaStreamDestination();
      this.limiter.connect(this.capture);
      return this.capture.stream;
    } catch {
      this.capture = null;
      return null;
    }
  }

  stopCapture(): void {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    try {
      this.limiter.disconnect(c);
    } catch {
      /* already gone */
    }
  }

  // ---------------------------------------------------------------- internals

  private openHz(): number {
    return Math.min(20000, this.ctx.sampleRate / 2 - 100);
  }

  private hz(f: number): number {
    return clamp(Number.isFinite(f) ? f : 440, 20, Math.min(MAX_HZ + 2000, this.ctx.sampleRate / 2 - 100));
  }

  private noiseBuffer(color: NoiseColor): AudioBuffer {
    let b = this.noise.get(color);
    if (!b) {
      b = makeNoise(this.ctx, color, this.random);
      this.noise.set(color, b);
    }
    return b;
  }

  /** Build one voice; returns the ctx time it ends. */
  private voice(
    v: Voice,
    when: number,
    out: AudioNode,
    c: { rate: number; detune: number; ts: number; random: () => number; nodes: AudioNode[]; sources: { node: AudioScheduledSourceNode; stopAt: number }[] },
  ): number {
    const ctx = this.ctx;
    const t0 = when + Math.max(0, v.at);
    const dur = Math.max(0.005, v.dur * c.ts);
    const stopAt = t0 + dur + 0.02;
    const amp = ctx.createGain();
    amp.gain.value = 0;
    applyEnvelope(amp.gain, envelopePoints(stretch(v.env, c.ts), v.gain, dur), t0);
    c.nodes.push(amp);

    let src: AudioScheduledSourceNode;
    if (v.kind === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = v.wave;
      osc.frequency.setValueAtTime(this.hz(v.freq), t0);
      if (v.to !== undefined) osc.frequency.exponentialRampToValueAtTime(this.hz(v.to), t0 + Math.max(0.005, (v.glide ?? v.dur) * c.ts));
      osc.detune.setValueAtTime((v.detune ?? 0) + c.detune, t0);
      if (v.vibrato) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = v.vibrato.rate;
        const depth = ctx.createGain();
        depth.gain.value = v.vibrato.depth;
        lfo.connect(depth);
        depth.connect(osc.detune);
        lfo.start(t0);
        lfo.stop(stopAt);
        c.nodes.push(lfo, depth);
        c.sources.push({ node: lfo, stopAt });
      }
      src = osc;
    } else {
      const buf = ctx.createBufferSource();
      buf.buffer = this.noiseBuffer(v.color);
      buf.loop = true;
      buf.playbackRate.value = c.rate;
      src = buf;
    }
    c.nodes.push(src);

    let head: AudioNode = src;
    if (v.filter) {
      const f = ctx.createBiquadFilter();
      f.type = v.filter.type;
      // Detune moves a noise voice's filters with its playback rate, so the colour shifts too.
      const k = v.kind === 'noise' ? c.rate : 1;
      f.frequency.setValueAtTime(this.hz(v.filter.freq * k), t0);
      if (v.filter.to !== undefined) f.frequency.exponentialRampToValueAtTime(this.hz(v.filter.to * k), t0 + Math.max(0.005, (v.filter.sweep ?? v.dur) * c.ts));
      if (v.filter.q !== undefined) f.Q.value = v.filter.q;
      head.connect(f);
      head = f;
      c.nodes.push(f);
    }
    head.connect(amp);
    head = amp;
    if (v.tremolo) {
      const trem = ctx.createGain();
      const depth = clamp(v.tremolo.depth, 0, 1);
      trem.gain.value = 1 - depth / 2;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = v.tremolo.rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = depth / 2;
      lfo.connect(lfoGain);
      lfoGain.connect(trem.gain);
      head.connect(trem);
      head = trem;
      lfo.start(t0);
      lfo.stop(stopAt);
      c.nodes.push(trem, lfo, lfoGain);
      c.sources.push({ node: lfo, stopAt });
    }
    if (v.pan && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(v.pan, -1, 1);
      head.connect(p);
      head = p;
      c.nodes.push(p);
    }
    head.connect(out);
    // Noise starts at a random point of its loop, so two hits of the same cue never sound identical.
    if (v.kind === 'noise') (src as AudioBufferSourceNode).start(t0, c.random() * NOISE_SECONDS * 0.9);
    else src.start(t0);
    src.stop(stopAt);
    c.sources.push({ node: src, stopAt });
    return t0 + dur;
  }

  private startBed(now: number): void {
    if (this.bed) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setValueAtTime(0, now);
    // Fades in after the low-pass has closed, so the muffle reads first and the buzz second.
    out.gain.linearRampToValueAtTime(BED_LEVEL, now + 0.8);
    out.connect(this.post);
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer('pink');
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 380;
    band.Q.value = 1.4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.7;
    noise.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(out);
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 116;
    const hum2 = ctx.createOscillator();
    hum2.type = 'sawtooth';
    hum2.frequency.value = 174.6;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 520;
    const trem = ctx.createGain();
    trem.gain.value = 0.25;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.15;
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);
    hum.connect(low);
    hum2.connect(low);
    low.connect(trem);
    trem.connect(out);
    const sources = [noise, hum, hum2, lfo];
    noise.start(now, this.random() * NOISE_SECONDS * 0.9);
    for (const s of sources.slice(1)) s.start(now);
    this.bed = { out, sources, nodes: [out, band, noiseGain, low, trem, lfoDepth, ...sources] };
  }

  private stopBed(now: number): void {
    const bed = this.bed;
    if (!bed) return;
    this.bed = null;
    const g = bed.out.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now, 0.12);
    bed.sources[0].onended = () => {
      for (const n of bed.nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
    for (const s of bed.sources) {
      try {
        s.stop(now + 0.7);
      } catch {
        /* already stopped */
      }
    }
  }
}
