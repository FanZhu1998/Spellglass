import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Point, ReplayData } from '../../contracts';
import { PROP_IDS, REPLAY_FORMAT_VERSION } from '../../contracts';
import { gradeFor } from '../../kernel';
import {
  DECODERS, LINK_MESSAGES, ReplayLinkError, checkReplayData, decodeReplay, encodeReplay, fromBase64Url, linkFor, packId, parseLink,
  replayParam, sixtyFour, toBase64Url, unpackId,
} from './codec';

const PACKS = fileURLToPath(new URL('../../../public/packs/', import.meta.url));
const index = JSON.parse(readFileSync(`${PACKS}index.json`, 'utf8')) as { packs: { kind: string; path: string }[] };
const SPELL_IDS: string[] = index.packs
  .filter((p) => p.kind === 'spellpack')
  .flatMap((p) => (JSON.parse(readFileSync(`${PACKS}${p.path}`, 'utf8')) as { spells: { id: string }[] }).spells.map((s) => s.id));

/** A deterministic pseudo-random source, so failures repeat. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function stroke(rand: () => number, n = 64): Point[] {
  return Array.from({ length: n }, () => [rand(), rand()] as Point);
}

function replay(spellId: string, over: Partial<ReplayData> = {}): ReplayData {
  return {
    format: REPLAY_FORMAT_VERSION, spellId, via: 'gesture', quality: 0.87, power: 0.42, variant: false, durationMs: 1312, aspect: 16 / 9,
    points: stroke(random(spellId.length)), ...over,
  };
}

describe('base64url', () => {
  it('matches RFC 4648 and round-trips every length', () => {
    expect(toBase64Url(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    const rand = random(7);
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(Array.from({ length: n }, () => Math.floor(rand() * 256)));
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('accepts padding and the standard alphabet, and refuses anything else', () => {
    expect(fromBase64Url('-_8=')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(fromBase64Url('+/8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(fromBase64Url('ab c')).toBeNull();
    expect(fromBase64Url('abcde')).toBeNull();
  });
});

describe('spell ids', () => {
  it('packs every seed spell id three characters to two bytes, and back', () => {
    expect(SPELL_IDS.length).toBeGreaterThanOrEqual(27);
    for (const id of SPELL_IDS) {
      const packed = packId(id)!;
      expect(packed.length, id).toBe(Math.ceil(id.length / 3) * 2);
      expect(unpackId(packed), id).toBe(id);
    }
    for (const id of ['a', 'ab', 'abc', 'abcd', 'x-1', '9-9-9', 'z'.repeat(64)]) expect(unpackId(packId(id)!)).toBe(id);
  });

  it('refuses ids that are not plain ids, and corrupt packings', () => {
    for (const id of ['', 'Lumos', 'lumos maxima', '-lumos', 'lumos-', 'lu--mos', 'z'.repeat(65)]) expect(packId(id), id).toBeNull();
    expect(unpackId(new Uint8Array([0xff, 0xff]))).toBeNull();
    expect(unpackId(new Uint8Array([0, 1]))).toBeNull();
    expect(unpackId(new Uint8Array([1]))).toBeNull();
    // 'a' then padding, then another group: padding may only end the last group.
    expect(unpackId(new Uint8Array([...packId('a')!, ...packId('bcd')!]))).toBeNull();
  });
});

describe('replay links', () => {
  it('round-trips every seed spell, within a byte of every coordinate', () => {
    SPELL_IDS.forEach((id, i) => {
      const data = replay(id, { via: (['gesture', 'voice', 'both'] as const)[i % 3], variant: i % 2 === 0, target: PROP_IDS[i % PROP_IDS.length] });
      const back = decodeReplay(encodeReplay(data));
      expect(back).toMatchObject({ format: 1, spellId: id, via: data.via, variant: data.variant, target: data.target });
      expect(back.quality).toBeCloseTo(0.87, 2);
      expect(back.power).toBeCloseTo(0.42, 2);
      expect(Math.abs(back.durationMs - 1312)).toBeLessThanOrEqual(16);
      expect(Math.abs(back.aspect - 16 / 9)).toBeLessThan(1 / 64);
      expect(back.points).toHaveLength(64);
      back.points.forEach((p, j) => {
        expect(Math.abs(p[0] - data.points[j][0])).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
        expect(Math.abs(p[1] - data.points[j][1])).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      });
    });
  });

  it('fits the longest seed spell id in about 200 characters after the #', () => {
    const longest = [...SPELL_IDS].sort((a, b) => b.length - a.length)[0];
    const { url, hash } = linkFor('https://example.test/Spellglass/', replay(longest));
    expect(hash.startsWith('cast=')).toBe(true);
    expect(url).toBe(`https://example.test/Spellglass/#${hash}`);
    // 18 characters ('petrificus-totalus', 'wingardium-leviosa'): 147 bytes, 196 characters of data.
    expect(hash.length - 'cast='.length).toBeLessThanOrEqual(196);
    expect(hash.length).toBeLessThanOrEqual(201);
    for (const id of SPELL_IDS) expect(linkFor('https://x/', replay(id)).hash.length, id).toBeLessThanOrEqual(201);
  });

  it('keeps the grade: qualities are floored to steps that land on the theme\'s boundaries', () => {
    for (const q of [0, 0.29, 0.4499, 0.45, 0.5999, 0.6, 0.7999, 0.8, 0.8001, 0.8999, 0.9, 0.95, 1]) {
      const back = decodeReplay(encodeReplay(replay('lumos', { quality: q })));
      expect(gradeFor(back.quality, 'cast'), String(q)).toBe(gradeFor(q, 'cast'));
      expect(gradeFor(back.quality, 'fizzle'), String(q)).toBe(gradeFor(q, 'fizzle'));
      expect(back.quality).toBeLessThanOrEqual(q);
    }
  });

  it('clamps coordinates to the frame and resamples other point counts to 64', () => {
    const outside = decodeReplay(encodeReplay(replay('nox', { points: [[-0.2, 0.5], [1.3, 0.5], ...stroke(random(3), 62)] })));
    expect(outside.points[0]).toEqual([0, 128 / 255]);
    expect(outside.points[1][0]).toBe(1);
    const few = decodeReplay(encodeReplay(replay('nox', { points: [[0, 0], [1, 1]] })));
    expect(few.points).toHaveLength(64);
    expect(few.points[0]).toEqual([0, 0]);
    expect(few.points[63]).toEqual([1, 1]);
  });

  it('carries voice-only casts without points, and casts without a target', () => {
    const voice = decodeReplay(encodeReplay(replay('lumos', { via: 'voice', points: [], target: undefined })));
    expect(voice.points).toEqual([]);
    expect(voice.via).toBe('voice');
    expect('target' in voice).toBe(false);
  });

  it('resamples evenly in isotropic space, so the replay moves at an even speed', () => {
    // An L: 0.4 caster units along x (0.71 isotropic at 16:9), then 0.6 down. Evenly spaced in
    // caster units, 40% of the samples would fall on the first leg; evenly in isotropic space, 54%.
    const aspect = 16 / 9;
    const pts = sixtyFour([[0.1, 0.2], [0.5, 0.2], [0.5, 0.8]], aspect);
    const leg1 = 0.4 * aspect;
    const total = leg1 + 0.6;
    pts.forEach((p, i) => {
      const along = Math.abs(p[1] - 0.2) < 1e-9 ? (p[0] - 0.1) * aspect : leg1 + (p[1] - 0.2);
      expect(Math.abs(along / total - i / 63)).toBeLessThan(1e-6);
    });
  });
});

describe('reading links', () => {
  const data = encodeReplay(replay('expelliarmus'));

  it('finds the data in a whole link, a fragment, a query-like fragment or on its own', () => {
    for (const input of [`https://host/app/#cast=${data}`, `#cast=${data}`, `cast=${data}`, `x=1&cast=${data}&y=2`, data, `  ${data}\n`]) {
      expect(replayParam(input), input).toBe(data);
      expect(parseLink(input).spellId).toBe('expelliarmus');
    }
    expect(replayParam('https://host/app/')).toBeNull();
    expect(replayParam('#x=1')).toBeNull();
  });

  it('refuses garbage, cut-off and tampered links with a plain message', () => {
    const bytes = fromBase64Url(data)!;
    const tamper = (i: number, v: number) => {
      const b = bytes.slice();
      b[i] = v;
      return toBase64Url(b);
    };
    const cases: [string, string][] = [
      ['', LINK_MESSAGES.empty],
      ['https://host/app/', LINK_MESSAGES.empty],
      ['cast=', LINK_MESSAGES.empty],
      ['cast=%%%', LINK_MESSAGES.damaged],
      ['cast=hello world', LINK_MESSAGES.damaged],
      [`cast=${data.slice(0, 40)}`, LINK_MESSAGES.damaged],
      [`cast=${tamper(1, bytes[1] | 3)}`, LINK_MESSAGES.damaged],
      [`cast=${tamper(2, 201)}`, LINK_MESSAGES.damaged],
      [`cast=${tamper(5, 0)}`, LINK_MESSAGES.damaged],
      [`cast=${tamper(7, 0xff)}`, LINK_MESSAGES.damaged],
      [`cast=${tamper(0, 0)}`, LINK_MESSAGES.damaged],
    ];
    for (const [input, message] of cases) {
      expect(() => parseLink(input), input).toThrow(ReplayLinkError);
      expect(() => parseLink(input), input).toThrow(message);
    }
  });

  it('says when a link comes from a newer edition, and keeps a decoder for every format', () => {
    const bytes = fromBase64Url(data)!;
    for (const version of [REPLAY_FORMAT_VERSION + 1, 255]) {
      const newer = bytes.slice();
      newer[0] = version;
      expect(() => decodeReplay(toBase64Url(newer))).toThrow(LINK_MESSAGES.newer);
    }
    for (let v = 1; v <= REPLAY_FORMAT_VERSION; v++) expect(typeof DECODERS[v]).toBe('function');
  });

  it('ignores reserved flag bits and props the shelf does not have yet', () => {
    const bytes = fromBase64Url(data)!;
    bytes[1] |= 0xf0;
    bytes[6] = 42;
    const back = decodeReplay(toBase64Url(bytes));
    expect(back.spellId).toBe('expelliarmus');
    expect(back.target).toBeUndefined();
  });

  it('checks replay data handed to share.replay', () => {
    expect(checkReplayData({ spellId: 'lumos', quality: 3, power: -1, points: [[0.1, 0.2]], aspect: 0 })).toEqual({
      format: 1, spellId: 'lumos', via: 'gesture', quality: 1, power: 0, variant: false, durationMs: 0, aspect: 16 / 9, points: [[0.1, 0.2]],
    });
    for (const bad of [null, {}, { spellId: 'Lumos!' }, { spellId: 'lumos', via: 'mind' }, { spellId: 'lumos', points: [[0, 'x']] }]) {
      expect(() => checkReplayData(bad)).toThrow(ReplayLinkError);
    }
  });
});
