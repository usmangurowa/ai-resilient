import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllModelsExhaustedError, createResilient } from '../src/index';
import type { FallbackInfo, Store } from '../src/index';

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

function apiError(
  statusCode: number,
  headers?: Record<string, string>,
): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode,
    ...(headers !== undefined ? { responseHeaders: headers } : {}),
  });
}

describe('ResilientLanguageModel doGenerate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the primary model when it succeeds', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('from A'),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const { text } = await generateText({ model, prompt: 'hi', maxRetries: 0 });
    expect(text).toBe('from A');
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it('reports provider ai-resilient and mirrors the primary modelId', () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
    });
    const model = createResilient({ models: [{ model: primary }] });
    expect(model.provider).toBe('ai-resilient');
    expect(model.modelId).toBe('model-a');
  });

  it('falls back to the next model on 429 and fires callbacks', async () => {
    const fallbacks: FallbackInfo[] = [];
    const errors: { error: unknown; modelId: string }[] = [];
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
      onFallback: (info) => fallbacks.push(info),
      onError: (error, modelId) => errors.push({ error, modelId }),
    });

    const { text } = await generateText({ model, prompt: 'hi', maxRetries: 0 });
    expect(text).toBe('from B');
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'rate-limit' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.modelId).toBe('model-a');
  });

  it('benches a 429 model for the cooldown and restores it after expiry', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: vi
        .fn<LanguageModelV2['doGenerate']>()
        .mockRejectedValueOnce(apiError(429))
        .mockResolvedValue(okResult('from A')),
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

    // First call: A rate-limits, falls back to B and benches A.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    expect(primary.doGenerateCalls).toHaveLength(1);

    // Second call while benched: A is skipped proactively.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    expect(primary.doGenerateCalls).toHaveLength(1);

    // After cooldown expiry, A is tried again.
    vi.advanceTimersByTime(30_001);
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it('benches using retry-after when present', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: vi
        .fn<LanguageModelV2['doGenerate']>()
        .mockRejectedValueOnce(apiError(429, { 'retry-after': '5' }))
        .mockResolvedValue(okResult('from A')),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      cooldown: 60_000,
    });

    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    vi.advanceTimersByTime(5001); // past retry-after, well before cooldown
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
  });

  it('does NOT fall back on 401 — throws immediately', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => {
        throw apiError(401);
      },
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    await expect(
      generateText({ model, prompt: 'hi', maxRetries: 0 }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it('falls back on 5xx without benching the model', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: vi
        .fn<LanguageModelV2['doGenerate']>()
        .mockRejectedValueOnce(apiError(503))
        .mockResolvedValue(okResult('from A')),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      onFallback: (info) => fallbacks.push(info),
    });

    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'transient' },
    ]);
    // No bench: the next call tries A first again.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
  });

  it('proactively skips a model near its declared limit', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('from A'),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { requestsPerMinute: 2 } },
        { model: secondary },
      ],
      threshold: 0.5, // skip when usage >= 1 of 2 rpm
      onFallback: (info) => fallbacks.push(info),
    });

    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'proactive' },
    ]);

    // Window slides: A becomes available again.
    vi.advanceTimersByTime(60_001);
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
  });

  it('proactively skips a model based on parsed provider headers', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'openai.chat',
      modelId: 'model-a',
      doGenerate: async () =>
        okResultWithHeaders('from A', {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '2',
          'x-ratelimit-reset-requests': '30s',
        }),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      threshold: 0.1,
    });

    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
    // Headers said only 2% remaining → A is skipped now.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    expect(primary.doGenerateCalls).toHaveLength(1);

    // Snapshot expires at reset time → A is tried again.
    vi.advanceTimersByTime(30_001);
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
  });

  it('tries all models in order when every model is proactively filtered', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('from A'),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { requestsPerMinute: 1 } },
        { model: secondary, limits: { requestsPerMinute: 1 } },
      ],
      threshold: 0.5,
    });

    // Exhaust both declared limits.
    await generateText({ model, prompt: 'hi', maxRetries: 0 }); // A
    await generateText({ model, prompt: 'hi', maxRetries: 0 }); // B
    // Both near-limit → attempted anyway, in configured order.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it('throws AllModelsExhaustedError with per-model attempts', async () => {
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
      doGenerate: async () => {
        throw apiError(503);
      },
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const error = await generateText({
      model,
      prompt: 'hi',
      maxRetries: 0,
    }).catch((e: unknown) => e);

    expect(AllModelsExhaustedError.isInstance(error)).toBe(true);
    const exhausted = error as AllModelsExhaustedError;
    expect(exhausted.attempts).toHaveLength(2);
    expect(exhausted.attempts[0]).toMatchObject({
      modelId: 'model-a',
      classification: 'rate-limit',
    });
    expect(exhausted.attempts[1]).toMatchObject({
      modelId: 'model-b',
      classification: 'transient',
    });
    expect((exhausted.attempts[0]?.error as APICallError).statusCode).toBe(429);
    expect(exhausted.message).toContain('model-a (rate-limit)');
    expect(exhausted.message).toContain('model-b (transient)');
  });

  it('degrades gracefully when the store fails', async () => {
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
      doGenerate: vi
        .fn<LanguageModelV2['doGenerate']>()
        .mockRejectedValueOnce(apiError(429))
        .mockResolvedValue(okResult('from A')),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: async () => okResult('from B'),
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { requestsPerMinute: 1 } },
        { model: secondary },
      ],
      store: failingStore,
    });

    // Reactive fallback still works despite the broken store.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from B');
    // No benching possible → A is assumed available and tried again.
    expect(
      (await generateText({ model, prompt: 'hi', maxRetries: 0 })).text,
    ).toBe('from A');
  });

  it('does not block the response on slow store writes (read-your-writes preserved)', async () => {
    vi.useRealTimers(); // stalled-promise interplay with fake timers can hang
    let resolveWrite: (() => void) | undefined;
    const backing = new Map<string, string>();
    const store: Store = {
      get: async (key) => backing.get(key) ?? null,
      set: async (key, value) => {
        backing.set(key, value);
        // First write stalls until released, simulating a slow network store.
        if (resolveWrite === undefined) {
          await new Promise<void>((r) => (resolveWrite = r));
        }
      },
    };
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult('one'),
    });
    const model = createResilient({
      models: [{ model: primary, limits: { requestsPerMinute: 1 } }],
      store,
    });

    // First call must resolve even though the store write is stalled.
    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    resolveWrite?.();

    // Second call flushes the pending record in buildPlan, then proceeds
    // (single model: the all-skip override still tries it).
    await generateText({ model, prompt: 'hi', maxRetries: 0 });
    expect(primary.doGenerateCalls).toHaveLength(2);
    // Usage bookkeeping landed in the store despite being off-path.
    expect([...backing.keys()].some((k) => k.includes(':usage:'))).toBe(true);
  });

  it('requires at least one model', () => {
    expect(() => createResilient({ models: [] })).toThrow(/at least one model/);
  });
});
