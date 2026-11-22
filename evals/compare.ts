import type { CaseResult, Summary } from "@/evals/evaluate";
import type { RunInfo } from "@/evals/report";

// Compares the single support agent with the multi-agent Copper + Refund agent
// from saved evaluation results (results.json files written by `npm run eval`).
// Only numbers that were measured are used; a number that couldn't be measured
// (for example a cost when the model reported no tokens) shows as "n/a".

export type SavedRun = {
  info: RunInfo;
  summary: Summary;
  results: CaseResult[];
};

export type Mode = "single" | "multi";

export type RunMetrics = {
  label: string;
  runId: string;
  mode: Mode;
  cases: number;
  /** Cases with a complete answer (not an error): the base of the averages. */
  casesMeasured: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  averageJudgeScore: number | null;
  /** Cases that are critical failures (a critical case or check, or the judge's flag). */
  criticalFailures: number;
  /** Cases where the judge itself set criticalViolation. */
  judgeCriticalFlags: number;
  /** Mean time per case, as measured, and without our own request-limiter waits. */
  averageLatencyMs: number;
  averageLatencyExRateLimitMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated from list prices; null if any case had unknown tokens. */
  executionCostUsd: number | null;
  judgeCostUsd: number | null;
  judgeTokens: number;
  toolCalls: number;
  toolErrors: number;
  handoffs: number;
  /** Cases that needed more than one attempt after a temporary error. */
  casesRetried: number;
  /** Extra runs of a case after a temporary error (attempts beyond the first). */
  caseReruns: number;
  /** Extra tries of the judge call after a temporary error. */
  judgeRetries: number;
  /** Cases that ended in an error after every retry: the service, not the answer. */
  infrastructureErrors: number;
  /** Cases that were answered and graded, and did not pass: the answer. */
  qualityFailures: number;
  /** Whole evaluation, start to finish (includes the Langfuse read-back). */
  wallClockMs: number | null;
  startedAt: string;
  finishedAt: string;
  commit: string;
  goldenSetVersion: string;
  rubricVersion: string;
  candidateModel: string;
  judgeModel: string;
  experimentUrl?: string;
};

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const sumOrNull = (values: (number | null)[]) =>
  values.some((v) => v === null) ? null : sum(values as number[]);

export function metricsOf(run: SavedRun, label: string): RunMetrics {
  const { results, info, summary } = run;
  const judged = results.filter((r) => r.judge);
  // A case that ended in an error has no complete answer, so its partial time
  // and usage are left out of the averages (and counted as an error instead).
  const measured = results.filter((r) => r.status !== "error");
  const latency = measured.map((r) => r.candidate.latencyMs);
  const waited = measured.map((r) => r.activity?.rateLimitWaitMs ?? 0);
  const inTokens = sum(measured.map((r) => r.candidate.inputTokens));
  const outTokens = sum(measured.map((r) => r.candidate.outputTokens));
  return {
    label,
    runId: info.runId,
    mode: (info.agentMode ?? "multi") as Mode,
    cases: results.length,
    casesMeasured: measured.length,
    passed: summary.passed,
    failed: summary.failed,
    errors: summary.errors,
    passRate: results.length ? summary.passed / results.length : 0,
    averageJudgeScore: judged.length
      ? sum(judged.map((r) => r.judge!.verdict.overall)) / judged.length
      : null,
    criticalFailures: results.filter((r) => r.criticalFailure).length,
    judgeCriticalFlags: judged.filter((r) => r.judge!.verdict.criticalViolation)
      .length,
    averageLatencyMs: measured.length ? sum(latency) / measured.length : 0,
    averageLatencyExRateLimitMs: measured.length
      ? (sum(latency) - sum(waited)) / measured.length
      : 0,
    modelCalls: sum(measured.map((r) => r.candidate.modelCalls)),
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens: inTokens + outTokens,
    executionCostUsd: sumOrNull(measured.map((r) => r.candidate.costUsd)),
    judgeCostUsd: sumOrNull(judged.map((r) => r.judge!.costUsd)),
    judgeTokens: sum(
      judged.map(
        (r) =>
          (r.judge!.usage.inputTokens ?? 0) +
          (r.judge!.usage.outputTokens ?? 0),
      ),
    ),
    toolCalls: sum(measured.map((r) => r.activity?.toolCalls ?? 0)),
    toolErrors: sum(measured.map((r) => r.activity?.toolErrors ?? 0)),
    handoffs: sum(measured.map((r) => r.activity?.handoffs ?? 0)),
    casesRetried: results.filter((r) => r.attempts > 1).length,
    caseReruns: sum(results.map((r) => Math.max(0, r.attempts - 1))),
    judgeRetries: sum(
      results.map((r) => Math.max(0, (r.judge?.attempts ?? 1) - 1)),
    ),
    infrastructureErrors: results.filter((r) => r.status === "error").length,
    qualityFailures: results.filter((r) => r.status === "failed").length,
    wallClockMs: wallClock(info.startedAt, info.finishedAt),
    startedAt: info.startedAt,
    finishedAt: info.finishedAt,
    commit: info.commit,
    goldenSetVersion: info.goldenSetVersion,
    rubricVersion: info.rubricVersion,
    candidateModel: info.candidateModel,
    judgeModel: info.judgeModel,
    ...(info.langfuse.experimentUrl && {
      experimentUrl: info.langfuse.experimentUrl,
    }),
  };
}

