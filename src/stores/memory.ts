import type { Store } from '../types';

interface Entry {
  value: string;
  expiresAt?: number;
}

/**
 * In-process `Store` backed by a `Map` with lazy TTL eviction.
 * Suitable for long-running servers; use a Redis/KV adapter for
 * serverless deployments.
 */
export function memoryStore(): Store {
  const map = new Map<string, Entry>();

  function evictIfExpired(key: string): Entry | undefined {
    const entry = map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      const entry = evictIfExpired(key);
      return entry?.value ?? null;
    },
    async set(key, value, ttlMs) {
      map.set(key, {
        value,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      });
    },
  };
}
