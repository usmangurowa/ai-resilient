import type { ErrorClassification } from './types';

interface ErrorShape {
  statusCode?: number | undefined;
  responseHeaders?: Record<string, string> | undefined;
  isRetryable?: boolean | undefined;
  message?: string | undefined;
}

/**
 * Extract the shape of an AI SDK `APICallError` (statusCode,
 * responseHeaders, isRetryable) via duck typing, so we don't need a
 * runtime dependency on `@ai-sdk/provider`.
 */
function getErrorShape(error: unknown): ErrorShape {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error) };
  }
  const e = error as Record<string, unknown>;
  return {
    statusCode:
      typeof e['statusCode'] === 'number' ? e['statusCode'] : undefined,
    responseHeaders:
      typeof e['responseHeaders'] === 'object' && e['responseHeaders'] !== null
        ? (e['responseHeaders'] as Record<string, string>)
        : undefined,
    isRetryable:
      typeof e['isRetryable'] === 'boolean' ? e['isRetryable'] : undefined,
    message: typeof e['message'] === 'string' ? e['message'] : undefined,
  };
}

const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|quota|exhausted|billing|insufficient.?quota/i;

const TRANSIENT_PATTERN =
  /overloaded|timeout|timed.?out|econnreset|econnrefused|etimedout|socket hang up|network|fetch failed|service unavailable|internal server error|bad gateway/i;

function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/**
 * Classify an error from a model call:
 *
 * - `rate-limit`: HTTP 429, quota/exhausted message patterns, or a
 *   `retry-after` header — fall back and bench the model.
 * - `transient`: HTTP 5xx, overloaded/network/timeout errors — fall back
 *   without benching.
 * - `fatal`: 400/401/403 and everything else — throw immediately.
 */
export function classifyError(error: unknown): ErrorClassification {
  const { statusCode, responseHeaders, isRetryable, message } =
    getErrorShape(error);
  const msg = message ?? '';

  if (statusCode === 429) return 'rate-limit';
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
    return 'fatal';
  }
  if (statusCode !== undefined && statusCode >= 500) return 'transient';
  if (getHeader(responseHeaders, 'retry-after') !== undefined) {
    return 'rate-limit';
  }
  if (RATE_LIMIT_PATTERN.test(msg)) return 'rate-limit';
  if (isRetryable === true) return 'transient';
  if (TRANSIENT_PATTERN.test(msg)) return 'transient';
  return 'fatal';
}

/**
 * Parse a `retry-after` header from an error's response headers into
 * milliseconds. Supports delta-seconds and HTTP-date formats.
 */
export function getRetryAfterMs(error: unknown): number | undefined {
  const { responseHeaders } = getErrorShape(error);
  const raw = getHeader(responseHeaders, 'retry-after');
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}
