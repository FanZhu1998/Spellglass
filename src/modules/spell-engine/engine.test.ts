import { describe, expect, it } from 'vitest';
import type { EventMap, Incantation, Recognition, Spellbook, SpellbookEntry, Stroke, TrackerStatus } from '../../contracts';
import { PROP_TAGS } from '../../contracts';
import { RECOGNITION_WAIT_MS, SpellEngineCore } from './engine';
import type { EngineEventType, EngineOutput, EngineSettings } from './types';
import { counterIds, detailOf, entryOf, flickStroke, pathStroke, recognitionOf, seedSpell, seedSpellbook, SEED_PACKS, settingsWith } from './test-support';
import { startingProps } from './targets';

function make(over: Partial<EngineSettings> = {}, book: Spellbook = seedSpellbook()) {
  const settings = settingsWith(over);
  const core = new SpellEngineCore({ settings: () => settings, newId: counterIds() });
  core.setSpellbook(book, 0);
  return { core, settings };
}

function of<K extends EngineEventType>(out: readonly EngineOutput[], type: K): EventMap[K][] {
  return out.filter((o) => o.type === type).map((o) => o.payload as EventMap[K]);
}

const types = (out: readonly EngineOutput[]) => out.map((o) => o.type);

/** Feed a stroke and its recognition at the stroke's end time. */
function feed(core: SpellEngineCore, stroke: Stroke, rec: Recognition, now = stroke.t1): EngineOutput[] {
  return [...core.stroke(stroke, now), ...core.recognition(rec, now)];
}

/** A clean flick recognized as `spellId`. */
function flick(core: SpellEngineCore, id: string, spellId: string, dir: 'up' | 'down' | 'left' | 'right', t0: number, over: { length?: number; durationMs?: number; score?: number } = {}) {
  const stroke = flickStroke(id, dir, { t0, durationMs: over.durationMs ?? 300, length: over.length });
  return feed(core, stroke, recognitionOf(id, { [spellId]: over.score ?? 0.93, 'expecto-patronum': 0.2 }, { stage: 'flick' }));
}

/** A path stroke recognized as `spellId` at `score`. */
function traced(core: SpellEngineCore, id: string, spellId: string, t0: number, score = 0.9, details?: ReturnType<typeof detailOf>[]) {
  const stroke = pathStroke(id, spellId, { t0, durationMs: 1500 });
  return feed(core, stroke, recognitionOf(id, { [spellId]: score, 'expecto-patronum': 0.2 }, { details: details ?? [detailOf(spellId, score)] }));
}

function say(core: SpellEngineCore, spellId: string | undefined, t: number, now: number, over: Partial<Incantation> = {}) {
  return core.incantation({ id: `u-${t}`, t, t0: t, t1: t + 500, text: spellId ?? 'hello', spellId, conf: 0.9, final: true, ...over }, now);
}

/** stroke.begin as the segmenter sends it for a pen stroke: at the press, with no points yet. */
function press(core: SpellEngineCore, id: string, t0: number) {
  core.strokeBegin({ id, points: [], t0, t1: t0, quality: 1 });
}

describe('a gesture cast', () => {
  it('fills every SpellCast field it can', () => {
    const { core } = make();
    const stroke = pathStroke('s1', 'alohomora', { t0: 1000, durationMs: 1950, cx: 0.4, cy: 0.5 });
    const detail = detailOf('alohomora', 0.92);
    const out = feed(core, stroke, recognitionOf('s1', { alohomora: 0.92, protego: 0.6 }, { details: [detail] }));
    expect(types(out)).toEqual(['spell.cast']);
    const [cast] = of(out, 'spell.cast');
    const last = stroke.points[stroke.points.length - 1];
    expect(cast).toMatchObject({
      id: 'cast-1', spellId: 'alohomora', t: 2950, via: 'gesture', strokeId: 's1', score: 0.92, effectScale: 1,
      targetId: 'box', incantation: 'Alohomora', detail, aim: { x: last.x, y: last.y },
    });
    expect(cast.quality).toBeGreaterThanOrEqual(0.9);
    expect(cast.power).toBeGreaterThan(0);
    expect(cast).not.toHaveProperty('variant');
    expect(cast).not.toHaveProperty('replay');
    expect(cast).not.toHaveProperty('practice');
  });

  it('joins the stroke and its recognition in either order, and decides once', () => {
    const { core } = make();
    const stroke = flickStroke('s1', 'up', { t0: 1000, durationMs: 300 });
    const rec = recognitionOf('s1', { lumos: 0.95 }, { stage: 'flick' });
    const first = core.recognition(rec, 1300);
    expect(first).toEqual([]);
    const second = core.stroke(stroke, 1301);
    expect(types(second)).toEqual(['spell.cast']);
    // Repeats of either event change nothing.
    expect(core.recognition(rec, 1302)).toEqual([]);
    expect(core.stroke(stroke, 1303)).toEqual([]);
  });

  it('ignores shadow recognitions', () => {
    const { core } = make();
    const stroke = flickStroke('s1', 'up', { t0: 1000, durationMs: 300 });
    expect(core.stroke(stroke, 1300)).toEqual([]);
    expect(core.recognition({ ...recognitionOf('s1', { lumos: 0.95 }), shadow: true }, 1300)).toEqual([]);
    expect(types(core.recognition(recognitionOf('s1', { lumos: 0.95 }, { stage: 'flick' }), 1301))).toEqual(['spell.cast']);
  });

  it('lets a stroke go when no recognition arrives', () => {
    const { core } = make();
    core.stroke(flickStroke('s1', 'up', { t0: 1000, durationMs: 300 }), 1300);
    expect(core.nextWake()).toBe(1300 + RECOGNITION_WAIT_MS);
    expect(core.tick(1300 + RECOGNITION_WAIT_MS - 1)).toEqual([]);
    const out = core.tick(1300 + RECOGNITION_WAIT_MS);
    expect(of(out, 'spell.fizzle')).toMatchObject([{ strokeId: 's1', reason: 'ignored' }]);
    expect(core.recognition(recognitionOf('s1', { lumos: 0.95 }), 3000)).toEqual([]);
  });

  it('fizzles low-score and ambiguous with the nearest spell, a hint, the stray part and the score as quality', () => {
    const { core } = make();
    const detail = detailOf('alohomora', 0.66, { reached: 0.8 });
    const out = traced(core, 's1', 'alohomora', 1000, 0.66, [detail]);
    expect(of(out, 'spell.fizzle')).toEqual([expect.objectContaining({
      strokeId: 's1', reason: 'low-score', nearest: { spellId: 'alohomora', score: 0.66 }, quality: 0.66,
      hint: 'The downstroke stopped short: carry it through the circle.', stray: expect.any(Object),
    })]);
    const amb = feed(core, pathStroke('s2', 'accio', { t0: 5000, durationMs: 1200 }), recognitionOf('s2', { accio: 0.8, protego: 0.78 }));
    expect(of(amb, 'spell.fizzle')[0]).toMatchObject({ reason: 'ambiguous', nearest: { spellId: 'accio', score: 0.8 } });
    expect(of(amb, 'spell.fizzle')[0].hint).toBeTruthy();
  });

  it('fizzles no-candidates when nothing is enabled', () => {
    const { core } = make();
    const out = feed(core, flickStroke('s1', 'up', { t0: 0, durationMs: 300 }), { strokeId: 's1', recognizer: 'r', candidates: [] });
    expect(of(out, 'spell.fizzle')[0]).toMatchObject({ reason: 'no-candidates', quality: 0 });
  });

  it('marks a recorded session played back as a replay', () => {
    const { core } = make();
    const stroke = flickStroke('s1', 'up', { t0: 0, durationMs: 300, src: 'tracker.replay' });
    const [cast] = of(feed(core, stroke, recognitionOf('s1', { lumos: 0.95 }, { stage: 'flick' })), 'spell.cast');
    expect(cast.replay).toBe(true);
  });
});

