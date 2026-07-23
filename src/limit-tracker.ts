import { parseRateLimitHeaders } from './header-parsers';
import type { Limits, ModelStatus, Store } from './types';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How long a parsed header snapshot stays relevant without a reset hint. */
const DEFAULT_SNAPSHOT_TTL_MS = 60_000;
/** Upper bound for header-snapshot lifetimes: garbage reset values must not pin a snapshot. */
const MAX_SNAPSHOT_TTL_MS = DAY_MS;

interface UsageState {
  /** Timestamps (ms) of requests within the last 24h. */
  requests: number[];
  /** `[timestamp, tokenCount]` pairs within the last minute. */
  tokens: [number, number][];
}

interface DimensionSnapshot {
  remaining: number;
  limit?: number | undefined;
  /** After this timestamp the dimension has reset and is ignored. */
  expiresAt: number;
}

interface HeaderSnapshot {
  requests?: DimensionSnapshot | undefined;
  tokens?: DimensionSnapshot | undefined;
}

export interface RecordSuccessInput {
  provider: string;
  headers?: Record<string, string> | undefined;
  totalTokens?: number | undefined;
  limits?: Limits | undefined;
}

/**
 * Tracks per-model rate-limit state: cooldown benches after rate-limit
 * errors, provider-header snapshots, and sliding-window self-counted
 * usage against user-declared limits.
 *
 * All state goes through the pluggable `Store`; any store failure is
 * swallowed and treated as "model available / nothing recorded".
 */
export class LimitTracker {
  private readonly store: Store;
  private readonly threshold: number;
  private readonly cooldown: number;
  /** Per-key promise chains serializing usage counter updates. */
  private readonly usageLocks = new Map<string, Promise<void>>();

  constructor(options: { store: Store; threshold: number; cooldown: number }) {
    this.store = options.store;
    this.threshold = options.threshold;
    this.cooldown = options.cooldown;
  }

  private benchKey(modelKey: string): string {
    return `ai-resilient:bench:${modelKey}`;
  }
  private usageKey(modelKey: string): string {
    return `ai-resilient:usage:${modelKey}`;
  }
  private headersKey(modelKey: string): string {
    return `ai-resilient:headers:${modelKey}`;
  }

  /**
   * False if the model is benched (cooldown active) or usage is at or
   * beyond `(1 - threshold)` of any known limit.
   */
  async isAvailable(modelKey: string, limits?: Limits): Promise<boolean> {
    try {
      if (await this.isBenched(modelKey)) return false;
      if (await this.isNearHeaderLimit(modelKey)) return false;
      if (limits && (await this.isNearDeclaredLimit(modelKey, limits))) {
        return false;
      }
      return true;
    } catch {
      // Store failure: assume available.
      return true;
    }
  }

  /**
   * Read-only per-model detail: bench expiry, active header-snapshot
   * dimensions, and (when `limits` is declared) self-counted window
   * usage. `available` mirrors {@link isAvailable} exactly. Never
   * throws: on store failure it degrades to `{ available: true }`.
   */
  async status(
    modelKey: string,
    limits?: Limits,
  ): Promise<Omit<ModelStatus, 'key' | 'provider' | 'modelId'>> {
    try {
      const detail: Omit<ModelStatus, 'key' | 'provider' | 'modelId'> = {
        available: await this.isAvailable(modelKey, limits),
      };

      // Bench: same parsing rules as isBenched — the value is the bench
      // expiry timestamp; unparseable values mean "not benched".
      const benchRaw = await this.store.get(this.benchKey(modelKey));
      if (benchRaw !== null) {
        const expiresAt = Number(benchRaw);
        if (Number.isFinite(expiresAt) && Date.now() < expiresAt) {
          detail.benchedUntil = expiresAt;
        }
      }

      const headersRaw = await this.store.get(this.headersKey(modelKey));
      if (headersRaw !== null) {
        const snapshot = JSON.parse(headersRaw) as HeaderSnapshot;
        const now = Date.now();
        const requests = this.dimensionStatus(snapshot.requests, now);
        const tokens = this.dimensionStatus(snapshot.tokens, now);
        if (requests !== undefined || tokens !== undefined) {
          detail.headerLimits = {
            ...(requests !== undefined ? { requests } : {}),
            ...(tokens !== undefined ? { tokens } : {}),
          };
        }
      }

      if (limits !== undefined) {
        const usage = await this.readUsage(modelKey);
        const now = Date.now();
        detail.selfCounted = {
          requestsLastMinute: usage.requests.filter((t) => now - t < MINUTE_MS)
            .length,
          requestsLastDay: usage.requests.filter((t) => now - t < DAY_MS)
            .length,
          tokensLastMinute: usage.tokens
            .filter(([t]) => now - t < MINUTE_MS)
            .reduce((sum, [, n]) => sum + n, 0),
        };
      }

      return detail;
    } catch {
      // Store failure: report available with no detail, matching
      // isAvailable's fail-open policy.
      return { available: true };
    }
  }

