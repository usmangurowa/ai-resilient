import { APICallError } from '@ai-sdk/provider';
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { streamText } from 'ai';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createResilient } from '../src/index';
import type { FallbackInfo } from '../src/index';
import { AllModelsExhaustedError } from '../src/index';

const USAGE = { inputTokens: 3, outputTokens: 7, totalTokens: 10 };

function textChunks(text: string): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'response-metadata',
      id: 'resp-1',
      modelId: 'x',
      timestamp: new Date(0),
    },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: text },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage: USAGE },
  ];
}

function streamOf(chunks: LanguageModelV2StreamPart[]) {
  return { stream: simulateReadableStream({ chunks }) };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode,
  });
}

const callOptions: LanguageModelV2CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

async function readAllParts(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const parts: LanguageModelV2StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe('ResilientLanguageModel doStream', () => {
  it('streams from the primary model on success', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => streamOf(textChunks('Hello from A')),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const result = streamText({ model, prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('Hello from A');
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it('falls back when doStream rejects with a rate limit', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => {
        throw apiError(429);
      },
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      onFallback: (info) => fallbacks.push(info),
    });

    const result = streamText({ model, prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('Hello from B');
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'rate-limit' },
    ]);
  });

  it('falls back on an error part before the first content chunk', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () =>
        streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: apiError(529) },
        ]),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      onFallback: (info) => fallbacks.push(info),
    });

    const { stream } = await model.doStream(callOptions);
    const parts = await readAllParts(stream);

    const deltas = parts.filter((p) => p.type === 'text-delta');
    expect(deltas).toEqual([
      { type: 'text-delta', id: '1', delta: 'Hello from B' },
    ]);
    // The failed model's prelude parts are not leaked to the caller.
    expect(parts.filter((p) => p.type === 'stream-start')).toHaveLength(1);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'transient' },
    ]);
  });

  it('propagates error parts after the first content chunk without fallback', async () => {
    const midStreamError = apiError(500);
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () =>
        streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'partial' },
          { type: 'error', error: midStreamError },
        ]),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const { stream } = await model.doStream(callOptions);
    const parts = await readAllParts(stream);

    expect(
      parts.some((p) => p.type === 'error' && p.error === midStreamError),
    ).toBe(true);
    expect(
      parts.filter((p) => p.type === 'text-delta').map((p) => p.delta),
    ).toEqual(['partial']);
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it('propagates stream failures after the first content chunk', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '1' });
            controller.enqueue({
              type: 'text-delta',
              id: '1',
              delta: 'partial',
            });
            controller.error(new Error('connection reset'));
          },
        }),
      }),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const { stream } = await model.doStream(callOptions);
    await expect(readAllParts(stream)).rejects.toThrow('connection reset');
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it('throws immediately (no fallback) on a fatal pre-content error', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => {
        throw apiError(401);
      },
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    await expect(model.doStream(callOptions)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it('errors the stream with a fatal error from a pre-content error part', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () =>
        streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: apiError(401) },
        ]),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const { stream } = await model.doStream(callOptions);
    await expect(readAllParts(stream)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it('errors the stream with AllModelsExhaustedError when every model fails pre-content', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () =>
        streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: apiError(429) },
        ]),
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf([{ type: 'error', error: apiError(503) }]),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const { stream } = await model.doStream(callOptions);
    const error = await readAllParts(stream).catch((e: unknown) => e);
    expect(AllModelsExhaustedError.isInstance(error)).toBe(true);
    const exhausted = error as AllModelsExhaustedError;
    expect(exhausted.attempts.map((a) => a.classification)).toEqual([
      'rate-limit',
      'transient',
    ]);
  });

  it('benches a model after a pre-content stream rate limit', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => {
        throw apiError(429);
      },
    });
    const secondary = new MockLanguageModelV2({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: async () => streamOf(textChunks('Hello from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      cooldown: 60_000,
    });

    const first = streamText({ model, prompt: 'hi', maxRetries: 0 });
    expect(await first.text).toBe('Hello from B');
    expect(primary.doStreamCalls).toHaveLength(1);

    // While benched, A is skipped without being called.
    const second = streamText({ model, prompt: 'hi', maxRetries: 0 });
    expect(await second.text).toBe('Hello from B');
    expect(primary.doStreamCalls).toHaveLength(1);
  });
});
