// Fake-camera clips for end-to-end tests (blueprint Section 12: "Playwright can feed a recorded video to
// the browser as a fake camera"; Section 13 "Tracker clips").
//
// Writes a YUV4MPEG2 (.y4m) file: a dark, slightly noisy room with a small bright round dot (the wand
// tip, lit by the light beside the lens) tracing unit-square gesture paths with the hold-still rhythm
// the segmenter expects (Section 7.4): hold 0.5 s, trace about 1.2 s, pause 0.5 s, then move away (the
// glint vanishes when the tip turns from the camera). Chrome plays it as its webcam:
//
//   chrome --use-fake-device-for-media-stream --use-file-for-fake-video-capture=/path/clip.y4m
//
// Chrome loops the file when it reaches the end.
//
// The camera sees the mirror image: a stroke the caster draws left to right appears right to left in the
// raw frame. Paths here are in caster space, like the packs (Appendix B), and are mirrored when drawn.
//
// The files are large (about 27 MB per second at 640x360, 30 fps): write them outside the repository,
// or into a git-ignored folder, and never commit them.
//
// CLI:
//   npx tsx tools/fake-camera/make-y4m.ts --out <file.y4m> [--width 640] [--height 360] [--fps 30]
//        [--spells lumos,wingardium-leviosa,protego,stupefy] [--colorspace C420jpeg|C420] [--seed 1]
//        [--size 0.6] [--radius 3] [--lead 1500] [--json]
// --json also writes <file>.json: the timeline and the true tip position (caster space) of every frame.

import { closeSync, openSync, readFileSync, writeSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Gesture, Point, SpellPack } from '../../src/contracts';
// The two helpers directly, not the kernel index (which also loads the pack service and its generated
// validators, which this CLI does not need).
import * as geometry from '../../src/kernel/geometry';
import { gesturePaths } from '../../src/kernel/gestures';

export type Colorspace = 'C420jpeg' | 'C420';

export interface ClipGesture {
  spellId: string;
  /** Unit-square path in caster space (as seen in the mirror), x right, y down. */
  path: Point[];
}

export interface ClipOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** C420jpeg: full-range 4:2:0 (what ffmpeg writes for yuv420p). C420: limited range, 16..235. */
  colorspace?: Colorspace;
  /** Default: Lumos, Wingardium Leviosa, Protego and Stupefy from public/packs/core-charms. */
  gestures?: ClipGesture[];
  /** Empty room before the first gesture, so the tracker's static mask settles. */
  leadMs?: number;
  holdMs?: number;
  traceMs?: number;
  pauseMs?: number;
  /** The tip is out of view between gestures for this long. */
  awayMs?: number;
  /** Dot radius in camera pixels, default 3 at every size: a 6 px glint, what Section 4 expects of a
   *  4 mm tip at 1 m in a 1920-pixel frame (at 640 px it stands for a tip with some glare). It does not
   *  grow with the frame, because the tracker's area limits are in camera pixels too: a dot scaled to
   *  19 px across at 1080p smears past brightTip.maxArea on a fast stroke. */
  dotRadius?: number;
  /** Peak brightness of the dot, 0..255 (full range). */
  dotLevel?: number;
  /** Side of the square the gestures are drawn in, as a fraction of the frame height. */
  gestureSize?: number;
  /** Uniform noise amplitude in luma levels. */
  noise?: number;
  seed?: number;
  /** Static bright spots (a lamp, a window glint), caster space with a radius in px, for mask tests. */
  lamps?: { x: number; y: number; radius: number; level?: number }[];
}

export interface FrameTruth {
  frame: number;
  /** ms from the start of the clip. */
  t: number;
  /** Where the tip is, in caster space, or null when it is out of view. */
  tip: { x: number; y: number } | null;
  phase: 'lead' | 'hold' | 'trace' | 'pause' | 'away';
  spellId?: string;
}

export interface ClipScript {
  width: number;
  height: number;
  fps: number;
  colorspace: Colorspace;
  frames: number;
  durationMs: number;
  dotRadius: number;
  /** Frame ranges of each gesture: hold starts at startFrame, the stroke runs traceStart..traceEnd. */
  gestures: { spellId: string; startFrame: number; traceStart: number; traceEnd: number; endFrame: number }[];
  truth: FrameTruth[];
}