  /** Map an unexpired stored dimension to its public status shape. */
  private dimensionStatus(
    dim: DimensionSnapshot | undefined,
    now: number,
  ): { remaining: number; limit?: number; resetsAt: number } | undefined {
    if (dim === undefined || now >= dim.expiresAt) return undefined;
    return {
      remaining: dim.remaining,
      ...(dim.limit !== undefined ? { limit: dim.limit } : {}),
      resetsAt: dim.expiresAt,
    };
  }

  private async isBenched(modelKey: string): Promise<boolean> {
    const raw = await this.store.get(this.benchKey(modelKey));
    if (raw === null) return false;
    // Belt and braces for stores without real TTL support: the value is
    // the bench expiry timestamp. Unparseable values fail open (not
    // benched), consistent with the store-failure policy in isAvailable.
    const expiresAt = Number(raw);
    return Number.isFinite(expiresAt) && Date.now() < expiresAt;
  }

  private async isNearHeaderLimit(modelKey: string): Promise<boolean> {
    const raw = await this.store.get(this.headersKey(modelKey));
    if (raw === null) return false;
    const snapshot = JSON.parse(raw) as HeaderSnapshot;
    const now = Date.now();
    // Each dimension keeps its own expiration so a fast-resetting,
    // non-limiting dimension can't wipe out a still-exhausted one.
    for (const dim of [snapshot.requests, snapshot.tokens]) {
      if (dim === undefined || now >= dim.expiresAt) continue;
      if (this.remainingBelowThreshold(dim.remaining, dim.limit)) return true;
    }
    return false;
  }

  private remainingBelowThreshold(
    remaining: number | undefined,
    limit: number | undefined,
  ): boolean {
    if (remaining === undefined) return false;
    if (remaining <= 0) return true;
    if (limit === undefined || limit <= 0) return false;
    return remaining / limit <= this.threshold;
  }

  private async isNearDeclaredLimit(
    modelKey: string,
    limits: Limits,
  ): Promise<boolean> {
    const usage = await this.readUsage(modelKey);
    const now = Date.now();

    if (limits.requestsPerMinute !== undefined) {
      const used = usage.requests.filter((t) => now - t < MINUTE_MS).length;
      if (used >= (1 - this.threshold) * limits.requestsPerMinute) return true;
    }
    if (limits.requestsPerDay !== undefined) {
      const used = usage.requests.filter((t) => now - t < DAY_MS).length;
      if (used >= (1 - this.threshold) * limits.requestsPerDay) return true;
    }
    if (limits.tokensPerMinute !== undefined) {
      const used = usage.tokens
        .filter(([t]) => now - t < MINUTE_MS)
        .reduce((sum, [, n]) => sum + n, 0);
      if (used >= (1 - this.threshold) * limits.tokensPerMinute) return true;
    }
    return false;
  }