describe('rules from pack data', () => {
  it('needs_active: Nox without Lumos fizzles with a plain hint naming Lumos', () => {
    const { core } = make();
    const out = flick(core, 's1', 'nox', 'down', 1000);
    expect(of(out, 'spell.fizzle')).toEqual([expect.objectContaining({ reason: 'needs-active', nearest: { spellId: 'nox', score: 0.93 }, hint: 'Cast Lumos first.' })]);
  });

  it('Nox ends Lumos: the cast comes first, then spell.ended with byCastId', () => {
    const { core } = make();
    const [lumos] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
    const out = flick(core, 's2', 'nox', 'down', 3000);
    expect(types(out)).toEqual(['spell.cast', 'spell.ended']);
    const [nox] = of(out, 'spell.cast');
    expect(of(out, 'spell.ended')).toEqual([{ spellId: 'lumos', castId: lumos.id, t: 3300, by: 'nox', byCastId: nox.id }]);
    expect(core.activeSpells()).toEqual([]);
  });

  it("'*' ends every active spell (Finite Incantatem), oldest first", () => {
    const { core } = make();
    const [lumos] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
    const [protego] = of(traced(core, 's2', 'protego', 2000), 'spell.cast');
    const [incendio] = of(traced(core, 's3', 'incendio', 4000), 'spell.cast');
    const out = flick(core, 's4', 'finite-incantatem', 'left', 6000);
    expect(types(out)).toEqual(['spell.cast', 'spell.ended', 'spell.ended', 'spell.ended']);
    expect(of(out, 'spell.ended').map((e) => [e.castId, e.by])).toEqual([
      [lumos.id, 'finite-incantatem'], [protego.id, 'finite-incantatem'], [incendio.id, 'finite-incantatem'],
    ]);
  });

  it('ends and ended_by: Aguamenti puts out Incendio but not Lumos', () => {
    const { core } = make();
    flick(core, 's1', 'lumos', 'up', 1000);
    const [incendio] = of(traced(core, 's2', 'incendio', 2000), 'spell.cast');
    const out = traced(core, 's3', 'aguamenti', 4000);
    expect(of(out, 'spell.ended')).toEqual([expect.objectContaining({ castId: incendio.id, by: 'aguamenti' })]);
    expect(core.activeSpells().map((a) => a.spellId)).toEqual(['lumos']);
  });

  it('ended_by alone ends a spell', () => {
    // A pack whose Nox lists nothing in `ends`: Lumos's ended_by still ends it.
    const book = seedSpellbook({ nox: { spell: { ...seedSpell('nox'), ends: undefined } } });
    const { core } = make({}, book);
    flick(core, 's1', 'lumos', 'up', 1000);
    expect(of(flick(core, 's2', 'nox', 'down', 2000), 'spell.ended')).toMatchObject([{ spellId: 'lumos', by: 'nox' }]);
  });

  it('a spell cast again replaces its earlier activation', () => {
    const { core } = make();
    const [first] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
    const out = flick(core, 's2', 'lumos', 'up', 2000);
    expect(types(out)).toEqual(['spell.cast', 'spell.ended']);
    const [second] = of(out, 'spell.cast');
    expect(of(out, 'spell.ended')).toEqual([{ spellId: 'lumos', castId: first.id, t: 2300, by: 'lumos', byCastId: second.id }]);
    expect(core.activeSpells().map((a) => a.castId)).toEqual([second.id]);
  });

  it('cooldown_ms: Lumos again within 400 ms fizzles; engine reset clears it', () => {
    const { core } = make();
    flick(core, 's1', 'lumos', 'up', 1000); // cast t 1300
    const quick = flick(core, 's2', 'lumos', 'up', 1350, { durationMs: 300 }); // t 1650 - 1300 = 350 < 400
    expect(of(quick, 'spell.fizzle')[0]).toMatchObject({ reason: 'cooldown', nearest: { spellId: 'lumos' } });
    const later = flick(core, 's3', 'lumos', 'up', 1400, { durationMs: 300 }); // 1700 - 1300 = 400
    expect(types(later)).toEqual(['spell.cast', 'spell.ended']);
    const reset = core.reset(1800);
    expect(of(reset, 'spell.ended')).toMatchObject([{ spellId: 'lumos', by: 'reset' }]);
    expect(types(flick(core, 's4', 'lumos', 'up', 1600, { durationMs: 300 }))).toEqual(['spell.cast']);
  });

  it('duration_ms: Protego is active from the bloom for 5 s, then ends by timeout', () => {
    const { core, settings } = make();
    const [protego] = of(traced(core, 's1', 'protego', 1000), 'spell.cast'); // decided at 2500
    const endsAt = 2500 + settings.bloomDelayMs + 5000;
    expect(core.nextWake()).toBe(endsAt);
    expect(core.tick(endsAt - 1)).toEqual([]);
    expect(core.tick(endsAt)).toEqual([{ type: 'spell.ended', payload: { spellId: 'protego', castId: protego.id, t: endsAt, by: 'timeout' } }]);
    expect(core.activeSpells()).toEqual([]);
  });

  it('timed spells count from the cast itself under reduced motion', () => {
    const { core } = make({ bloomDelayMs: 0 });
    traced(core, 's1', 'protego', 1000);
    expect(core.nextWake()).toBe(2500 + 5000);
  });

  it('ends active spells whose pack becomes unavailable', () => {
    const { core } = make();
    const [lumos] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
    const out = core.setSpellbook(seedSpellbook({ lumos: { available: false, enabled: false } }, 2), 5000);
    expect(out).toEqual([{ type: 'spell.ended', payload: { spellId: 'lumos', castId: lumos.id, t: 5000, by: 'unavailable' } }]);
  });

  it('stop ends active spells and answers strokes in flight', () => {
    const { core } = make({ mode: 'assisted' });
    core.setVoiceStatus({ state: 'listening', local: true });
    flick(core, 's1', 'lumos', 'up', 1000);
    traced(core, 's2', 'alohomora', 2000, 0.65); // waits for speech
    const out = core.stop(3600);
    expect(of(out, 'spell.fizzle')).toMatchObject([{ strokeId: 's2', reason: 'ignored' }]);
    expect(of(out, 'spell.ended')).toMatchObject([{ spellId: 'lumos', by: 'stopped' }]);
  });
});

