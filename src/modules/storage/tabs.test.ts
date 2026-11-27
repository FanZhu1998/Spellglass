// The relay to the app's other tabs on its own, over a channel that, unlike a BroadcastChannel, hands
// every post to every member, its sender too. The real channel between two kernels is covered in
// storage.test.ts.

import { describe, expect, it } from 'vitest';
import type { StorageChanged } from '../../contracts';
import { TabRelay, readMessage, type TabChannel } from './tabs';

function echoingChannels() {
  const members = new Set<((event: MessageEvent) => void)[]>();
  return (): TabChannel => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    members.add(listeners);
    return {
      postMessage: (data) => {
        for (const m of members) for (const l of m) l({ data } as MessageEvent);
      },
      addEventListener: (_type, listener) => listeners.push(listener),
      close: () => members.delete(listeners),
    };
  };
}

function relay(open: () => TabChannel, mode: 'indexeddb' | 'memory' | null = 'indexeddb') {
  const heard: StorageChanged[] = [];
  const r = new TabRelay({ open, dbName: 'db', mode: () => mode, heard: (c) => heard.push(c) });
  r.open();
  return { r, heard };
}

describe('TabRelay', () => {
  it('never hands a tab its own change back, whatever the channel does', () => {
    const open = echoingChannels();
    const a = relay(open);
    const b = relay(open);
    a.r.post({ stores: ['progress'], reason: 'put', keys: ['lumos'] });
    expect(a.heard).toEqual([]);
    expect(b.heard).toEqual([{ stores: ['progress'], reason: 'other-tab', keys: ['lumos'] }]);
  });

  it('carries on without telling anyone where no channel can be opened', () => {
    const errors: string[] = [];
    const r = new TabRelay({
      open: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      },
      dbName: 'db', mode: () => 'indexeddb', heard: () => undefined, onError: (what) => errors.push(what),
    });
    r.open();
    expect(() => r.post({ stores: ['kv'], reason: 'put', keys: ['k'] })).not.toThrow();
    expect(errors).toEqual(['could not open the channel to the other tabs']);
  });
});

describe('readMessage', () => {
  it('reads a change of known stores from another tab, and nothing else', () => {
    expect(readMessage({ from: 'b', stores: ['kv', 'kv'], keys: ['a'] }, 'a')).toEqual({ stores: ['kv'], reason: 'other-tab', keys: ['a'] });
    expect(readMessage({ from: 'a', stores: ['kv'] }, 'a')).toBeNull();
    expect(readMessage({ stores: ['kv'] }, 'a')).toBeNull();
    expect(readMessage({ from: 'b', stores: [] }, 'a')).toBeNull();
    expect(readMessage({ from: 'b', stores: ['kv'], keys: [] }, 'a')).toEqual({ stores: ['kv'], reason: 'other-tab' });
    expect(readMessage(null, 'a')).toBeNull();
  });
});
