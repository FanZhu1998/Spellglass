// Playing a replay (Section 11.1: "Opening the link replays the trace and the effect on a plain
// backdrop, with no camera needed"). The stage does the playing ('stage.replay': it animates the trace,
// asks the engine to cast with replay: true, lets the effect run and resolves when it is over); this
// file checks that the spell can be shown here and turns every refusal into a plain sentence.
//
// A spell whose pack is off or whose needs are unmet is not played: a shared link must not bring a
// pack the player turned off (the restricted section) onto their stage, and the engine would refuse
// it anyway. Locked spells (a later tier) still replay: watching one teaches nothing the spellbook
// does not already show. Replays never count toward progress and never become keepsakes; the engine
// marks the cast as a replay and every module honours that.

import type { Kernel, ReplayData, Spellbook, SpellbookEntry } from '../../contracts';
import { KernelError, ask, lastPayload } from '../../kernel';

export const REPLAY_MESSAGES = {
  noStage: 'Replays need the mirror, and it is not running yet.',
  failed: 'The replay could not play.',
} as const;

export function notInBook(spellId: string): string {
  return `This replay is of a spell that is not in your spellbook (${spellId}).`;
}

export function notAvailable(entry: SpellbookEntry): string {
  const reason = entry.unavailableReason ? ` ${entry.unavailableReason}` : '';
  return `${entry.spell.incantation} is not available here, so this replay cannot play.${reason}`;
}

async function spellbook(kernel: Kernel): Promise<Spellbook | null> {
  const sticky = lastPayload(kernel, 'spellbook.changed');
  if (sticky) return sticky;
  try {
    return await ask(kernel, 'spellbook.get');
  } catch {
    return null;
  }
}

/** The spellbook entry a replay needs, or a KernelError('not-supported') saying why it cannot play. */
export async function playableEntry(kernel: Kernel, spellId: string): Promise<SpellbookEntry> {
  const book = await spellbook(kernel);
  const entry = book?.spells.find((e) => e.spell.id === spellId);
  if (!entry) throw new KernelError('not-supported', notInBook(spellId));
  if (!entry.available) throw new KernelError('not-supported', notAvailable(entry));
  return entry;
}

/** Play a replay on the stage; resolves with how long it took once it is over. The backdrop is the
 *  stage's default (plain) unless a clip that includes the camera asks for it. */
export async function playReplay(kernel: Kernel, data: ReplayData, options: { backdrop?: 'plain' | 'camera' } = {}): Promise<{ durationMs: number }> {
  await playableEntry(kernel, data.spellId);
  try {
    const result = await ask(kernel, 'stage.replay', {
      spellId: data.spellId,
      points: data.points,
      aspect: data.aspect,
      durationMs: data.durationMs,
      via: data.via,
      quality: data.quality,
      power: data.power,
      variant: data.variant,
      ...(data.target ? { targetId: data.target } : {}),
      ...(options.backdrop ? { backdrop: options.backdrop } : {}),
    });
    return { durationMs: result.durationMs };
  } catch (err) {
    throw await replayFailure(kernel, data.spellId, err);
  }
}

/** A refusal from the stage or the engine, as the player should read it. */
async function replayFailure(kernel: Kernel, spellId: string, err: unknown): Promise<KernelError> {
  if (err instanceof KernelError && err.code === 'no-handler') return new KernelError('not-supported', REPLAY_MESSAGES.noStage, err);
  // The pack may have been turned off while the trace was drawn: the engine then refuses the cast.
  try {
    await playableEntry(kernel, spellId);
  } catch (unavailable) {
    return unavailable as KernelError;
  }
  if (err instanceof KernelError) return err;
  return new KernelError('handler-failed', REPLAY_MESSAGES.failed, err);
}
