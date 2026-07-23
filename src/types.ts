/**
 * User-declared rate limits for a model, used for self-counted tracking
 * when the provider exposes no rate-limit headers.
 */
export interface Limits {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerMinute?: number;
}

/** Language model specification versions the wrapper supports. */
export type SpecificationVersion = 'v2' | 'v3' | 'v4';

/**
 * Structural stand-in for a language model of any supported
 * specification version (`LanguageModelV2` from ai v5 / provider v2,
 * `LanguageModelV3` from ai v6 / provider v3, `LanguageModelV4` from
 * ai v7 / provider v4).
 *
 * `LanguageModelV3` / `LanguageModelV4` are deliberately not imported
 * from `@ai-sdk/provider`: those types only exist in provider v3/v4, so
 * importing them would break type-checking for consumers still on
 * provider v2. TypeScript's structural typing makes real models of all
 * versions assignable to this shape, and values of this shape assignable
 * to the concrete `LanguageModelV2` / `LanguageModelV3` /
 * `LanguageModelV4` interfaces.
 */
export interface AnyLanguageModel<
  Version extends SpecificationVersion = SpecificationVersion,
> {
  readonly specificationVersion: Version;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls:
    PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  /* eslint-disable @typescript-eslint/no-explicit-any --
   * The exact call-option/result shapes are owned by the wrapped models'
   * spec version; `any` keeps this stand-in mutually assignable with both
   * LanguageModelV2 and LanguageModelV3. */
  doGenerate(options: any): PromiseLike<any>;
  doStream(options: any): PromiseLike<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Configuration for a single model in the fallback chain. */
export interface ModelConfig<
  Version extends SpecificationVersion = SpecificationVersion,
> {
  model: AnyLanguageModel<Version>;
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

/** Point-in-time status of one model in the chain. */
export interface ModelStatus {
  /** Store key: `provider:modelId` (with `#<n>` suffix on duplicates). */
  key: string;
  provider: string;
  modelId: string;
  /** False when benched or proactively near a limit — mirrors routing. */
  available: boolean;
  /** Present only while benched: epoch ms when the bench expires. */
  benchedUntil?: number;
  /** Present when a provider header snapshot is active for a dimension. */
  headerLimits?: {
    requests?: { remaining: number; limit?: number; resetsAt: number };
    tokens?: { remaining: number; limit?: number; resetsAt: number };
  };
  /** Present when the model has declared `limits`: self-counted usage. */
  selfCounted?: {
    requestsLastMinute: number;
    requestsLastDay: number;
    tokensLastMinute: number;
  };
}

/** Snapshot returned by `resilientStatus`. */
export interface ResilientStatus {
  models: ModelStatus[];
}

/** Options for {@link createResilient}. */
export interface ResilientOptions<
  Version extends SpecificationVersion = SpecificationVersion,
> {
  /**
   * Models to try, in priority order. At least one is required. All
   * models must implement the same specification version (mixing ai v5
   * and ai v6 models is rejected at construction).
   */
  models: ModelConfig<Version>[];
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
