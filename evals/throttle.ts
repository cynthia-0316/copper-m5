// Keeps the evaluation under the model's requests-per-minute limit.
// Google's free tier allows 15 requests a minute; one evaluation makes about
// 80 model calls (Ask Copper's steps and the judge), so unthrottled it would
// be refused part-way. This wraps `fetch` for Google's API only, in the
// evaluation's own process (the app's code is untouched):
//  - it never sends more than `perMinute` requests in any 60 seconds;
//  - if Google still says 429 "retry in N s", it waits that long and sends the
//    SAME request again, a few times, which is a temporary-error retry and
//    never re-rolls an answer.
// Set EVAL_REQUESTS_PER_MINUTE (0 turns this off) for a key with higher limits.

const GOOGLE = "generativelanguage.googleapis.com";

export function installModelThrottle(
  perMinute = Number(process.env.EVAL_REQUESTS_PER_MINUTE ?? 12),
  fetchImpl: typeof fetch = globalThis.fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
): typeof fetch {
  if (!(perMinute > 0)) return fetchImpl;
  const sent: number[] = [];

  async function slot() {
    for (;;) {
      const cutoff = now() - 60_000;
      while (sent.length && sent[0] <= cutoff) sent.shift();
      if (sent.length < perMinute) {
        sent.push(now());
        return;
      }
      await sleep(Math.max(250, sent[0] + 60_000 - now() + 50));
    }
  }

  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes(GOOGLE)) return fetchImpl(input, init);
    for (let attempt = 0; ; attempt++) {
      await slot();
      const response = await fetchImpl(input, init);
      if (response.status !== 429 || attempt >= 4) return response;
      const body = await response.clone().text();
      const seconds = Number(/retry in ([\d.]+)\s*s/i.exec(body)?.[1] ?? 20);
      await sleep((seconds + 1) * 1000);
    }
  };
}

/** Turns the throttle on for this process. */
export function enableModelThrottle() {
  globalThis.fetch = installModelThrottle();
}
