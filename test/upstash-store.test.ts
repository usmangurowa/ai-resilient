import { describe, expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';
import { LimitTracker } from '../src/index';
import { upstashStore } from '../src/stores/upstash';

interface SetCall {
  key: string;
  value: string;
  opts?: { px?: number } | undefined;
}

function fakeUpstash() {
  const map = new Map<string, unknown>();
  const setCalls: SetCall[] = [];
  const client = {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string, opts?: { px?: number }) {
      setCalls.push({ key, value, opts });
      map.set(key, value);
      return 'OK';
    },
  };
  return { client, map, setCalls };
}

describe('upstashStore', () => {
  it('stores and retrieves values', async () => {
    const { client } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    await store.set('a', '1');
    expect(await store.get('a')).toBe('1');
    expect(await store.get('missing')).toBeNull();
  });

  it('maps ttlMs to the px option', async () => {
    const { client, setCalls } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    await store.set('a', '1', 5000);
    expect(setCalls).toEqual([{ key: 'a', value: '1', opts: { px: 5000 } }]);
  });

  it('omits px when no ttlMs is given', async () => {
    const { client, setCalls } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    await store.set('a', '1');
    expect(setCalls).toEqual([{ key: 'a', value: '1', opts: undefined }]);
  });

  it('rounds fractional ttlMs to a positive integer, never 0', async () => {
    const { client, setCalls } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    await store.set('a', '1', 0.4);
    expect(setCalls[0]?.opts).toEqual({ px: 1 });
  });

  it('normalizes JSON-parsed values back to strings', async () => {
    const { client, map } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    // The Upstash SDK JSON-parses responses: "42" comes back as 42.
    map.set('n', 42);
    expect(await store.get('n')).toBe('42');
  });

  it('returns null for null or undefined values', async () => {
    const { client, map } = fakeUpstash();
    const store = upstashStore(client as unknown as Redis);
    expect(await store.get('missing')).toBeNull();
    map.set('u', undefined);
    expect(await store.get('u')).toBeNull();
  });

  it('satisfies LimitTracker as the real consumer', async () => {
    const { client } = fakeUpstash();
    const tracker = new LimitTracker({
      store: upstashStore(client as unknown as Redis),
      threshold: 0.8,
      cooldown: 60_000,
    });
    await tracker.recordRateLimit('m', 5000);
    expect(await tracker.isAvailable('m')).toBe(false);
  });
});
