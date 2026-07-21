# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`ai-resilient` wraps Vercel AI SDK v5 with reactive fallback (on rate-limit /
transient errors) and proactive switching (before limits are hit). The
authoritative behaviour spec is
[docs/specs/2026-07-21-ai-resilient-design.md](docs/specs/2026-07-21-ai-resilient-design.md)
— reconcile any behaviour change with that document first.

## Commands

| Script                  | Command                 |
| ----------------------- | ----------------------- |
| `npm run typecheck`     | `tsc --noEmit`          |
| `npm run lint`          | `eslint .`              |
| `npm run format`        | `prettier --write .`    |
| `npm run format:check`  | `prettier --check .`    |
| `npm test`              | `vitest run`            |
| `npm run test:watch`    | `vitest`                |
| `npm run test:coverage` | `vitest run --coverage` |
| `npm run build`         | `tsup`                  |

`prepublishOnly` chains the full gate: typecheck → lint → format:check → test →
build. A tag push matching `v*` triggers `.github/workflows/release.yml`, which
runs `npm publish --provenance` (the npm lifecycle runs the full gate via
`prepublishOnly`); requires an `NPM_TOKEN` secret.

## Hard rules

### Zero runtime dependencies

`dependencies` must stay absent from `package.json`. Both `ai@^5` and
`@ai-sdk/provider@^2.0.0` are **peer dependencies**. Consequence:
`src/classify-error.ts` detects `APICallError` by duck-typing the object shape
(`statusCode`, `responseHeaders`, `isRetryable`, `message`) rather than
importing the class and using `instanceof`. Keep it that way — importing
`@ai-sdk/provider` at runtime would introduce a runtime dependency.

### `exactOptionalPropertyTypes` is on

`tsconfig.json` sets `"exactOptionalPropertyTypes": true`. Never assign
`undefined` to an optional property; always **omit** the key:

```ts
// ✅
...(value !== undefined ? { key: value } : {})

// ❌
{ key: value }  // when value may be undefined
```

This idiom appears throughout `src/header-parsers.ts` and
`src/resilient-model.ts`.

### Fail-open store philosophy

Any store failure (thrown exception or garbage return value) must degrade to
"model available / recording skipped", never surface an error to the caller.
`LimitTracker.isAvailable` wraps all store calls in a `try/catch` and returns
`true` on failure. `recordSuccess` and `recordRateLimit` swallow store errors
the same way. The unparseable-bench path in `isBenched` also fails open (treats
a bad value as "not benched"). **Never let store failures propagate.**

### Streaming commit-before-return invariant

In `src/resilient-model.ts` `doStream`: the fallback decision (whether to
try the next candidate) must be made **before** the first content part arrives.
The commit logic lives inside `doStream` and completes before the method
returns. Do not move it into the stream pipeline — once content is flowing, it
is too late to fall back.

### Non-blocking bookkeeping (`pendingRecords`)

`recordSuccess` store writes are queued on a `pendingRecords` promise chain
(a field on `ResilientModel`). The response path does **not** await them.
`buildPlan` awaits `pendingRecords` at the top to guarantee read-your-writes
before planning the next call. Do not re-await the writes on the response path
or move them inline there.

## Store key scheme

All keys use the format `<prefix>:<modelKey>` where `<modelKey>` is
`provider:modelId` (with a `#<index>` suffix appended on duplicate model
entries in the candidates array):

| Key pattern                  | Holds                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `ai-resilient:bench:<key>`   | Bench expiry timestamp (ms since epoch) as a string                     |
| `ai-resilient:usage:<key>`   | JSON `{requests: number[], tokens: [number,number][]}` (sliding window) |
| `ai-resilient:headers:<key>` | JSON `HeaderSnapshot` (parsed provider rate-limit headers)              |

## Testing conventions

- **Test runner**: Vitest. One test file per source module under `test/`.
- **Model mocks**: `MockLanguageModelV2` from `ai/test` — do not use real
  models or network calls.
- **Time-dependent tests**: `vi.useFakeTimers()` / `vi.useRealTimers()` (see
  `test/limit-tracker.test.ts`).
- **Retry suppression**: pass `maxRetries: 0` on every `generateText` /
  `streamText` / `generateObject` / `streamObject` call in tests so the SDK's
  own retry loop does not mask fallback behaviour.

## Commit convention

Imperative summary line (`Add …`, `Fix …`, `Move …`). Body ends with:

```
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```
