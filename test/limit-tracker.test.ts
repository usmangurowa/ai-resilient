import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitTracker } from '../src/limit-tracker';
import { memoryStore } from '../src/stores/memory';
import type { Store } from '../src/types';

function makeTracker(overrides?: {
  store?: Store;
  threshold?: number;
  cooldown?: number;
}): LimitTracker {
  return new LimitTracker({
    store: overrides?.store ?? memoryStore(),
    threshold: overrides?.threshold ?? 0.1,
    cooldown: overrides?.cooldown ?? 60_000,
  });
}

describe('LimitTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('benching', () => {
    it('benches a model for the cooldown after a rate limit', async () => {
      const tracker = makeTracker({ cooldown: 60_000 });
      await tracker.recordRateLimit('m1');
      expect(await tracker.isAvailable('m1')).toBe(false);
      vi.advanceTimersByTime(59_999);
      expect(await tracker.isAvailable('m1')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await tracker.isAvailable('m1')).toBe(true);
    });

    it('uses retry-after over the cooldown when provided', async () => {
      const tracker = makeTracker({ cooldown: 60_000 });
      await tracker.recordRateLimit('m1', 5000);
      vi.advanceTimersByTime(4999);
      expect(await tracker.isAvailable('m1')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await tracker.isAvailable('m1')).toBe(true);
    });

    it('does not affect other models', async () => {
      const tracker = makeTracker();
      await tracker.recordRateLimit('m1');
      expect(await tracker.isAvailable('m2')).toBe(true);
    });
  });

  describe('self-counted declared limits', () => {
    const limits = { requestsPerMinute: 10 };

    it('marks a model unavailable when usage nears the declared rpm', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      // (1 - 0.1) * 10 = 9 → available until the 9th request lands
      for (let i = 0; i < 8; i++) {
        await tracker.recordSuccess('m1', { provider: 'test', limits });
      }
      expect(await tracker.isAvailable('m1', limits)).toBe(true);
      await tracker.recordSuccess('m1', { provider: 'test', limits });
      expect(await tracker.isAvailable('m1', limits)).toBe(false);
    });

    it('slides the window: old requests stop counting', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      for (let i = 0; i < 9; i++) {
        await tracker.recordSuccess('m1', { provider: 'test', limits });
      }
      expect(await tracker.isAvailable('m1', limits)).toBe(false);
      vi.advanceTimersByTime(59_999);
      expect(await tracker.isAvailable('m1', limits)).toBe(false);
      vi.advanceTimersByTime(2);
      expect(await tracker.isAvailable('m1', limits)).toBe(true);
    });

    it('counts requests across window boundaries correctly', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      for (let i = 0; i < 5; i++) {
        await tracker.recordSuccess('m1', { provider: 'test', limits });
      }
      vi.advanceTimersByTime(30_000);
      for (let i = 0; i < 4; i++) {
        await tracker.recordSuccess('m1', { provider: 'test', limits });
      }
      // 9 requests inside the last 60s → unavailable
      expect(await tracker.isAvailable('m1', limits)).toBe(false);
      // first batch (5) slides out → 4 remain
      vi.advanceTimersByTime(30_001);
      expect(await tracker.isAvailable('m1', limits)).toBe(true);
    });

    it('tracks tokensPerMinute', async () => {
      const tokenLimits = { tokensPerMinute: 1000 };
      const tracker = makeTracker({ threshold: 0.1 });
      await tracker.recordSuccess('m1', {
        provider: 'test',
        limits: tokenLimits,
        totalTokens: 800,
      });
      expect(await tracker.isAvailable('m1', tokenLimits)).toBe(true);
      await tracker.recordSuccess('m1', {
        provider: 'test',
        limits: tokenLimits,
        totalTokens: 150,
      });
      // 950 >= 900 → unavailable
      expect(await tracker.isAvailable('m1', tokenLimits)).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(await tracker.isAvailable('m1', tokenLimits)).toBe(true);
    });

    it('tracks requestsPerDay over a 24h window', async () => {
      const dayLimits = { requestsPerDay: 10 };
      const tracker = makeTracker({ threshold: 0.1 });
      for (let i = 0; i < 9; i++) {
        await tracker.recordSuccess('m1', {
          provider: 'test',
          limits: dayLimits,
        });
      }
      expect(await tracker.isAvailable('m1', dayLimits)).toBe(false);
      vi.advanceTimersByTime(2 * 60_000);
      // still within 24h
      expect(await tracker.isAvailable('m1', dayLimits)).toBe(false);
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(await tracker.isAvailable('m1', dayLimits)).toBe(true);
    });
  });

  describe('provider header limits', () => {
    it('marks a model unavailable when parsed headers show low remaining', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      await tracker.recordSuccess('m1', {
        provider: 'openai.chat',
        headers: {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '5',
          'x-ratelimit-reset-requests': '30s',
        },
      });
      expect(await tracker.isAvailable('m1')).toBe(false);
    });

    it('stays available when plenty of remaining quota', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      await tracker.recordSuccess('m1', {
        provider: 'openai.chat',
        headers: {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '95',
        },
      });
      expect(await tracker.isAvailable('m1')).toBe(true);
    });

    it('header snapshot expires at reset time', async () => {
      const tracker = makeTracker({ threshold: 0.1 });
      await tracker.recordSuccess('m1', {
        provider: 'openai.chat',
        headers: {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '10s',
        },
      });
      expect(await tracker.isAvailable('m1')).toBe(false);
      vi.advanceTimersByTime(10_001);
      expect(await tracker.isAvailable('m1')).toBe(true);
    });

    it('treats zero remaining tokens as unavailable', async () => {
      const tracker = makeTracker();
      await tracker.recordSuccess('m1', {
        provider: 'anthropic.messages',
        headers: { 'anthropic-ratelimit-tokens-remaining': '0' },
      });
      expect(await tracker.isAvailable('m1')).toBe(false);
    });
  });

  describe('store failure degradation', () => {
    const failingStore: Store = {
      async get() {
        throw new Error('store down');
      },
      async set() {
        throw new Error('store down');
      },
    };

    it('isAvailable returns true when the store throws', async () => {
      const tracker = makeTracker({ store: failingStore });
      expect(await tracker.isAvailable('m1', { requestsPerMinute: 1 })).toBe(
        true,
      );
    });

    it('recordSuccess and recordRateLimit do not throw', async () => {
      const tracker = makeTracker({ store: failingStore });
      await expect(
        tracker.recordSuccess('m1', {
          provider: 'openai.chat',
          headers: { 'x-ratelimit-remaining-requests': '0' },
          limits: { requestsPerMinute: 1 },
        }),
      ).resolves.toBeUndefined();
      await expect(tracker.recordRateLimit('m1')).resolves.toBeUndefined();
    });
  });
});
