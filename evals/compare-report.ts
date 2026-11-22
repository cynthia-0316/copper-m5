import {
  fmt,
  mean,
  metricsOf,
  type Mode,
  type RunMetrics,
  type SavedRun,
  sum,
} from "@/evals/compare";
import type { RetryTrace } from "@/evals/retry-trace";
import type { ModelId } from "@/lib/ai/models";
import { PRICING } from "@/lib/ai/pricing";

// The full single vs multi report: every run, the two architectures side by
// side, and what was spent on retries. Everything is read from saved results;
// a number that was not measured says so instead of being worked out.

export type LoadedRun = {
  run: SavedRun;
  metrics: RunMetrics;
  /** Every attempt traced in Langfuse; undefined when it wasn't collected. */
  retries?: RetryTrace;
};

export function loadRun(
  run: SavedRun,
  label: string,
  retries?: RetryTrace,
): LoadedRun {
  return { run, metrics: metricsOf(run, label), retries };
}

const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(4)}`);
const seconds = (ms: number | null) =>
  ms === null ? "not measured" : (ms / 1000).toFixed(1);
const minutes = (ms: number | null) =>
  ms === null ? "not measured" : `${(ms / 60000).toFixed(1)} min`;

/** One row per run, in the order they were run. */
export function renderPerRun(runs: LoadedRun[]): string {
  const rows = runs.map(({ metrics: m }, i) => {
    return `| ${i + 1} | ${m.mode} | \`${m.runId}\` | \`${m.commit.slice(0, 7)}\` | ${m.passed}/${m.cases} | ${fmt(m.averageJudgeScore, 2)} | ${m.criticalFailures} | ${m.qualityFailures} | ${m.infrastructureErrors} | ${seconds(m.averageLatencyMs)} | ${seconds(m.averageLatencyExRateLimitMs)} | ${(m.modelCalls / Math.max(1, m.casesMeasured)).toFixed(2)} | ${Math.round(m.totalTokens / Math.max(1, m.casesMeasured))} | ${usd(m.executionCostUsd)} | ${usd(m.judgeCostUsd)} | ${m.caseReruns} | ${m.judgeRetries} | ${minutes(m.wallClockMs)} |`;
  });
  return [
    "| Run | Architecture | Run ID | Commit | Passed | Avg judge | Critical | Quality fails | Infra errors | End-to-end s/case | Execution s/case | Model calls/case | Tokens/case | Answering cost | Judge cost | Case re-runs | Judge retries | Wall-clock |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export type Retried = {
  attempts: number;
  byOutcome: Record<string, number>;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /**
   * Attempts numbered below the lowest one Langfuse holds (for example attempt
   * 1 when only attempt 2 has a trace): they happened, but their use can't be
   * known.
   */
  untracedEarlier: number;
};

/**
 * The attempts of a run that were NOT the one graded: what they were and what
 * they used. null when the run's attempts weren't collected from Langfuse.
 */
export function retriedAttempts(run: LoadedRun): Retried | null {
  if (!run.retries) return null;
  const last = new Map<string, number>();
  for (const a of run.retries.attempts)
    last.set(a.caseId, Math.max(last.get(a.caseId) ?? 0, a.attempt));
  const first = new Map<string, number>();
  for (const a of run.retries.attempts)
    first.set(a.caseId, Math.min(first.get(a.caseId) ?? Infinity, a.attempt));
  const untracedEarlier = sum(
    [...first.values()].map((n) => Math.max(0, n - 1)),
  );
  const earlier = run.retries.attempts.filter(
    (a) => a.attempt < (last.get(a.caseId) ?? 0),
  );
  const price = PRICING[run.run.info.candidateModel as ModelId];
  const inTokens = sum(earlier.map((a) => a.inputTokens));
  const outTokens = sum(earlier.map((a) => a.outputTokens));
  const byOutcome: Record<string, number> = {};
  for (const a of earlier)
    byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
  return {
    attempts: earlier.length,
    byOutcome,
    modelCalls: sum(earlier.map((a) => a.modelCalls)),
    inputTokens: inTokens,
    outputTokens: outTokens,
    costUsd: price
      ? (inTokens * price.input + outTokens * price.output) / 1_000_000
      : null,
    untracedEarlier,
  };
}

const total = (runs: RunMetrics[], pick: (m: RunMetrics) => number) =>
  sum(runs.map(pick));

/** The mean with every run in brackets, so no run hides behind an average. */
const both = (
  runs: RunMetrics[],
  pick: (m: RunMetrics) => number | null,
  show: (n: number | null) => string,
) => {
  const values = runs.map(pick);
  return `${show(mean(values))} (${values.map(show).join(" / ")})`;
};

