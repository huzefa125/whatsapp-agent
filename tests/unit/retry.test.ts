import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/utils/retry';

describe('withRetry Utility', () => {
  it('returns value immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and resolves when subsequent attempt succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Temporary failure');
      }
      return 'recovered';
    });

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 10,
      maxDelayMs: 50,
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts max retries and throws the final error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Persistent outage'));

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 10,
        maxDelayMs: 30,
      })
    ).rejects.toThrow('Persistent outage');

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('aborts retries immediately if error is not retryable', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('FATAL_AUTH_ERROR'));

    await expect(
      withRetry(fn, {
        maxRetries: 5,
        retryableErrors: (err) => (err as Error).message !== 'FATAL_AUTH_ERROR',
      })
    ).rejects.toThrow('FATAL_AUTH_ERROR');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
