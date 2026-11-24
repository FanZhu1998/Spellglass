import { describe, expect, it } from 'vitest';
import { AUDIO_CUES } from '../../../contracts';
import { buildRecipe, recipeLength } from './cues';
import { AudioGraph, BED_LEVEL, envelopePoints, FLOOR, MASTER_LEVEL, MUFFLE_HZ } from './synth';
import { asAudioContext, FakeAudioContext, FakeBiquad, FakeBufferSource, FakeCompressor, FakeGain, FakeOscillator, type FakeNode } from './testing';

function graphOn(fake: FakeAudioContext, opts: { volume?: number; muted?: boolean; muffled?: boolean } = {}): AudioGraph {
  return new AudioGraph(asAudioContext(fake), { volume: opts.volume ?? 0.8, muted: opts.muted ?? false, muffled: opts.muffled ?? false });
}

/** The node the graph sends to the speakers through: the last gain before the destination. */
const volumeNode = (fake: FakeAudioContext) => fake.nodes.find((n) => n.connections.includes(fake.destination)) as FakeGain;
const muffleFilter = (fake: FakeAudioContext) => fake.nodes.find((n): n is FakeBiquad => n instanceof FakeBiquad) as FakeBiquad;

describe('envelopes', () => {
  const cases = [
    { env: { attack: 0.01, decay: 0.3 }, dur: 0.34 },
    { env: { attack: 0.2, hold: 0.5, decay: 0.6, sustain: 0.3, release: 0.1 }, dur: 1.5 },
    { env: { attack: 2, decay: 2 }, dur: 0.5 }, // longer than the voice: compressed into it
    { env: { attack: 0, decay: 0 }, dur: 0.001 },
  ];
  for (const c of cases) {
    it(`${JSON.stringify(c.env)} over ${c.dur} s`, () => {
      const pts = envelopePoints(c.env, 0.4, c.dur);
      expect(pts[0]).toEqual({ t: 0, v: 0, ramp: 'set' });
      expect(pts[pts.length - 1].v).toBe(0);
      expect(pts[pts.length - 1].t).toBeCloseTo(Math.max(0.005, c.dur));
      for (let i = 1; i < pts.length; i++) expect(pts[i].t).toBeGreaterThanOrEqual(pts[i - 1].t);
      for (const p of pts) {
        expect(p.v).toBeGreaterThanOrEqual(0);
        if (p.ramp === 'exp') expect(p.v).toBeGreaterThanOrEqual(FLOOR);
      }
      expect(Math.max(...pts.map((p) => p.v))).toBeCloseTo(0.4);
    });
  }
});

describe('rendering', () => {
  it('renders every cue without breaking a rule of the Web Audio API', () => {
    const fake = new FakeAudioContext(() => 0);
    const g = graphOn(fake);
    for (const cue of AUDIO_CUES) {
      const before = fake.sources().length;
      const recipe = buildRecipe(cue, 3);
      const when = 1;
      const s = g.play(recipe, when, { gain: 1, detune: 0, timeScale: 1, seed: 3 });
      expect(s.endsAt, cue).toBeCloseTo(when + recipeLength(recipe), 5);
      const mine = fake.sources().slice(before);
      expect(mine.length, cue).toBeGreaterThanOrEqual(recipe.voices.length);
      for (const src of mine) {
        expect(src.startedAt!, cue).toBeGreaterThanOrEqual(when);
        expect(src.stoppedAt!, cue).toBeLessThanOrEqual(s.endsAt + 0.05);
        expect(src.stoppedAt!, cue).toBeGreaterThan(src.startedAt!);
      }
    }
  });

  it('applies the gain, detune and time scale it is given', () => {
    const fake = new FakeAudioContext(() => 0);
    const g = graphOn(fake);
    const recipe = buildRecipe('chime', 1);
    const s = g.play(recipe, 0.5, { gain: 1.3, detune: 200, timeScale: 1.2, seed: 1 });
    const out = fake.nodes.filter((n): n is FakeGain => n instanceof FakeGain).find((n) => n.gain.value === 1.3);
    expect(out).toBeDefined();
    const osc = fake.sources().filter((x): x is FakeOscillator => x instanceof FakeOscillator);
    expect(osc[0].detune.events[0]).toMatchObject({ type: 'set', v: 200 });
    expect(s.endsAt).toBeCloseTo(0.5 + recipeLength(recipe) * 1.2, 5);

    const n = g.play(buildRecipe('snuff', 1), 0, { gain: 1, detune: 1200, timeScale: 1, seed: 1 });
    expect(n.endsAt).toBeGreaterThan(0);
    const noise = fake.sources().filter((x): x is FakeBufferSource => x instanceof FakeBufferSource);
    expect(noise[noise.length - 1].playbackRate.value).toBeCloseTo(2);
    expect(noise[noise.length - 1].loop).toBe(true);
  });

  it('stops a cue with a fade, never stretching a voice past its own end', () => {
    let now = 0;
    const fake = new FakeAudioContext(() => now);
    const g = graphOn(fake);
    const before = fake.sources().length;
    const firstNode = fake.nodes.length;
    const s = g.play(buildRecipe('patronus', 1), 0.01, { gain: 1, detune: 0, timeScale: 1, seed: 1 });
    const natural = fake.sources().slice(before).map((x) => x.stoppedAt!);
    now = 500;
    s.stop(0.5, 0.1);
    const mine = fake.sources().slice(before);
    mine.forEach((src, i) => expect(src.stoppedAt!).toBeLessThanOrEqual(Math.min(natural[i], 0.5 + 0.1 + 0.02)));
    // The cue's own gain (the first node play() makes) ramps to silence over the fade.
    const out = fake.nodes[firstNode] as FakeGain;
    expect(out.gain.events.slice(-3)).toEqual([{ type: 'cancel', t: 0.5 }, { type: 'set', v: 1, t: 0.5 }, { type: 'linear', v: 0, t: 0.6 }]);
  });

  it('disconnects a cue once all its sources have ended', () => {
    let now = 0;
    const fake = new FakeAudioContext(() => now);
    const g = graphOn(fake);
    const start = fake.nodes.length;
    g.play(buildRecipe('arm-tick', 1), 0.01, { gain: 1, detune: 0, timeScale: 1, seed: 1 });
    const created = fake.nodes.slice(start);
    now = 1000;
    fake.flush();
    expect(created.every((n) => n.disconnected)).toBe(true);
  });
});

