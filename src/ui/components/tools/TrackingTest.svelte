<script lang="ts">
  // Appendix A as a short checklist: one evening settles whether this camera can see the wand tip.
  // The full test, with its own exposure slider and recordings, is the tip finder page.
  import { trackingTest } from './session-state.svelte';

  const STEPS: { title: string; text: string }[] = [
    { title: 'Baseline', text: 'Room lights on, the tip 1 m from the camera and pointed at it. Does the tip stand out at all? It probably will not.' },
    { title: 'Light beside the lens', text: 'Hold a phone flashlight touching the bezel next to the camera, and dim the room. Look for a sharp dot at the tip.' },
    { title: 'Prove it is the reflection', text: 'Slide the flashlight 10 cm away from the lens. The dot should fade.' },
    { title: 'The screen as the light', text: 'Flashlight off; turn on the screen light. A fainter dot may still be enough.' },
    { title: 'Exposure', text: 'Lower the exposure until the room is nearly black. Aim for a contrast of 3× or more.' },
    { title: 'Motion', text: 'Draw circles and flicks at a natural pace. The dot should be there in nine frames out of ten.' },
    { title: 'Distance', text: 'Repeat at 0.6 m and 1.5 m, and note where steps 5 and 6 still pass.' },
    { title: 'Infrared leak (optional)', text: 'Point a TV remote at the camera and press a button. A flash means some infrared gets through.' },
    { title: 'Camera list (optional)', text: 'Look in the camera list for a second camera with “IR” in its name.' },
    { title: 'Hand tracking', text: 'Choose Hand and hold the wand as you cast. Do the landmarks stay on your hand?' },
  ];

  const finder = `${import.meta.env.BASE_URL}tools/tip-finder.html`;
  const done = $derived(trackingTest.done.filter(Boolean).length);
</script>

<details class="test">
  <summary>
    <span class="summary-title">The tracking test, step by step</span>
    <span class="count">{done} of {STEPS.length} done</span>
  </summary>
  <ol class="steps">
    {#each STEPS as s, i (s.title)}
      <li>
        <label class="step">
          <input type="checkbox" class="tick" bind:checked={trackingTest.done[i]} />
          <span>
            <span class="step-title">{i + 1}. {s.title}</span>
            <span class="step-text">{s.text}</span>
          </span>
        </label>
      </li>
    {/each}
  </ol>
  <p class="finder">
    <a href={finder} target="_blank" rel="noopener">Open the tip finder</a>
    <span class="muted">A separate page for this test. Values you set there become the starting values here.</span>
  </p>
</details>

<style>
  .test {
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--night) 40%, transparent);
  }

  summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding: 8px 16px;
    cursor: pointer;
    list-style: none;
    border-radius: var(--radius);
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: '';
    flex: none;
    width: 9px;
    height: 9px;
    border-right: 2px solid var(--ash);
    border-bottom: 2px solid var(--ash);
    transform: rotate(-45deg);
    transition: transform var(--duration) var(--ease-out);
  }

  .test[open] summary::before {
    transform: rotate(45deg);
  }

  .summary-title {
    flex: 1;
    font-size: var(--text-body);
  }

  .count {
    font-size: var(--text-small);
    color: var(--ash);
    white-space: nowrap;
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0 16px 6px;
    display: grid;
    gap: 2px;
  }

  .step {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 8px 0;
    cursor: pointer;
  }

  .step input {
    margin: 2px 0 0;
  }

  .step-title {
    display: block;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .step input:checked + span .step-title {
    color: var(--verdigris);
  }

  .step input:checked + span .step-title::after {
    content: ' ✓';
  }

  .step-text {
    display: block;
    font-size: var(--text-small);
    color: var(--ash);
  }

  .finder {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 12px 16px 16px;
    border-top: 1px solid var(--line);
  }

  .finder a {
    font-size: var(--text-body);
    justify-self: start;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }

  .finder .muted {
    font-size: var(--text-small);
  }
</style>
