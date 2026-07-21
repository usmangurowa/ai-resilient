import { describe, expect, it } from 'vitest';
import { parseDuration, parseRateLimitHeaders } from '../src/header-parsers';

describe('parseDuration', () => {
  it('parses plain seconds', () => {
    expect(parseDuration('30')).toBe(30_000);
  });
  it('parses OpenAI-style durations', () => {
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('7.66s')).toBe(7660);
    expect(parseDuration('6m0s')).toBe(360_000);
    expect(parseDuration('2m59.56s')).toBe(179_560);
    expect(parseDuration('123ms')).toBe(123);
    expect(parseDuration('1h2m3s')).toBe(3_723_000);
  });
  it('returns undefined for garbage', () => {
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

describe('parseRateLimitHeaders', () => {
  it('parses OpenAI headers', () => {
    const parsed = parseRateLimitHeaders('openai.chat', {
      'x-ratelimit-limit-requests': '10000',
      'x-ratelimit-remaining-requests': '9998',
      'x-ratelimit-limit-tokens': '200000',
      'x-ratelimit-remaining-tokens': '199866',
      'x-ratelimit-reset-requests': '8.64s',
      'x-ratelimit-reset-tokens': '40ms',
    });
    expect(parsed).toEqual({
      requestsLimit: 10000,
      requestsRemaining: 9998,
      requestsResetMs: 8640,
      tokensLimit: 200000,
      tokensRemaining: 199866,
      tokensResetMs: 40,
    });
  });

  it('parses Groq headers (OpenAI style)', () => {
    const parsed = parseRateLimitHeaders('groq.chat', {
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '2',
      'x-ratelimit-reset-requests': '2s',
    });
    expect(parsed.requestsRemaining).toBe(2);
    expect(parsed.requestsLimit).toBe(30);
    expect(parsed.requestsResetMs).toBe(2000);
  });

  it('parses Anthropic headers', () => {
    const reset = new Date(Date.now() + 45_000).toISOString();
    const parsed = parseRateLimitHeaders('anthropic.messages', {
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': reset,
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-tokens-remaining': '39000',
      'anthropic-ratelimit-tokens-reset': reset,
    });
    expect(parsed.requestsLimit).toBe(50);
    expect(parsed.requestsRemaining).toBe(49);
    expect(parsed.tokensLimit).toBe(40000);
    expect(parsed.tokensRemaining).toBe(39000);
    expect(parsed.requestsResetMs).toBeGreaterThan(40_000);
    expect(parsed.requestsResetMs).toBeLessThanOrEqual(45_000);
    expect(parsed.tokensResetMs).toBeGreaterThan(40_000);
    expect(parsed.tokensResetMs).toBeLessThanOrEqual(45_000);
  });

  it('is case-insensitive on header names', () => {
    const parsed = parseRateLimitHeaders('openai.chat', {
      'X-RateLimit-Remaining-Requests': '5',
    });
    expect(parsed.requestsRemaining).toBe(5);
  });

  it('falls back to IETF draft headers for unknown providers', () => {
    const parsed = parseRateLimitHeaders('mistral.chat', {
      'ratelimit-limit': '100',
      'ratelimit-remaining': '10',
      'ratelimit-reset': '12',
    });
    expect(parsed).toEqual({
      requestsLimit: 100,
      requestsRemaining: 10,
      requestsResetMs: 12_000,
    });
  });

  it('parses OpenAI-style headers from Mistral when present', () => {
    const parsed = parseRateLimitHeaders('mistral.chat', {
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '59',
      'x-ratelimit-limit-tokens': '500000',
      'x-ratelimit-remaining-tokens': '499000',
    });
    expect(parsed.requestsLimit).toBe(60);
    expect(parsed.requestsRemaining).toBe(59);
    expect(parsed.tokensLimit).toBe(500000);
    expect(parsed.tokensRemaining).toBe(499000);
  });

  it('parses IETF draft headers from Google', () => {
    const parsed = parseRateLimitHeaders('google.generative-ai', {
      'ratelimit-limit': '15',
      'ratelimit-remaining': '1',
      'ratelimit-reset': '40',
    });
    expect(parsed).toEqual({
      requestsLimit: 15,
      requestsRemaining: 1,
      requestsResetMs: 40_000,
    });
  });

  it('clamps Anthropic reset timestamps in the past to zero', () => {
    const past = new Date(Date.now() - 30_000).toISOString();
    const parsed = parseRateLimitHeaders('anthropic.messages', {
      'anthropic-ratelimit-requests-remaining': '10',
      'anthropic-ratelimit-requests-reset': past,
    });
    expect(parsed.requestsResetMs).toBe(0);
  });

  it('prefers OpenAI-style headers for unknown providers when present', () => {
    const parsed = parseRateLimitHeaders('google.generative-ai', {
      'x-ratelimit-remaining-requests': '3',
    });
    expect(parsed.requestsRemaining).toBe(3);
  });

  it('returns empty object for no headers', () => {
    expect(parseRateLimitHeaders('openai.chat', undefined)).toEqual({});
    expect(parseRateLimitHeaders('openai.chat', {})).toEqual({
      requestsRemaining: undefined,
      requestsLimit: undefined,
      requestsResetMs: undefined,
      tokensRemaining: undefined,
      tokensLimit: undefined,
      tokensResetMs: undefined,
    });
  });
});
