# ai-resilient

[![npm version](https://img.shields.io/npm/v/ai-resilient.svg)](https://www.npmjs.com/package/ai-resilient)
[![CI](https://github.com/usmangurowa/ai-resilient/actions/workflows/ci.yml/badge.svg)](https://github.com/usmangurowa/ai-resilient/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/ai-resilient.svg)](https://www.npmjs.com/package/ai-resilient)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/ai-resilient?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/ai-resilient.svg)](https://github.com/usmangurowa/ai-resilient/blob/main/LICENSE)

Smart model fallback for the [Vercel AI SDK](https://ai-sdk.dev) (v5 and v6).

## Why

Your primary model _will_ hit a 429 in production. The usual fix looks like this:

```ts
// ❌ repeated at every call site, loses streaming, retries fatal errors too
try {
  return await generateText({ model: groq('llama-3.3-70b'), prompt });
} catch {
  return await generateText({ model: openai('gpt-4o-mini'), prompt });
}
```

`ai-resilient` replaces that with one drop-in model:

```ts
const model = createResilient({
  models: [
    { model: groq('llama-3.3-70b-versatile') },
    { model: openai('gpt-4o-mini') },
  ],
});
// use it everywhere generateText / streamText / generateObject / streamObject accept a model
```

…and it's smarter than a try/catch:

- knows which errors are worth falling back on (429/5xx/network) vs fatal (400/401/403 → throw immediately),
- **benches** rate-limited models for `retry-after` so the next request doesn't waste a call on them,
- **proactively switches** _before_ you hit the limit by reading provider rate-limit headers,
- falls back mid-`streamText` — but only before the first content chunk, so users never see spliced output.

`ai-resilient` wraps a chain of language models in a single `LanguageModelV2` that:

- **Reactively falls back** to the next model on rate-limit (429/quota) and transient (5xx/network) errors — but _not_ on fatal errors (400/401/403), which throw immediately.
- **Proactively switches** away from models that are near a known rate limit, using provider rate-limit response headers (OpenAI, Anthropic, Groq, Google, Mistral) and/or self-counted usage against limits you declare.

Works transparently with `generateText`, `streamText`, `generateObject`, and `streamObject`, using your own API keys — no gateway required.

## Install

```sh
npm install ai-resilient ai
```

`ai` (v5 or v6) and `@ai-sdk/provider` are peer dependencies (`@ai-sdk/provider` ships with `ai`, so most package managers install it automatically). `ai-resilient` has zero runtime dependencies.

The returned model mirrors the specification version of the models it wraps — `LanguageModelV2` on ai v5, `LanguageModelV3` on ai v6 — so it plugs into `generateText`/`streamText`/`generateObject`/`streamObject` on either major. All models in one chain must come from the same SDK major; mixing throws at construction.

## Usage

```ts
import { generateText } from 'ai';
import { createResilient } from 'ai-resilient';
import { groq } from '@ai-sdk/groq';
import { google } from '@ai-sdk/google';

const model = createResilient({
  models: [
    {
      model: groq('llama-3.3-70b-versatile'),
      limits: { requestsPerMinute: 30 },
    },
    { model: google('gemini-2.0-flash') },
  ],
});

const { text } = await generateText({ model, prompt: 'Hello!' });
```

Models are tried in the order you configure them. The first model is the primary; the rest are fallbacks.

## Options

```ts
createResilient({
  models, // required: [{ model, limits? }, ...]
  store: memoryStore(), // default; pluggable (Redis/KV)
  threshold: 0.1, // skip a model when <10% of a known limit remains
  cooldown: 60_000, // ms to bench a model after a rate-limit error
  onFallback: (info) => {}, // { from, to, reason: 'rate-limit' | 'transient' | 'proactive' }
  onError: (error, modelId) => {},
});
```

Per-model `limits` (`requestsPerMinute`, `requestsPerDay`, `tokensPerMinute`) enable self-counted sliding-window tracking for providers that expose no rate-limit headers.

## Behavior

| Situation                               | Behavior                                            |
| --------------------------------------- | --------------------------------------------------- |
| 429 / quota exceeded                    | Bench model (`retry-after` or `cooldown`), try next |
| 5xx / overloaded / network error        | Try next model (no bench)                           |
| 400 / 401 / 403                         | Throw immediately                                   |
| Stream error before first content chunk | Fall back, fresh stream on next model               |
| Stream error after first content chunk  | Propagate to caller                                 |
| All models fail                         | `AllModelsExhaustedError` with per-model attempts   |
| All models near a limit                 | Try all in order anyway                             |
| Store unavailable                       | Assume available, skip recording                    |

### Error handling

```ts
import { AllModelsExhaustedError } from 'ai-resilient';

try {
  await generateText({ model, prompt: '...' });
} catch (error) {
  if (AllModelsExhaustedError.isInstance(error)) {
    for (const { modelId, classification, error: cause } of error.attempts) {
      console.error(`${modelId} failed (${classification})`, cause);
    }
  }
}
```

## Custom stores

The default `memoryStore()` keeps state in-process, which suits long-running servers. For serverless deployments, plug in any store implementing:

```ts
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}
```

Example Redis adapter (using `ioredis`):

```ts
import Redis from 'ioredis';
import type { Store } from 'ai-resilient';

function redisStore(redis: Redis): Store {
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) await redis.set(key, value, 'PX', ttlMs);
      else await redis.set(key, value);
    },
  };
}
```

Store failures never break your calls: if the store throws, models are assumed available and recording is skipped.

## API

Beyond `createResilient`, these building blocks are exported:

| Export                                                                                                                                           | Kind     | Purpose                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryStore()`                                                                                                                                  | function | Default in-process `Store` with TTL eviction.                                                                                                               |
| `AllModelsExhaustedError`                                                                                                                        | class    | Thrown when every model fails; has `attempts: ModelAttempt[]` and static `isInstance(error)`.                                                               |
| `classifyError(error)`                                                                                                                           | function | Classify any error as `'rate-limit' \| 'transient' \| 'fatal'` — the same logic the fallback loop uses.                                                     |
| `getRetryAfterMs(error)`                                                                                                                         | function | Parse a `retry-after` header (delta-seconds or HTTP-date) from an error's `responseHeaders` into milliseconds.                                              |
| `parseRateLimitHeaders(provider, headers)`                                                                                                       | function | Parse provider rate-limit headers (OpenAI, Anthropic, Groq, Google, Mistral, IETF draft) into a normalized `ParsedRateLimit`.                               |
| `LimitTracker`                                                                                                                                   | class    | The tracker behind proactive switching: bench state, header snapshots, sliding-window counters. Useful for custom orchestration on top of the same `Store`. |
| `Store`, `Limits`, `ModelConfig`, `ResilientOptions`, `FallbackInfo`, `FallbackReason`, `ErrorClassification`, `ModelAttempt`, `ParsedRateLimit` | types    | Public types for the options and callbacks above.                                                                                                           |

## Scope (v1)

Language models only. Not included: embeddings/image/speech models, mid-stream fallback (restarting after tokens were emitted), multi-key rotation, cost/latency-based routing.

## License

MIT
