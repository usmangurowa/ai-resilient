# ai-resilient — Design Spec

**Date:** 2026-07-21
**Status:** Approved by user
**Target:** Standalone open-source npm package

## Problem

Developers using free-tier AI model API keys hit rate limits and quota exhaustion. When that happens, calls fail. Existing solutions (`ai-fallback`) only react _after_ an error occurs and treat all errors the same. Vercel AI Gateway fallbacks require routing through Vercel's gateway rather than the developer's own API keys.

## Goal

A wrapper SDK for the Vercel AI SDK (v5) that:

1. **Reactively** falls back to the next configured model on rate-limit/quota/transient errors — but _not_ on fatal errors (auth, bad request).
2. **Proactively** tracks rate-limit state (from provider response headers and/or user-declared limits) and switches to a fallback model _before_ the limit is hit.

## Non-goals (v1)

- Embeddings, image, and speech models (language models only).
- Mid-stream fallback (restarting a stream after tokens were emitted).
- Multi-key rotation per provider (possible v2 feature).
- Cost-based or latency-based routing.

## Public API

```ts
import { createResilient, memoryStore } from 'ai-resilient';
import { groq } from '@ai-sdk/groq';
import { google } from '@ai-sdk/google';

const model = createResilient({
  models: [
    { model: groq('llama-3.3-70b'), limits: { requestsPerMinute: 30 } },
    { model: google('gemini-2.0-flash') },
  ],
  store: memoryStore(), // default; pluggable (Redis/KV adapters)
  threshold: 0.1, // proactively skip a model when <10% of a known limit remains
  cooldown: 60_000, // ms to bench a model after a rate-limit error (default 60s)
  onFallback: (info) => {}, // { from, to, reason: 'rate-limit' | 'transient' | 'proactive' }
  onError: (error, modelId) => {},
});

const { text } = await generateText({ model, prompt: '...' });
```

- `createResilient` returns an object implementing `LanguageModelV2`, so it works transparently with `generateText`, `streamText`, `generateObject`, `streamObject`.
- Per-model config: `{ model: LanguageModelV2, limits?: { requestsPerMinute?, requestsPerDay?, tokensPerMinute? } }`.
- Declared `limits` enable self-counted tracking when the provider exposes no headers.

## Architecture

Three units, each independently testable:

### 1. `ResilientLanguageModel` (implements `LanguageModelV2`)

- `doGenerate` / `doStream`:
  1. Ask `LimitTracker` for available models, in configured order (bench/cooldown and near-limit models filtered out).
  2. If **all** models are filtered out proactively, fall back to trying all models in configured order anyway (attempting beats failing without trying).
  3. Try each candidate. On error → `classifyError`:
     - `rate-limit` / `transient` → report to tracker, try next model.
     - `fatal` → throw immediately.
  4. All candidates failed → throw `AllModelsExhaustedError` with `attempts: { modelId, error, classification }[]`.
- Streaming: wrap the stream. Errors **before the first content chunk** trigger fallback to the next model (a fresh stream). Errors after the first chunk propagate to the caller unchanged.
- After each successful call, pass response headers to `LimitTracker.recordSuccess`.
- `provider` is reported as `ai-resilient`; `modelId` mirrors the primary model's id.

### 2. `LimitTracker`

- `isAvailable(modelKey): Promise<boolean>` — false if benched (cooldown active) or usage ≥ `(1 - threshold)` of any known limit.
- `recordSuccess(modelKey, headers)`:
  - Parse rate-limit headers via per-provider parsers: OpenAI (`x-ratelimit-*`), Anthropic (`anthropic-ratelimit-*`), Groq, Google, Mistral. Unknown providers → no-op.
  - Increment sliding-window counters for any user-declared limits (requests + tokens per window).
- `recordRateLimit(modelKey, retryAfterMs?)` — bench the model for `retryAfterMs` (parsed from `retry-after` header when present) or the configured `cooldown`.
- All state persisted through the `Store` interface.

### 3. `classifyError(error): 'rate-limit' | 'transient' | 'fatal'`

- `rate-limit`: HTTP 429, quota/exhausted message patterns, or `retry-after` header present.
- `transient`: HTTP 5xx, overloaded, network/timeout errors.
- `fatal`: 400/401/403 and anything else — throw immediately, no fallback.
- Uses AI SDK's `APICallError` (`statusCode`, `responseHeaders`, `isRetryable`) when available; falls back to message-pattern matching.

## Store interface

```ts
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}
```

- `memoryStore()` — default, in-process Map with TTL eviction. Suitable for long-running servers.
- Pluggable for serverless: Redis/Vercel KV adapters are ~20 lines each (adapters may ship separately or as docs examples in v1).
- **Graceful degradation:** if a store call throws, treat the model as available and skip recording. The store is an optimization, never a blocker.

## Error handling summary

| Situation                       | Behavior                                          |
| ------------------------------- | ------------------------------------------------- |
| 429 / quota exceeded            | Bench model (retry-after or cooldown), try next   |
| 5xx / overloaded / network      | Try next model (no bench)                         |
| 401 / 403 / 400                 | Throw immediately                                 |
| Stream error before first chunk | Fall back, start fresh stream on next model       |
| Stream error after first chunk  | Propagate to caller                               |
| All models fail                 | `AllModelsExhaustedError` with per-model attempts |
| All models near limit           | Try all in order anyway                           |
| Store unavailable               | Assume available, skip recording                  |

## Testing

- **Vitest** with `MockLanguageModelV2` from `ai/test` — no network calls.
- Matrix:
  - Falls back on 429; benches with retry-after; cooldown expiry restores model.
  - Does NOT fall back on 401.
  - Proactive skip when self-counted usage nears declared limit.
  - Proactive skip from parsed provider headers.
  - Stream fallback before first chunk; propagation after first chunk.
  - Sliding-window counter correctness across window boundaries.
  - Header parser unit tests per provider.
  - Store failure → graceful degradation.
  - `AllModelsExhaustedError` contents.

## Package setup

- TypeScript, strict mode. Build with `tsup` (ESM + CJS + `.d.ts`).
- `ai` v5 as **peer dependency**; zero runtime dependencies.
- New GitHub repo: `usmangurowa/ai-resilient` (name subject to npm availability check).
- Vitest for tests; standard `npm publish` workflow (CI later).