describe('targets and variants', () => {
  it('aims at the prop nearest the end of the stroke among the spell’s targets', () => {
    const { core } = make();
    core.setProps(startingProps(16 / 9));
    // Accio acts on movable props: this C ends at the lower right, near the plant.
    const stroke = pathStroke('s1', 'accio', { t0: 0, durationMs: 1200, cx: 0.7, cy: 0.6, size: 0.3 });
    const [cast] = of(feed(core, stroke, recognitionOf('s1', { accio: 0.9 })), 'spell.cast');
    expect(cast.targetId).toBe('plant');
  });

  it('casts without a target when no prop carries the tag', () => {
    const { core } = make();
    const scene = startingProps();
    for (const p of scene.props) p.tags = p.tags.filter((t) => t !== PROP_TAGS.lockable);
    core.setProps(scene);
    const [cast] = of(traced(core, 's1', 'alohomora', 0), 'spell.cast');
    expect(cast).not.toHaveProperty('targetId');
  });

  it('a large, quick Lumos becomes Lumos Maxima', () => {
    const { core } = make();
    const [big] = of(flick(core, 's1', 'lumos', 'up', 1000, { length: 0.85, durationMs: 220 }), 'spell.cast');
    expect(big.power).toBeGreaterThanOrEqual(0.8);
    expect(big).toMatchObject({ variant: 'Lumos Maxima', effectScale: 1.6 });
    const [plain] = of(flick(core, 's2', 'lumos', 'up', 3000, { length: 0.3 }), 'spell.cast');
    expect(plain.variant).toBeUndefined();
    expect(plain.effectScale).toBe(1);
  });
});

describe('the play area', () => {
  // A play area from Wand tuning: the middle of the mirror.
  const playArea = { x: 0.3, y: 0.15, w: 0.4, h: 0.6 };
  const status = (tracker: string, pen: boolean) => ({ tracker, state: 'tracking' as const, lock: 1, fps: 60, aspect: 16 / 9, pen });
  const lumos = (id: string) => recognitionOf(id, { lumos: 0.93, 'expecto-patronum': 0.2 }, { stage: 'flick' });

  it('measures pen strokes against the whole mirror, and camera strokes against the play area', () => {
    const { core } = make({ playArea });
    core.setTrackerStatus(status('tracker.pointer', true));
    core.setTrackerStatus(status('tracker.bright-tip', false));
    // The same quick flick, 0.4 of the mirror tall in 200 ms.
    const shape = { durationMs: 200, length: 0.4 };
    const [pen] = of(feed(core, flickStroke('s1', 'up', { t0: 1000, ...shape, src: 'tracker.pointer' }), lumos('s1')), 'spell.cast');
    const [camera] = of(feed(core, flickStroke('s2', 'up', { t0: 3000, ...shape, src: 'tracker.bright-tip' }), lumos('s2')), 'spell.cast');
    expect(pen.power).toBeCloseTo(0.52, 2); // 0.6 × (0.4 - 0.15) / (0.75 - 0.15) + 0.4 × (2 / s) / 3
    expect(pen.variant).toBeUndefined();
    expect(camera.power).toBeGreaterThan(0.9);
    expect(camera.variant).toBe('Lumos Maxima');
  });

  it('gives pen strokes the size hints of the whole mirror', () => {
    const { core } = make({ playArea });
    core.setTrackerStatus(status('tracker.pointer', true));
    core.setFocus('lumos');
    // 0.17 of the mirror: evaluated (segmenter.minExtent 0.15) but small; against the play area it would be 0.28.
    const out = feed(core, flickStroke('s1', 'up', { t0: 1000, durationMs: 300, length: 0.17, src: 'tracker.pointer' }), lumos('s1'));
    expect(of(out, 'practice.attempt')).toMatchObject([{ success: true, hint: 'Make the flick longer.' }]);
  });

  it('keeps the pen flag a stroke arrived with while it waits for speech', () => {
    const { core } = make({ playArea, mode: 'strict' });
    core.setVoiceStatus({ state: 'listening', local: true });
    core.setTrackerStatus(status('tracker.replay', true));
    const stroke = flickStroke('s1', 'up', { t0: 1000, durationMs: 200, length: 0.4, src: 'tracker.replay' });
    expect(types(feed(core, stroke, lumos('s1')))).toEqual(['spell.pending']);
    // The recorded session has played: the replay tracker is back to pen false before the decision.
    core.setTrackerStatus(status('tracker.replay', false));
    const [cast] = of(core.incantation({ id: 'u1', t: 1100, t0: 1100, t1: 1500, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true }, 1700), 'spell.cast');
    expect(cast).toMatchObject({ spellId: 'lumos', via: 'both', replay: true });
    expect(cast.power).toBeCloseTo(0.52, 2);
  });
});

