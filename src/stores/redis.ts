import type { Redis } from 'ioredis';
import type { Store } from '../types';

/**
 * `Store` adapter backed by an ioredis client. Pass an existing client;
 * the adapter never creates or closes connections. Store failures are
 * tolerated by the core (fail-open), so no error handling is needed here.
 */
export function redisStore(redis: Redis): Store {
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) {
        // PX must be a positive integer; guard sub-millisecond TTLs.
        await redis.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)));
      } else {
        await redis.set(key, value);
      }
    },
  };
}
