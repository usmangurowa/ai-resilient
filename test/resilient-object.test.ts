import { APICallError } from '@ai-sdk/provider';
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { generateObject, streamObject } from 'ai';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createResilient } from '../src/index';

type GenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;

const schema = z.object({ name: z.string(), age: z.number() });
const JSON_TEXT = '{"name":"Ada","age":36}';
const USAGE = { inputTokens: 3, outputTokens: 7, totalTokens: 10 };

function okResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    warnings: [],
  };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode,
  });
}

function jsonChunks(): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: '{"name":"Ada",' },
    { type: 'text-delta', id: '1', delta: '"age":36}' },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage: USAGE },
  ];
}

function streamOf(chunks: LanguageModelV2StreamPart[]) {
  return { stream: simulateReadableStream({ chunks }) };
}

describe('generateObject through the resilient wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds when the primary model returns JSON text', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: async () => okResult(JSON_TEXT),
    });
    const model = createResilient({ models: [{ model: primary }] });

    const result = await generateObject({
      model,
      schema,
      prompt: 'who?',
      maxRetries: 0,
    });

    expect(result.object).toEqual({ name: 'Ada', age: 36 });
  });

  it('falls back to the secondary model on a 429 from the primary', async () => {
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
      doGenerate: async () => okResult(JSON_TEXT),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const result = await generateObject({
      model,
      schema,
      prompt: 'who?',
      maxRetries: 0,
    });

    expect(result.object).toEqual({ name: 'Ada', age: 36 });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });
});

describe('streamObject through the resilient wrapper', () => {
  it('succeeds when the primary model streams JSON deltas', async () => {
    const primary = new MockLanguageModelV2({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: async () => streamOf(jsonChunks()),
    });
    const model = createResilient({ models: [{ model: primary }] });

    const result = streamObject({
      model,
      schema,
      prompt: 'who?',
      maxRetries: 0,
    });
    // Iterating partialObjectStream drives the underlying ReadableStream so
    // the `_object` deferred promise resolves. Collect the last partial to
    // verify incremental emission and satisfy the unused-variable rule.
    let lastPartial: unknown;
    for await (const partial of result.partialObjectStream) {
      lastPartial = partial;
    }
    expect(lastPartial).toEqual({ name: 'Ada', age: 36 });
    expect(await result.object).toEqual({ name: 'Ada', age: 36 });
  });

  it('falls back to the secondary model when the primary rejects before streaming', async () => {
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
      doStream: async () => streamOf(jsonChunks()),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
    });

    const result = streamObject({
      model,
      schema,
      prompt: 'who?',
      maxRetries: 0,
    });
    let lastPartial: unknown;
    for await (const partial of result.partialObjectStream) {
      lastPartial = partial;
    }
    expect(lastPartial).toEqual({ name: 'Ada', age: 36 });
    expect(await result.object).toEqual({ name: 'Ada', age: 36 });
  });
});