describe('modes (Section 7.7)', () => {
  const listening = { state: 'listening' as const, local: true };

  describe('gesture', () => {
    it('marks the cast both when an agreeing incantation was heard in the window', () => {
      const { core } = make();
      core.setVoiceStatus(listening);
      say(core, 'lumos', 0, 700); // 1 s before t0 = 1000 (inside 2.5 s)
      const [cast] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
      expect(cast.via).toBe('both');
      // The incantation served that decision: the next Lumos does not get it.
      const [again] = of(flick(core, 's2', 'lumos', 'up', 2000), 'spell.cast');
      expect(again.via).toBe('gesture');
    });

    it('counts speech that overlaps the window by its edge, and not a millisecond less', () => {
      const { core } = make();
      core.setVoiceStatus(listening);
      // Stroke t0 5000: the window opens at 2500. Speech 2000..2500 touches it; 1999..2499 does not.
      core.incantation({ id: 'in', t: 2000, t0: 2000, t1: 2500, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true }, 2600);
      expect(of(flick(core, 's1', 'lumos', 'up', 5000), 'spell.cast')[0].via).toBe('both');
      const late = make();
      late.core.setVoiceStatus(listening);
      late.core.incantation({ id: 'out', t: 1999, t0: 1999, t1: 2499, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true }, 2600);
      expect(of(flick(late.core, 's1', 'lumos', 'up', 5000), 'spell.cast')[0].via).toBe('gesture');
    });

    it('ignores incantations said too long before the stroke', () => {
      const { core } = make();
      core.setVoiceStatus(listening);
      say(core, 'lumos', 0, 600); // speech 0..500, window starts at 4000 - 2500 = 1500
      const [cast] = of(flick(core, 's1', 'lumos', 'up', 4000), 'spell.cast');
      expect(cast.via).toBe('gesture');
    });

    it('never casts on voice alone', () => {
      const { core } = make();
      core.setVoiceStatus(listening);
      expect(say(core, 'lumos', 0, 600)).toEqual([]);
    });
  });

  describe('assisted', () => {
    it('accepts the heard spell at the assisted score: incantation before the stroke', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      say(core, 'alohomora', 500, 1200);
      const out = traced(core, 's1', 'alohomora', 1000, 0.64); // t1 2500
      expect(of(out, 'spell.cast')).toMatchObject([{ spellId: 'alohomora', via: 'both', score: 0.64, t: 2500 }]);
    });

    it('waits up to voiceAfterMs for an incantation, publishing spell.pending', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      const out = traced(core, 's1', 'alohomora', 1000, 0.64); // t1 2500
      expect(out).toEqual([{ type: 'spell.pending', payload: { strokeId: 's1', until: 3500, waitingFor: 'voice' } }]);
      // Spoken 500 ms after the stroke ended: cast, timed at the incantation (it decided).
      const cast = say(core, 'alohomora', 3000, 3400);
      expect(of(cast, 'spell.cast')).toMatchObject([{ spellId: 'alohomora', via: 'both', strokeId: 's1', t: 3000 }]);
      expect(core.tick(4000)).toEqual([]);
    });

    it('decides on the gesture alone at the deadline; a late incantation changes nothing', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      traced(core, 's1', 'alohomora', 1000, 0.64);
      expect(core.nextWake()).toBe(3500);
      expect(core.tick(3499)).toEqual([]);
      const out = core.tick(3500);
      expect(of(out, 'spell.fizzle')).toMatchObject([{ strokeId: 's1', reason: 'low-score', nearest: { spellId: 'alohomora' } }]);
      // The final result arrives after the deadline, though the speech was in the window.
      expect(say(core, 'alohomora', 3200, 3600)).toEqual([]);
    });

    it('casts at once when the gesture passes and nobody is speaking', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      expect(types(flick(core, 's1', 'lumos', 'up', 1000))).toEqual(['spell.cast']);
    });

    it('holds a passing gesture while an utterance is under way, with the latency allowance', () => {
      const { core, settings } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      core.incantation({ id: 'u1', t: 1100, text: 'no', conf: 0.5, final: false }, 1200);
      const out = flick(core, 's1', 'lumos', 'up', 1000); // t1 1300
      const until = 1300 + settings.voiceAfterMs + settings.voiceLatencyMs;
      expect(out).toEqual([{ type: 'spell.pending', payload: { strokeId: 's1', until, waitingFor: 'voice' } }]);
      // The utterance turns out to be Nox: the voice picks the spell; Nox scores under 0.60 here.
      const said = core.incantation({ id: 'u1', t: 1100, t0: 1100, t1: 1700, text: 'nox', spellId: 'nox', conf: 0.9, final: true }, 2200);
      expect(of(said, 'spell.fizzle')).toMatchObject([{ reason: 'low-score', nearest: { spellId: 'nox' } }]);
    });

    it('extends the wait once when speech starts during it', () => {
      const { core, settings } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      traced(core, 's1', 'alohomora', 1000, 0.64); // until 3500
      const out = core.incantation({ id: 'u1', t: 3000, text: 'alo', conf: 0.4, final: false }, 3100);
      expect(out).toEqual([{ type: 'spell.pending', payload: { strokeId: 's1', until: 3500 + settings.voiceLatencyMs, waitingFor: 'voice' } }]);
      expect(core.incantation({ id: 'u1', t: 3000, text: 'alo', conf: 0.4, final: false }, 3200)).toEqual([]);
      expect(core.tick(3600)).toEqual([]);
      expect(of(say(core, 'alohomora', 3000, 4100, { id: 'u1' }), 'spell.cast')).toMatchObject([{ spellId: 'alohomora', via: 'both' }]);
    });

    it('a final that names no spell lets a passing gesture cast', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      core.incantation({ id: 'u1', t: 1100, text: 'um', conf: 0.5, final: false }, 1200);
      expect(types(flick(core, 's1', 'lumos', 'up', 1000))).toEqual(['spell.pending']);
      const out = core.incantation({ id: 'u1', t: 1100, text: 'um', conf: 0.5, final: true }, 1500);
      expect(of(out, 'spell.cast')).toMatchObject([{ spellId: 'lumos', via: 'gesture' }]);
    });

    it('a locked spell heard in the window fizzles unavailable, leaving the wording to the shell', () => {
      const { core } = make({ mode: 'assisted' }, seedSpellbook({ reparo: { status: 'locked', enabled: false } }));
      core.setVoiceStatus(listening);
      say(core, 'reparo', 900, 1000);
      const [fizzle] = of(traced(core, 's1', 'alohomora', 1000, 0.95), 'spell.fizzle');
      expect(fizzle).toMatchObject({ reason: 'unavailable', nearest: { spellId: 'reparo', score: 0 } });
      expect(fizzle).not.toHaveProperty('hint');
    });

    it('plays by gesture rules while voice is not ready', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus({ state: 'unavailable', local: true });
      expect(of(traced(core, 's1', 'alohomora', 1000, 0.64), 'spell.fizzle')).toMatchObject([{ reason: 'low-score' }]);
    });

    it('a final that lands after its stroke was cast stays with that stroke, not the next one', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      // "Lumos" said while flicking: the gesture passes and nobody is heard speaking yet, so it casts at once.
      expect(of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast')).toMatchObject([{ spellId: 'lumos', via: 'gesture' }]);
      expect(say(core, 'lumos', 1100, 2000)).toEqual([]); // speech 1100..1600, inside the next stroke's window too
      // A clean Nox flick with nothing said casts Nox, instead of fizzling on the stale Lumos.
      expect(of(flick(core, 's2', 'nox', 'down', 2600), 'spell.cast')).toMatchObject([{ spellId: 'nox', via: 'gesture' }]);
    });

    it('so does one begun just after the stroke that names its spell', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'lumos', 'up', 1000); // cast at once at 1300
      expect(say(core, 'lumos', 1400, 2300)).toEqual([]); // flick, then the word: speech 1400..1900
      expect(of(flick(core, 's2', 'nox', 'down', 2600), 'spell.cast')).toMatchObject([{ spellId: 'nox' }]);
    });

    it('speech begun during a stroke never decides the next one, whatever it names', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'lumos', 'up', 1000);
      expect(say(core, 'nox', 1200, 2000)).toEqual([]); // heard as Nox, begun while flicking
      expect(of(traced(core, 's2', 'protego', 2500), 'spell.cast')).toMatchObject([{ spellId: 'protego', via: 'gesture' }]);
    });

    it('an incantation begun after a stroke that names another spell still serves the next stroke', () => {
      const { core } = make({ mode: 'assisted' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'lumos', 'up', 1000);
      // Spoken inside the first stroke's window too (it ends at 2300), but after the stroke itself.
      expect(say(core, 'alohomora', 1500, 2400)).toEqual([]);
      const out = traced(core, 's2', 'alohomora', 2500, 0.64); // too weak to pass alone
      expect(of(out, 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'alohomora', via: 'both', score: 0.64 }]);
    });

    it('a word said once the next stroke has begun is that stroke’s, even when it names the spell just cast', () => {
      // The next flick is traced at once (1700..2600, the word at 1750), or pressed at 1500 and moved
      // at 2100 after a rest (the word at 1600, during the rest). Either final lands before it ends.
      const retries = [
        { press: 1700, t0: 1700, durationMs: 900, speech: 1750, finalAt: 2300 },
        { press: 1500, t0: 2100, durationMs: 300, speech: 1600, finalAt: 2250 },
      ];
      for (const r of retries) {
        const { core } = make({ mode: 'assisted' });
        core.setVoiceStatus(listening);
        // A Lumos flick casts at once: nothing is heard yet.
        expect(of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast')).toMatchObject([{ spellId: 'lumos', via: 'gesture' }]);
        press(core, 's2', r.press);
        expect(say(core, 'lumos', r.speech, r.finalAt, { t1: r.speech + 400 })).toEqual([]);
        // 35° off vertical, ambiguous on its own: the incantation decides it.
        const stroke = flickStroke('s2', 'up', { t0: r.t0, durationMs: r.durationMs });
        const out = feed(core, stroke, recognitionOf('s2', { lumos: 0.84, expelliarmus: 0.82 }));
        expect(of(out, 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'lumos', via: 'both' }]);
      }
    });
  });

  describe('strict', () => {
    it('casts when stroke and incantation agree', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      say(core, 'lumos', 900, 1000);
      expect(of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast')).toMatchObject([{ via: 'both' }]);
    });

    it('waits for the incantation, then fizzles strict-mismatch', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      expect(types(flick(core, 's1', 'lumos', 'up', 1000))).toEqual(['spell.pending']);
      const out = core.tick(2300);
      expect(of(out, 'spell.fizzle')).toMatchObject([{ reason: 'strict-mismatch', nearest: { spellId: 'lumos' }, hint: 'Say the incantation as you trace.' }]);
    });

    it('a late agreeing incantation inside the wait casts', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'lumos', 'up', 1000);
      expect(of(say(core, 'lumos', 1600, 2100), 'spell.cast')).toMatchObject([{ spellId: 'lumos', via: 'both', t: 1600 }]);
    });

    it('a disagreeing incantation fizzles strict-mismatch at once', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'lumos', 'up', 1000);
      expect(of(say(core, 'nox', 1500, 1900), 'spell.fizzle')).toMatchObject([{
        reason: 'strict-mismatch', hint: 'The incantation and the gesture named different spells.',
      }]);
    });

    it('a final that lands after its stroke fizzled does not count against the next stroke', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'stupefy', 'right', 1000); // waits for speech until 2300
      expect(of(core.tick(2300), 'spell.fizzle')).toMatchObject([{ strokeId: 's1', reason: 'strict-mismatch', hint: 'Say the incantation as you trace.' }]);
      expect(say(core, 'stupefy', 1200, 2600)).toEqual([]); // its final, too late: speech 1200..1700
      // The next stroke waits for its own incantation instead of fizzling at once on Stupefy.
      expect(types(flick(core, 's2', 'lumos', 'up', 3000))).toEqual(['spell.pending']);
      expect(of(say(core, 'lumos', 3100, 3600), 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'lumos', via: 'both' }]);
    });

    it('nor does one begun just after the stroke that names its spell', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'stupefy', 'right', 1000);
      core.tick(2300); // none heard
      expect(say(core, 'stupefy', 1800, 2900)).toEqual([]); // speech 1800..2300
      expect(types(flick(core, 's2', 'lumos', 'up', 3000))).toEqual(['spell.pending']);
    });

    it('an incantation begun after a stroke still serves the next stroke it names', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      flick(core, 's1', 'stupefy', 'right', 1000);
      core.tick(2300); // none heard
      // "Lumos", for the next stroke, begins inside the first stroke's window; its final lands later.
      expect(say(core, 'lumos', 2000, 2900)).toEqual([]); // speech 2000..2500
      expect(of(flick(core, 's2', 'lumos', 'up', 3000), 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'lumos', via: 'both' }]);
    });

    /** "Nox" said while flicking Lumos: strict mode fizzles at once on the disagreeing word. */
    function fizzleOnNox(core: SpellEngineCore) {
      say(core, 'nox', 1050, 1290, { t1: 1250 });
      expect(of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.fizzle')).toMatchObject([{
        reason: 'strict-mismatch', hint: 'The incantation and the gesture named different spells.',
      }]);
    }

    it('the retry after a disagreeing incantation keeps the word said while its button is down', () => {
      // Traced at once (1700..2600), or pressed at 1600 and moved at 2400; "Lumos" is said from 100 ms
      // after the press, and its final lands at 2300, before the retry ends.
      for (const r of [{ press: 1700, t0: 1700, durationMs: 900 }, { press: 1600, t0: 2400, durationMs: 300 }]) {
        const { core } = make({ mode: 'strict' });
        core.setVoiceStatus(listening);
        fizzleOnNox(core);
        press(core, 's2', r.press);
        expect(say(core, 'lumos', r.press + 100, 2300, { t1: r.press + 500 })).toEqual([]);
        const out = flick(core, 's2', 'lumos', 'up', r.t0, { durationMs: r.durationMs });
        expect(of(out, 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'lumos', via: 'both' }]);
      }
    });

    it('so does a retry whose word was said before its press: the fizzled stroke has had its word', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      fizzleOnNox(core);
      // "Lumos" first (1500..1900), then the press at 2000; the final lands while the retry is traced.
      press(core, 's2', 2000);
      expect(say(core, 'lumos', 1500, 2300, { t1: 1900 })).toEqual([]);
      expect(of(flick(core, 's2', 'lumos', 'up', 2000, { durationMs: 600 }), 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'lumos', via: 'both' }]);
    });

    it('once a stroke has had its word, the next one’s word timed a little early still serves it', () => {
      const { core } = make({ mode: 'strict' });
      core.setVoiceStatus(listening);
      say(core, 'lumos', 600, 1200); // speech 600..1100
      expect(of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast')).toMatchObject([{ via: 'both' }]);
      // Pressed again at once and "Nox" said straight away; speech starts are estimates (voice/heard.ts),
      // and this one is put at 1200, before the first stroke ended at 1300.
      expect(types(flick(core, 's2', 'nox', 'down', 1350))).toEqual(['spell.pending']);
      expect(of(say(core, 'nox', 1200, 2300, { t1: 1700 }), 'spell.cast')).toMatchObject([{ strokeId: 's2', spellId: 'nox', via: 'both' }]);
    });
  });

  describe('voice only', () => {
    it('casts from the incantation alone, aimed at a fresh tip', () => {
      const { core } = make({ mode: 'voice' });
      core.setVoiceStatus(listening);
      core.noteTip({ t: 900, x: 0.3, y: 0.4, conf: 1, src: 'tracker.hand' });
      const out = say(core, 'alohomora', 1000, 1500);
      expect(of(out, 'spell.cast')).toEqual([expect.objectContaining({
        spellId: 'alohomora', via: 'voice', t: 1000, aim: { x: 0.3, y: 0.4 }, targetId: 'box', incantation: 'Alohomora', quality: 0.9,
      })]);
      expect(of(out, 'spell.cast')[0]).not.toHaveProperty('strokeId');
      expect(of(out, 'spell.cast')[0]).not.toHaveProperty('score');
    });

    it('aims at the centre of the play area when the tip is stale', () => {
      const { core } = make({ mode: 'voice', playArea: { x: 0.2, y: 0.1, w: 0.6, h: 0.6 } });
      core.setVoiceStatus(listening);
      core.noteTip({ t: 100, x: 0.3, y: 0.4, conf: 1, src: 'tracker.hand' });
      const [cast] = of(say(core, 'lumos', 2000, 2500), 'spell.cast');
      expect(cast.aim.x).toBeCloseTo(0.5, 6);
      expect(cast.aim.y).toBeCloseTo(0.4, 6);
    });

    it('aims at the centre of the whole mirror for the mouse, whatever the play area', () => {
      const playArea = { x: 0.2, y: 0.1, w: 0.6, h: 0.6 };
      // A stale tip from the pointer: the pointer plays in the whole mirror (contracts/settings.ts).
      const a = make({ mode: 'voice', playArea }).core;
      a.setVoiceStatus(listening);
      a.setTrackerStatus({ tracker: 'tracker.pointer', state: 'tracking', lock: 1, fps: 60, pen: true } as TrackerStatus);
      a.noteTip({ t: 100, x: 0.3, y: 0.4, conf: 1, src: 'tracker.pointer' });
      const [cast] = of(say(a, 'lumos', 2000, 2500), 'spell.cast');
      expect(cast.aim).toEqual({ x: 0.5, y: 0.5 });
      // No tip yet: the tracker that is running decides.
      const b = make({ mode: 'voice', playArea }).core;
      b.setVoiceStatus(listening);
      b.setTrackerStatus({ tracker: 'tracker.pointer', state: 'searching', lock: 0, fps: 0, pen: true } as TrackerStatus);
      const [cast2] = of(say(b, 'lumos', 2000, 2500), 'spell.cast');
      expect(cast2.aim).toEqual({ x: 0.5, y: 0.5 });
    });

    it('applies the rules to voice casts, and serves each incantation once', () => {
      const { core } = make({ mode: 'voice' });
      core.setVoiceStatus(listening);
      expect(of(say(core, 'nox', 1000, 1500), 'spell.fizzle')).toMatchObject([{ reason: 'needs-active', hint: 'Cast Lumos first.' }]);
      expect(types(say(core, 'lumos', 2000, 2500))).toEqual(['spell.cast']);
      expect(say(core, 'lumos', 2000, 2600)).toEqual([]); // the same id again
    });

    it('fizzles unavailable for a locked spell', () => {
      const { core } = make({ mode: 'voice' }, seedSpellbook({ crucio: { status: 'locked', enabled: false } }));
      core.setVoiceStatus(listening);
      expect(of(say(core, 'crucio', 1000, 1500), 'spell.fizzle')).toMatchObject([{ reason: 'unavailable', nearest: { spellId: 'crucio' } }]);
    });

    it('answers any stroke with ignored', () => {
      const { core } = make({ mode: 'voice' });
      core.setVoiceStatus(listening);
      const out = core.stroke(flickStroke('s1', 'up', { t0: 1000, durationMs: 300 }), 1300);
      expect(of(out, 'spell.fizzle')).toMatchObject([{ strokeId: 's1', reason: 'ignored' }]);
      expect(core.recognition(recognitionOf('s1', { lumos: 0.95 }), 1300)).toEqual([]);
    });

    it('falls back to gesture rules when voice is off', () => {
      const { core } = make({ mode: 'voice' });
      core.setVoiceStatus({ state: 'off', local: true });
      expect(types(flick(core, 's1', 'lumos', 'up', 1000))).toEqual(['spell.cast']);
      expect(say(core, 'lumos', 2000, 2500)).toEqual([]);
    });
  });
});

