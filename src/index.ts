import { LimitTracker } from './limit-tracker';
import { ResilientLanguageModel } from './resilient-model';
import { memoryStore } from './stores/memory';
import type {
  AnyLanguageModel,
  ResilientOptions,
  SpecificationVersion,
} from './types';

export { AllModelsExhaustedError, type ModelAttempt } from './errors';
export { classifyError, getRetryAfterMs } from './classify-error';
export { memoryStore } from './stores/memory';
export { LimitTracker } from './limit-tracker';
export { parseRateLimitHeaders, type ParsedRateLimit } from './header-parsers';
export type {
  AnyLanguageModel,
  ErrorClassification,
  FallbackInfo,
  FallbackReason,
  Limits,
  ModelConfig,
  ResilientOptions,
  SpecificationVersion,
  Store,
} from './types';

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Create a resilient language model that transparently falls back across
 * the configured models on rate-limit/transient errors and proactively
 * switches away from models near a known rate limit.
 *
 * The returned model mirrors the specification version of the models it
 * wraps — `LanguageModelV2` for ai v5 models, `LanguageModelV3` for
 * ai v6 models — so it works with `generateText`, `streamText`,
 * `generateObject`, and `streamObject` on either SDK major. Mixing spec
 * versions in one chain throws.
 */
export function createResilient<Version extends SpecificationVersion>(
  options: ResilientOptions<Version>,
): AnyLanguageModel<Version> {
  const tracker = new LimitTracker({
    store: options.store ?? memoryStore(),
    threshold: options.threshold ?? DEFAULT_THRESHOLD,
    cooldown: options.cooldown ?? DEFAULT_COOLDOWN_MS,
  });
  return new ResilientLanguageModel({
    models: options.models,
    tracker,
    ...(options.onFallback !== undefined
      ? { onFallback: options.onFallback }
      : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  }) as unknown as AnyLanguageModel<Version>;
}