/** Milliseconds between two ISO times, or null when either is missing. */
function wallClock(start: string, end: string): number | null {
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Mean of a metric across runs, or null if any run lacks it. */
export const mean = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === values.length && known.length
    ? sum(known) / known.length
    : null;
};

export const fmt = (value: number | null, digits = 0) =>
  value === null ? "n/a" : value.toFixed(digits);

const usd = (value: number | null) =>
  value === null ? "n/a" : `$${value.toFixed(4)}`;

/** "mean (run1, run2)" so every run stays visible next to its average. */
function cell(
  runs: RunMetrics[],
  pick: (m: RunMetrics) => number | null,
  show: (n: number | null) => string,
) {
  const values = runs.map(pick);
  const average = mean(values);
  return runs.length > 1
    ? `${show(average)} (${values.map(show).join(" / ")})`
    : show(average);
}

export type Comparison = {
  single: RunMetrics[];
  multi: RunMetrics[];
  /** Per case: passes across each architecture's runs. */
  cases: {
    caseId: string;
    single: { passed: number; of: number; failures: string[] };
    multi: { passed: number; of: number; failures: string[] };
  }[];
};

export function compare(runs: { run: SavedRun; label: string }[]): Comparison {
  const metrics = runs.map(({ run, label }) => ({
    run,
    metrics: metricsOf(run, label),
  }));
  const of = (mode: Mode) => metrics.filter((m) => m.metrics.mode === mode);
  const ids = [
    ...new Set(metrics.flatMap((m) => m.run.results.map((r) => r.caseId))),
  ];
  const side = (mode: Mode, caseId: string) => {
    const found = of(mode).flatMap((m) =>
      m.run.results.filter((r) => r.caseId === caseId),
    );
    return {
      passed: found.filter((r) => r.status === "passed").length,
      of: found.length,
      failures: found
        .filter((r) => r.status !== "passed")
        .map((r) => `${r.status}: ${r.failures.join("; ")}`),
    };
  };
  return {
    single: of("single").map((m) => m.metrics),
    multi: of("multi").map((m) => m.metrics),
    cases: ids.map((caseId) => ({
      caseId,
      single: side("single", caseId),
      multi: side("multi", caseId),
    })),
  };
}