describe('replays and steering', () => {
  it('ignores live strokes and speech while a replay plays', () => {
    const { core } = make({ mode: 'voice' });
    core.setVoiceStatus({ state: 'listening', local: true });
    core.setReplayState({ playing: true, castId: 'x' }, 0);
    expect(say(core, 'lumos', 1000, 1500)).toEqual([]);
    expect(of(core.stroke(flickStroke('s1', 'up', { t0: 1000, durationMs: 300 }), 1300), 'spell.fizzle')).toMatchObject([{ reason: 'ignored' }]);
  });

  it('while steering, a passing stroke still casts and anything else fizzles steering with no hint', () => {
    const { core } = make();
    core.setFocus('alohomora');
    core.setSteering({ castId: 'lev-1', spellId: 'wingardium-leviosa' });
    const miss = traced(core, 's1', 'alohomora', 1000, 0.5, [detailOf('alohomora', 0.5, { reached: 0.7 })]);
    expect(types(miss)).toEqual(['spell.fizzle']); // no practice attempt for steering
    expect(of(miss, 'spell.fizzle')[0]).toMatchObject({ reason: 'steering' });
    expect(of(miss, 'spell.fizzle')[0]).not.toHaveProperty('hint');
    expect(of(flick(core, 's2', 'finite-incantatem', 'left', 4000), 'spell.cast')).toHaveLength(1);
    // A blocked cast while steering is a steering fizzle too.
    expect(of(flick(core, 's3', 'nox', 'down', 6000), 'spell.fizzle')[0]).toMatchObject({ reason: 'steering' });
  });

  it('engine.cast: a replay with variants, targeting and lasts; until-ended spells end after the hold', () => {
    const { core, settings } = make();
    const { cast, out } = core.cast({ spellId: 'lumos', via: 'gesture', quality: 0.9, power: 0.7, variant: true, replay: true, holdMs: 3000 }, 1000);
    expect(cast).toMatchObject({ spellId: 'lumos', replay: true, variant: 'Lumos Maxima', effectScale: 1.6, t: 1000, aim: { x: 0.5, y: 0.5 } });
    expect(types(out)).toEqual(['spell.cast']);
    const endsAt = 1000 + settings.bloomDelayMs + 3000;
    expect(core.nextWake()).toBe(endsAt);
    expect(of(core.tick(endsAt), 'spell.ended')).toEqual([{ spellId: 'lumos', castId: cast.id, t: endsAt, by: 'replay' }]);
    // A replay sets no cooldown for live play.
    const replayAgain = core.cast({ spellId: 'stupefy', via: 'gesture', quality: 0.9, power: 0.3, replay: true }, 6000);
    expect(replayAgain.cast).toMatchObject({ targetId: 'dummy' });
    expect(types(flick(core, 's1', 'stupefy', 'right', 6000, { durationMs: 100 }))).toEqual(['spell.cast']);
  });

  it('engine.cast: the default hold, variant false, and an end when the stage replay stops', () => {
    const { core } = make();
    const { cast } = core.cast({ spellId: 'lumos', via: 'gesture', quality: 0.9, power: 0.95, variant: false, replay: true }, 1000);
    expect(cast.variant).toBeUndefined();
    expect(core.nextWake()).toBe(1000 + 250 + 4000);
    core.setReplayState({ playing: true, castId: cast.id }, 1000);
    expect(core.setReplayState({ playing: false }, 2000)).toEqual([{ type: 'spell.ended', payload: { spellId: 'lumos', castId: cast.id, t: 2000, by: 'replay' } }]);
  });

  it('engine.cast hits the prop the replay names, and ends what the spell ends', () => {
    const { core } = make();
    const [lumos] = of(flick(core, 's1', 'lumos', 'up', 1000), 'spell.cast');
    const { cast, out } = core.cast({ spellId: 'nox', via: 'both', quality: 0.8, power: 0.4, targetId: 'teacup', aim: { x: 0.2, y: 0.3 }, replay: true }, 2000);
    expect(cast).toMatchObject({ targetId: 'teacup', aim: { x: 0.2, y: 0.3 }, via: 'both' });
    expect(of(out, 'spell.ended')).toEqual([{ spellId: 'lumos', castId: lumos.id, t: 2000, by: 'nox', byCastId: cast.id }]);
  });

  it('engine.cast refuses unknown and unavailable spells', () => {
    const { core } = make({}, seedSpellbook({ crucio: { available: false, enabled: false } }));
    expect(() => core.cast({ spellId: 'nope', via: 'gesture', quality: 1, power: 1, replay: true }, 0)).toThrow(/No spell/);
    expect(() => core.cast({ spellId: 'crucio', via: 'gesture', quality: 1, power: 1, replay: true }, 0)).toThrow(/not available/);
  });
});

