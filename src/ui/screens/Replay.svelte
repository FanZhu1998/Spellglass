<script lang="ts">
  // Replay: a link opened with #cast=... (Section 11.1: "Opening the link replays the trace and the
  // effect on a plain backdrop, with no camera needed"). The card sits under the mirror, where the
  // Mirror's controls usually are, so the replay plays in full view. Nothing here asks for the camera:
  // a first-time visitor sees the cast before any permission prompt.
  import type { ReplayData, Spell } from '../../contracts';
  import { ask, describeError } from '../../kernel';
  import type { AppState } from '../app-state.svelte';
  import { focusOnMount } from '../actions';
  import StrokePath from '../components/StrokePath.svelte';
  import Icon from '../components/shell/Icon.svelte';

  let { app }: { app: AppState } = $props();

  type Phase = 'reading' | 'waiting' | 'playing' | 'done' | 'unavailable' | 'unreadable' | 'failed';
  let phase = $state<Phase>('reading');
  let data = $state.raw<ReplayData | null>(null);
  let reason = $state<string | null>(null);
  let played = false;

  const entry = $derived(data ? app.entry(data.spellId) : null);
  const name = $derived.by(() => {
    if (!data) return '';
    const spell = entry?.spell;
    return (spell && variantLabel(spell, data)) ?? spell?.incantation ?? data.spellId;
  });
  const grade = $derived(data ? app.grade(data.quality, 'cast') : '');

  // Read the link.
  $effect(() => {
    const hash = app.replayHash;
    if (!hash) {
      phase = 'unreadable';
      return;
    }
    let cancelled = false;
    ask(app.kernel, 'share.parse', { hash }).then(
      (d) => {
        if (cancelled) return;
        data = d;
        phase = 'waiting';
      },
      (err) => {
        if (cancelled) return;
        reason = describeError(err).message;
        phase = 'unreadable';
      },
    );
    return () => {
      cancelled = true;
    };
  });

  // Play it at once, as soon as the mirror is running.
  $effect(() => {
    if (phase === 'waiting' && app.started && data && !played) {
      played = true;
      void play();
    }
  });

  async function play() {
    const d = data;
    if (!d || phase === 'playing') return;
    // A spell whose pack is off here is not played (the share module refuses it as well).
    const e = app.entry(d.spellId);
    if (!e || !e.available) {
      phase = 'unavailable';
      return;
    }
    phase = 'playing';
    reason = null;
    try {
      await ask(app.kernel, 'share.replay', { data: d });
      phase = 'done';
    } catch (err) {
      const after = app.entry(d.spellId);
      if (!after || !after.available) {
        phase = 'unavailable';
      } else {
        reason = describeError(err).message;
        phase = 'failed';
      }
    }
  }

  function startCasting() {
    app.clearReplayLink();
    app.go(app.settings['app.onboarded'] ? 'mirror' : 'threshold');
  }

  /** The pack variant a replay was cast as (such as Lumos Maxima), if any. */
  function variantLabel(spell: Spell, d: ReplayData): string | null {
    if (!d.variant || !spell.variants?.length) return null;
    const fits = spell.variants.find((v) => {
      const w = v.when ?? {};
      return (w.power_min === undefined || d.power >= w.power_min)
        && (w.power_max === undefined || d.power <= w.power_max)
        && (w.quality_min === undefined || d.quality >= w.quality_min);
    });
    return (fits ?? spell.variants[0]).label ?? null;
  }

  const statusText = $derived.by(() => {
    switch (phase) {
      case 'reading':
        return 'Reading the link.';
      case 'waiting':
        return 'Getting the mirror ready.';
      case 'playing':
        return 'Playing the cast on a plain backdrop. No camera needed.';
      case 'done':
        return 'That was the cast. Watch it again, or cast your own.';
      case 'failed':
        return reason ?? 'The replay could not play.';
      default:
        return '';
    }
  });
</script>