const DEFAULTS = {
  width: 640, height: 360, fps: 30, colorspace: 'C420jpeg' as Colorspace,
  leadMs: 1500, holdMs: 500, traceMs: 1200, pauseMs: 500, awayMs: 600,
  dotRadius: 3, dotLevel: 250, gestureSize: 0.6, noise: 3, seed: 1,
};

/** The four core gestures the e2e tests trace, from the shipped pack (so a redrawn seed stays in sync). */
export const DEFAULT_SPELLS = ['lumos', 'wingardium-leviosa', 'protego', 'stupefy'];

const here = dirname(fileURLToPath(import.meta.url));

/** Gesture paths from a spell pack file: flicks become straight lines through the middle. */
export function gesturesFromPack(spellIds: readonly string[] = DEFAULT_SPELLS, packPath = resolve(here, '../../public/packs/core-charms/pack.json')): ClipGesture[] {
  const pack = JSON.parse(readFileSync(packPath, 'utf8')) as SpellPack;
  return spellIds.map((id) => {
    const spell = pack.spells.find((s) => s.id === id);
    if (!spell) throw new Error(`No spell '${id}' in ${packPath}`);
    return { spellId: id, path: gesturePath(spell.gesture) };
  });
}

export function gesturePath(g: Gesture): Point[] {
  if ('flick' in g) return geometry.flickPath(g.flick);
  const [first] = gesturePaths(g);
  if (!first?.length) throw new Error('Gesture has no path');
  return first;
}

/** Plan the clip: the timeline and where the tip is on every frame. Pure. */
export function planClip(options: ClipOptions = {}): ClipScript {
  const o = { ...DEFAULTS, ...options };
  if (o.width % 2 || o.height % 2) throw new Error('4:2:0 needs an even width and height');
  const gestures = options.gestures ?? gesturesFromPack();
  const frameMs = 1000 / o.fps;
  const toFrames = (ms: number) => Math.max(0, Math.round(ms / frameMs));
  const aspect = o.width / o.height;
  // The gesture's isotropic unit square, centred, gestureSize of the height on a side.
  const place = ([u, v]: Point) => ({ x: 0.5 + ((u - 0.5) * o.gestureSize) / aspect, y: 0.5 + (v - 0.5) * o.gestureSize });

  const truth: FrameTruth[] = [];
  const push = (phase: FrameTruth['phase'], tip: FrameTruth['tip'], spellId?: string) =>
    truth.push({ frame: truth.length, t: Math.round(truth.length * frameMs * 1000) / 1000, tip, phase, spellId });

  for (let i = 0; i < toFrames(o.leadMs); i++) push('lead', null);
  const timeline: ClipScript['gestures'] = [];
  for (const g of gestures) {
    const path = g.path;
    const startFrame = truth.length;
    const start = place(path[0]), end = place(path[path.length - 1]);
    for (let i = 0; i < toFrames(o.holdMs); i++) push('hold', start, g.spellId);
    const traceStart = truth.length;
    const n = Math.max(2, toFrames(o.traceMs));
    for (let i = 0; i < n; i++) {
      const tau = i / (n - 1);
      // Mostly even speed with a gentle ease at both ends, like a hand that knows the shape.
      const s = 0.8 * tau + 0.2 * tau * tau * (3 - 2 * tau);
      push('trace', place(geometry.pointAt(path, s)), g.spellId);
    }
    const traceEnd = truth.length - 1;
    for (let i = 0; i < toFrames(o.pauseMs); i++) push('pause', end, g.spellId);
    for (let i = 0; i < toFrames(o.awayMs); i++) push('away', null, g.spellId);
    timeline.push({ spellId: g.spellId, startFrame, traceStart, traceEnd, endFrame: truth.length - 1 });
  }
  return {
    width: o.width,
    height: o.height,
    fps: o.fps,
    colorspace: o.colorspace,
    frames: truth.length,
    durationMs: Math.round(truth.length * frameMs),
    dotRadius: options.dotRadius ?? DEFAULTS.dotRadius,
    gestures: timeline,
    truth,
  };
}

