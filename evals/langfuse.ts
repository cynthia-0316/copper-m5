import { LangfuseClient } from "@langfuse/client";
import {
  LangfuseOtelSpanAttributes,
  startObservation,
} from "@langfuse/tracing";
import type { CaseResult } from "@/evals/evaluate";
import { GOLDEN_SET, GOLDEN_SET_VERSION } from "@/evals/golden-set";
import type { RunMeta } from "@/evals/runner";
import { flushTraces, langfuseConfig } from "@/lib/ai/langfuse";

// Sends an evaluation to Langfuse (the only evals and monitoring tool the
// course uses). Langfuse 4 records an evaluation as an *experiment* on a
// dataset:
//  - The golden set is the dataset `copper-golden-set`, one item per case.
//  - `dataset.runExperiment()` (see scripts/run-evals.ts) runs each item as a
//    task. Everything Ask Copper does for that case (the agents, model calls,
//    tools and handoffs from lib/copper/assistant/trace.ts) is recorded inside
//    that item's trace, and the case's scores are attached to that same trace.
//  - The judge's call gets its own trace ("eval-judge") with its tokens, cost
//    and time, linked to the case's trace by id, so judging is never mixed
//    into Copper's own cost.

export type LangfuseRun = {
  client: LangfuseClient;
  /** Things that did not reach Langfuse, in words. */
  problems: string[];
};

export function openLangfuse(): LangfuseRun | undefined {
  const { config } = langfuseConfig();
  if (!config) return undefined;
  return {
    client: new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    }),
    problems: [],
  };
}

/** The shape of a score as the experiment evaluators return it. */
export type Evaluation = {
  name: string;
  /** Booleans are sent as 1 or 0 with dataType BOOLEAN. */
  value: number | string;
  comment?: string;
  metadata?: Record<string, unknown>;
  dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
};

const NUMERIC = [
  ["correctness", "correctness"],
  ["groundedness", "groundedness"],
  ["rule_compliance", "ruleCompliance"],
  ["tool_fidelity", "toolFidelity"],
  ["overall", "overall"],
] as const;

export const SCORE_NAMES = [
  "correctness",
  "groundedness",
  "rule_compliance",
  "tool_fidelity",
  "overall",
  "critical_violation",
  "deterministic_pass",
  "case_pass",
];