<section class="replay page on-vellum" aria-labelledby="replay-title" data-replay-state={phase} use:focusOnMount>
  {#if phase === 'unreadable'}
    <div class="seal" aria-hidden="true"><Icon name="close" size={24} /></div>
    <div class="body">
      <h2 id="replay-title" class="kicker">A cast shared with you</h2>
      <p class="spell">This link could not be read.</p>
      {#if reason}<p class="what">{reason}</p>{/if}
    </div>
    <div class="actions">
      <button class="btn btn-seal" onclick={startCasting}>Start casting</button>
    </div>
  {:else}
    <div class="shape" aria-hidden={!data?.points.length}>
      {#if data && data.points.length > 1}
        <StrokePath points={data.points} aspect={data.aspect} size={92} tone="ink" reducedMotion={app.reducedMotion} label="The traced stroke of {name}" />
      {:else}
        <div class="seal" aria-hidden="true"><Icon name="star" size={24} /></div>
      {/if}
    </div>
    <div class="body">
      <h2 id="replay-title" class="kicker">A cast shared with you</h2>
      {#if data}
        <p class="spell">
          <span class="spell-name">{name}</span>
          {#if phase !== 'unavailable'}<span class="grade"><span aria-hidden="true">✦</span> {grade}</span>{/if}
        </p>
        {#if phase === 'unavailable'}
          <p class="what problem" role="status">
            <span class="glyph" aria-hidden="true">✕</span>
            {entry ? 'This cast uses a spell from a pack that is turned off here.' : 'This cast uses a spell that is not in this spellbook.'}
          </p>
        {:else}
          <p class="what">
            {#if entry?.spell.known_as}<span class="known">{entry.spell.known_as}.</span>{/if}
            {entry?.spell.description ?? ''}
            {#if data.via === 'voice'}<span class="known"> Cast by voice.</span>{/if}
          </p>
          <p class="status" role="status" aria-live="polite">{statusText}</p>
        {/if}
      {:else}
        <p class="status" role="status" aria-live="polite">{statusText}</p>
      {/if}
    </div>
    <div class="actions">
      {#if phase !== 'unavailable'}
        <button class="btn" onclick={() => play()} disabled={phase !== 'done' && phase !== 'failed'}>
          <Icon name="replay" size={20} />Watch again
        </button>
      {/if}
      <button class="btn btn-seal" onclick={startCasting}>Start casting</button>
    </div>
  {/if}
</section>

<style>
  /* A card sent by a friend: parchment ruled twice in ink, the cast's stroke drawn on it in a small
     framed figure. */
  /* The stroke, the words, then the buttons, in one row while they fit; the buttons go under the
     words when the card is too narrow for all three, at any window size. The card is as wide as the
     frame but never much narrower than its words: a narrow card grows tall, which takes height from
     the mirror and narrows the frame again, so a short window would settle on a tiny mirror. */
  .replay {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 22px;
    width: min(calc(100% - 2 * var(--stage-pr, 20px)), max(var(--frame-w, 100%), 640px));
    margin: 6px auto 4px;
    padding: 16px 24px 16px 18px;
    border-radius: 2px;
    box-shadow:
      inset 0 0 0 1px rgb(110 76 30 / 0.35),
      inset 0 0 22px rgb(120 84 36 / 0.24),
      4px 14px 40px rgb(0 0 0 / 0.55),
      1px 3px 6px rgb(0 0 0 / 0.4);
  }

  .replay::before {
    content: '';
    position: absolute;
    inset: 6px;
    border: 1px solid rgb(43 33 24 / 0.32);
    outline: 1px solid rgb(43 33 24 / 0.16);
    outline-offset: 2px;
    pointer-events: none;
  }

  .shape {
    flex: none;
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    border-radius: 1px;
    background: radial-gradient(80% 80% at 50% 45%, rgb(255 252 240 / 0.7), rgb(255 248 228 / 0.25));
    box-shadow:
      inset 0 0 0 1px rgb(43 33 24 / 0.45),
      inset 0 0 0 4px rgb(255 251 238 / 0.55),
      inset 0 0 0 5px rgb(43 33 24 / 0.2);
  }

  .seal {
    flex: none;
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    color: color-mix(in srgb, var(--oxblood) 45%, #ffe0d6);
    background: radial-gradient(circle at 36% 30%, color-mix(in srgb, var(--oxblood) 78%, #ffd2c4), var(--oxblood) 52%, var(--oxblood-2) 100%);
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--oxblood) 60%, black),
      0 0 0 3.5px color-mix(in srgb, var(--oxblood) 88%, #ffc0b0),
      inset 0 -2px 5px rgb(0 0 0 / 0.4),
      1px 3px 6px rgb(0 0 0 / 0.3);
  }

  .body {
    flex: 1 1 200px;
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .kicker {
    margin: 0;
    font-family: var(--font-label);
    font-size: 18px;
    letter-spacing: 0.07em;
    color: var(--rubric);
  }

  .spell {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 14px;
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(26px, 2.4vw, 34px);
    line-height: 1.15;
  }

  .grade {
    font-family: var(--font-label);
    font-size: var(--text-body);
    letter-spacing: 0.04em;
    color: var(--ink-brown);
  }

  .what {
    margin: 2px 0 0;
    font-size: var(--text-body);
    line-height: 1.4;
  }

  .known {
    font-style: italic;
  }

  .problem {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }

  .glyph {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    background: var(--oxblood);
    color: var(--vellum);
    transform: translateY(3px);
  }

  .status {
    margin: 2px 0 0;
    font-size: var(--text-small);
    font-style: italic;
    color: var(--ink-soft);
  }

  /* At the row's end; on a row of their own, at the right, when they wrap. */
  .actions {
    flex: 0 1 auto;
    max-width: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
    margin-left: auto;
  }

  .actions .btn-seal {
    min-width: 160px;
  }
</style>