describe('practice (Section 10.3)', () => {
  it('grades every stroke against the practised spell, counting attempts per session', () => {
    const { core } = make();
    core.setFocus('alohomora');
    const first = traced(core, 's1', 'alohomora', 1000, 0.66, [detailOf('alohomora', 0.66, { reached: 0.8 })]);
    expect(types(first)).toEqual(['spell.fizzle', 'practice.attempt']);
    expect(of(first, 'spell.fizzle')[0].practice).toBe(true);
    expect(of(first, 'practice.attempt')[0]).toEqual(expect.objectContaining({
      spellId: 'alohomora', attempt: 1, success: false, score: 0.66, quality: 0.66, strokeId: 's1',
      hint: 'The downstroke stopped short: carry it through the circle.',
    }));
    const second = traced(core, 's2', 'alohomora', 4000, 0.93);
    expect(of(second, 'spell.cast')[0].practice).toBe(true);
    const attempt = of(second, 'practice.attempt')[0];
    expect(attempt).toMatchObject({ attempt: 2, success: true, castSpellId: 'alohomora', score: 0.93 });
    expect(attempt.quality).toBe(of(second, 'spell.cast')[0].quality);
    expect(attempt.hint).toBeUndefined(); // clean: nothing to improve
    core.setFocus('alohomora');
    expect(of(traced(core, 's3', 'alohomora', 7000, 0.93), 'practice.attempt')[0].attempt).toBe(1);
  });

  it('when another spell is cast instead, says what to change to draw the practised one', () => {
    const { core } = make();
    core.setFocus('lumos');
    const stroke = flickStroke('s1', 'down', { t0: 1000, durationMs: 300 });
    const rec = recognitionOf('s1', { stupefy: 0.9, lumos: 0.2 }, { stage: 'flick', details: [detailOf('stupefy', 0.9), detailOf('lumos', 0.2)] });
    const out = feed(core, stroke, rec);
    expect(of(out, 'spell.cast')[0].spellId).toBe('stupefy');
    expect(of(out, 'practice.attempt')[0]).toMatchObject({ spellId: 'lumos', success: false, castSpellId: 'stupefy', score: 0.2, hint: 'Flick straight up.' });
  });

  it('a correct gesture stopped by a rule is a success with blockedBy', () => {
    const { core } = make();
    core.setFocus('nox');
    const out = flick(core, 's1', 'nox', 'down', 1000);
    expect(types(out)).toEqual(['spell.fizzle', 'practice.attempt']);
    expect(of(out, 'practice.attempt')[0]).toMatchObject({ success: true, blockedBy: 'needs-active', hint: 'Cast Lumos first.' });
    expect(of(out, 'practice.attempt')[0]).not.toHaveProperty('castSpellId');
  });

  it('a strict-mode gesture that passed but was not spoken is a success blocked by strict-mismatch', () => {
    const { core } = make({ mode: 'strict' });
    core.setVoiceStatus({ state: 'listening', local: true });
    core.setFocus('lumos');
    flick(core, 's1', 'lumos', 'up', 1000);
    const out = core.tick(2300);
    expect(of(out, 'practice.attempt')[0]).toMatchObject({ success: true, blockedBy: 'strict-mismatch', hint: 'Say the incantation as you trace.' });
  });

  it('suggests an improvement for an accepted cast that could be better', () => {
    const { core } = make();
    core.setFocus('alohomora');
    const deviation = Array.from({ length: 64 }, (_, i) => (i >= 50 && i <= 61 ? 0.2 : 0.04));
    const out = traced(core, 's1', 'alohomora', 1000, 0.84, [detailOf('alohomora', 0.84, { deviation })]);
    expect(of(out, 'practice.attempt')[0]).toMatchObject({ success: true, hint: 'The downstroke wandered: keep it closer to the guide.' });
    expect(of(out, 'practice.attempt')[0].stray).toBeDefined();
  });

  it('replayed strokes are never practice', () => {
    const { core } = make();
    core.setFocus('lumos');
    const stroke = flickStroke('s1', 'up', { t0: 0, durationMs: 300, src: 'tracker.replay' });
    const out = feed(core, stroke, recognitionOf('s1', { lumos: 0.95 }, { stage: 'flick' }));
    expect(types(out)).toEqual(['spell.cast']);
    expect(of(out, 'spell.cast')[0].practice).toBeUndefined();
  });
});

