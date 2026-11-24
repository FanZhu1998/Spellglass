<script lang="ts">
  // The spell's gesture as an engraved plate on the vellum: the stroke with its start dot, drawing
  // itself at the gesture's intended pace (gesturePaceMs, the pace the engine grades tempo against),
  // then resting whole with its arrowhead before it draws again. Under reduced motion it is drawn
  // whole at once (Section 10.6). The entry's templates and flick direction are already mirrored for
  // a left-handed caster, so what is drawn is what is matched.
  import { untrack } from 'svelte';
  import type { Point, SpellbookEntry } from '../../../contracts';
  import { geometry, gesturePaceMs } from '../../../kernel';
  import StrokePath from '../StrokePath.svelte';

  let { entry, reducedMotion = false, label }: { entry: SpellbookEntry; reducedMotion?: boolean; label: string } = $props();

  /** StrokePath draws during the first 80% of its duration and holds the finished stroke after. */
  const DRAW_SHARE = 0.8;
  /** How long the finished stroke rests, with its arrowhead, before the next pass. */
  const REST_MS = 1300;

  const points = $derived.by((): Point[] => {
    const g = entry.spell.gesture;
    if ('flick' in g) return geometry.flickPath(g.flick);
    return entry.templates[0] ?? [];
  });
  const paceMs = $derived(gesturePaceMs(entry.spell.gesture));
  const passMs = $derived(Math.round(paceMs / DRAW_SHARE));

  let pass = $state(0);
  let drawing = $state(false);

  $effect(() => {
    // A new gesture (another spell, a redraw, the left-handed switch) starts a fresh pass.
    void entry.gestureKey;
    const ms = passMs;
    if (reducedMotion || points.length < 2) {
      drawing = false;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      pass += 1;
      drawing = true;
      // Swap to the still drawing during the hold at the end of the pass, before the dash
      // animation finishes and would hide the ink for a frame.
      timer = setTimeout(() => {
        drawing = false;
        timer = setTimeout(run, REST_MS);
      }, Math.round(ms * (DRAW_SHARE + 0.12)));
    };
    untrack(run);
    return () => clearTimeout(timer);
  });
</script>

<div class="plate">
  {#key pass}
    <StrokePath {points} animate={drawing} durationMs={passMs} loop={false} {reducedMotion} tone="ink" {label} />
  {/key}
</div>

<style>
  /* A figure drawn on the page in a frame ruled twice in ink, with small flowers at its corners, as
     an old manual frames its plates. */
  .plate {
    position: relative;
    display: grid;
    place-items: center;
    width: var(--plate-size, 220px);
    aspect-ratio: 1;
    border-radius: 1px;
    background:
      radial-gradient(85% 85% at 50% 45%, rgb(255 252 240 / 0.6), rgb(255 252 240 / 0) 72%),
      color-mix(in srgb, var(--vellum) 90%, white);
    box-shadow:
      inset 0 0 0 1px rgb(43 33 24 / 0.5),
      inset 0 0 0 5px color-mix(in srgb, var(--vellum) 90%, white),
      inset 0 0 0 6px rgb(43 33 24 / 0.28),
      0 1px 0 rgb(255 255 255 / 0.5),
      1px 2px 5px rgb(90 60 24 / 0.16);
  }

  .plate::before {
    content: '';
    position: absolute;
    inset: 2px;
    pointer-events: none;
    --flower: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cg fill='%232b2118' fill-opacity='.55'%3E%3Cpath d='M6 1C7.2 3 7.2 4.6 6 6 4.8 4.6 4.8 3 6 1ZM6 11C4.8 9 4.8 7.4 6 6c1.2 1.4 1.2 3 0 5ZM1 6C3 4.8 4.6 4.8 6 6 4.6 7.2 3 7.2 1 6ZM11 6C9 7.2 7.4 7.2 6 6c1.4-1.2 3-1.2 5 0Z'/%3E%3C/g%3E%3Ccircle cx='6' cy='6' r='1' fill='%237b1e2b'/%3E%3C/svg%3E");
    background:
      var(--flower) 0 0 / 12px no-repeat,
      var(--flower) 100% 0 / 12px no-repeat,
      var(--flower) 0 100% / 12px no-repeat,
      var(--flower) 100% 100% / 12px no-repeat;
  }

  .plate :global(.stroke-path) {
    width: 88%;
    height: 88%;
  }
</style>
