import { LangfuseClient } from "@langfuse/client";
import {
  LangfuseOtelSpanAttributes,
  startObservation,
} from "@langfuse/tracing";
import type { CaseResult } from "@/evals/evaluate";
import {
  GOLDEN_SET,
  GOLDEN_SET_VERSION,
  type GoldenCase,
} from "@/evals/golden-set";
import type { RunMeta } from "@/evals/runner";
import { allPages, type Getter, politeGetter } from "@/evals/polite";
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

/** What the support agent(s) used for a case, one score each (execution only). */
export const EXECUTION_SCORE_NAMES = [
  "exec_model_calls",
  "exec_input_tokens",
  "exec_output_tokens",
  "exec_cost_usd",
  "exec_latency_ms",
  "exec_tool_calls",
  "exec_tool_errors",
  "exec_handoffs",
];

export const SCORE_NAMES = [
  ...EXECUTION_SCORE_NAMES,
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
  meta: Pick<RunMeta, "runId" | "commit" | "goldenSetVersion" | "agentMode">,
  rubricVersion: string,
): Evaluation[] {
  const metadata = {
    ...(meta.agentMode && { agentMode: meta.agentMode }),
    caseId: result.caseId,
    runId: meta.runId,
    commit: meta.commit,
    goldenSetVersion: meta.goldenSetVersion,
    rubricVersion,
    judgeModel: result.judge?.model ?? "none",
    critical: result.critical,
  };
  const out: Evaluation[] = [];
  // The cost of answering the customer, apart from the cost of judging it.
  const c = result.candidate;
  const a = result.activity;
  const exec = (name: string, value: number, comment?: string) =>
    out.push({
      name,
      value,
      dataType: "NUMERIC",
      metadata,
      ...(comment && { comment }),
    });
  exec("exec_model_calls", c.modelCalls);
  exec("exec_input_tokens", c.inputTokens);
  exec("exec_output_tokens", c.outputTokens);
  // Cost is an estimate from list prices; left out when tokens were unknown.
  if (c.costUsd !== null)
    exec(
      "exec_cost_usd",
      c.costUsd,
      "estimate: reported tokens x Google list prices (lib/ai/pricing.ts)",
    );
  exec(
    "exec_latency_ms",
    c.latencyMs,
    `includes ${a?.rateLimitWaitMs ?? 0} ms waiting for the evaluation's own request limiter`,
  );
  exec("exec_tool_calls", a?.toolCalls ?? 0);
  exec("exec_tool_errors", a?.toolErrors ?? 0);
  exec("exec_handoffs", a?.handoffs ?? 0);
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
  meta: Pick<RunMeta, "runId" | "commit" | "goldenSetVersion" | "agentMode">,
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
        ...(meta.agentMode && { agentMode: meta.agentMode }),
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
    ...(meta.agentMode ? [`arch:${meta.agentMode}`] : []),
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
export async function syncDataset(
  lf: LangfuseRun,
  rubricVersion: string,
  cases: GoldenCase[] = GOLDEN_SET,
  datasetName: string = DATASET_NAME,
  version: string = GOLDEN_SET_VERSION,
) {
  await lf.client.api.datasets.create({
    name: datasetName,
    description:
      "Ask Copper golden set: fixed questions with the facts, behaviors and rules a correct answer needs. Created from evals/golden-set.ts.",
    metadata: { goldenSetVersion: version, rubricVersion },
  });
  for (const testCase of cases)
    await lf.client.api.datasetItems.create({
      datasetName,
      id: datasetItemId(datasetName, testCase.id),
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
        goldenSetVersion: version,
        rubricVersion,
      },
    });
}

/**
 * Dataset item ids are unique across the whole Langfuse project, not per
 * dataset. The original dataset keeps the plain case id (its items already
 * exist under it); any other dataset (the architecture-neutral one) prefixes
 * its name, so the same case can live in both. The case id is also kept in
 * each item's metadata.caseId, which is what a run reads it back by.
 */
export const datasetItemId = (datasetName: string, caseId: string) =>
  datasetName === DATASET_NAME ? caseId : `${datasetName}:${caseId}`;

type ReadRow = {
  name?: string;
  experimentName?: string;
  traceId?: string;
  subject?: { traceId?: string };
};

export type ReadBack = {
  scores: number;
  items: number;
  /**
   * Set when the last attempt to ask Langfuse FAILED (an HTTP error). The
   * counts are then not evidence that data is missing: only that the question
   * wasn't answered. Without it, fewer than expected means the data is not there.
   */
  error?: string;
};

/**
 * Reads the run's experiment items and scores back from Langfuse, one request
 * at a time and within its rate limit (evals/polite.ts), and waits for them to
 * appear: Langfuse takes a while to make new data visible. `since` is when
 * the run started.
 */
export async function readBack(
  runId: string,
  traceIds: string[],
  expected: { scores: number; items: number },
  options: { since: string; waitMs?: number; get?: Getter } = {
    since: new Date(Date.now() - 6 * 3600_000).toISOString(),
  },
): Promise<ReadBack> {
  const { since, waitMs = 240_000, get = politeGetter() } = options;
  const deadline = Date.now() + waitMs;
  const wanted = new Set(traceIds);
  const enc = encodeURIComponent;
  const from = new Date(Date.parse(since) - 5 * 60_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  let found: ReadBack = { scores: 0, items: 0 };
  for (;;) {
    try {
      const items = (
        await allPages<ReadRow>(
          get,
          `/api/public/experiment-items?fromStartTime=${enc(from)}&toStartTime=${enc(to)}&limit=100`,
        )
      ).filter(
        (i) => i.experimentName === runId && i.traceId && wanted.has(i.traceId),
      );
      const scores = (
        await allPages<ReadRow>(
          get,
          `/api/public/v3/scores?fields=${enc("core,subject")}&fromTimestamp=${enc(from)}&toTimestamp=${enc(to)}&limit=100`,
        )
      ).filter((s) => s.subject?.traceId && wanted.has(s.subject.traceId));
      found = {
        scores: scores.length,
        items: new Set(items.map((i) => i.traceId)).size,
      };
    } catch (error) {
      found = {
        ...found,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      (found.scores >= expected.scores &&
        found.items >= expected.items &&
        !found.error) ||
      Date.now() >= deadline
    )
      return found;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
