export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryableErrors?: (err: unknown) => boolean;
}

/**
 * Executes an async operation with bounded exponential backoff and jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const backoffFactor = options.backoffFactor ?? 2;
  const retryableErrors = options.retryableErrors ?? (() => true);

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !retryableErrors(err)) {
        throw err;
      }

      // Add full jitter (0 to delay)
      const jitteredDelay = Math.min(maxDelayMs, delay * (0.5 + Math.random() * 0.5));
      await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
      delay = Math.min(maxDelayMs, delay * backoffFactor);
    }
  }
}