describe('one decision per stroke', () => {
  it('every stroke gets exactly one cast or fizzle, whatever the mode and timing', () => {
    const { core } = make({ mode: 'assisted' });
    core.setVoiceStatus({ state: 'listening', local: true });
    const decided = new Map<string, number>();
    const count = (out: EngineOutput[]) => {
      for (const o of out) {
        if (o.type === 'spell.cast' || o.type === 'spell.fizzle') {
          const id = o.payload.strokeId;
          if (id) decided.set(id, (decided.get(id) ?? 0) + 1);
        }
      }
    };
    let t = 1000;
    const spells: [string, 'up' | 'down' | 'left' | 'right' | null, number][] = [
      ['lumos', 'up', 0.95], ['alohomora', null, 0.65], ['nox', 'down', 0.9], ['protego', null, 0.5], ['lumos', 'up', 0.95],
      ['finite-incantatem', 'left', 0.9], ['accio', null, 0.75],
    ];
    spells.forEach(([spellId, dir, score], i) => {
      const id = `s${i}`;
      const stroke = dir ? flickStroke(id, dir, { t0: t, durationMs: 300 }) : pathStroke(id, spellId, { t0: t, durationMs: 1200 });
      count(core.stroke(stroke, stroke.t1));
      count(core.recognition(recognitionOf(id, { [spellId]: score, 'expecto-patronum': 0.3 }, { stage: dir ? 'flick' : 'template' }), stroke.t1));
      count(core.recognition(recognitionOf(id, { [spellId]: score }), stroke.t1 + 1)); // a duplicate
      if (i === 1) count(say(core, 'alohomora', stroke.t1 + 200, stroke.t1 + 600));
      t = stroke.t1 + 100;
      count(core.tick(t));
      t += 2000;
      count(core.tick(t));
    });
    expect([...decided.keys()].sort()).toEqual(spells.map((_, i) => `s${i}`).sort());
    for (const n of decided.values()) expect(n).toBe(1);
  });
});

describe('spellbook entries', () => {
  it('only casts spells the spellbook enables', () => {
    const book = seedSpellbook({ lumos: { status: 'locked', enabled: false } });
    const { core } = make({}, book);
    const out = feed(core, flickStroke('s1', 'up', { t0: 0, durationMs: 300 }), recognitionOf('s1', { lumos: 0.95, nox: 0.4 }, { stage: 'flick' }));
    expect(of(out, 'spell.fizzle')[0]).toMatchObject({ reason: 'low-score', nearest: { spellId: 'nox' } });
  });

  it('builds entries the way the pack service does', () => {
    const lumos = seedSpellbook().spells.find((e: SpellbookEntry) => e.spell.id === 'lumos')!;
    expect(lumos.lasts).toBe('until-ended');
    expect(entryOf(seedSpell('protego'), SEED_PACKS[0]).lasts).toBe(5000);
    expect(entryOf(seedSpell('stupefy'), SEED_PACKS[0]).lasts).toBeNull();
  });
});
