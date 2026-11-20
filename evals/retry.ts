// Retries for TEMPORARY failures only: rate limits, server errors, dropped
// connections. A low score is never retried (that would keep re-rolling the
// answer until it happened to pass). Each retry waits a bit longer.

export function isTransient(error: unknown): boolean {
  const text = `${error instanceof Error ? `${error.name} ${error.message}` : String(error)} ${
    typeof error === "object" && error !== null && "statusCode" in error
      ? String((error as { statusCode: unknown }).statusCode)
      : ""
  }`;
  return /\b(429|500|502|503|504)\b|rate.?limit|quota|overloaded|unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(
    text,
  );
}

export async function withRetries<T>(
  run: (attempt: number) => Promise<T>,
  {
    retries,
    retryable = isTransient,
    delayMs = 2000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    /** How many times to retry after the first try. */
    retries: number;
    retryable?: (error: unknown) => boolean;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await run(attempt), attempts: attempt };
    } catch (error) {
      if (attempt > retries || !retryable(error)) throw error;
      await sleep(delayMs * attempt);
    }
  }
}
