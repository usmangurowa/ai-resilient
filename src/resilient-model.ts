import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { classifyError, getRetryAfterMs } from './classify-error';
import { AllModelsExhaustedError, type ModelAttempt } from './errors';
import { LimitTracker } from './limit-tracker';
import type { FallbackReason, ModelConfig, ResilientOptions } from './types';

type DoGenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;
type DoStreamResult = Awaited<ReturnType<LanguageModelV2['doStream']>>;

interface Candidate {
  config: ModelConfig;
  /** Unique store key: `provider:modelId` (+ index suffix on collision). */
  key: string;
}

interface PlanEntry {
  candidate: Candidate;
  /** True when the model was proactively filtered by the LimitTracker. */
  skip: boolean;
}

interface PendingFallback {
  from: string;
  reason: FallbackReason;
}

const PRELUDE_PART_TYPES = new Set(['stream-start', 'response-metadata']);

/**
 * A `LanguageModelV2` that transparently falls back across a chain of
 * models on rate-limit and transient errors, and proactively skips
 * models that are near a known rate limit.
 */
export class ResilientLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'ai-resilient';

  private readonly candidates: Candidate[];
  private readonly tracker: LimitTracker;
  private readonly onFallback: ResilientOptions['onFallback'];
  private readonly onError: ResilientOptions['onError'];

  constructor(options: {
    models: ModelConfig[];
    tracker: LimitTracker;
    onFallback?: ResilientOptions['onFallback'];
    onError?: ResilientOptions['onError'];
  }) {
    if (options.models.length === 0) {
      throw new Error('ai-resilient: at least one model is required');
    }
    const seen = new Map<string, number>();
    this.candidates = options.models.map((config) => {
      const base = `${config.model.provider}:${config.model.modelId}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { config, key: count === 0 ? base : `${base}#${count}` };
    });
    this.tracker = options.tracker;
    this.onFallback = options.onFallback;
    this.onError = options.onError;
  }

  get modelId(): string {
    return this.primary.modelId;
  }

  get supportedUrls(): LanguageModelV2['supportedUrls'] {
    return this.primary.supportedUrls;
  }

  private get primary(): LanguageModelV2 {
    // candidates is non-empty by construction
    return this.candidates[0]!.config.model;
  }

  /**
   * Order candidates and mark near-limit/benched ones as skipped. If
   * every model would be skipped, try all of them in configured order
   * anyway — attempting beats failing without trying.
   */
  private async buildPlan(): Promise<PlanEntry[]> {
    const plan: PlanEntry[] = [];
    for (const candidate of this.candidates) {
      const available = await this.tracker.isAvailable(
        candidate.key,
        candidate.config.limits,
      );
      plan.push({ candidate, skip: !available });
    }
    if (plan.every((entry) => entry.skip)) {
      for (const entry of plan) entry.skip = false;
    }
    return plan;
  }

  private fireFallbacks(pending: PendingFallback[], to: string): void {
    for (const { from, reason } of pending) {
      this.onFallback?.({ from, to, reason });
    }
    pending.length = 0;
  }

  /**
   * Handle a failed attempt: notify, classify, bench on rate-limit, and
   * queue the fallback notification. Rethrows fatal errors.
   */
  private async handleFailure(
    error: unknown,
    candidate: Candidate,
    attempts: ModelAttempt[],
    pending: PendingFallback[],
  ): Promise<void> {
    const modelId = candidate.config.model.modelId;
    this.onError?.(error, modelId);
    const classification = classifyError(error);
    if (classification === 'fatal') throw error;
    attempts.push({ modelId, error, classification });
    if (classification === 'rate-limit') {
      await this.tracker.recordRateLimit(candidate.key, getRetryAfterMs(error));
    }
    pending.push({ from: modelId, reason: classification });
  }

  private async recordSuccess(
    candidate: Candidate,
    headers: Record<string, string> | undefined,
    usage: LanguageModelV2Usage | undefined,
  ): Promise<void> {
    const totalTokens =
      usage?.totalTokens ??
      (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : undefined);
    await this.tracker.recordSuccess(candidate.key, {
      provider: candidate.config.model.provider,
      headers,
      totalTokens,
      limits: candidate.config.limits,
    });
  }

  async doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<DoGenerateResult> {
    const plan = await this.buildPlan();
    const attempts: ModelAttempt[] = [];
    const pending: PendingFallback[] = [];

    for (const entry of plan) {
      const { candidate } = entry;
      const modelId = candidate.config.model.modelId;
      if (entry.skip) {
        pending.push({ from: modelId, reason: 'proactive' });
        continue;
      }
      this.fireFallbacks(pending, modelId);
      try {
        const result = await candidate.config.model.doGenerate(options);
        await this.recordSuccess(
          candidate,
          result.response?.headers,
          result.usage,
        );
        return result;
      } catch (error) {
        await this.handleFailure(error, candidate, attempts, pending);
      }
    }
    throw new AllModelsExhaustedError(attempts);
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<DoStreamResult> {
    const plan = await this.buildPlan();
    const attempts: ModelAttempt[] = [];
    const pending: PendingFallback[] = [];
    let index = 0;

    const acquire = async (): Promise<{
      candidate: Candidate;
      result: DoStreamResult;
    }> => {
      while (index < plan.length) {
        const entry = plan[index++]!;
        const { candidate } = entry;
        const modelId = candidate.config.model.modelId;
        if (entry.skip) {
          pending.push({ from: modelId, reason: 'proactive' });
          continue;
        }
        this.fireFallbacks(pending, modelId);
        try {
          const result = await candidate.config.model.doStream(options);
          return { candidate, result };
        } catch (error) {
          await this.handleFailure(error, candidate, attempts, pending);
        }
      }
      throw new AllModelsExhaustedError(attempts);
    };

    // Try candidates until one produces content (or finishes cleanly)
    // before returning, so the returned request/response metadata always
    // belongs to the model that actually serves the stream.
    for (;;) {
      const { candidate, result } = await acquire();
      const reader = result.stream.getReader();
      const prelude: LanguageModelV2StreamPart[] = [];
      let firstContent: LanguageModelV2StreamPart | undefined;
      let usage: LanguageModelV2Usage | undefined;
      let done = false;

      try {
        for (;;) {
          const { done: readDone, value } = await reader.read();
          if (readDone) {
            done = true;
            break;
          }
          if (value.type === 'error') {
            // Pre-content stream error: treat like a failed call so we
            // can fall back to the next model.
            throw value.error;
          }
          if (value.type === 'finish') usage = value.usage;
          if (PRELUDE_PART_TYPES.has(value.type)) {
            prelude.push(value);
            continue;
          }
          firstContent = value;
          break;
        }
      } catch (error) {
        reader.cancel().catch(() => {});
        // Rethrows fatal errors; otherwise fall through to next candidate.
        await this.handleFailure(error, candidate, attempts, pending);
        continue;
      }

      // Committed: first content part arrived (or the stream finished).
      // Errors from here on propagate to the consumer unchanged.
      let preludeIndex = 0;
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        pull: async (controller) => {
          if (preludeIndex < prelude.length) {
            controller.enqueue(prelude[preludeIndex++]);
            return;
          }
          if (firstContent !== undefined) {
            const part = firstContent;
            firstContent = undefined;
            controller.enqueue(part);
            return;
          }
          if (!done) {
            const { done: readDone, value } = await reader.read();
            if (!readDone) {
              if (value.type === 'finish') usage = value.usage;
              controller.enqueue(value);
              return;
            }
            done = true;
          }
          await this.recordSuccess(candidate, result.response?.headers, usage);
          controller.close();
        },
        cancel: (reason) => reader.cancel(reason),
      });

      return {
        stream,
        ...(result.request !== undefined ? { request: result.request } : {}),
        ...(result.response !== undefined ? { response: result.response } : {}),
      };
    }
  }
}
