// Files brought into the Workshop (Section 11.1: "a friend drops it onto the Workshop screen"): pack
// files dropped anywhere on the Workshop or chosen with the button, and data exports from "Export my
// data", which wait for the player to confirm before anything changes. One instance per open Workshop.

import type { PackKind } from '../../../../contracts';
import { ask } from '../../../../kernel';
import type { AppState } from '../../../app-state.svelte';
import { errorText, readFileText } from '../format';

export interface PackImportResult {
  id: number;
  filename: string;
  ok: boolean;
  /** The pack's title once loaded (or its id). */
  title?: string;
  kind?: PackKind;
  /** Problems that did not stop the import, to show as they are. */
  warnings: string[];
  error?: string;
}

export type FileKind = 'pack' | 'data' | 'session';

/** What a dropped JSON file is, from its schema field. Anything unreadable goes to the pack service,
 *  which says plainly why it is not a pack. */
export function sniff(text: string): FileKind {
  try {
    const json: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const schema = json && typeof json === 'object' ? (json as { schema?: unknown }).schema : undefined;
    if (typeof schema === 'string') {
      if (/^spellglass-data\//.test(schema)) return 'data';
      if (/^session\//.test(schema)) return 'session';
    }
  } catch {
    /* not JSON: the pack service gives the reason */
  }
  return 'pack';
}

const KEEP_RESULTS = 6;

/** What one drop or one choice of files came to. */
export interface ImportBatch {
  /** The tab that shows the outcome: Your data when a data export waits there, else Packs. */
  where: 'packs' | 'data';
  /** What became of each file that is not a data export, in the order the files came. */
  results: PackImportResult[];
  /** The name of the data export now waiting for the player to confirm it, if the batch held one. */
  data: string | null;
}

export class Imports {
  packs = $state.raw<PackImportResult[]>([]);
  busy = $state(false);
  /** A data export dropped on the Workshop, waiting for the player to confirm the import. */
  pendingData = $state.raw<{ filename: string; text: string } | null>(null);
  private seq = 0;

  /** Files dropped on the Workshop or chosen with "Choose a pack file", sorted the same way either
   *  way: packs are imported at once, a session is refused in plain words, and a data export waits for
   *  confirmation on Your data. Null while another batch is still being read. */
  async files(app: AppState, files: readonly File[]): Promise<ImportBatch | null> {
    if (!files.length || this.busy) return null;
    this.busy = true;
    const results: PackImportResult[] = [];
    let data: string | null = null;
    try {
      for (const file of files) {
        let text: string;
        try {
          text = await readFileText(file);
        } catch (err) {
          results.push(this.push({ filename: file.name, ok: false, warnings: [], error: errorText(err, 'The file could not be read.') }));
          continue;
        }
        const kind = sniff(text);
        if (kind === 'data') {
          this.pendingData = { filename: file.name, text };
          data = file.name;
        } else if (kind === 'session') {
          results.push(
            this.push({
              filename: file.name,
              ok: false,
              warnings: [],
              error: 'This is a recorded session for tests, not a pack, so it is not imported here.',
            }),
          );
        } else {
          results.push(await this.importPack(app, file.name, text));
        }
      }
    } finally {
      this.busy = false;
    }
    return { where: data !== null ? 'data' : 'packs', results, data };
  }

  dismiss(id: number): void {
    this.packs = this.packs.filter((r) => r.id !== id);
  }

  private async importPack(app: AppState, filename: string, text: string): Promise<PackImportResult> {
    try {
      const r = await ask(app.kernel, 'packs.import', { text, filename });
      const title = app.spellbook?.packs.find((p) => p.id === r.id)?.title ?? r.id;
      return this.push({ filename, ok: true, title, kind: r.kind, warnings: r.warnings ?? [] });
    } catch (err) {
      return this.push({ filename, ok: false, warnings: [], error: errorText(err, 'This file could not be imported.') });
    }
  }

  private push(r: Omit<PackImportResult, 'id'>): PackImportResult {
    const result = { ...r, id: ++this.seq };
    this.packs = [result, ...this.packs].slice(0, KEEP_RESULTS);
    return result;
  }
}
