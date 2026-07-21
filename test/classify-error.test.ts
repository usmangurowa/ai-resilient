import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { classifyError, getRetryAfterMs } from '../src/classify-error';

function apiError(overrides: {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  message?: string;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    message: overrides.message ?? 'error',
    url: 'https://api.example.com',
    requestBodyValues: {},
    ...(overrides.statusCode !== undefined
      ? { statusCode: overrides.statusCode }
      : {}),
    ...(overrides.responseHeaders !== undefined
      ? { responseHeaders: overrides.responseHeaders }
      : {}),
    ...(overrides.isRetryable !== undefined
      ? { isRetryable: overrides.isRetryable }
      : {}),
  });
}

describe('classifyError', () => {
  it('classifies HTTP 429 as rate-limit', () => {
    expect(classifyError(apiError({ statusCode: 429 }))).toBe('rate-limit');
  });

  it('classifies retry-after header as rate-limit', () => {
    expect(
      classifyError(
        apiError({ statusCode: 418, responseHeaders: { 'Retry-After': '30' } }),
      ),
    ).toBe('rate-limit');
  });

  it('classifies quota messages as rate-limit', () => {
    expect(classifyError(new Error('Quota exceeded for project'))).toBe(
      'rate-limit',
    );
    expect(classifyError(new Error('RESOURCE_EXHAUSTED'))).toBe('rate-limit');
  });

  it('classifies 5xx as transient', () => {
    expect(classifyError(apiError({ statusCode: 500 }))).toBe('transient');
    expect(classifyError(apiError({ statusCode: 502 }))).toBe('transient');
    expect(classifyError(apiError({ statusCode: 503 }))).toBe('transient');
    expect(classifyError(apiError({ statusCode: 504 }))).toBe('transient');
    // Anthropic's "overloaded" status
    expect(classifyError(apiError({ statusCode: 529 }))).toBe('transient');
  });

  it('classifies network/timeout messages as transient', () => {
    expect(classifyError(new Error('fetch failed'))).toBe('transient');
    expect(classifyError(new Error('Request timed out'))).toBe('transient');
    expect(classifyError(new Error('read ECONNRESET'))).toBe('transient');
    expect(classifyError(new Error('Overloaded'))).toBe('transient');
  });

  it('respects isRetryable when no other signal is present', () => {
    expect(
      classifyError(apiError({ message: 'weird', isRetryable: true })),
    ).toBe('transient');
  });

  it('classifies 400/401/403 as fatal even with rate-limit-ish messages', () => {
    expect(classifyError(apiError({ statusCode: 401 }))).toBe('fatal');
    expect(classifyError(apiError({ statusCode: 403 }))).toBe('fatal');
    expect(
      classifyError(apiError({ statusCode: 400, message: 'bad request' })),
    ).toBe('fatal');
  });

  it('classifies unknown errors as fatal', () => {
    expect(classifyError(new Error('something else'))).toBe('fatal');
    expect(classifyError('string error')).toBe('fatal');
    expect(classifyError(null)).toBe('fatal');
  });

  it('classifies other 4xx statuses as fatal', () => {
    expect(classifyError(apiError({ statusCode: 404 }))).toBe('fatal');
    expect(classifyError(apiError({ statusCode: 422 }))).toBe('fatal');
  });
});

describe('getRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(
      getRetryAfterMs(
        apiError({ statusCode: 429, responseHeaders: { 'retry-after': '30' } }),
      ),
    ).toBe(30_000);
  });

  it('parses HTTP dates', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = getRetryAfterMs(
      apiError({ statusCode: 429, responseHeaders: { 'retry-after': future } }),
    );
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('returns undefined when absent or unparsable', () => {
    expect(getRetryAfterMs(apiError({ statusCode: 429 }))).toBeUndefined();
    expect(
      getRetryAfterMs(
        apiError({
          statusCode: 429,
          responseHeaders: { 'retry-after': 'soonish' },
        }),
      ),
    ).toBeUndefined();
    expect(getRetryAfterMs(new Error('nope'))).toBeUndefined();
  });
});
