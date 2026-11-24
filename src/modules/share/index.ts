// Sharing (share.links): keepsakes, replay links, keepsake cards, clips, and handing files and links
// to the player (Section 11.1 "Four things to share", Section 10.4 Keepsakes, Section 9.4 share links).
//
// Inputs:  'stroke.end' (a short cache by stroke id), 'spell.cast' (a keepsake for every cast that is
//          not a replay), 'storage.changed' (keepsakes changed by an import or a clear); sticky
//          'spellbook.changed' (spell names, availability, the theme) and 'tracker.status' (aspect).
// Outputs: 'share.clip.state'.
// Requests handled: share.link, share.parse, share.replay, share.card, share.clip.start,
//          share.clip.stop, share.file, share.url, keepsakes.list, keepsakes.delete.
// Requests made: storage.* (keepsakes), stage.replay, stage.capture.*, audio.capture.*, spellbook.get.
//
// The manifest requires nothing: links and cards must work everywhere, so clips and file sharing check
// what the browser offers when they are asked (kernel.has and feature detection at call time).
//
// The work is split: codec.ts (the link format), keepsakes.ts and shelf.ts (keepsakes), replay.ts,
// card.ts, clip.ts, deliver.ts.

import type { Keepsake, Kernel, Module, ModuleManifest, SpellCast } from '../../contracts';
import { KernelError, describeError, lastPayload, logger, on, serve, setting } from '../../kernel';
import { browserCardEnv, cardContent, cardFilename, cardPalette, renderCard } from './card';
import { ClipRecorder, browserClipEnv } from './clip';
import { ReplayLinkError, checkReplayData, linkFor, parseLink } from './codec';
import { browserDeliverEnv, shareFile, shareUrl } from './deliver';
import { StrokeCache, buildKeepsake, keepsakeToReplay, strokeRecord } from './keepsakes';
import { playReplay, playableEntry } from './replay';
import { KeepsakeShelf } from './shelf';

export const MANIFEST: ModuleManifest = {
  id: 'share.links',
  kind: 'share',
  title: 'Sharing',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['share@1'],
  requires: [],
};

const log = logger('share');

/** The Keepsakes screen may ask right after start; it waits this long for the stored ones. Storage
 *  always answers within its open timeout (3 s), from memory if need be, so this only bounds a
 *  storage module that never answers. */
const LIST_WAIT_MS = 5000;
/** Strokes recorded sessions play back are replays: never keepsakes (contracts/v1.ts SpellCast.replay). */
const REPLAY_TRACKER = 'tracker.replay';

export const SHARE_MESSAGES = {
  notKept: 'That cast is not among your keepsakes any more.',
  needCast: 'Say which cast: give its id.',
  needLink: 'There is no replay link to read.',
  needReplay: 'Give a replay to play: the link\'s data or a keepsake\'s cast id.',
  noCards: 'This browser cannot draw a card.',
  needFile: 'Give a file to share: a blob and a file name.',
  needUrl: 'Give a link to share.',
  noAddress: 'This copy of Spellglass has no web address for replay links. Save a card or record a clip to share the cast.',
} as const;