const totalAndRuns = (runs: RunMetrics[], pick: (m: RunMetrics) => number) =>
  `${total(runs, pick)} (${runs.map(pick).join(" / ")})`;

const of = (runs: LoadedRun[], mode: Mode) =>
  runs.filter((r) => r.metrics.mode === mode).map((r) => r.metrics);

/** The side-by-side table: the two architectures, their runs in brackets. */
export function renderFinal(runs: LoadedRun[]): string {
  const s = of(runs, "single");
  const m = of(runs, "multi");
  const row = (name: string, cell: (x: RunMetrics[]) => string) =>
    `| ${name} | ${cell(s)} | ${cell(m)} |`;
  return [
    "| Metric | Single Agent | Multi Agent |",
    "|---|---|---|",
    row("Runs", (x) => String(x.length)),
    row("Cases evaluated (all runs)", (x) => String(total(x, (r) => r.cases))),
    row("Cases with a complete answer, the base of the averages below", (x) =>
      totalAndRuns(x, (r) => r.casesMeasured),
    ),
    row("Cases passed (all runs)", (x) => totalAndRuns(x, (r) => r.passed)),
    row("Pass rate, mean of runs", (x) =>
      both(
        x,
        (r) => r.passRate * 100,
        (n) => `${fmt(n, 1)}%`,
      ),
    ),
    row("Average judge score (1-5)", (x) =>
      both(
        x,
        (r) => r.averageJudgeScore,
        (n) => fmt(n, 2),
      ),
    ),
    row("Critical violations (cases, all runs)", (x) =>
      totalAndRuns(x, (r) => r.criticalFailures),
    ),
    row("Quality failures (answered, did not pass)", (x) =>
      totalAndRuns(x, (r) => r.qualityFailures),
    ),
    row("Infrastructure errors (no valid result)", (x) =>
      totalAndRuns(x, (r) => r.infrastructureErrors),
    ),
    row(
      "Average end-to-end latency per case (s), final attempt, as measured",
      (x) =>
        both(
          x,
          (r) => r.averageLatencyMs / 1000,
          (n) => fmt(n, 1),
        ),
    ),
    row(
      "Average execution latency per case (s), without our request-limiter waits",
      (x) =>
        both(
          x,
          (r) => r.averageLatencyExRateLimitMs / 1000,
          (n) => fmt(n, 1),
        ),
    ),
    row("Average model calls per case", (x) =>
      both(
        x,
        (r) => r.modelCalls / Math.max(1, r.casesMeasured),
        (n) => fmt(n, 2),
      ),
    ),
    row("Average tokens per case, answering (input + output)", (x) =>
      both(
        x,
        (r) => r.totalTokens / Math.max(1, r.casesMeasured),
        (n) => fmt(n, 0),
      ),
    ),
    row("Answering cost per valid case (estimate)", (x) =>
      both(
        x,
        (r) =>
          r.executionCostUsd === null
            ? null
            : r.executionCostUsd / Math.max(1, r.casesMeasured),
        (n) => (n === null ? "n/a" : `${n.toFixed(5)}`),
      ),
    ),
    row("Answering cost, total over valid cases (estimate)", (x) => {
      const costs = x.map((r) => r.executionCostUsd);
      return costs.some((c) => c === null)
        ? "n/a"
        : `${usd(sum(costs as number[]))} (${costs.map(usd).join(" / ")})`;
    }),
    row("Retry count: case re-runs (all runs)", (x) =>
      totalAndRuns(x, (r) => r.caseReruns),
    ),
    row("Retry count: judge retries (all runs)", (x) =>
      totalAndRuns(x, (r) => r.judgeRetries),
    ),
    row("Handoff count (all runs)", (x) => totalAndRuns(x, (r) => r.handoffs)),
    row("Tool execution errors (all runs)", (x) =>
      totalAndRuns(x, (r) => r.toolErrors),
    ),
    row("Evaluation wall-clock per run", (x) =>
      both(
        x,
        (r) => r.wallClockMs,
        (n) => (n === null ? "not measured" : `${(n / 60000).toFixed(1)} min`),
      ),
    ),
  ].join("\n");
}

