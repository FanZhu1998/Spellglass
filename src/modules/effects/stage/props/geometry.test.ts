// The published sizes follow the art (art brief: keep each prop's published radius truthful). The
// engine aims at props by distance and the core places effects at their centres, so a radius that
// drifted from what is drawn would make a prop look bigger or smaller than it acts.

import { describe, expect, it } from 'vitest';
import type { PropId } from '../../../../contracts';
import { buildBoxArt } from './art/box';
import { buildCandleArt } from './art/candle';
import type { ArtBox } from './art/canvas';
import { DUMMY_JOINTS, buildDummyArt } from './art/dummy';
import { buildFeatherArt } from './art/feather';
import { buildPlantArt } from './art/plant';
import { buildTeacupArt } from './art/teacup';
import { DIMS } from './geometry';
import { recorder } from './testing';

/** The painted extent of each prop's body at rest, in mH from its base. */
function bodies(): Record<PropId, ArtBox> {
  const f = recorder().factory;
  const candle = buildCandleArt(f, 1);
  const feather = buildFeatherArt(f, 1);
  const box = buildBoxArt(f, 1);
  const teacup = buildTeacupArt(f, 1);
  const plant = buildPlantArt(f, 1);
  const dummy = buildDummyArt(f, 1);
  if (!candle || !feather || !box || !teacup || !plant || !dummy) throw new Error('no art');
  const J = DUMMY_JOINTS;
  // The dummy at rest: its parts where the joints put them.
  const parts: ArtBox[] = [
    dummy.stand.box, dummy.torso.box,
    { x0: dummy.arms.box.x0, y0: dummy.arms.box.y0 + J.shoulder.y, x1: dummy.arms.box.x1, y1: dummy.arms.box.y1 + J.shoulder.y },
    { x0: dummy.head.box.x0, y0: dummy.head.box.y0 + J.head.y, x1: dummy.head.box.x1, y1: dummy.head.box.y1 + J.head.y },
  ];
  const union = parts.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  return { candle: candle.body.box, feather: feather.body.box, box: box.body.box, teacup: teacup.body.box, plant: plant.body.box, dummy: union };
}

describe('prop sizes', () => {
  it('publishes a radius truthful to what is drawn: close to the body\'s mean half-extent', () => {
    const b = bodies();
    for (const id of Object.keys(b) as PropId[]) {
      const { x0, y0, x1, y1 } = b[id];
      const hw = (x1 - x0) / 2;
      const hh = (y1 - y0) / 2;
      const mean = Math.sqrt((hw * hw + hh * hh) / 2);
      expect(Math.abs(DIMS[id].radius - mean) / mean, `${id}: radius ${DIMS[id].radius}, body ${hw.toFixed(0)} x ${hh.toFixed(0)}`).toBeLessThan(0.12);
    }
  });

  it('gives each body the height and footprint it is drawn with', () => {
    const b = bodies();
    for (const id of ['candle', 'box', 'teacup', 'plant', 'dummy'] as const) {
      const height = -b[id].y0;
      expect(Math.abs(DIMS[id].height - height) / height, `${id} height`).toBeLessThan(0.08);
    }
    for (const id of Object.keys(b) as PropId[]) {
      // The contact shadow is no wider than the body that throws it.
      expect(DIMS[id].foot, `${id} foot`).toBeLessThanOrEqual(b[id].x1 - b[id].x0);
    }
  });
});
