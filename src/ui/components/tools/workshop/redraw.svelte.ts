// Redrawing a gesture (Section 9.5: "A recording in the Workshop screen, saved on your device"; the
// pack and the recognizer are left alone). The next completed stroke goes to 'segmenter.capture'
// instead of being cast, is checked with 'recognizer.score' against the other spells, and is kept with
// 'spellbook.override.set' only when the player chooses to.

import type { Recognition, Stroke } from '../../../../contracts';
import { ask } from '../../../../kernel';
import type { AppState } from '../../../app-state.svelte';
import { errorText } from '../format';
import type { Note } from './types';
import { alike, joinAnd } from './words';

export const CAPTURE_MS = 15_000;
/** Pack lint's line (Section 7.5): two gestures closer than this may be confused. */
export const CONFUSABLE = 0.8;

export type RedrawPhase = 'idle' | 'drawing' | 'captured' | 'saving';

export class Redraw {
  spellId = $state<string | null>(null);
  phase = $state<RedrawPhase>('idle');
  stroke = $state.raw<Stroke | null>(null);
  scored = $state.raw<Recognition | null>(null);
  note = $state<Note | null>(null);
  endsAt = $state(0);
  private cancelled = false;

  choose(spellId: string): void {
    if (this.phase === 'drawing' || this.phase === 'saving') return;
    if (spellId === this.spellId) return;
    this.spellId = spellId;
    this.discard();
  }

  /** Forget a captured drawing that was not used. */
  discard(): void {
    if (this.phase === 'drawing' || this.phase === 'saving') return;
    this.stroke = null;
    this.scored = null;
    this.note = null;
    this.phase = 'idle';
  }

  /** Wait for one stroke in the mirror. Resolves when it came, timed out or was cancelled. */
  async draw(app: AppState): Promise<void> {
    if (!this.spellId || this.phase === 'drawing' || this.phase === 'saving') return;
    this.cancelled = false;
    this.phase = 'drawing';
    this.stroke = null;
    this.scored = null;
    this.note = null;
    this.endsAt = Date.now() + CAPTURE_MS;
    let stroke: Stroke | null;
    try {
      stroke = await ask(app.kernel, 'segmenter.capture', { timeoutMs: CAPTURE_MS });
    } catch (err) {
      this.phase = 'idle';
      this.note = { kind: 'error', text: errorText(err, 'Drawing could not start. Choose Draw it now to try again.') };
      return;
    }
    if (this.cancelled) {
      this.phase = 'idle';
      this.note = null;
      return;
    }
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) {
      this.phase = 'idle';
      this.note = { kind: 'warn', text: 'No stroke came in 15 seconds. Choose Draw it now to try again.' };
      return;
    }
    this.stroke = stroke;
    this.phase = 'captured';
    await this.check(app);
  }

  cancel(app: AppState): void {
    if (this.phase !== 'drawing') return;
    this.cancelled = true;
    // A newer capture replaces the waiting one (which resolves null), and this one ends at once.
    void ask(app.kernel, 'segmenter.capture', { timeoutMs: 0 }).catch(() => undefined);
  }

  /** Score the drawing against every available spell (a dry run: nothing is cast or published). */
  async check(app: AppState): Promise<void> {
    const s = this.stroke;
    if (!s) return;
    try {
      this.scored = await ask(app.kernel, 'recognizer.score', {
        points: s.points.map((p) => [p.x, p.y] as [number, number]),
        aspect: s.aspect && s.aspect > 0 ? s.aspect : 16 / 9,
      });
    } catch (err) {
      this.scored = null;
      this.note = { kind: 'warn', text: `The drawing could not be checked against the other spells. ${errorText(err)}` };
    }
  }

  /** Other spells this drawing scores above the confusion line against, best first. */
  rivals(): { spellId: string; score: number }[] {
    const r = this.scored;
    if (!r || !this.spellId) return [];
    return r.candidates.filter((c) => c.spellId !== this.spellId && c.score > CONFUSABLE).sort((a, b) => b.score - a.score);
  }

  closest(): { spellId: string; score: number } | null {
    const r = this.scored;
    if (!r || !this.spellId) return null;
    return [...r.candidates].filter((c) => c.spellId !== this.spellId).sort((a, b) => b.score - a.score)[0] ?? null;
  }

  /** The check in words: "This is close to Protego; it may be confused with it." */
  verdict(nameOf: (spellId: string) => string): Note | null {
    if (!this.scored) return null;
    const rivals = this.rivals();
    if (rivals.length) {
      const names = joinAnd(rivals.slice(0, 3).map((r) => nameOf(r.spellId)));
      return { kind: 'warn', text: `This is close to ${names}; it may be confused with ${rivals.length > 1 ? 'them' : 'it'}.` };
    }
    const near = this.closest();
    if (!near) return { kind: 'ok', text: 'No other spell is open to compare it with.' };
    return { kind: 'ok', text: `No other spell is close to it. The nearest is ${nameOf(near.spellId)}, ${alike(near.score)} alike.` };
  }

  async use(app: AppState): Promise<boolean> {
    const spellId = this.spellId;
    const stroke = this.stroke;
    if (!spellId || !stroke || this.phase === 'saving') return false;
    this.phase = 'saving';
    try {
      await ask(app.kernel, 'spellbook.override.set', { spellId, stroke: $state.snapshot(stroke) as Stroke });
      this.phase = 'idle';
      this.stroke = null;
      this.scored = null;
      this.note = { kind: 'ok', text: `Saved. ${app.spellName(spellId)} now uses your drawing, on this device only.` };
      return true;
    } catch (err) {
      this.phase = 'captured';
      this.note = { kind: 'error', text: errorText(err, 'The drawing could not be saved.') };
      return false;
    }
  }

  async restore(app: AppState): Promise<boolean> {
    const spellId = this.spellId;
    if (!spellId) return false;
    try {
      await ask(app.kernel, 'spellbook.override.clear', { spellId });
      this.note = { kind: 'ok', text: `${app.spellName(spellId)} uses the book’s drawing again.` };
      return true;
    } catch (err) {
      this.note = { kind: 'error', text: errorText(err, 'The book’s drawing could not be brought back.') };
      return false;
    }
  }
}
