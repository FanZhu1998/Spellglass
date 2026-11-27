// What the shipped spells act on (Section 8, "On screen"), through the real pack loader and spell
// engine: a spell's `targets` and the shelf as it starts (contracts/scene.ts PROP_START) decide it.

import { describe, expect, it } from 'vitest';
import type { SpellCast } from '../../src/contracts';
import { SHELF_LAYOUT } from '../../src/contracts';
import { createPipeline } from './harness';

describe('targets of the shipped spells', () => {
  it('Wingardium Leviosa lifts the feather ("The feather lifts and follows your tip"), wherever the stroke ends', async () => {
    const p = await createPipeline();
    try {
      for (const id of Object.keys(SHELF_LAYOUT) as (keyof typeof SHELF_LAYOUT)[]) {
        for (const y of [0.3, SHELF_LAYOUT[id].y]) {
          const aim = { x: SHELF_LAYOUT[id].x, y };
          const cast = await p.kernel.request<SpellCast>('engine.cast', {
            spellId: 'wingardium-leviosa', via: 'gesture', quality: 1, power: 0.5, aim, replay: true,
          });
          expect(cast.targetId, `a stroke ending at (${aim.x}, ${aim.y})`).toBe('feather');
        }
      }
    } finally {
      await p.dispose();
    }
  });
});
