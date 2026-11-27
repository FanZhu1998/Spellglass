import { describe, expect, it, vi } from 'vitest';
import { isLocalUrl, restrictNetwork } from './guard';

const ORIGIN = 'https://fan.example';
const HREF = `${ORIGIN}/Spellglass/assets/worker-abc.js`;

function scope() {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(`ok ${String(input)}`));
  const opened: string[] = [];
  class FakeXhr {
    open(_method: string, url: string) {
      opened.push(url);
    }
  }
  const s = { location: { href: HREF, origin: ORIGIN }, fetch, XMLHttpRequest: FakeXhr as unknown as { prototype: { open: (...args: unknown[]) => void } } };
  return { s, fetch, opened, FakeXhr };
}

describe('isLocalUrl', () => {
  it('allows the own origin, relative paths, blob: and data: URLs', () => {
    expect(isLocalUrl('/Spellglass/models/hand_landmarker.task', HREF, ORIGIN)).toBe(true);
    expect(isLocalUrl('../models/wasm/vision_wasm_module_internal.wasm', HREF, ORIGIN)).toBe(true);
    expect(isLocalUrl(`blob:${ORIGIN}/0b1c-2d3e`, HREF, ORIGIN)).toBe(true);
    expect(isLocalUrl('data:application/octet-stream;base64,AAAA', HREF, ORIGIN)).toBe(true);
  });

  it('refuses every other origin', () => {
    expect(isLocalUrl('https://odml.pa.googleapis.com/v1/log', HREF, ORIGIN)).toBe(false);
    expect(isLocalUrl('https://fan.example.evil.test/x', HREF, ORIGIN)).toBe(false);
    expect(isLocalUrl('http://fan.example/x', HREF, ORIGIN)).toBe(false);
    expect(isLocalUrl('blob:https://elsewhere.test/uuid', HREF, ORIGIN)).toBe(false);
    expect(isLocalUrl('http://[bad', HREF, ORIGIN)).toBe(false);
  });
});

describe('restrictNetwork', () => {
  it("passes the app's own requests through and refuses MediaPipe's usage logger", async () => {
    const { s, fetch } = scope();
    const guard = restrictNetwork(s);
    await expect(s.fetch('/Spellglass/models/hand_landmarker.task')).resolves.toBeInstanceOf(Response);
    await expect(s.fetch(new URL(`${ORIGIN}/Spellglass/models/wasm/x.wasm`))).resolves.toBeInstanceOf(Response);
    await expect(s.fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' })).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(guard.refused).toEqual(['https://odml.pa.googleapis.com/v1/log']);
  });

  it('refuses XMLHttpRequest to other origins as well', () => {
    const { s, opened, FakeXhr } = scope();
    restrictNetwork(s);
    const xhr = new FakeXhr();
    xhr.open('GET', '/Spellglass/models/wasm/loader.js');
    expect(() => xhr.open('POST', 'https://telemetry.example/collect')).toThrow(TypeError);
    expect(opened).toEqual(['/Spellglass/models/wasm/loader.js']);
  });
});
