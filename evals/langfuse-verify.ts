import type { CaseResult } from "@/evals/evaluate";
import { evaluationsFor } from "@/evals/langfuse";
import type { Getter } from "@/evals/polite";
import type { RunInfo } from "@/evals/report";

// Checks, one at a time and read-only, that what a run sent to Langfuse is
// there: its traces, its experiment, the experiment's items and every score.
// Four separate answers, because they can differ, and each answer says whether
// the data is MISSING (the query worked and it is not there) or the query
// FAILED (an HTTP error: nothing can be concluded about the data).

export type Check =
  | { state: "ok"; found: number; expected: number }
  | { state: "missing"; found: number; expected: number; detail: string }
  | { state: "query_failed"; detail: string };

export type RunVerification = {
  runId: string;
  traces: Check;
  experiment: Check;
  experimentItems: Check;
  scores: Check;
  /** Score names with fewer scores than expected, when scores are missing. */
  scoreShortfall?: Record<string, { found: number; expected: number }>;
};

type SavedRun = { info: RunInfo; results: CaseResult[] };

/** The few fields of a Langfuse row this check reads. */
type Row = {
  name?: string;
  traceId?: string;
  experimentName?: string;
  metadata?: { runId?: string };
  subject?: { traceId?: string };
};

type Page = { data?: Row[]; meta?: { cursor?: string } };

async function pages(get: Getter, path: string): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  do {
    const body = (await get(
      `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )) as Page;
    out.push(...(body.data ?? []));
    cursor = body.meta?.cursor;
  } while (cursor);
  return out;
}

const failed = (error: unknown): Check => ({
  state: "query_failed",
  detail: error instanceof Error ? error.message : String(error),
});

const verdict = (found: number, expected: number, detail: string): Check =>
  found >= expected
    ? { state: "ok", found, expected }
    : { state: "missing", found, expected, detail };

/** What a run should have sent: one trace and one set of scores per case. */
export function expectedScores(saved: SavedRun) {
  const meta = {
    runId: saved.info.runId,
    commit: saved.info.commit,
    goldenSetVersion: saved.info.goldenSetVersion,
    ...(saved.info.agentMode && { agentMode: saved.info.agentMode }),
  };
  const byName: Record<string, number> = {};
  let total = 0;
  for (const r of saved.results) {
    if (!r.finalTraceId) continue;
    for (const e of evaluationsFor(r, meta, saved.info.rubricVersion)) {
      byName[e.name] = (byName[e.name] ?? 0) + 1;
      total++;
    }
  }
  return { total, byName };
}

export async function verifyRun(
  saved: SavedRun,
  get: Getter,
): Promise<RunVerification> {
  const { runId, startedAt, finishedAt } = saved.info;
  const enc = encodeURIComponent;
  const from = new Date(Date.parse(startedAt) - 5 * 60_000).toISOString();
  const to = new Date(Date.parse(finishedAt) + 60 * 60_000).toISOString();
  const traceIds = saved.results.flatMap((r) =>
    r.finalTraceId ? [r.finalTraceId] : [],
  );
  const wanted = new Set(traceIds);
  const out: RunVerification = {
    runId,
    traces: { state: "query_failed", detail: "not run" },
    experiment: { state: "query_failed", detail: "not run" },
    experimentItems: { state: "query_failed", detail: "not run" },
    scores: { state: "query_failed", detail: "not run" },
  };

  try {
    const roots = (
      await pages(
        get,
        `/api/public/v2/observations?fields=${enc("core,basic,metadata")}&name=ask-copper-turn&fromStartTime=${enc(from)}&toStartTime=${enc(to)}&limit=1000`,
      )
    ).filter((o) => o.metadata?.runId === runId);
    const present = new Set(roots.map((o) => o.traceId as string));
    const found = traceIds.filter((id) => present.has(id)).length;
    out.traces = verdict(
      found,
      traceIds.length,
      `${traceIds.length - found} of the cases' traces were not returned`,
    );
  } catch (error) {
    out.traces = failed(error);
  }

  try {
    const experiments = await pages(
      get,
      `/api/public/experiments?fromStartTime=${enc(from)}&toStartTime=${enc(to)}&limit=50`,
    );
    const mine = experiments.find((e) => e.name === runId);
    out.experiment = mine
      ? { state: "ok", found: 1, expected: 1 }
      : {
          state: "missing",
          found: 0,
          expected: 1,
          detail: `the query worked and returned ${experiments.length} experiment(s), none named ${runId}`,
        };
  } catch (error) {
    out.experiment = failed(error);
  }

  try {
    const items = (
      await pages(
        get,
        `/api/public/experiment-items?fromStartTime=${enc(from)}&toStartTime=${enc(to)}&limit=100`,
      )
    ).filter(
      (i) => i.experimentName === runId && i.traceId && wanted.has(i.traceId),
    );
    out.experimentItems = verdict(
      new Set(items.map((i) => i.traceId)).size,
      traceIds.length,
      "experiment items for some cases were not returned",
    );
  } catch (error) {
    out.experimentItems = failed(error);
  }

  try {
    const expected = expectedScores(saved);
    const scores = (
      await pages(
        get,
        `/api/public/v3/scores?fields=${enc("core,subject")}&fromTimestamp=${enc(from)}&toTimestamp=${enc(to)}&limit=100`,
      )
    ).filter((s) => s.subject?.traceId && wanted.has(s.subject.traceId));
    const found: Record<string, number> = {};
    for (const s of scores)
      if (s.name) found[s.name] = (found[s.name] ?? 0) + 1;
    const short: Record<string, { found: number; expected: number }> = {};
    for (const [name, want] of Object.entries(expected.byName))
      if ((found[name] ?? 0) < want)
        short[name] = { found: found[name] ?? 0, expected: want };
    out.scores = verdict(
      scores.length,
      expected.total,
      `${Object.keys(short).length} score name(s) have fewer scores than were sent`,
    );
    if (Object.keys(short).length) out.scoreShortfall = short;
  } catch (error) {
    out.scores = failed(error);
  }
  return out;
}

/** One line per check, for a table. */
export function describeCheck(check: Check): string {
  if (check.state === "ok") return `ok (${check.found}/${check.expected})`;
  if (check.state === "missing")
    return `MISSING (${check.found}/${check.expected}): ${check.detail}`;
  return `QUERY FAILED: ${check.detail}`;
}
