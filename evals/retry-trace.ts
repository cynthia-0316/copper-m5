import { politeGetter } from "@/evals/polite";

// What happened to the attempts of a case that were run again after a temporary
// error. results.json keeps only the last attempt of a case; every attempt,
// though, was traced in Langfuse (one `ask-copper-turn` trace per attempt,
// tagged with the run id, case id and attempt number). This reads those traces
// back, so a retry is explained by what the trace shows, not guessed.
//
// Not recorded anywhere, so reported as "not measured": why the judge was
// retried, how many times the evaluation's own limiter met a 429, and the AI
// SDK's own quick retries inside one model call.

export type AttemptTrace = {
  caseId: string;
  attempt: number;
  traceId: string;
  /** What the trace shows: an answer, no answer at all, or an error. */
  outcome: "answered" | "no_answer" | "error";
  detail?: string;
  latencyMs: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type RetryTrace = {
  runId: string;
  collectedAt: string;
  attempts: AttemptTrace[];
};

type Observation = {
  id: string;
  traceId: string;
  name: string;
  type: string;
  level?: string;
  statusMessage?: string | null;
  output?: unknown;
  latency?: number | null;
  metadata?: Record<string, unknown>;
  usageDetails?: { input?: number; output?: number } | null;
};

type Page = { data?: Observation[]; meta?: { cursor?: string } };
type Get = (path: string) => Promise<unknown>;

const NO_ANSWER = /Sorry, something went wrong on my end/;

export function classify(
  root: Observation,
): Pick<AttemptTrace, "outcome" | "detail"> {
  if (root.metadata?.status === "error" || root.level === "ERROR")
    return {
      outcome: "error",
      detail: String(root.statusMessage ?? "turn ended in an error").slice(
        0,
        300,
      ),
    };
  if (typeof root.output === "string" && NO_ANSWER.test(root.output))
    return {
      outcome: "no_answer",
      detail:
        'the model ended the turn with no answer (the chat\'s "Sorry" fallback)',
    };
  return { outcome: "answered" };
}

async function pages(get: Get, path: string): Promise<Observation[]> {
  const out: Observation[] = [];
  let cursor: string | undefined;
  do {
    const body = (await get(
      `${path}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )) as Page;
    out.push(...(body.data ?? []));
    cursor = body.meta?.cursor;
  } while (cursor);
  return out;
}

/**
 * Every attempt of every case of one run, from Langfuse. `from` and `to` bound
 * the search in time (ISO strings): the run's start and a margin after its end.
 */
export async function collectRetryTrace(
  runId: string,
  from: string,
  to: string,
  get: Get = politeGetter(),
): Promise<RetryTrace> {
  const roots = (
    await pages(
      get,
      `/api/public/v2/observations?fields=${encodeURIComponent("core,basic,io,metadata,metrics")}&name=ask-copper-turn&fromStartTime=${encodeURIComponent(from)}&toStartTime=${encodeURIComponent(to)}`,
    )
  ).filter((o) => o.metadata?.runId === runId);
  const attempts: AttemptTrace[] = [];
  for (const root of roots) {
    const generations = (
      await pages(
        get,
        `/api/public/v2/observations?fields=${encodeURIComponent("core,basic,usage")}&type=GENERATION&traceId=${root.traceId}&fromStartTime=${encodeURIComponent(from)}`,
      )
    ).filter((o) => o.type === "GENERATION");
    attempts.push({
      caseId: String(root.metadata?.caseId),
      attempt: Number(root.metadata?.attempt ?? 1),
      traceId: root.traceId,
      ...classify(root),
      latencyMs:
        typeof root.latency === "number"
          ? Math.round(root.latency * 1000)
          : null,
      modelCalls: generations.length,
      inputTokens: generations.reduce(
        (n, g) => n + (g.usageDetails?.input ?? 0),
        0,
      ),
      outputTokens: generations.reduce(
        (n, g) => n + (g.usageDetails?.output ?? 0),
        0,
      ),
    });
  }
  attempts.sort(
    (a, b) => a.caseId.localeCompare(b.caseId) || a.attempt - b.attempt,
  );
  return { runId, collectedAt: new Date().toISOString(), attempts };
}
