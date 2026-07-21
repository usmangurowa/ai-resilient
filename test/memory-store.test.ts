import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../src/stores/memory';

describe('memoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', async () => {
    const store = memoryStore();
    await store.set('a', '1');
    expect(await store.get('a')).toBe('1');
    expect(await store.get('missing')).toBeNull();
  });

  it('evicts entries after their TTL', async () => {
    const store = memoryStore();
    await store.set('a', '1', 1000);
    expect(await store.get('a')).toBe('1');
    vi.advanceTimersByTime(999);
    expect(await store.get('a')).toBe('1');
    vi.advanceTimersByTime(1);
    expect(await store.get('a')).toBeNull();
  });

  it('keeps entries without TTL forever', async () => {
    const store = memoryStore();
    await store.set('a', '1');
    vi.advanceTimersByTime(1e9);
    expect(await store.get('a')).toBe('1');
  });

  it('overwriting resets the TTL', async () => {
    const store = memoryStore();
    await store.set('a', '1', 1000);
    vi.advanceTimersByTime(900);
    await store.set('a', '2', 1000);
    vi.advanceTimersByTime(900);
    expect(await store.get('a')).toBe('2');
  });
});
