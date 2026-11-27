// Stage (effect.stage): the mirror's picture (Sections 7.8 and 10). The live camera image is the
// stage; effects that belong to the wand are drawn at the tracked tip, the casting moment plays on
// every cast (Section 10.1), and a shelf of props along the bottom gives spells something to act on.
//
// The module has two halves behind one internal interface (types.ts): the core (core/: loop,
// layers, ink, text, light, particles, shapes, scene effects, practice guide, replays, clips) and
// the shelf of props (props/). Nothing outside effects/stage imports either.

import type { Module, ModuleManifest } from '../../../contracts';
import { EFFECT_CAPABILITY } from '../../../contracts';
import { logger } from '../../../kernel';
import type { Shelf } from './types';
import { StageCore, STAGE_ID } from './core/stage';
import { createShelf } from './props';

const log = logger('stage');

/** Every primitive in contracts/effects.ts except sound, which the audio module plays. log.fade is
 *  listed although the stage draws nothing for it: it only publishes its effect.start and effect.end. */
const EFFECTS = (Object.keys(EFFECT_CAPABILITY) as (keyof typeof EFFECT_CAPABILITY)[]).filter((use) => !use.startsWith('audio.'));

export const MANIFEST: ModuleManifest = {
  id: STAGE_ID,
  kind: 'effect',
  title: 'Stage',
  version: '1.0.0',
  // 1.2: reads TrackerStatus.segmentation (the tip's lostMs).
  contract: '^1.2',
  provides: ['fx.light@1', 'fx.particles@1', 'fx.props@1', 'fx.shapes@1', 'fx.scene@1', 'fx.text@1'],
  requires: ['platform.dom'],
  effects: EFFECTS,
};

/** A shelf with nothing on it: the stage works, and prop steps play a sparkle instead. */
export function emptyShelf(): Shelf {
  return { props: [], drawShelf: () => {} };
}

/** The props half's shelf (props/index.ts). If it cannot be built the stage still runs, with an
 *  empty shelf, so one broken prop never takes the mirror down with it. */
function makeShelf(): Shelf {
  try {
    const shelf = createShelf();
    if (shelf && Array.isArray(shelf.props) && typeof shelf.drawShelf === 'function') return shelf;
    log.warn('createShelf() returned something that is not a shelf; the shelf stays empty');
  } catch (err) {
    log.warn('the shelf could not be built; the shelf stays empty', err);
  }
  return emptyShelf();
}

export function createStageModule(opts: { host: HTMLElement }): Module {
  return new StageCore(MANIFEST, { host: opts.host, shelf: makeShelf() }).module();
}