describe('master bus', () => {
  it('sets the volume from the player, and silence when muted', () => {
    const fake = new FakeAudioContext(() => 0);
    const g = graphOn(fake, { volume: 0.5 });
    expect(volumeNode(fake).gain.target).toBeCloseTo(MASTER_LEVEL * 0.5);
    g.setVolume(1, true);
    expect(volumeNode(fake).gain.target).toBe(0);
    g.setVolume(2, false);
    expect(volumeNode(fake).gain.target).toBeCloseTo(MASTER_LEVEL);
  });

  it('routes cues through the muffle filter and a limiter before the volume', () => {
    const fake = new FakeAudioContext(() => 0);
    graphOn(fake);
    const filter = muffleFilter(fake);
    const limiter = fake.nodes.find((n): n is FakeCompressor => n instanceof FakeCompressor)!;
    const reaches = (from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return from.connections.some((c) => 'connections' in c && reaches(c as FakeNode, to, seen));
    };
    expect(reaches(filter, limiter)).toBe(true);
    expect(reaches(limiter, volumeNode(fake))).toBe(true);
    expect(reaches(volumeNode(fake), fake.destination)).toBe(true);
  });

  it('muffles: the low-pass closes and a soft buzzing bed starts, then both release', () => {
    const fake = new FakeAudioContext(() => 0, { sampleRate: 48000 });
    const g = graphOn(fake);
    const filter = muffleFilter(fake);
    const sourcesBefore = fake.sources().length;
    g.setMuffled(true);
    expect(g.isMuffled).toBe(true);
    expect(filter.frequency.target).toBe(MUFFLE_HZ);
    const bed = fake.sources().slice(sourcesBefore);
    expect(bed.length).toBeGreaterThan(0);
    expect(bed.every((s) => s.startedAt !== undefined && s.stoppedAt === undefined)).toBe(true);
    const bedOut = fake.nodes.find((n): n is FakeGain => n instanceof FakeGain && n.gain.events.some((e) => e.v === BED_LEVEL));
    expect(bedOut).toBeDefined();
    g.setMuffled(true); // already muffled: nothing new
    expect(fake.sources().length).toBe(sourcesBefore + bed.length);
    g.setMuffled(false);
    expect(filter.frequency.target).toBeGreaterThan(10_000);
    expect(bed.every((s) => s.stoppedAt !== undefined)).toBe(true);
  });

  it('starts muffled when built during a muffle', () => {
    const fake = new FakeAudioContext(() => 0);
    graphOn(fake, { muffled: true });
    expect(muffleFilter(fake).frequency.target).toBe(MUFFLE_HZ);
  });

  it('hands out a capture stream from after the limiter, and stops it', () => {
    const fake = new FakeAudioContext(() => 0);
    const g = graphOn(fake);
    const stream = g.startCapture();
    expect(stream).toBeTruthy();
    expect(g.startCapture()).toBe(stream);
    const limiter = fake.nodes.find((n): n is FakeCompressor => n instanceof FakeCompressor)!;
    const dest = fake.nodes.find((n) => n.kind === 'stream-destination')!;
    expect(limiter.connections).toContain(dest);
    g.stopCapture();
    expect(limiter.connections).not.toContain(dest);
    expect(graphOn(new FakeAudioContext(() => 0, { noCapture: true })).startCapture()).toBeNull();
  });
});