export function createShareModule(opts: { appUrl: string }): Module {
  // The app's base address, ending in '/' (src/main.ts); any fragment is dropped. Empty when there is
  // none to give (the desktop app built without SPELLGLASS_WEB_URL): then there are no replay links.
  const appUrl = String(opts.appUrl ?? '').split('#')[0];
  let kernel: Kernel | null = null;
  let shelf: KeepsakeShelf | null = null;
  let clips: ClipRecorder | null = null;
  let running = false;
  const strokes = new StrokeCache(16);

  const invalid = (message: string) => new KernelError('invalid-payload', message);

  async function keepsake(castId: unknown): Promise<Keepsake> {
    if (typeof castId !== 'string' || !castId) throw invalid(SHARE_MESSAGES.needCast);
    const found = await shelf?.find(castId);
    if (!found) throw invalid(SHARE_MESSAGES.notKept);
    return found;
  }

  /** A keepsake for every cast that is not a replay. */
  function remember(k: Kernel, cast: SpellCast): void {
    if (!cast || typeof cast.id !== 'string' || typeof cast.spellId !== 'string' || cast.replay === true) return;
    const stroke = strokes.get(cast.strokeId);
    const entry = lastPayload(k, 'spellbook.changed')?.spells.find((e) => e.spell.id === cast.spellId);
    const name = entry?.spell.incantation ?? cast.incantation ?? cast.spellId;
    const aspect = lastPayload(k, 'tracker.status')?.aspect ?? lastPayload(k, 'stage.surface')?.aspect ?? 16 / 9;
    shelf?.add(buildKeepsake(cast, stroke, name, aspect, Date.now()));
  }

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      const s = new KeepsakeShelf(k, log);
      shelf = s;
      const c = new ClipRecorder({
        kernel: k,
        source: MANIFEST.id,
        env: browserClipEnv,
        log,
        prepareReplay: async (castId, includeCamera) => {
          const data = keepsakeToReplay(await keepsake(castId));
          await playableEntry(k, data.spellId);
          return { spellId: data.spellId, play: () => playReplay(k, data, includeCamera ? { backdrop: 'camera' } : {}) };
        },
      });
      clips = c;

      on(k, 'stroke.end', (stroke) => {
        if (!running || stroke?.src === REPLAY_TRACKER) return;
        const record = strokeRecord(stroke);
        if (record) strokes.add(record);
      });
      on(k, 'spell.cast', (cast) => {
        if (running) remember(k, cast);
      });
      on(k, 'storage.changed', (change) => {
        if (running) s.onStorageChanged(change);
      });

      // ------------------------------------------------------------------ keepsakes
      serve(k, 'keepsakes.list', async (p) => {
        const limit = p?.limit;
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw invalid('keepsakes.list limit must be a whole number, 0 or more.');
        await s.whenLoaded(LIST_WAIT_MS);
        return s.all(limit);
      });
      serve(k, 'keepsakes.delete', async (p) => {
        if (typeof p?.id !== 'string' || !p.id) throw invalid(SHARE_MESSAGES.needCast);
        await s.remove(p.id);
      });

      // ------------------------------------------------------------------ links
      serve(k, 'share.link', async (p) => {
        const found = await keepsake(p?.castId);
        if (!appUrl) throw new KernelError('not-supported', SHARE_MESSAGES.noAddress);
        try {
          return linkFor(appUrl, keepsakeToReplay(found));
        } catch (err) {
          throw invalid(err instanceof ReplayLinkError ? err.message : describeError(err).message);
        }
      });
      serve(k, 'share.parse', (p) => {
        if (typeof p?.hash !== 'string') throw invalid(SHARE_MESSAGES.needLink);
        try {
          return parseLink(p.hash);
        } catch (err) {
          throw invalid(err instanceof ReplayLinkError ? err.message : describeError(err).message);
        }
      });
      serve(k, 'share.replay', async (p) => {
        if (p?.data !== undefined) {
          let data;
          try {
            data = checkReplayData(p.data);
          } catch (err) {
            throw invalid(err instanceof ReplayLinkError ? err.message : describeError(err).message);
          }
          return playReplay(k, data);
        }
        if (p?.castId !== undefined) return playReplay(k, keepsakeToReplay(await keepsake(p.castId)));
        throw invalid(SHARE_MESSAGES.needReplay);
      });

      // ------------------------------------------------------------------ cards
      serve(k, 'share.card', async (p) => {
        const found = await keepsake(p?.castId);
        const env = browserCardEnv();
        if (!env) throw new KernelError('not-supported', SHARE_MESSAGES.noCards);
        const theme = lastPayload(k, 'spellbook.changed')?.theme ?? null;
        try {
          const blob = await renderCard(cardContent(found, theme), cardPalette(theme), env);
          return { blob, filename: cardFilename(found) };
        } catch (err) {
          log.warn('could not draw a card', err);
          throw new KernelError('not-supported', SHARE_MESSAGES.noCards, err);
        }
      });

      // ------------------------------------------------------------------ clips
      serve(k, 'share.clip.start', (p) => {
        const includeCamera = typeof p?.includeCamera === 'boolean' ? p.includeCamera : setting(k, 'share.includeCamera') === true;
        return c.start({ includeCamera, maxMs: p?.maxMs, castId: p?.castId });
      });
      serve(k, 'share.clip.stop', () => c.stop());

      // ------------------------------------------------------------------ handing over
      // No await before navigator.share in either: they must keep the click's user activation.
      serve(k, 'share.file', (p) => {
        if (!p || typeof Blob === 'undefined' || !(p.blob instanceof Blob) || typeof p.filename !== 'string' || !p.filename) throw invalid(SHARE_MESSAGES.needFile);
        return shareFile(p, browserDeliverEnv()).catch((err: unknown) => {
          throw new KernelError('not-supported', describeError(err).message, err);
        });
      });
      serve(k, 'share.url', (p) => {
        if (typeof p?.url !== 'string' || !p.url) throw invalid(SHARE_MESSAGES.needUrl);
        return shareUrl(p, browserDeliverEnv());
      });
    },

    async start() {
      if (!kernel || !shelf || running) return;
      running = true;
      // In the background: start() never waits on storage.
      void shelf.load();
    },

    async stop() {
      running = false;
      strokes.clear();
      await clips?.shutdown();
    },
  };
}