export function renderComparison(comparison: Comparison): string {
  const { single, multi } = comparison;
  const row = (
    name: string,
    pick: (m: RunMetrics) => number | null,
    show: (n: number | null) => string,
  ) => `| ${name} | ${cell(single, pick, show)} | ${cell(multi, pick, show)} |`;
  const lines = [
    `Runs: single-agent ${single.length}, multi-agent ${multi.length}. Each cell is the mean over that architecture's runs, with every run in brackets.`,
    "",
    "| Metric | Single Agent | Multi Agent |",
    "|---|---|---|",
    row(
      "Cases passed (of 18)",
      (m) => m.passed,
      (n) => fmt(n, 1),
    ),
    row(
      "Pass rate",
      (m) => m.passRate * 100,
      (n) => `${fmt(n, 0)}%`,
    ),
    row(
      "Average judge score (1-5)",
      (m) => m.averageJudgeScore,
      (n) => fmt(n, 2),
    ),
    row(
      "Critical failures (cases)",
      (m) => m.criticalFailures,
      (n) => fmt(n, 1),
    ),
    row(
      "Judge critical-violation flags",
      (m) => m.judgeCriticalFlags,
      (n) => fmt(n, 1),
    ),
    row(
      "Cases that ended in an error",
      (m) => m.errors,
      (n) => fmt(n, 1),
    ),
    row(
      "Average latency per case (s), as measured",
      (m) => m.averageLatencyMs / 1000,
      (n) => fmt(n, 1),
    ),
    row(
      "Average latency per case (s), without our own request-limiter waits",
      (m) => m.averageLatencyExRateLimitMs / 1000,
      (n) => fmt(n, 1),
    ),
    row(
      "Model calls (total)",
      (m) => m.modelCalls,
      (n) => fmt(n, 1),
    ),
    row(
      "Total tokens, answering (input + output)",
      (m) => m.totalTokens,
      (n) => fmt(n, 0),
    ),
    row("Estimated execution cost (answering)", (m) => m.executionCostUsd, usd),
    row(
      "Tool calls (total)",
      (m) => m.toolCalls,
      (n) => fmt(n, 1),
    ),
    row(
      "Tool execution errors",
      (m) => m.toolErrors,
      (n) => fmt(n, 1),
    ),
    row(
      "Handoffs",
      (m) => m.handoffs,
      (n) => fmt(n, 1),
    ),
    row(
      "Cases re-run after a temporary error",
      (m) => m.casesRetried,
      (n) => fmt(n, 1),
    ),
    "",
    "Judging is counted apart from answering:",
    "",
    "| | Single Agent | Multi Agent |",
    "|---|---|---|",
    row(
      "Judge tokens (total)",
      (m) => m.judgeTokens,
      (n) => fmt(n, 0),
    ),
    row("Estimated judge cost", (m) => m.judgeCostUsd, usd),
  ];
  const differing = comparison.cases.filter(
    (c) =>
      c.single.passed / Math.max(1, c.single.of) !==
      c.multi.passed / Math.max(1, c.multi.of),
  );
  const unstable = comparison.cases.filter(
    (c) =>
      (c.single.of > 1 && c.single.passed % c.single.of !== 0) ||
      (c.multi.of > 1 && c.multi.passed % c.multi.of !== 0),
  );
  lines.push("", "### Cases where the two architectures differ", "");
  if (!differing.length)
    lines.push(
      "None: every case had the same pass rate for both architectures.",
    );
  for (const c of differing) {
    lines.push(
      `- **${c.caseId}**: single ${c.single.passed}/${c.single.of}, multi ${c.multi.passed}/${c.multi.of}`,
    );
    for (const f of c.single.failures)
      lines.push(`  - single: ${f.slice(0, 400)}`);
    for (const f of c.multi.failures)
      lines.push(`  - multi: ${f.slice(0, 400)}`);
  }
  lines.push(
    "",
    "### Cases that changed between runs of the same architecture",
    "",
  );
  if (!unstable.length) lines.push("None.");
  for (const c of unstable)
    lines.push(
      `- **${c.caseId}**: single ${c.single.passed}/${c.single.of}, multi ${c.multi.passed}/${c.multi.of}`,
    );
  return lines.join("\n") + "\n";
}
