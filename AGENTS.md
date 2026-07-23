# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`ai-resilient` wraps Vercel AI SDK v5/v6 with reactive fallback (on rate-limit /
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

`dependencies` must stay absent from `package.json`. Both `ai@^5 || ^6` and
`@ai-sdk/provider@^2 || ^3` are **peer dependencies**. Consequence:
`src/classify-error.ts` detects `APICallError` by duck-typing the object shape
(`statusCode`, `responseHeaders`, `isRetryable`, `message`) rather than
importing the class and using `instanceof`. Keep it that way — importing
`@ai-sdk/provider` at runtime would introduce a runtime dependency.

### Store adapters

Store adapters live in `src/stores/` and are exposed **only** via subpath
exports (`ai-resilient/redis`, `ai-resilient/upstash`) — never re-export
them from `src/index.ts`, or the root bundle would reference optional
packages. Adapters import client types **type-only** (erased at build
time), never construct or close clients (the user owns the connection
lifecycle), and their client packages are **optional peer dependencies**
(`peerDependenciesMeta`) plus tsup `external` entries.

### Spec-version support (v2/v3/v4)

The wrapper supports `LanguageModelV2` (ai v5), `LanguageModelV3`
(ai v6), and `LanguageModelV4` (ai v7) via the structural
`AnyLanguageModel` type in `src/types.ts`. Never
`import type { LanguageModelV3 }` or `import type { LanguageModelV4 }` —
they don't exist in provider v2, so the emitted d.ts would break
consumers on ai v5. Related invariants:

- `ResilientLanguageModel.specificationVersion` is a **getter** delegating
  to the primary model. Hardcoding `'v2'` makes ai v6 wrap the model in its
  v2→v3 compat adapter and double-convert already-v3 pass-through results.
- Mixed spec versions in one chain throw at construction.
- Usage token counts are normalized in `recordSuccess`
  (`extractTotalTokens`): v2 usage is flat numbers with `totalTokens`,
  v3/v4 usage (same nested shape) nests `{ total }` objects with no
  top-level total.
- The v4 stream part type `raw` carries no user-visible content and is
  treated as prelude (`PRELUDE_PART_TYPES`) so a pre-content error after
  a `raw` part still falls back.
- Dev deps stay on `ai@5`/`provider@2`; v3 and v4 paths are tested with
  hand-rolled structural mocks in `test/resilient-v3.test.ts` and
  `test/resilient-v4.test.ts`
  (`MockLanguageModelV2` was removed in ai v6, and `ai/test` mocks
  can't represent v3/v4 shapes on v5).

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