export function y4mHeader(width: number, height: number, fps: number, colorspace: Colorspace): string {
  // Progressive, square pixels; the colour space names the chroma layout and range.
  return `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 ${colorspace}\n`;
}

/** Bytes of one frame's planes (4:2:0). */
export function frameBytes(width: number, height: number): number {
  return width * height + 2 * (width / 2) * (height / 2);
}

/** Renders frames of a planned clip into Y, U and V planes. */
export class ClipRenderer {
  private readonly background: Float32Array;
  /** Scratch for one frame's light, reused (8 MB at 1080p). */
  private readonly luma: Float32Array;
  private state: number;
  private readonly o: Required<Pick<ClipOptions, 'noise' | 'dotLevel'>> & ClipOptions;

  constructor(
    readonly script: ClipScript,
    options: ClipOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...options };
    this.state = (options.seed ?? DEFAULTS.seed) * 2654435761 || 1;
    const { width: w, height: h } = script;
    // A dim study: a faint warm wash on the wall behind the caster, darker toward the corners.
    this.background = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - w * 0.5) / w, dy = (y - h * 0.35) / h;
        this.background[y * w + x] = 14 + 12 * Math.exp(-(dx * dx + dy * dy) * 6);
      }
    }
    for (const lamp of options.lamps ?? []) {
      const cx = (1 - lamp.x) * w, cy = lamp.y * h;
      this.stamp(this.background, cx, cy, lamp.radius, lamp.level ?? 245);
    }
    this.luma = new Float32Array(w * h);
  }

  /** Fill `out` (frameBytes long) with frame i: Y plane, then U, then V. */
  render(i: number, out: Uint8Array): Uint8Array {
    const { width: w, height: h, colorspace } = this.script;
    const luma = this.luma;
    luma.set(this.background);
    const truth = this.script.truth[i];
    if (truth?.tip) {
      // A short exposure smears the dot a little along its path: three sub-positions over 1/120 s.
      const prev = this.script.truth[i - 1]?.tip ?? truth.tip;
      for (let k = 0; k < 3; k++) {
        const f = 1 - k * 0.125; // 1/120 s is a quarter of a 30 fps frame interval
        const x = prev.x + (truth.tip.x - prev.x) * f, y = prev.y + (truth.tip.y - prev.y) * f;
        // Mirror: the camera sees the caster's right on its left.
        this.stamp(luma, (1 - x) * w, y * h, this.script.dotRadius, this.o.dotLevel);
      }
    }
    const noise = this.o.noise;
    const limited = colorspace === 'C420';
    for (let p = 0; p < w * h; p++) {
      let v = luma[p] + (noise ? (this.rand() * 2 - 1) * noise : 0);
      if (limited) v = 16 + (v * 219) / 255;
      out[p] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    // A grey room: no colour.
    out.fill(128, w * h, frameBytes(w, h));
    return out;
  }

  /** An anti-aliased bright disc, taking the brighter of what is there and the disc (light, not paint). */
  private stamp(plane: Float32Array, cx: number, cy: number, r: number, level: number): void {
    const { width: w, height: h } = this.script;
    for (let y = Math.max(0, Math.floor(cy - r - 2)); y < Math.min(h, Math.ceil(cy + r + 2)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 2)); x < Math.min(w, Math.ceil(cx + r + 2)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cover = Math.min(1, Math.max(0, r + 0.5 - d));
        if (cover <= 0) continue;
        const p = y * w + x;
        const v = plane[p] + (level - plane[p]) * cover;
        if (v > plane[p]) plane[p] = v;
      }
    }
  }

  /** xorshift32: fast, deterministic noise. */
  private rand(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return (x >>> 0) / 4294967296;
  }
}

