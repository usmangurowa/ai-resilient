import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResilient, resilientStatus } from '../src/index';
import type { Store } from '../src/index';

type GenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;

function okResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    warnings: [],
  };
}

function okResultWithHeaders(
  text: string,
  headers: Record<string, string>,
): GenerateResult {
  return { ...okResult(text), response: { headers } };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode,
  });
}

describe('resilientStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports every model available on a fresh chain, with selfCounted only for declared limits', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { requestsPerMinute: 10 } },
        { model: secondary },
      ],
    });

    const status = await resilientStatus(model);
    expect(status.models).toHaveLength(2);
    expect(status.models[0]).toEqual({
      key: 'mock-a:model-a',
      provider: 'mock-a',
      modelId: 'model-a',
      available: true,
      selfCounted: {
        requestsLastMinute: 0,
        requestsLastDay: 0,
        tokensLastMinute: 0,
      },
    });
    expect(status.models[1]).toEqual({
      key: 'mock-b:model-b',
      provider: 'mock-b',
      modelId: 'model-b',
      available: true,
    });
    expect(status.models[0]).not.toHaveProperty('benchedUntil');
    expect(status.models[0]).not.toHaveProperty('headerLimits');
    expect(status.models[1]).not.toHaveProperty('selfCounted');
  });

  it('exposes benchedUntil after a 429 and clears it once the cooldown expires', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => {
        throw apiError(429);
      },
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      cooldown: 30_000,
    });

    const before = Date.now();
    await generateText({ model, prompt: 'hi', maxRetries: 0 });

    const benched = await resilientStatus(model);
    expect(benched.models[0]).toMatchObject({
      modelId: 'model-a',
      available: false,
      benchedUntil: before + 30_000,
    });
    expect(benched.models[1]).toMatchObject({
      modelId: 'model-b',
      available: true,
    });

    vi.advanceTimersByTime(30_001);
    const restored = await resilientStatus(model);
    expect(restored.models[0]?.available).toBe(true);
    expect(restored.models[0]).not.toHaveProperty('benchedUntil');
  });

  it('exposes headerLimits parsed from provider rate-limit headers', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'openai.chat',
      modelId: 'model-a',
      doGenerate: async () =>
        okResultWithHeaders('from A', {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '50',
          'x-ratelimit-reset-requests': '30s',
        }),
    });
    const model = createResilient({ models: [{ model: primary }] });

    await generateText({ model, prompt: 'hi', maxRetries: 0 });

    const status = await resilientStatus(model);
    expect(status.models[0]?.available).toBe(true);
    expect(status.models[0]?.headerLimits).toEqual({
      requests: {
        remaining: 50,
        limit: 100,
        resetsAt: Date.now() + 30_000,
      },
    });
  });

  it('counts self-tracked requests for models with declared limits', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('from A'),
    });
    const model = createResilient({
      models: [{ model: primary, limits: { requestsPerMinute: 10 } }],
    });

    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    await generateText({ model, prompt: 'hi', maxRetries: 0 });

    const status = await resilientStatus(model);
    expect(status.models[0]?.selfCounted?.requestsLastMinute).toBe(3);
    expect(status.models[0]?.selfCounted?.requestsLastDay).toBe(3);
  });

  it('fails open when the store throws: resolves with every model available', async () => {
    const failingStore: Store = {
      async get() {
        throw new Error('store down');
      },
      async set() {
        throw new Error('store down');
      },
    };
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { requestsPerMinute: 1 } },
        { model: secondary },
      ],
      store: failingStore,
    });

    const status = await resilientStatus(model);
    expect(status.models).toHaveLength(2);
    for (const entry of status.models) {
      expect(entry.available).toBe(true);
      expect(entry).not.toHaveProperty('benchedUntil');
      expect(entry).not.toHaveProperty('headerLimits');
      expect(entry).not.toHaveProperty('selfCounted');
    }
  });

  it('throws TypeError for models not created by createResilient', async () => {
    const plain = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
    });
    expect(() => resilientStatus(plain)).toThrow(TypeError);
    expect(() => resilientStatus(plain)).toThrow(/createResilient/);
  });

  it('sees bookkeeping from a call made immediately before (read-your-writes)', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('from A'),
    });
    const model = createResilient({
      models: [{ model: primary, limits: { requestsPerMinute: 10 } }],
    });

    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    // No extra awaiting: status() must flush pendingRecords itself.
    const status = await resilientStatus(model);
    expect(status.models[0]?.selfCounted?.requestsLastMinute).toBe(1);
  });

  describe('store reads', () => {
    function countingStore(): { store: Store; gets: string[] } {
      const map = new Map<string, string>();
      const gets: string[] = [];
      return {
        gets,
        store: {
          async get(key) {
            gets.push(key);
            return map.get(key) ?? null;
          },
          async set(key, value) {
            map.set(key, value);
          },
        },
      };
    }

    it('reads bench, headers, and usage exactly once each for a model with declared limits', async () => {
      const { store, gets } = countingStore();
      const primary = new MockLanguageModelV2({
        provider: 'mock-a',
        modelId: 'model-a',
      });
      const model = createResilient({
        models: [{ model: primary, limits: { requestsPerMinute: 10 } }],
        store,
      });

      await resilientStatus(model);
      expect(gets).toHaveLength(3);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:bench:')),
      ).toHaveLength(1);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:headers:')),
      ).toHaveLength(1);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:usage:')),
      ).toHaveLength(1);
    });

    it('reads only bench and headers for a model without declared limits', async () => {
      const { store, gets } = countingStore();
      const primary = new MockLanguageModelV2({
        provider: 'mock-a',
        modelId: 'model-a',
      });
      const model = createResilient({
        models: [{ model: primary }],
        store,
      });

      await resilientStatus(model);
      expect(gets).toHaveLength(2);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:bench:')),
      ).toHaveLength(1);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:headers:')),
      ).toHaveLength(1);
      expect(
        gets.filter((k) => k.startsWith('ai-resilient:usage:')),
      ).toHaveLength(0);
    });

    it('reports available and benchedUntil consistently from a single bench read', async () => {
      const { store } = countingStore();
      const benchedUntil = Date.now() + 60_000;
      await store.set(
        'ai-resilient:bench:mock-a:model-a',
        String(benchedUntil),
      );
      const primary = new MockLanguageModelV2({
        provider: 'mock-a',
        modelId: 'model-a',
      });
      const model = createResilient({
        models: [{ model: primary }],
        store,
      });

      const status = await resilientStatus(model);
      expect(status.models[0]).toMatchObject({
        available: false,
        benchedUntil,
      });
    });
  });
});