  /**
   * Record a successful call: parse provider rate-limit headers and
   * increment sliding-window counters for declared limits.
   */
  async recordSuccess(
    modelKey: string,
    input: RecordSuccessInput,
  ): Promise<void> {
    try {
      if (input.headers !== undefined) {
        await this.recordHeaders(modelKey, input.provider, input.headers);
      }
      if (input.limits !== undefined) {
        await this.recordUsage(modelKey, input.limits, input.totalTokens);
      }
    } catch {
      // Store failure: skip recording.
    }
  }

  private async recordHeaders(
    modelKey: string,
    provider: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const parsed = parseRateLimitHeaders(provider, headers);
    const now = Date.now();
    const snapshot: HeaderSnapshot = {};
    if (parsed.requestsRemaining !== undefined) {
      snapshot.requests = {
        remaining: parsed.requestsRemaining,
        limit: parsed.requestsLimit,
        expiresAt:
          now +
          Math.min(
            parsed.requestsResetMs ?? DEFAULT_SNAPSHOT_TTL_MS,
            MAX_SNAPSHOT_TTL_MS,
          ),
      };
    }
    if (parsed.tokensRemaining !== undefined) {
      snapshot.tokens = {
        remaining: parsed.tokensRemaining,
        limit: parsed.tokensLimit,
        expiresAt:
          now +
          Math.min(
            parsed.tokensResetMs ?? DEFAULT_SNAPSHOT_TTL_MS,
            MAX_SNAPSHOT_TTL_MS,
          ),
      };
    }
    // Keep the snapshot around until the *slowest* dimension resets;
    // each dimension expires individually in isNearHeaderLimit.
    const ttl = Math.max(
      (snapshot.requests?.expiresAt ?? 0) - now,
      (snapshot.tokens?.expiresAt ?? 0) - now,
    );
    if (ttl <= 0) return;
    await this.store.set(
      this.headersKey(modelKey),
      JSON.stringify(snapshot),
      ttl,
    );
  }

  private recordUsage(
    modelKey: string,
    limits: Limits,
    totalTokens: number | undefined,
  ): Promise<void> {
    // Serialize read-modify-write per key so concurrent calls in this
    // process don't drop each other's counts. Distributed setups sharing
    // a store across processes should prefer a store with atomic
    // operations; self-counting is best-effort there.
    return this.serializeUsageUpdate(modelKey, async () => {
      const usage = await this.readUsage(modelKey);
      const now = Date.now();

      const trackDay = limits.requestsPerDay !== undefined ? DAY_MS : MINUTE_MS;
      usage.requests = usage.requests.filter((t) => now - t < trackDay);
      usage.requests.push(now);

      usage.tokens = usage.tokens.filter(([t]) => now - t < MINUTE_MS);
      if (limits.tokensPerMinute !== undefined && totalTokens !== undefined) {
        usage.tokens.push([now, totalTokens]);
      }

      await this.store.set(
        this.usageKey(modelKey),
        JSON.stringify(usage),
        trackDay,
      );
    });
  }

  private serializeUsageUpdate(
    modelKey: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = this.usageLocks.get(modelKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.usageLocks.set(modelKey, tail);
    void tail.then(() => {
      if (this.usageLocks.get(modelKey) === tail) {
        this.usageLocks.delete(modelKey);
      }
    });
    return next;
  }

  private async readUsage(modelKey: string): Promise<UsageState> {
    const raw = await this.store.get(this.usageKey(modelKey));
    if (raw === null) return { requests: [], tokens: [] };
    const parsed = JSON.parse(raw) as Partial<UsageState>;
    return {
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    };
  }

  /**
   * Bench a model after a rate-limit error, for `retryAfterMs` when the
   * provider sent one, otherwise for the configured cooldown.
   */
  async recordRateLimit(
    modelKey: string,
    retryAfterMs?: number,
  ): Promise<void> {
    const benchMs = retryAfterMs ?? this.cooldown;
    if (benchMs <= 0) return;
    try {
      await this.store.set(
        this.benchKey(modelKey),
        String(Date.now() + benchMs),
        benchMs,
      );
    } catch {
      // Store failure: skip recording.
    }
  }
}
