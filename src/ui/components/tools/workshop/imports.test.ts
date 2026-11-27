// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Module } from '../../../../contracts';
import { createKernel, memoryPersistence } from '../../../../kernel';
import { AppState } from '../../../app-state.svelte';
import { Imports } from './imports.svelte';
import { batchSummary } from './words';

/** Stands in for the kernel's pack service (its handler replaces the kernel's): JSON of the spellpack
 *  schema is a pack, anything else is refused with the service's kind of reason. */
const packs: Module = {
  manifest: { id: 'packs.test', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: [] },
  async init(kernel) {
    kernel.handle('packs.import', ({ text }: { text: string }) => {
      let json: { id?: string; schema?: string };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('This file is not JSON');
      }
      if (json.schema && !/^spellpack\//.test(json.schema)) throw new Error(`"${json.schema}" is not a pack format Spellglass knows`);
      return { id: json.id ?? 'pack', kind: 'spellpack', warnings: [] };
    });
  },
  async start() {},
  async stop() {},
};

async function shell(): Promise<AppState> {
  const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
  kernel.register(packs);
  await kernel.init();
  await kernel.start();
  return new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
}

const file = (name: string, body: unknown) => new File([typeof body === 'string' ? body : JSON.stringify(body)], name, { type: 'application/json' });

// Section 11.1: "a friend drops it onto the Workshop screen". Dropped or chosen with "Choose a pack
// file", every file is sorted the same way.
describe('Imports: a batch of files', () => {
  it('sends a data export to Your data and refuses a session in plain words', async () => {
    const app = await shell();
    const imports = new Imports();
    const batch = await imports.files(app, [file('spellglass-data-2026-11-22.json', { schema: 'spellglass-data/1' }), file('session.json', { schema: 'session/1' })]);
    expect(batch?.where).toBe('data');
    expect(batch?.data).toBe('spellglass-data-2026-11-22.json');
    expect(imports.pendingData?.filename).toBe('spellglass-data-2026-11-22.json');
    expect(batch?.results).toHaveLength(1);
    expect(batch?.results[0]).toMatchObject({ filename: 'session.json', ok: false, error: expect.stringMatching(/recorded session for tests, not a pack/) });
    expect(batch?.results[0].error).not.toMatch(/session\/1/);
  });

  it('returns what became of every file, in order, for one announcement', async () => {
    const app = await shell();
    const imports = new Imports();
    const batch = await imports.files(app, [file('broken.json', '{ "schema": "spellpack/1", '), file('a.json', { schema: 'spellpack/1', id: 'a' }), file('session.json', { schema: 'session/1' })]);
    expect(batch?.where).toBe('packs');
    expect(batch?.results.map((r) => [r.filename, r.ok])).toEqual([['broken.json', false], ['a.json', true], ['session.json', false]]);
    expect(batchSummary(batch!)).toBe('Imported 1 of 3 files. broken.json and session.json were not imported.');
    // The list on the Packs tab shows the newest first.
    expect(imports.packs.map((r) => r.filename)).toEqual(['session.json', 'a.json', 'broken.json']);
  });
});
