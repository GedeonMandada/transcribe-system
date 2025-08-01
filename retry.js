const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
];

/**
 * A utility to wrap an async function with a retry mechanism, specifically for transient network errors.
 * @param {() => Promise<T>} fn The async function to execute.
 * @param {object} [options]
 * @param {number} [options.retries=3] The maximum number of attempts.
 * @param {number} [options.delay=2000] The initial delay in milliseconds.
 * @param {(error: Error, attempt: number) => void} [options.onRetry] A callback for logging each retry attempt.
 * @returns {Promise<T>}
 * @template T
 */
export const withRetry = async (fn, { retries = 3, delay = 2000, onRetry } = {}) => {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (!RETRYABLE_ERROR_CODES.includes(error.code) || attempt >= retries) {
        throw error;
      }
      if (onRetry) onRetry(error, attempt);
      const backoff = delay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
};