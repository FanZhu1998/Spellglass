// Recording a session in the fixture format (Section 13: "casting each spell twenty times"). The
// diagnostics module does the recording; this keeps what the Workshop shows about it: the spell the
// caster is asked to cast, and how many strokes have been decided since the recording began. It lives
// at module level, so a recording survives the Workshop being folded away or closed while casting, and
// the diagnostics overlay can show it too.

import type { RecordedSession } from '../../../../contracts';
import { ask, lastPayload, on } from '../../../../kernel';
import type { AppState } from '../../../app-state.svelte';
import { dateStamp, errorText, jsonBlob } from '../format';

export interface Decision {
  ok: boolean;
  text: string;
}

export interface SavedSession {
  filename: string;
  decisions: number;
  outcome: string;
}

class Recording {
  active = $state(false);
  busy = $state(false);
  intended = $state<string | null>(null);
  /** Strokes decided since the recording began: every cast and every real fizzle. */
  total = $state(0);
  /** Decided since the intended spell last changed, and how many of those cast that spell. */
  forSpell = $state(0);
  rightForSpell = $state(0);
  last = $state<Decision | null>(null);
  error = $state<string | null>(null);
  saved = $state<SavedSession | null>(null);
  /** The diagnostics module stopped the recording itself (the tracker stopped or changed). */
  interrupted = $state(false);

  private offs: (() => void)[] = [];
  private labels = new Set<string>();

  async start(app: AppState, intended: string | null): Promise<boolean> {
    if (this.active || this.busy) return false;
    this.busy = true;
    this.error = null;
    this.saved = null;
    const title = `Spellglass session, ${dateStamp()}`;
    try {
      await ask(app.kernel, 'session.record.start', intended ? { intended, title } : { title });
      this.active = true;
      this.interrupted = false;
      this.intended = intended;
      this.labels = new Set(intended ? [intended] : []);
      this.total = 0;
      this.forSpell = 0;
      this.rightForSpell = 0;
      this.last = null;
      this.listen(app);
      return true;
    } catch (err) {
      this.error = errorText(err, 'The recording could not start.');
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Change the spell the caster is asked to cast (null: any spell, unlabelled). */
  async label(app: AppState, spellId: string | null): Promise<void> {
    if (!this.active || spellId === this.intended) return;
    try {
      await ask(app.kernel, 'session.record.label', { spellId });
      this.intended = spellId;
      if (spellId) this.labels.add(spellId);
      this.forSpell = 0;
      this.rightForSpell = 0;
      this.last = null;
    } catch (err) {
      this.error = errorText(err, 'The spell could not be changed.');
    }
  }

  /** The spell after the intended one in `order` (the first when none is intended), wrapping round. */
  nextOf(order: readonly string[]): string | null {
    if (!order.length) return null;
    const i = this.intended ? order.indexOf(this.intended) : -1;
    return order[(i + 1) % order.length];
  }

  /** Stop, then hand the fixture over as a JSON file (downloaded where the browser cannot share it). */
  async stop(app: AppState): Promise<RecordedSession | null> {
    if (this.busy) return null;
    this.busy = true;
    this.error = null;
    this.unlisten();
    try {
      const session = await ask(app.kernel, 'session.record.stop');
      const decisions = this.total;
      this.active = false;
      this.interrupted = false;
      const which = this.labels.size === 1 ? [...this.labels][0] : this.labels.size > 1 ? 'mixed' : (session.intended ?? 'any');
      const filename = `spellglass-session-${dateStamp()}-${safeName(which)}.json`;
      const r = await ask(app.kernel, 'share.file', { blob: jsonBlob(JSON.stringify(session, null, 2)), filename, title: 'Spellglass session' });
      this.saved = { filename, decisions, outcome: r.outcome };
      return session;
    } catch (err) {
      this.active = false;
      this.error = errorText(err, 'The recording could not be saved.');
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** A recording the diagnostics module reports that this page did not start (after a reload of this
   *  code, say): show it, and count from now. */
  adopt(app: AppState): void {
    if (this.active || this.busy) return;
    if (!lastPayload(app.kernel, 'diagnostics.stats')?.recording) return;
    this.active = true;
    this.interrupted = false;
    this.listen(app);
  }

  private listen(app: AppState): void {
    this.unlisten();
    const k = app.kernel;
    this.offs = [
      on(k, 'spell.cast', (c) => {
        if (c.replay) return;
        this.total++;
        this.forSpell++;
        const name = c.variant ?? c.incantation ?? app.spellName(c.spellId);
        const ok = !this.intended || c.spellId === this.intended;
        if (ok) this.rightForSpell++;
        this.last = { ok, text: ok ? `${name}, cast` : `${name}, cast instead` };
      }),
      on(k, 'spell.fizzle', (f) => {
        if (f.reason === 'steering' || f.reason === 'ignored') return;
        this.total++;
        this.forSpell++;
        const near = f.nearest ? app.spellName(f.nearest.spellId) : '';
        this.last = { ok: false, text: near ? `Fizzled, close to ${near}` : 'Fizzled' };
      }),
      on(k, 'diagnostics.stats', (s) => {
        // The recording stopped on its own (the tracker stopped or another took over); what was
        // recorded up to then is kept for Stop and save.
        if (!s.recording && this.active && !this.busy && !this.interrupted) this.interrupted = true;
      }),
    ];
  }

  private unlisten(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}

/** A spell id as part of a file name. */
function safeName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

export const recording = new Recording();
