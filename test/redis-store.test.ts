import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { LimitTracker } from '../src/index';
import { redisStore } from '../src/stores/redis';

interface SetCall {
  key: string;
  value: string;
  mode?: string | undefined;
  ttl?: number | undefined;
}

function fakeRedis() {
  const map = new Map<string, string>();
  const setCalls: SetCall[] = [];
  const client = {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string, mode?: string, ttl?: number) {
      setCalls.push({ key, value, mode, ttl });
      map.set(key, value);
      return 'OK';
    },
  };
  return { client, setCalls };
}

describe('redisStore', () => {
  it('stores and retrieves values', async () => {
    const { client } = fakeRedis();
    const store = redisStore(client as unknown as Redis);
    await store.set('a', '1');
    expect(await store.get('a')).toBe('1');
    expect(await store.get('missing')).toBeNull();
  });

  it('passes PX with the TTL when ttlMs is given', async () => {
    const { client, setCalls } = fakeRedis();
    const store = redisStore(client as unknown as Redis);
    await store.set('a', '1', 5000);
    expect(setCalls).toEqual([{ key: 'a', value: '1', mode: 'PX', ttl: 5000 }]);
  });

  it('omits PX when no ttlMs is given', async () => {
    const { client, setCalls } = fakeRedis();
    const store = redisStore(client as unknown as Redis);
    await store.set('a', '1');
    expect(setCalls).toEqual([
      { key: 'a', value: '1', mode: undefined, ttl: undefined },
    ]);
  });

  it('rounds fractional ttlMs to a positive integer, never 0', async () => {
    const { client, setCalls } = fakeRedis();
    const store = redisStore(client as unknown as Redis);
    await store.set('a', '1', 0.4);
    expect(setCalls[0]?.ttl).toBe(1);
    await store.set('b', '2', 1500.6);
    expect(setCalls[1]?.ttl).toBe(1501);
  });

  it('satisfies LimitTracker as the real consumer', async () => {
    const { client } = fakeRedis();
    const tracker = new LimitTracker({
      store: redisStore(client as unknown as Redis),
      threshold: 0.8,
      cooldown: 60_000,
    });
    await tracker.recordRateLimit('m', 5000);
    expect(await tracker.isAvailable('m')).toBe(false);
  });
});