/** Scores in the experiment's evaluator format; the SDK attaches them. */
export function evaluationsFor(
  result: CaseResult,
  meta: Pick<RunMeta, "runId" | "commit" | "goldenSetVersion">,
  rubricVersion: string,
): Evaluation[] {
  const metadata = {
    caseId: result.caseId,
    runId: meta.runId,
    commit: meta.commit,
    goldenSetVersion: meta.goldenSetVersion,
    rubricVersion,
    judgeModel: result.judge?.model ?? "none",
    critical: result.critical,
  };
  const out: Evaluation[] = [];
  if (result.judge) {
    const { verdict } = result.judge;
    for (const [name, key] of NUMERIC)
      out.push({
        name,
        value: verdict[key],
        dataType: "NUMERIC",
        metadata,
        ...(name === "overall" && {
          comment: verdict.reasoning.slice(0, 1500),
        }),
      });
    out.push({
      name: "critical_violation",
      value: verdict.criticalViolation ? 1 : 0,
      dataType: "BOOLEAN",
      comment: verdict.reasoning.slice(0, 1500),
      metadata,
    });
  }
  out.push(
    {
      name: "deterministic_pass",
      value: result.checks.every((c) => c.passed) ? 1 : 0,
      dataType: "BOOLEAN",
      comment:
        result.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.id}: ${c.detail}`)
          .join("\n")
          .slice(0, 1500) || "all checks passed",
      metadata,
    },
    {
      name: "case_pass",
      value: result.status === "passed" ? 1 : 0,
      dataType: "BOOLEAN",
      comment: result.failures.join("\n").slice(0, 1500) || "passed",
      metadata,
    },
  );
  return out;
}

/** The judge's own model call, as its own trace, with usage and cost. */
export function recordJudgeTrace(
  result: CaseResult,
  meta: Pick<RunMeta, "runId" | "commit" | "goldenSetVersion">,
  rubricVersion: string,
) {
  const judge = result.judge;
  if (!judge) return;
  const end = new Date(judge.startedAt.getTime() + judge.latencyMs);
  const span = startObservation(
    "eval-judge",
    {
      model: judge.model.replace(/^google\//, ""),
      input: judge.prompt.slice(0, 8000),
      output: judge.verdict,
      usageDetails: {
        ...(judge.usage.inputTokens !== null && {
          input: judge.usage.inputTokens,
        }),
        ...(judge.usage.outputTokens !== null && {
          output: judge.usage.outputTokens,
        }),
      },
      ...(judge.costUsd !== null && { costDetails: { total: judge.costUsd } }),
      metadata: {
        caseId: result.caseId,
        runId: meta.runId,
        commit: meta.commit,
        goldenSetVersion: meta.goldenSetVersion,
        rubricVersion,
        judgeModel: judge.model,
        candidateTraceId: result.finalTraceId ?? "",
        attempts: judge.attempts,
        temperature: 0,
        costBasis:
          judge.costUsd === null
            ? "unknown: no token counts reported"
            : "estimate: reported tokens x Google list prices (lib/ai/pricing.ts)",
      },
    },
    { asType: "generation", startTime: judge.startedAt },
  );
  const set = (key: string, value: string | string[]) =>
    span.otelSpan.setAttribute(key, value);
  set(LangfuseOtelSpanAttributes.TRACE_NAME, "eval-judge");
  set(
    LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
    `eval-${meta.runId}-judge`.slice(0, 100),
  );
  set(LangfuseOtelSpanAttributes.TRACE_TAGS, [
    "eval",
    "judge",
    `eval-run:${meta.runId}`,
    `case:${result.caseId}`,
  ]);
  set(LangfuseOtelSpanAttributes.ENVIRONMENT, "eval");
  span.end(end);
}

/** Sends every pending trace and score. True only if both were sent. */
export async function flushLangfuse(lf: LangfuseRun): Promise<boolean> {
  let ok = await flushTraces();
  try {
    await lf.client.flush();
  } catch (error) {
    console.warn(
      "[langfuse] could not send scores:",
      error instanceof Error ? error.message : String(error),
    );
    ok = false;
  }
  return ok;
}

type ApiAuth = { base: string; auth: string };
function apiAuth(): ApiAuth | undefined {
  const { config } = langfuseConfig();
  if (!config) return undefined;
  return {
    base: config.baseUrl.replace(/\/$/, ""),
    auth: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
  };
}

export async function api(path: string): Promise<unknown> {
  const a = apiAuth();
  if (!a) throw new Error("Langfuse is not configured");
  const res = await fetch(`${a.base}${path}`, {
    headers: { Authorization: a.auth },
  });
  if (!res.ok)
    throw new Error(`Langfuse ${path.split("?")[0]} answered ${res.status}`);
  return res.json();
}

/** The Langfuse project id, for links. Undefined if it can't be read. */
export async function projectId(): Promise<string | undefined> {
  try {
    const body = (await api("/api/public/projects")) as {
      data?: { id: string }[];
    };
    return body.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

export function traceUrl(projectId: string | undefined, traceId: string) {
  const a = apiAuth();
  return a && projectId
    ? `${a.base}/project/${projectId}/traces/${traceId}`
    : undefined;
}

/** The dataset in Langfuse that holds the golden set. */
export const DATASET_NAME = "copper-golden-set";

/**
 * Creates (or updates) the Langfuse dataset of the golden set: one item per
 * case, with the conversation as the input and what a correct answer must
 * contain as the expected output. Items are keyed by case id, so running this
 * again updates them instead of adding copies.
 */
export async function syncDataset(lf: LangfuseRun, rubricVersion: string) {
  await lf.client.api.datasets.create({
    name: DATASET_NAME,
    description:
      "Ask Copper golden set: fixed questions with the facts, behaviors and rules a correct answer needs. Created from evals/golden-set.ts.",
    metadata: { goldenSetVersion: GOLDEN_SET_VERSION, rubricVersion },
  });
  for (const testCase of GOLDEN_SET)
    await lf.client.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: testCase.id,
      input: {
        surface: testCase.surface,
        startingAgent: testCase.agent ?? "copper",
        autoRefundLimitUsd: testCase.limitUsd ?? 50,
        refundsAlreadyOnConsole: testCase.refunds ?? [],
        conversation: testCase.turns,
      },
      expectedOutput: testCase.expected,
      metadata: {
        caseId: testCase.id,
        title: testCase.title,
        category: testCase.category,
        critical: testCase.critical,
        sources: testCase.sources,
        checks: testCase.checks,
        goldenSetVersion: GOLDEN_SET_VERSION,
        rubricVersion,
      },
    });
}

/**
 * Reads the run's scores back from Langfuse (`/api/public/v3/scores`) and
 * returns how many of the expected ones are there. Langfuse takes a while to
 * make new data visible, so this waits (up to `waitMs`) for all of them.
 */
export async function readBack(
  runId: string,
  traceIds: string[],
  expected: { scores: number; items: number },
  waitMs = 180_000,
): Promise<{ scores: number; items: number }> {
  const deadline = Date.now() + waitMs;
  const wanted = new Set(traceIds);
  const from = new Date(Date.now() - 6 * 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  let found = { scores: 0, items: 0 };
  for (;;) {
    try {
      let scores = 0;
      for (const name of SCORE_NAMES) {
        let cursor: string | undefined;
        do {
          const body = (await api(
            `/api/public/v3/scores?limit=100&fields=core,subject&name=${name}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )) as {
            data?: { subject?: { traceId?: string } }[];
            meta?: { cursor?: string };
          };
          scores += (body.data ?? []).filter(
            (s) => s.subject?.traceId && wanted.has(s.subject.traceId),
          ).length;
          cursor = body.meta?.cursor;
        } while (cursor);
      }
      // The experiment's items: one per case, linked to the dataset item.
      let items = 0;
      let cursor: string | undefined;
      do {
        const body = (await api(
          `/api/public/experiment-items?limit=100&fromStartTime=${encodeURIComponent(from)}&toStartTime=${encodeURIComponent(to)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        )) as {
          data?: { experimentName?: string; traceId?: string }[];
          meta?: { cursor?: string };
        };
        items += (body.data ?? []).filter(
          (i) =>
            i.experimentName === runId && i.traceId && wanted.has(i.traceId),
        ).length;
        cursor = body.meta?.cursor;
      } while (cursor);
      found = { scores, items };
    } catch {
      // Try again until the deadline: the API can be briefly unavailable.
    }
    if (
      (found.scores >= expected.scores && found.items >= expected.items) ||
      Date.now() > deadline
    )
      return found;
    await new Promise((r) => setTimeout(r, 6000));
  }
}
