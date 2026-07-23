// Tests for provider-spec v4 (ai v7) support. Dev deps stay on ai v5 /
// provider v2, so v4 models are hand-rolled structural mocks here,
// mirroring test/resilient-v3.test.ts.
import { describe, expect, it } from 'vitest';
import { createResilient } from '../src/index';
import type { AnyLanguageModel, FallbackInfo } from '../src/index';

/** Nested usage shape shared by LanguageModelV3/V4 (no top-level totalTokens). */
function v4Usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input },
    outputTokens: { total: output, text: output },
  };
}

function v4GenerateResult(text: string, usage = v4Usage(3, 7)) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { type: 'stop' },
    usage,
    warnings: [],
  };
}

interface MockV4Options {
  provider?: string;
  modelId?: string;
  doGenerate?: () => PromiseLike<unknown>;
  doStream?: () => PromiseLike<unknown>;
}

interface MockV4 extends AnyLanguageModel<'v4'> {
  doGenerateCalls: unknown[];
  doStreamCalls: unknown[];
}

function mockV4Model(options: MockV4Options = {}): MockV4 {
  const doGenerateCalls: unknown[] = [];
  const doStreamCalls: unknown[] = [];
  return {
    specificationVersion: 'v4',
    provider: options.provider ?? 'mock-v4',
    modelId: options.modelId ?? 'model-v4',
    supportedUrls: {},
    doGenerateCalls,
    doStreamCalls,
    doGenerate(callOptions: unknown) {
      doGenerateCalls.push(callOptions);
      return (
        options.doGenerate?.() ?? Promise.resolve(v4GenerateResult('mock text'))
      );
    },
    doStream(callOptions: unknown) {
      doStreamCalls.push(callOptions);
      return (
        options.doStream?.() ?? Promise.resolve(v4StreamResult('mock text'))
      );
    },
  };
}

/** V4 stream including the new `raw` part type ahead of any content. */
function v4StreamResult(text: string, usage = v4Usage(3, 7)) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'raw', rawValue: { chunk: 1 } });
        controller.enqueue({ type: 'text-start', id: '1' });
        controller.enqueue({ type: 'text-delta', id: '1', delta: text });
        controller.enqueue({ type: 'text-end', id: '1' });
        controller.enqueue({
          type: 'finish',
          finishReason: { type: 'stop' },
          usage,
        });
        controller.close();
      },
    }),
  };
}

/** V4 stream that errors after a `raw` part but before any content part. */
function v4StreamErrorAfterRaw(error: unknown) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'raw', rawValue: { chunk: 1 } });
        controller.enqueue({ type: 'error', error });
        controller.close();
      },
    }),
  };
}

const callOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

async function readAll(
  stream: ReadableStream<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const parts: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe('provider-spec v4 support', () => {
  it('mirrors the wrapped models specification version', () => {
    const v4 = createResilient({ models: [{ model: mockV4Model() }] });
    expect(v4.specificationVersion).toBe('v4');
  });

  it('rejects a chain that mixes v4 with v3 models', () => {
    const v3Model = {
      ...mockV4Model(),
      specificationVersion: 'v3',
    } as unknown as AnyLanguageModel;
    expect(() =>
      createResilient({
        models: [{ model: mockV4Model() }, { model: v3Model }],
      }),
    ).toThrow(/same specification version.*v3, v4/);
  });

  it('falls back on a rate-limited v4 doGenerate', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = mockV4Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error('rate limited'), {
            statusCode: 429,
            responseHeaders: {},
          }),
        ),
    });
    const secondary = mockV4Model({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: () => Promise.resolve(v4GenerateResult('from B')),
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      onFallback: (info) => fallbacks.push(info),
    });

    const result = (await model.doGenerate(callOptions)) as {
      content: { type: string; text: string }[];
    };
    expect(result.content).toEqual([{ type: 'text', text: 'from B' }]);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'rate-limit' },
    ]);
  });

  it('counts nested v4 usage against tokensPerMinute limits', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = mockV4Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: () =>
        Promise.resolve(v4GenerateResult('from A', v4Usage(60, 35))),
    });
    const secondary = mockV4Model({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: () => Promise.resolve(v4GenerateResult('from B')),
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { tokensPerMinute: 100 } },
        { model: secondary },
      ],
      onFallback: (info) => fallbacks.push(info),
    });

    // First call records 95 tokens (60 + 35 from the nested totals),
    // putting the primary within the 0.1 threshold of its 100 tpm limit.
    await model.doGenerate(callOptions);
    await model.doGenerate(callOptions);

    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'proactive' },
    ]);
  });

  it('streams v4 parts through, including pre-content raw parts', async () => {
    const model = createResilient({
      models: [{ model: mockV4Model() }],
    });

    const result = (await model.doStream(callOptions)) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    const parts = await readAll(result.stream);
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'raw',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    // The buffered raw prelude part is replayed unchanged.
    expect(parts[1]).toEqual({ type: 'raw', rawValue: { chunk: 1 } });
  });

  it('falls back on a v4 stream error after raw but before content', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = mockV4Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: () =>
        Promise.resolve(
          v4StreamErrorAfterRaw(
            Object.assign(new Error('rate limited'), {
              statusCode: 429,
              responseHeaders: {},
            }),
          ),
        ),
    });
    const secondary = mockV4Model({
      provider: 'mock-b',
      modelId: 'model-b',
    });
    const model = createResilient({
      models: [{ model: primary }, { model: secondary }],
      onFallback: (info) => fallbacks.push(info),
    });

    const result = (await model.doStream(callOptions)) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    const parts = await readAll(result.stream);
    // Raw parts from the abandoned primary are discarded with it; only
    // the fallback stream's parts reach the consumer.
    expect(
      parts.filter((p) => p.type === 'text-delta').map((p) => p.delta),
    ).toEqual(['mock text']);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'rate-limit' },
    ]);
  });
});
