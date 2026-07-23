import type { Redis } from '@upstash/redis';
import type { Store } from '../types';

/**
 * `Store` adapter backed by an @upstash/redis client (HTTP; suits
 * serverless/edge). Pass an existing client; values are normalized back
 * to strings because the Upstash SDK JSON-parses responses.
 */
export function upstashStore(redis: Redis): Store {
  return {
    async get(key) {
      const value = await redis.get<unknown>(key);
      if (value === null || value === undefined) return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) {
        await redis.set(key, value, { px: Math.max(1, Math.round(ttlMs)) });
      } else {
        await redis.set(key, value);
      }
    },
  };
}
