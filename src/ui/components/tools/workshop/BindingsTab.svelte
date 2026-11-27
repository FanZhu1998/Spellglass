<script lang="ts">
  // Bindings (Section 7.8): a table of data that maps a spell to one more action outside the mirror,
  // such as "Lumos also turns on the desk lamp". Outputs are a later milestone (M5); the table is shown
  // as it is, with a plain note, so nothing here promises what this edition cannot do.
  import type { Binding } from '../../../../contracts';
  import type { AppState } from '../../../app-state.svelte';
  import StatusLine from '../StatusLine.svelte';
  import ToolSection from '../ToolSection.svelte';

  let { app }: { app: AppState } = $props();

  const rows = $derived.by((): Binding[] => {
    const v: unknown = app.settings['bindings'];
    return Array.isArray(v) ? v.filter((b): b is Binding => !!b && typeof b === 'object' && typeof (b as Binding).spellId === 'string') : [];
  });

  function outputName(id: string): { name: string; here: boolean } {
    const m = app.modules.find((x) => x.manifest.id === id);
    return m ? { name: m.manifest.title ?? id, here: m.state !== 'unavailable' } : { name: id || 'An output', here: false };
  }
</script>

<div class="bindings">
  <ToolSection id="ws-bindings" title="Bindings" lede="A binding makes a spell do one more thing outside the mirror, such as Lumos also turning on a desk lamp.">
    <StatusLine kind="info" text="Outputs such as room lights come in a later version. Until then this table shows any bindings that are set, and none of them act." />

    <div class="table-wrap">
      <table class="table">
        <caption class="visually-hidden">Bindings: spells and the extra action each one takes</caption>
        <thead>
          <tr>
            <th scope="col">Spell</th>
            <th scope="col">Also does</th>
            <th scope="col">Through</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as b, i (b.id || `row-${i}`)}
            {@const out = outputName(b.output)}
            <tr>
              <th scope="row" class="spell">{app.spellName(b.spellId)}</th>
              <td>{b.target || '–'}</td>
              <td>
                {#if out.here}{out.name}{:else}<code>{out.name}</code>{' '}<span class="muted">(not in this edition)</span>{/if}
              </td>
              <td class="state" data-on={b.enabled}>{b.enabled ? 'On' : 'Off'}</td>
            </tr>
          {:else}
            <tr class="example" aria-label="An example row, not a binding">
              <th scope="row" class="spell">Lumos</th>
              <td>turns on the desk lamp</td>
              <td>a home automation webhook</td>
              <td class="state">Example</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if rows.length === 0}<p class="ws-help">No bindings are set. The example row shows how one will read.</p>{/if}
  </ToolSection>

  <ToolSection id="ws-bindings-safety" title="When outputs arrive">
    <ul class="points">
      <li>Each output is off until you turn it on.</li>
      <li>{app.desktop ? 'Spellglass asks before it may reach a device on your home network.' : 'The browser asks before Spellglass may reach a device on your home network.'}</li>
      <li>Keep bindings to lights and sounds: never bind a spell to a lock or a door.</li>
    </ul>
  </ToolSection>
</div>

<style>
  .bindings {
    display: grid;
    max-width: 820px;
  }

  .table-wrap {
    overflow-x: auto;
    border-radius: var(--radius);
    border: 1px solid color-mix(in srgb, var(--brass) 45%, var(--line));
    background: color-mix(in srgb, var(--night) 42%, transparent);
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-small);
  }

  th,
  td {
    padding: 12px 16px;
    text-align: left;
    vertical-align: baseline;
    border-bottom: 1px solid var(--line);
  }

  thead th {
    font-weight: 400;
    color: var(--ash);
    background: color-mix(in srgb, var(--night) 35%, transparent);
  }

  tbody tr:last-child th,
  tbody tr:last-child td {
    border-bottom: 0;
  }

  .spell {
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 20px;
    color: var(--vellum);
  }

  .state[data-on='true'] {
    color: var(--verdigris);
  }

  /* On and off differ by shape as well as color: a tick, a ring. */
  .state[data-on='true']::before {
    content: '✓ ';
  }

  .state[data-on='false']::before {
    content: '○ ';
    color: var(--ash);
  }

  code {
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  /* The example is told apart by its words ("Example"), italics and a dashed edge, never by fading:
     it is the table's only content until a binding exists, so it keeps the 4.5:1 of Section 10.2
     (Ash on the table's dark ground). */
  .example th,
  .example td {
    color: var(--ash);
    font-style: italic;
  }

  .example {
    outline: 1px dashed color-mix(in srgb, var(--ash) 55%, transparent);
    outline-offset: -5px;
  }

  .points {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 8px;
  }

  .points li {
    position: relative;
    padding-left: 22px;
    font-size: var(--text-small);
    color: var(--vellum);
  }

  .points li::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 0.6em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--brass);
  }
</style>