/** Write a clip to `path`, frame by frame (the file can be hundreds of megabytes). Returns the script. */
export function writeY4m(path: string, options: ClipOptions = {}): ClipScript {
  const script = planClip(options);
  const renderer = new ClipRenderer(script, options);
  const buf = new Uint8Array(frameBytes(script.width, script.height));
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, y4mHeader(script.width, script.height, script.fps, script.colorspace));
    for (let i = 0; i < script.frames; i++) {
      writeSync(fd, 'FRAME\n');
      writeSync(fd, renderer.render(i, buf));
    }
  } finally {
    closeSync(fd);
  }
  return script;
}

export interface Y4mFile {
  width: number;
  height: number;
  fps: number;
  colorspace: string;
  headerBytes: number;
  frameCount: number;
  /** The Y plane of frame i (a view into the file's bytes). */
  luma(i: number): Uint8Array;
}

/** Read a .y4m written by writeY4m (or ffmpeg's yuv420p): header fields and frame access. */
export function readY4m(bytes: Uint8Array): Y4mFile {
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) throw new Error('No y4m header');
  const header = new TextDecoder().decode(bytes.subarray(0, nl));
  const parts = header.split(' ');
  if (parts[0] !== 'YUV4MPEG2') throw new Error(`Not a y4m file: ${parts[0]}`);
  const field = (p: string) => parts.find((x) => x.startsWith(p))?.slice(1);
  const width = Number(field('W')), height = Number(field('H'));
  const [num, den] = (field('F') ?? '30:1').split(':').map(Number);
  const colorspace = field('C') ?? '420jpeg';
  const size = frameBytes(width, height);
  const offsets: number[] = [];
  let at = nl + 1;
  while (at < bytes.length) {
    const end = bytes.indexOf(0x0a, at);
    if (end < 0) throw new Error(`Truncated frame header at byte ${at}`);
    const tag = new TextDecoder().decode(bytes.subarray(at, Math.min(end, at + 5)));
    if (tag !== 'FRAME') throw new Error(`Expected FRAME at byte ${at}, found '${tag}'`);
    const data = end + 1;
    if (data + size > bytes.length) throw new Error(`Truncated frame ${offsets.length}`);
    offsets.push(data);
    at = data + size;
  }
  return {
    width, height, fps: num / (den || 1), colorspace: `C${colorspace}`, headerBytes: nl + 1, frameCount: offsets.length,
    luma: (i) => bytes.subarray(offsets[i], offsets[i] + width * height),
  };
}

// ---------------------------------------------------------------------------------------- CLI

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const out = typeof args.out === 'string' ? resolve(args.out) : null;
  if (!out || args.help) {
    console.log('Usage: npx tsx tools/fake-camera/make-y4m.ts --out <file.y4m> [--width 640] [--height 360] [--fps 30] [--spells a,b,c] [--colorspace C420jpeg|C420] [--seed 1] [--size 0.6] [--radius 3] [--lead 1500] [--json]');
    process.exitCode = out ? 0 : 1;
    return;
  }
  const n = (k: string) => (typeof args[k] === 'string' ? Number(args[k]) : undefined);
  const spells = typeof args.spells === 'string' ? args.spells.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SPELLS;
  const options: ClipOptions = {
    width: n('width'), height: n('height'), fps: n('fps'), seed: n('seed'), gestureSize: n('size'), dotRadius: n('radius'), leadMs: n('lead'),
    colorspace: args.colorspace === 'C420' ? 'C420' : 'C420jpeg',
    gestures: gesturesFromPack(spells),
  };
  for (const k of Object.keys(options) as (keyof ClipOptions)[]) if (options[k] === undefined) delete options[k];
  const script = writeY4m(out, options);
  const bytes = 'YUV4MPEG2'.length + script.frames * (6 + frameBytes(script.width, script.height));
  console.log(`Wrote ${out}: ${script.width}x${script.height} at ${script.fps} fps, ${script.frames} frames (${(script.durationMs / 1000).toFixed(1)} s, about ${Math.round(bytes / 1e6)} MB).`);
  for (const g of script.gestures) console.log(`  ${g.spellId}: frames ${g.startFrame} to ${g.endFrame} (stroke ${g.traceStart} to ${g.traceEnd})`);
  if (args.json) {
    writeFileSync(`${out}.json`, JSON.stringify(script));
    console.log(`Wrote ${out}.json (timeline and true tip positions, caster space).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
