// Tests for provider-spec v3 (ai v6) support. MockLanguageModelV2 from
// 'ai/test' (ai v5 dev dep) only produces v2 models, so v3 models are
// hand-rolled structural mocks here.
import { describe, expect, it } from 'vitest';
import { createResilient } from '../src/index';
import type { AnyLanguageModel, FallbackInfo } from '../src/index';

/** Nested usage shape introduced by LanguageModelV3 (no top-level totalTokens). */
function v3Usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input },
    outputTokens: { total: output, text: output },
  };
}

function v3GenerateResult(text: string, usage = v3Usage(3, 7)) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { type: 'stop' },
    usage,
    warnings: [],
  };
}

interface MockV3Options {
  provider?: string;
  modelId?: string;
  doGenerate?: () => PromiseLike<unknown>;
  doStream?: () => PromiseLike<unknown>;
}

interface MockV3 extends AnyLanguageModel<'v3'> {
  doGenerateCalls: unknown[];
  doStreamCalls: unknown[];
}

function mockV3Model(options: MockV3Options = {}): MockV3 {
  const doGenerateCalls: unknown[] = [];
  const doStreamCalls: unknown[] = [];
  return {
    specificationVersion: 'v3',
    provider: options.provider ?? 'mock-v3',
    modelId: options.modelId ?? 'model-v3',
    supportedUrls: {},
    doGenerateCalls,
    doStreamCalls,
    doGenerate(callOptions: unknown) {
      doGenerateCalls.push(callOptions);
      return (
        options.doGenerate?.() ?? Promise.resolve(v3GenerateResult('mock text'))
      );
    },
    doStream(callOptions: unknown) {
      doStreamCalls.push(callOptions);
      return (
        options.doStream?.() ?? Promise.resolve(v3StreamResult('mock text'))
      );
    },
  };
}

function v3StreamResult(text: string, usage = v3Usage(3, 7)) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
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

describe('provider-spec v3 support', () => {
  it('mirrors the wrapped models specification version', () => {
    const v3 = createResilient({ models: [{ model: mockV3Model() }] });
    expect(v3.specificationVersion).toBe('v3');
  });

  it('rejects a chain that mixes specification versions', () => {
    const v2Model = {
      ...mockV3Model(),
      specificationVersion: 'v2',
    } as unknown as AnyLanguageModel;
    expect(() =>
      createResilient({
        models: [{ model: mockV3Model() }, { model: v2Model }],
      }),
    ).toThrow(/same specification version.*v2, v3/);
  });

  it('passes v3 generate results through unchanged', async () => {
    const usage = v3Usage(11, 22);
    const model = createResilient({
      models: [
        {
          model: mockV3Model({
            doGenerate: () => Promise.resolve(v3GenerateResult('hello', usage)),
          }),
        },
      ],
    });

    const result = (await model.doGenerate(callOptions)) as Record<
      string,
      unknown
    >;
    // The nested v3 usage object must not be flattened or stringified.
    expect(result.usage).toBe(usage);
    expect(result.finishReason).toEqual({ type: 'stop' });
  });

  it('counts nested v3 usage against tokensPerMinute limits', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = mockV3Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doGenerate: () =>
        Promise.resolve(v3GenerateResult('from A', v3Usage(60, 35))),
    });
    const secondary = mockV3Model({
      provider: 'mock-b',
      modelId: 'model-b',
      doGenerate: () => Promise.resolve(v3GenerateResult('from B')),
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

  it('counts v3 stream finish usage against tokensPerMinute limits', async () => {
    const primary = mockV3Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: () =>
        Promise.resolve(v3StreamResult('from A', v3Usage(60, 35))),
    });
    const secondary = mockV3Model({
      provider: 'mock-b',
      modelId: 'model-b',
      doStream: () => Promise.resolve(v3StreamResult('from B')),
    });
    const model = createResilient({
      models: [
        { model: primary, limits: { tokensPerMinute: 100 } },
        { model: secondary },
      ],
    });

    const first = (await model.doStream(callOptions)) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    await readAll(first.stream);
    const second = (await model.doStream(callOptions)) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    const parts = await readAll(second.stream);

    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(
      parts.filter((p) => p.type === 'text-delta').map((p) => p.delta),
    ).toEqual(['from B']);
    // The v3 finish part passes through unchanged.
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.usage).toEqual(v3Usage(3, 7));
  });

  it('falls back across v3 models on a pre-content stream error', async () => {
    const fallbacks: FallbackInfo[] = [];
    const primary = mockV3Model({
      provider: 'mock-a',
      modelId: 'model-a',
      doStream: () =>
        Promise.reject(
          Object.assign(new Error('rate limited'), {
            statusCode: 429,
            isRetryable: true,
          }),
        ),
    });
    const secondary = mockV3Model({
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
    expect(
      parts.filter((p) => p.type === 'text-delta').map((p) => p.delta),
    ).toEqual(['mock text']);
    expect(fallbacks).toEqual([
      { from: 'model-a', to: 'model-b', reason: 'rate-limit' },
    ]);
  });
});
