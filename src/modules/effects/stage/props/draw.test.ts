// Drawing runs only in a browser, but every path through draw() is exercised here against a recording
// context: no exceptions, no NaN reaching the canvas, no negative radii, balanced save/restore. How it
// looks is checked by eye in the dev harness (dev/index.html).

import { describe, expect, it } from 'vitest';
import type { PropView } from '../types';
import { createShelf } from './index';
import { act, fakeStage, frameAt, recorder, run, type FakeStage, type Recorder } from './testing';

function drawAll(shelf: ReturnType<typeof createShelf>, rec: Recorder, stage: FakeStage, reduced = false, quality: 'high' | 'low' = 'high'): void {
  const f = frameAt(stage.now, 16, { reducedMotion: reduced, quality });
  shelf.drawShelf(rec.layers, f, stage.services);
  for (const p of shelf.props) {
    p.update(f, stage.services);
    p.draw(rec.layers, f, stage.services);
    p.drawHidden?.(rec.layers, f, stage.services, 0.8);
  }
  expect(rec.depth(rec.layers.shade)).toBe(0);
  expect(rec.depth(rec.layers.light)).toBe(0);
}

function byId(shelf: ReturnType<typeof createShelf>, id: string): PropView {
  const p = shelf.props.find((q) => q.id === id);
  if (!p) throw new Error(id);
  return p;
}