/** Judging cost, apart from answering. */
export function renderJudgeCost(runs: LoadedRun[]): string {
  const s = of(runs, "single");
  const m = of(runs, "multi");
  const row = (
    name: string,
    pick: (r: RunMetrics) => number | null,
    show: (n: number | null) => string,
  ) => `| ${name} | ${both(s, pick, show)} | ${both(m, pick, show)} |`;
  return [
    "| AI judge (apart from answering) | Single Agent | Multi Agent |",
    "|---|---|---|",
    row(
      "Judge tokens per run",
      (r) => r.judgeTokens,
      (n) => fmt(n, 0),
    ),
    row("Estimated judge cost per run", (r) => r.judgeCostUsd, usd),
  ].join("\n");
}

/** What the re-run attempts were and what they used, from the Langfuse traces. */
export function renderRetries(runs: LoadedRun[]): string {
  const lines = [
    "| Run | Architecture | Case re-runs (results.json) | Earlier attempts traced: no answer / error | Model calls in them | Tokens in them | Cost of them (estimate) | Earlier attempts with NO trace (use unknown) | Judge retries |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  runs.forEach((r, i) => {
    const w = retriedAttempts(r);
    const m = r.metrics;
    lines.push(
      w
        ? `| ${i + 1} | ${m.mode} | ${m.caseReruns} | ${w.byOutcome.no_answer ?? 0} / ${w.byOutcome.error ?? 0} (of ${w.attempts}) | ${w.modelCalls} | ${w.inputTokens + w.outputTokens} | ${usd(w.costUsd)} | ${w.untracedEarlier} | ${m.judgeRetries} (reason not recorded) |`
        : `| ${i + 1} | ${m.mode} | ${m.caseReruns} | not measured | not measured | not measured | not measured | not measured | ${m.judgeRetries} (reason not recorded) |`,
    );
  });
  return lines.join("\n");
}

/** Cases that were re-run, with what each attempt was. */
export function renderRetryDetails(runs: LoadedRun[]): string {
  const lines: string[] = [];
  runs.forEach((r, i) => {
    if (!r.retries) return;
    const byCase = new Map<string, typeof r.retries.attempts>();
    for (const a of r.retries.attempts)
      byCase.set(a.caseId, [...(byCase.get(a.caseId) ?? []), a]);
    for (const [caseId, attempts] of byCase) {
      const lowest = Math.min(...attempts.map((a) => a.attempt));
      if (attempts.length < 2 && lowest === 1) continue;
      const recorded = r.run.results.find((c) => c.caseId === caseId);
      const parts = [
        ...(lowest > 1
          ? [
              `attempt${lowest > 2 ? "s" : ""} 1${lowest > 2 ? `-${lowest - 1}` : ""} has no trace`,
            ]
          : []),
        ...attempts.map((a) => `attempt ${a.attempt} ${a.outcome}`),
      ];
      lines.push(
        `- Run ${i + 1} (${r.metrics.mode}), **${caseId}**: ${parts.join(", then ")}${
          recorded?.status === "error"
            ? `. The case is recorded as an infrastructure error (${recorded.failures.join("; ").slice(0, 80)}), so a later attempt that did finish was never graded or counted`
            : ""
        }`,
      );
    }
  });
  return lines.length ? lines.join("\n") : "No case was re-run in any run.";
}

/** Per case: pass count across each architecture's runs, with the failures. */
export function renderCases(runs: LoadedRun[]): string {
  const ids = [
    ...new Set(runs.flatMap((r) => r.run.results.map((c) => c.caseId))),
  ];
  const side = (mode: Mode, id: string) =>
    runs
      .filter((r) => r.metrics.mode === mode)
      .map((r) => r.run.results.find((c) => c.caseId === id))
      .map((c) =>
        !c
          ? "-"
          : c.status === "passed"
            ? "pass"
            : c.status === "error"
              ? "ERROR"
              : "FAIL",
      );
  const lines = [
    "| Case | Single (run 1 / run 4) | Multi (run 2 / run 3) |",
    "|---|---|---|",
  ];
  for (const id of ids)
    lines.push(
      `| ${id} | ${side("single", id).join(" / ")} | ${side("multi", id).join(" / ")} |`,
    );
  return lines.join("\n");
}

/** Every failing or errored case with the reason, for any run. */
export function renderFailures(runs: LoadedRun[]): string {
  const lines: string[] = [];
  runs.forEach((r, i) => {
    for (const c of r.run.results.filter((x) => x.status !== "passed"))
      lines.push(
        `- Run ${i + 1} (${r.metrics.mode}), **${c.caseId}** [${c.status === "error" ? "infrastructure error" : "quality failure"}${c.criticalFailure ? ", critical" : ""}]: ${c.failures.join("; ").slice(0, 500)}`,
      );
  });
  return lines.length
    ? lines.join("\n")
    : "No case failed or errored in any run.";
}
