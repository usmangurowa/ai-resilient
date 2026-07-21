import type { LanguageModelV2 } from '@ai-sdk/provider';

/**
 * User-declared rate limits for a model, used for self-counted tracking
 * when the provider exposes no rate-limit headers.
 */
export interface Limits {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerMinute?: number;
}

/** Configuration for a single model in the fallback chain. */
export interface ModelConfig {
  model: LanguageModelV2;
  limits?: Limits;
}

/** Result of classifying an error. */
export type ErrorClassification = 'rate-limit' | 'transient' | 'fatal';

/** Why a fallback from one model to another happened. */
export type FallbackReason = 'rate-limit' | 'transient' | 'proactive';

/** Information passed to the `onFallback` callback. */
export interface FallbackInfo {
  /** modelId of the model being switched away from. */
  from: string;
  /** modelId of the model being switched to. */
  to: string;
  reason: FallbackReason;
}

/**
 * Pluggable persistence for rate-limit state (bench timers, usage counters,
 * parsed header snapshots). Implementations must support optional TTLs.
 *
 * Store failures are always tolerated: the model is assumed available and
 * recording is skipped.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}

/** Options for {@link createResilient}. */
export interface ResilientOptions {
  /** Models to try, in priority order. At least one is required. */
  models: ModelConfig[];
  /** State store. Defaults to an in-process `memoryStore()`. */
  store?: Store;
  /**
   * Proactively skip a model when less than this fraction of a known limit
   * remains. Default: 0.1 (10%).
   */
  threshold?: number;
  /**
   * Milliseconds to bench a model after a rate-limit error when no
   * `retry-after` header is present. Default: 60_000.
   */
  cooldown?: number;
  /** Called whenever a fallback from one model to another occurs. */
  onFallback?: (info: FallbackInfo) => void;
  /** Called for every model error, including ones that trigger fallback. */
  onError?: (error: unknown, modelId: string) => void;
}
