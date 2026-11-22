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
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}: {
  send?: Fetch;
  /** Minimum time between two requests; 2.6 s keeps under 30 a minute. */
  gapMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Getter {
  let last = 0;
  // One at a time, whoever asks: requests wait in a queue.
  let queue: Promise<unknown> = Promise.resolve();
  const once = async (path: string): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      const res = await send(path);
      const text = await res.text();
      if (res.status === 200) return JSON.parse(text);
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
