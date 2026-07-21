/**
 * Normalized rate-limit state parsed from provider response headers.
 */
export interface ParsedRateLimit {
  requestsRemaining?: number | undefined;
  requestsLimit?: number | undefined;
  /** Milliseconds until the request limit resets. */
  requestsResetMs?: number | undefined;
  tokensRemaining?: number | undefined;
  tokensLimit?: number | undefined;
  /** Milliseconds until the token limit resets. */
  tokensResetMs?: number | undefined;
}

type Headers = Record<string, string>;

function lower(headers: Headers): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse duration strings used in OpenAI/Groq reset headers, e.g.
 * `"1s"`, `"7.66s"`, `"2m59.56s"`, `"6m0s"`, `"1h2m3s"`, `"123ms"`,
 * or a plain number of seconds.
 */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const plain = Number(value);
  if (Number.isFinite(plain)) return plain * 1000;

  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0;
  let matched = false;
  for (const [, amount, unit] of value.matchAll(pattern)) {
    matched = true;
    const n = Number(amount);
    if (unit === 'h') ms += n * 3_600_000;
    else if (unit === 'm') ms += n * 60_000;
    else if (unit === 's') ms += n * 1000;
    else ms += n;
  }
  return matched ? Math.round(ms) : undefined;
}

/** Parse an RFC 3339 timestamp into ms-from-now. */
function parseResetTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - Date.now());
}

/** OpenAI and Groq use `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`. */
function parseOpenAIStyle(h: Headers): ParsedRateLimit {
  return {
    requestsRemaining: num(h['x-ratelimit-remaining-requests']),
    requestsLimit: num(h['x-ratelimit-limit-requests']),
    requestsResetMs: parseDuration(h['x-ratelimit-reset-requests']),
    tokensRemaining: num(h['x-ratelimit-remaining-tokens']),
    tokensLimit: num(h['x-ratelimit-limit-tokens']),
    tokensResetMs: parseDuration(h['x-ratelimit-reset-tokens']),
  };
}

/** Anthropic uses `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`. */
function parseAnthropic(h: Headers): ParsedRateLimit {
  return {
    requestsRemaining: num(h['anthropic-ratelimit-requests-remaining']),
    requestsLimit: num(h['anthropic-ratelimit-requests-limit']),
    requestsResetMs: parseResetTimestamp(
      h['anthropic-ratelimit-requests-reset'],
    ),
    tokensRemaining: num(h['anthropic-ratelimit-tokens-remaining']),
    tokensLimit: num(h['anthropic-ratelimit-tokens-limit']),
    tokensResetMs: parseResetTimestamp(h['anthropic-ratelimit-tokens-reset']),
  };
}

/**
 * `ratelimit-reset` is delta-seconds per the IETF draft, but some
 * implementations send a Unix epoch timestamp. Values that would put the
 * reset more than a year out are interpreted as epoch seconds.
 */
function parseIetfReset(value: string | undefined): number | undefined {
  const reset = num(value);
  if (reset === undefined) return undefined;
  const YEAR_S = 31_536_000;
  if (reset > YEAR_S) {
    // Epoch seconds → delta from now, clamped to >= 0.
    return Math.max(0, reset * 1000 - Date.now());
  }
  return reset * 1000;
}

/**
 * Best-effort parser for providers without a documented scheme
 * (Google, Mistral): tries OpenAI-style headers, then the IETF
 * draft `ratelimit-*` headers.
 */
function parseGeneric(h: Headers): ParsedRateLimit {
  const openai = parseOpenAIStyle(h);
  if (Object.values(openai).some((v) => v !== undefined)) return openai;
  const reset = parseIetfReset(h['ratelimit-reset']);
  return {
    requestsRemaining: num(h['ratelimit-remaining']),
    requestsLimit: num(h['ratelimit-limit']),
    ...(reset !== undefined ? { requestsResetMs: reset } : {}),
  };
}

/**
 * Parse provider rate-limit headers into a normalized shape.
 * The provider is matched by prefix of the model's `provider` string
 * (e.g. `"openai.chat"` → OpenAI). Unknown providers get the
 * best-effort generic parser.
 */
export function parseRateLimitHeaders(
  provider: string,
  headers: Headers | undefined,
): ParsedRateLimit {
  if (headers === undefined) return {};
  const h = lower(headers);
  const p = provider.toLowerCase();

  if (p.startsWith('openai') || p.startsWith('groq')) {
    return parseOpenAIStyle(h);
  }
  if (p.startsWith('anthropic')) {
    return parseAnthropic(h);
  }
  // google, mistral, and unknown providers
  return parseGeneric(h);
}