describe('drawing', () => {
  it('draws the shelf and every prop at rest, in every state, without a single bad call', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage();
    stage.tip = { x: 0.5, y: 0.4 };
    // Revelio on throughout, so the hidden details' ink (drawn inside draw()) takes every state too.
    stage.reveal = 0.8;
    const s = stage.services;
    const step = (ms: number) => {
      for (let t = 0; t < ms; t += 40) {
        stage.now += 40;
        drawAll(shelf, rec, stage);
      }
    };
    step(100);
    expect(rec.calls).toBeGreaterThan(30);

    byId(shelf, 'candle').apply('prop.ignite', act('a', 'prop.ignite', { hold: true }).action, s);
    byId(shelf, 'box').apply('prop.unlock', act('b', 'prop.unlock').action, s);
    byId(shelf, 'teacup').apply('prop.mend', act('c', 'prop.mend').action, s);
    byId(shelf, 'feather').apply('prop.levitate', act('d', 'prop.levitate', { follow_tip: true, duration_ms: 3000 }).action, s);
    byId(shelf, 'plant').apply('prop.scale', act('e', 'prop.scale', { factor: 1.6, duration_ms: 3000 }).action, s);
    byId(shelf, 'dummy').apply('prop.disarm', act('f', 'prop.disarm').action, s);
    step(600);
    byId(shelf, 'dummy').apply('prop.freeze', act('g', 'prop.freeze', { topple: true }).action, s);
    byId(shelf, 'dummy').apply('prop.costume', act('h', 'prop.costume', { costume: 'hat' }).action, s);
    step(900);
    for (const id of ['candle', 'feather', 'box', 'teacup', 'plant']) {
      byId(shelf, id).apply('prop.scale', act(`x${id}`, 'prop.scale', { factor: 0, mode: 'shatter' }).action, s);
    }
    step(1200);
    for (const id of ['candle', 'feather', 'box', 'teacup', 'plant']) byId(shelf, id).apply('prop.mend', act(`m${id}`, 'prop.mend').action, s);
    byId(shelf, 'dummy').end('*');
    byId(shelf, 'dummy').apply('prop.mimic', act('i', 'prop.mimic').action, s);
    byId(shelf, 'dummy').apply('prop.costume', act('j', 'prop.costume', { costume: 'ruff' }).action, s);
    step(400);
    byId(shelf, 'dummy').apply('prop.costume', act('k', 'prop.costume', { costume: 'bow' }).action, s);
    byId(shelf, 'box').apply('prop.pull', act('l', 'prop.pull').action, s);
    byId(shelf, 'teacup').apply('prop.push', act('m', 'prop.push', { mode: 'follow' }).action, s);
    step(800);
    byId(shelf, 'dummy').end('*');
    byId(shelf, 'dummy').apply('prop.topple', act('n', 'prop.topple').action, s);
    step(1500);
    // Reduced motion and low quality take other branches.
    for (let i = 0; i < 10; i++) {
      stage.now += 40;
      drawAll(shelf, rec, stage, true, 'low');
    }
    expect(rec.problems).toEqual([]);
  });

  it('copes with a letterboxed, high-density mirror and a resize', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage({ width: 1200, height: 900, dpr: 2, caster: { x: 0, y: 112, w: 1200, h: 675 } });
    for (let i = 0; i < 5; i++) {
      stage.now += 16;
      drawAll(shelf, rec, stage);
    }
    const resized = fakeStage({ width: 1920, height: 1000, dpr: 1 });
    resized.now = stage.now;
    for (let i = 0; i < 20; i++) {
      resized.now += 16;
      drawAll(shelf, rec, resized);
    }
    expect(rec.problems).toEqual([]);
  });

  it('draws nothing, and does not throw, where no canvas can be made (Node)', () => {
    const shelf = createShelf();
    const stage = fakeStage();
    const rec = recorder();
    run(shelf.props, stage, 32);
    const f = frameAt(stage.now);
    shelf.drawShelf(rec.layers, f, stage.services);
    for (const p of shelf.props) p.draw(rec.layers, f, stage.services);
    expect(rec.calls).toBe(0);
    expect(rec.problems).toEqual([]);
  });

  it('paints hidden details on the bodies only while Revelio shows them', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage();
    const frame = (): number => {
      const before = rec.calls;
      stage.now += 16;
      const f = frameAt(stage.now);
      for (const p of shelf.props) {
        p.update(f, stage.services);
        p.draw(rec.layers, f, stage.services);
      }
      return rec.calls - before;
    };
    frame();
    // Revelio once first: the dummy's chalk is painted the first time it is wanted, and that painting
    // is not what is counted here.
    stage.reveal = 1;
    frame();
    stage.reveal = 0;
    frame();
    const hidden = frame();
    stage.reveal = 1;
    const shown = frame();
    // One drawing each, in its place in the body: the name on the candle, the letter in the feather, the
    // violet in the teacup, the key under the pot, the chalk under the dummy's arms. The box's rune is
    // light on dark wood and is drawn by drawHidden alone.
    expect(shown - hidden).toBe(5);
    stage.reveal = 0;
    expect(frame()).toBe(hidden);
    expect(rec.problems).toEqual([]);
  });

  it('twinkles and blurs the flying wand only with motion on (Section 10.6)', () => {
    const count = (reducedMotion: boolean): { hidden: number[]; wand: number } => {
      const rec = recorder();
      const shelf = createShelf({ canvasFactory: rec.factory });
      const stage = fakeStage();
      const dummy = byId(shelf, 'dummy');
      const hidden: number[] = [];
      let wand = 0;
      for (let i = 0; i < 160; i++) {
        stage.now += 16;
        const f = frameAt(stage.now, 16, { reducedMotion });
        if (i === 2) dummy.apply('prop.disarm', act('exp', 'prop.disarm').action, stage.services);
        for (const p of shelf.props) p.update(f, stage.services);
        const before = rec.calls;
        dummy.draw(rec.layers, f, stage.services);
        if (i > 2 && i < 12) wand += rec.calls - before;
        const mid = rec.calls;
        for (const p of shelf.props) p.drawHidden?.(rec.layers, f, stage.services, 1);
        // The first frame also paints the sprites, which the recorder counts too.
        if (i > 0) hidden.push(rec.calls - mid);
      }
      expect(rec.problems).toEqual([]);
      return { hidden, wand };
    };
    const still = count(true);
    const moving = count(false);
    // Reduced motion: the same steady halos every frame, never a glint.
    expect(new Set(still.hidden).size).toBe(1);
    expect(Math.max(...moving.hidden)).toBeGreaterThan(still.hidden[0]);
    // The motion ghosts behind the spinning wand are extra drawings that reduced motion leaves out.
    expect(moving.wand).toBeGreaterThan(still.wand);
  });

  it('after a resize, repaints one prop a frame rather than all of them in one frame', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage({ width: 1600, height: 900 });
    for (let i = 0; i < 3; i++) {
      stage.now += 16;
      drawAll(shelf, rec, stage);
    }
    const resized = fakeStage({ width: 1280, height: 720 });
    resized.now = stage.now;
    const added: number[] = [];
    for (let i = 0; i < 40; i++) {
      const before = rec.surfaces;
      resized.now += 16;
      drawAll(shelf, rec, resized);
      added.push(rec.surfaces - before);
    }
    // Every prop repainted, each in a frame of its own...
    expect(added.filter((n) => n > 0).length).toBeGreaterThanOrEqual(6);
    // ...so no frame painted more than one prop's sprites (the box has the most) and the shelf's.
    expect(Math.max(...added)).toBeLessThanOrEqual(12);
    expect(rec.problems).toEqual([]);
  });

  it('paints its sprites once, not every frame', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage();
    for (let i = 0; i < 3; i++) {
      stage.now += 16;
      drawAll(shelf, rec, stage);
    }
    const surfaces = rec.surfaces;
    for (let i = 0; i < 60; i++) {
      stage.now += 16;
      drawAll(shelf, rec, stage);
    }
    expect(rec.surfaces).toBe(surfaces);
  });

  it('paints a shattered prop\'s wreck the first time it is shattered, and only then', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage();
    const s = stage.services;
    const frames = (n: number): number[] => {
      const added: number[] = [];
      for (let i = 0; i < n; i++) {
        const before = rec.surfaces;
        stage.now += 16;
        drawAll(shelf, rec, stage);
        added.push(rec.surfaces - before);
      }
      return added;
    };
    frames(3);
    // Nothing is painted for wrecks before anything is shattered.
    expect(frames(5).every((n) => n === 0)).toBe(true);
    for (const id of ['candle', 'feather', 'box', 'teacup', 'plant']) {
      byId(shelf, id).apply('prop.scale', act(`x${id}`, 'prop.scale', { factor: 0, mode: 'shatter' }).action, s);
    }
    // Painted in the first frame they are drawn: the box's wreck is one sprite, and the others are their
    // own bodies cut into pieces, a sprite each and the wreck they are laid into.
    expect(frames(1)[0]).toBeGreaterThanOrEqual(1 + 4 * 2);
    // The ghost of each outline follows a moment later; then nothing more while they lie there.
    frames(80);
    expect(frames(60).every((n) => n === 0)).toBe(true);
    for (const id of ['candle', 'feather', 'box', 'teacup', 'plant']) byId(shelf, id).apply('prop.mend', act(`m${id}`, 'prop.mend').action, s);
    expect(frames(60).every((n) => n === 0)).toBe(true);
    // Shattered again, the same wrecks come back without being painted again.
    for (const id of ['candle', 'feather', 'box', 'teacup', 'plant']) {
      byId(shelf, id).apply('prop.scale', act(`y${id}`, 'prop.scale', { factor: 0, mode: 'shatter' }).action, s);
    }
    expect(frames(30).every((n) => n === 0)).toBe(true);
    expect(rec.problems).toEqual([]);
  });

  it('draws a wreck lying on the shelf, not a heap and a bright outline', () => {
    const rec = recorder();
    const shelf = createShelf({ canvasFactory: rec.factory });
    const stage = fakeStage();
    const box = byId(shelf, 'box');
    stage.now += 16;
    drawAll(shelf, rec, stage);
    box.apply('prop.scale', act('x', 'prop.scale', { factor: 0, mode: 'shatter' }).action, stage.services);
    run(box, stage, 1200);
    // What the box draws now: its wreck on the shade layer at full strength, and a ghost of its outline
    // on the light layer that is barely there.
    const shadeAlphas: number[] = [];
    const lightAlphas: number[] = [];
    const watch = (ctx: CanvasRenderingContext2D, into: number[]): (() => void) => {
      const draw = ctx.drawImage.bind(ctx);
      (ctx as { drawImage: unknown }).drawImage = (...args: unknown[]) => {
        into.push(ctx.globalAlpha);
        return (draw as (...a: unknown[]) => void)(...args);
      };
      return () => {
        delete (ctx as { drawImage?: unknown }).drawImage;
      };
    };
    const undoShade = watch(rec.layers.shade, shadeAlphas);
    const undoLight = watch(rec.layers.light, lightAlphas);
    box.draw(rec.layers, frameAt(stage.now), stage.services);
    undoShade();
    undoLight();
    expect(shadeAlphas).toEqual([1]);
    expect(lightAlphas.length).toBe(1);
    expect(lightAlphas[0]).toBeLessThan(0.06);
    expect(rec.problems).toEqual([]);
  });
});
