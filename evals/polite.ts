import { langfuseConfig } from "@/lib/ai/langfuse";

// A polite reader for Langfuse's public API. Langfuse allows about 30 requests
// a minute on these endpoints; asking faster is answered with HTTP 429 and
// "retryAfterSeconds". This reader sends one request at a time, keeps a gap
// between them, waits out a 429 as told, and tries again a few times. Every
// other error is thrown with its status and body, never swallowed: "the query
// failed" and "the data is not there" are different things and must stay apart.

export class LangfuseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(
      `Langfuse ${path.split("?")[0]} answered ${status}: ${body.slice(0, 200)}`,
    );
    this.name = "LangfuseHttpError";
  }
}

/** The connection failed before Langfuse answered (no network, DNS, reset). */
export class LangfuseNetworkError extends Error {
  constructor(
    readonly path: string,
    readonly cause: string,
  ) {
    super(`Langfuse ${path.split("?")[0]} could not be reached: ${cause}`);
    this.name = "LangfuseNetworkError";
  }
}

/**
 * Why a question to Langfuse failed. None of these says the data is missing:
 * "missing" is only ever concluded from a question that was answered.
 */
export type FailureKind =
  | "rate_limit" // HTTP 429: asked faster than Langfuse allows
  | "bad_request" // HTTP 400, 404 or 422: the question itself is wrong
  | "not_authorized" // HTTP 401 or 403: the keys
  | "server" // HTTP 5xx: Langfuse is having trouble
  | "network" // never reached Langfuse
  | "other";

export function failureKind(error: unknown): FailureKind {
  if (error instanceof LangfuseNetworkError) return "network";
  if (error instanceof LangfuseHttpError) {
    if (error.status === 429) return "rate_limit";
    if ([400, 404, 422].includes(error.status)) return "bad_request";
    if ([401, 403].includes(error.status)) return "not_authorized";
    if (error.status >= 500) return "server";
  }
  return "other";
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  rate_limit: "rate limit",
  bad_request: "bad query",
  not_authorized: "not authorized",
  server: "Langfuse server error",
  network: "network",
  other: "other",
};

export type Getter = (path: string) => Promise<unknown>;

type Fetch = (
  path: string,
) => Promise<{ status: number; text: () => Promise<string> }>;

function defaultFetch(): Fetch {
  const { config } = langfuseConfig();
  if (!config) throw new Error("Langfuse is not configured");
  const base = config.baseUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  return (path) =>
    fetch(`${base}${path}`, { headers: { Authorization: auth } });
}

/** Every row of a paged Langfuse list, following the cursor. */
export async function allPages<T>(get: Getter, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const body = (await get(
      `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )) as { data?: T[]; meta?: { cursor?: string } };
    out.push(...(body.data ?? []));
    cursor = body.meta?.cursor;
  } while (cursor);
  return out;
}

export function politeGetter({
  send = defaultFetch(),
  gapMs = 2600,
  retries = 6,
  networkRetries = 4,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}: {
  send?: Fetch;
  /** Minimum time between two requests; 2.6 s keeps under 30 a minute. */
  gapMs?: number;
  retries?: number;
  /** Tries again after a connection that never reached Langfuse. */
  networkRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Getter {
  let last = 0;
  // One at a time, whoever asks: requests wait in a queue.
  let queue: Promise<unknown> = Promise.resolve();
  const once = async (path: string): Promise<unknown> => {
    let networkFailures = 0;
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      let res: { status: number; text: () => Promise<string> };
      let text: string;
      try {
        res = await send(path);
        text = await res.text();
      } catch (error) {
        // The connection failed: a temporary problem, tried again a few times
        // with a growing wait, then reported as a network failure.
        const cause = error instanceof Error ? error.message : String(error);
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        if (networkFailures >= networkRetries)
          throw new LangfuseNetworkError(
            path,
            code ? `${cause} (${code})` : cause,
          );
        networkFailures++;
        await sleep(Math.min(5000 * networkFailures, 30_000));
        last = now();
        continue;
      }
      if (res.status === 200) {
        try {
          return JSON.parse(text);
        } catch {
          throw new LangfuseHttpError(
            200,
            path,
            `not JSON: ${text.slice(0, 100)}`,
          );
        }
      }
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= retries)
        throw new LangfuseHttpError(res.status, path, text);
      let seconds = 15;
      try {
        seconds = Number(
          JSON.parse(text)?.details?.retryAfterSeconds ?? seconds,
        );
      } catch {
        // not JSON: use the default wait
      }
      await sleep((seconds + 1) * 1000);
      last = now();
    }
  };
  return (path) => {
    const next = queue.then(() => once(path));
    queue = next.catch(() => undefined);
    return next;
  };
}
