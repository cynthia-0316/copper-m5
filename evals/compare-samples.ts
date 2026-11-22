import { fmt, type Mode, sum } from "@/evals/compare";
import type { ModelId } from "@/lib/ai/models";
import { PRICING } from "@/lib/ai/pricing";
import { type LoadedRun, retriedAttempts } from "@/evals/compare-report";

// Sample sizes, exclusions and the like-for-like comparison. A value that is
// missing is never counted as 0 and never disappears quietly: each metric shows
// how many cases it rests on, and every excluded case is listed with its reason.

const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(4)}`);

const archRuns = (runs: LoadedRun[], mode: Mode) =>
  runs.filter((r) => r.metrics.mode === mode);

/**
 * Why a case ended in an error, from its message. An error means no valid
 * answer or grade exists for that case: the service or network failed, the
 * answer was not found wrong. The cause of a timeout is not proven by the data.
 */
export function errorKind(message: string): string {
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
      message,
    )
  )
    return "network";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (
    /high demand|\b(429|500|502|503|504)\b|quota|rate.?limit|overloaded|unavailable/i.test(
      message,
    )
  )
    return "Gemini service";
  if (/without an answer/i.test(message)) return "model gave no answer";
  return "other";
}

/** Per architecture: how many cases each metric rests on, and what is missing. */
export function renderSampleSizes(runs: LoadedRun[]): string {
  const cell = (mode: Mode, pick: (r: LoadedRun) => number) => {
    const rs = archRuns(runs, mode);
    return String(sum(rs.map(pick)));
  };
  const scheduled = (r: LoadedRun) => r.run.results.length;
  const valid = (r: LoadedRun) =>
    r.run.results.filter((c) => c.status !== "error").length;
  const judged = (r: LoadedRun) => r.run.results.filter((c) => c.judge).length;
  const costKnown = (r: LoadedRun) =>
    r.run.results.filter(
      (c) => c.status !== "error" && c.candidate.costUsd !== null,
    ).length;
  const missing = (mode: Mode) => {
    const rs = archRuns(runs, mode);
    const total = sum(rs.map(scheduled));
    const errors = total - sum(rs.map(valid));
    return `${errors} of ${total} (${total ? ((errors / total) * 100).toFixed(1) : "0.0"}%)`;
  };
  const row = (name: string, pick: (r: LoadedRun) => number) =>
    `| ${name} | ${cell("single", pick)} | ${cell("multi", pick)} |`;
  return [
    "| Effective sample (cases) | Single Agent | Multi Agent |",
    "|---|---|---|",
    row("Scheduled (18 per run)", scheduled),
    row(
      "Valid: answered and graded (pass rate, judge score, critical violations)",
      judged,
    ),
    row(
      "Valid: complete answer (latency, model calls, tokens, tool counts, handoffs)",
      valid,
    ),
    row("Valid: complete answer with a known cost (answering cost)", costKnown),
    `| Missing: ended in an error (infrastructure), excluded from every average | ${missing("single")} | ${missing("multi")} |`,
    "",
    "A case that ended in an error is excluded from averages and counted here; it is never treated as 0 and never counted as a wrong answer.",
  ].join("\n");
}

/** Every case that ended in an error, with its kind and the message. */
export function renderExcluded(runs: LoadedRun[]): string {
  const lines: string[] = [];
  runs.forEach((r, i) => {
    for (const c of r.run.results.filter((x) => x.status === "error"))
      lines.push(
        `| ${i + 1} | ${r.metrics.mode} | ${c.caseId} | ${errorKind(c.failures.join(" "))} | ${c.failures.join("; ").replace(/\|/g, "/").slice(0, 160)} | ${c.attempts} |`,
      );
  });
  if (!lines.length) return "No case ended in an error in any run.";
  return [
    "| Run | Architecture | Case | Kind | Message | Attempts |",
    "|---|---|---|---|---|---|",
    ...lines,
  ].join("\n");
}

/**
 * Only cases that have a valid result in EVERY run of BOTH architectures, so
 * a missing case in one run can't tilt the comparison. Returns the case ids.
 */
export function completeCaseIds(runs: LoadedRun[]): string[] {
  if (!runs.length) return [];
  const ids = [
    ...new Set(runs.flatMap((r) => r.run.results.map((c) => c.caseId))),
  ];
  return ids.filter((id) =>
    runs.every((r) =>
      r.run.results.some((c) => c.caseId === id && c.status !== "error"),
    ),
  );
}

/** The like-for-like table over the complete cases only. */
export function renderLikeForLike(runs: LoadedRun[]): string {
  const ids = new Set(completeCaseIds(runs));
  const stat = (mode: Mode) => {
    const rs = archRuns(runs, mode);
    const cases = rs.flatMap((r) =>
      r.run.results.filter((c) => ids.has(c.caseId)),
    );
    const judged = cases.filter((c) => c.judge);
    const costs = cases.map((c) => c.candidate.costUsd);
    return {
      n: cases.length,
      passed: cases.filter((c) => c.status === "passed").length,
      critical: cases.filter((c) => c.criticalFailure).length,
      judge: judged.length
        ? sum(judged.map((c) => c.judge!.verdict.overall)) / judged.length
        : null,
      latency: cases.length
        ? sum(cases.map((c) => c.candidate.latencyMs)) / cases.length / 1000
        : null,
      exec: cases.length
        ? (sum(cases.map((c) => c.candidate.latencyMs)) -
            sum(cases.map((c) => c.activity?.rateLimitWaitMs ?? 0))) /
          cases.length /
          1000
        : null,
      calls: cases.length
        ? sum(cases.map((c) => c.candidate.modelCalls)) / cases.length
        : null,
      tokens: cases.length
        ? sum(
            cases.map(
              (c) => c.candidate.inputTokens + c.candidate.outputTokens,
            ),
          ) / cases.length
        : null,
      cost: costs.some((c) => c === null) ? null : sum(costs as number[]),
      handoffs: sum(cases.map((c) => c.activity?.handoffs ?? 0)),
    };
  };
  const s = stat("single");
  const m = stat("multi");
  const row = (name: string, a: string, b: string) =>
    `| ${name} | ${a} | ${b} |`;
  return [
    `Cases with a valid result in every one of the ${runs.length} runs: **${ids.size} of 18** (${[...ids].length ? [...ids].join(", ") : "none"}). Each architecture's numbers use exactly these cases.`,
    "",
    "| Like-for-like | Single Agent | Multi Agent |",
    "|---|---|---|",
    row("Case results (cases x runs)", String(s.n), String(m.n)),
    row(
      "Passed",
      `${s.passed} (${s.n ? ((s.passed / s.n) * 100).toFixed(1) : "n/a"}%)`,
      `${m.passed} (${m.n ? ((m.passed / m.n) * 100).toFixed(1) : "n/a"}%)`,
    ),
    row("Critical failures", String(s.critical), String(m.critical)),
    row("Average judge score", fmt(s.judge, 2), fmt(m.judge, 2)),
    row("Average end-to-end latency (s)", fmt(s.latency, 1), fmt(m.latency, 1)),
    row(
      "Average execution latency (s), without our limiter's waits",
      fmt(s.exec, 1),
      fmt(m.exec, 1),
    ),
    row("Average model calls", fmt(s.calls, 2), fmt(m.calls, 2)),
    row("Average tokens (input + output)", fmt(s.tokens, 0), fmt(m.tokens, 0)),
    row("Answering cost over these cases (estimate)", usd(s.cost), usd(m.cost)),
    row("Handoffs", String(s.handoffs), String(m.handoffs)),
  ].join("\n");
}

/**
 * What is known about the use of cases that ended in an error. results.json has
 * nothing for them; Langfuse may hold the traces of later attempts (never
 * graded, never counted), and earlier attempts may have no trace at all.
 */
function unconfirmedCost(run: LoadedRun, caseIds: string[]): string {
  if (!run.retries)
    return `unknown for ${caseIds.length} case(s) (Langfuse attempts not collected)`;
  const ids = new Set(caseIds);
  const traced = run.retries.attempts.filter((a) => ids.has(a.caseId));
  const price = PRICING[run.run.info.candidateModel as ModelId];
  const tokens = sum(traced.map((a) => a.inputTokens + a.outputTokens));
  const cost = price
    ? sum(
        traced.map(
          (a) =>
            (a.inputTokens * price.input + a.outputTokens * price.output) /
            1_000_000,
        ),
      )
    : null;
  const untraced = sum(
    caseIds.map((id) => {
      const lowest = Math.min(
        ...traced.filter((a) => a.caseId === id).map((a) => a.attempt),
        Infinity,
      );
      return Number.isFinite(lowest) ? Math.max(0, lowest - 1) : 1;
    }),
  );
  return `${traced.length} later attempt(s) traced in Langfuse, never graded: ${tokens} tokens, ${usd(cost)}; ${untraced} earlier attempt(s) with no trace: use unknown`;
}

/**
 * Cost in three kinds that are never added together as if they were one:
 *  - observed: the answering usage of valid cases (tokens the model reported);
 *  - retry waste: earlier attempts of re-run cases, from Langfuse traces;
 *  - unconfirmed: usage of cases that ended in an error, a lower bound at best
 *    (the run was cut off; a missing or partial trace can't be completed).
 * The judge's cost is separate from all three.
 */
export function renderCostKinds(runs: LoadedRun[]): string {
  const lines = [
    "| Run | Architecture | Observed answering cost (valid cases) | Valid cases | Retry waste (earlier attempts, Langfuse) | Unconfirmed: usage seen on errored cases (lower bound) | Judge cost (separate) |",
    "|---|---|---|---|---|---|---|",
  ];
  runs.forEach((r, i) => {
    const valid = r.run.results.filter((c) => c.status !== "error");
    const errored = r.run.results.filter((c) => c.status === "error");
    const observed = valid.some((c) => c.candidate.costUsd === null)
      ? null
      : sum(valid.map((c) => c.candidate.costUsd as number));
    const waste = retriedAttempts(r);
    const seen = errored.length
      ? unconfirmedCost(
          r,
          errored.map((c) => c.caseId),
        )
      : "none";
    lines.push(
      `| ${i + 1} | ${r.metrics.mode} | ${usd(observed)} | ${valid.length} | ${waste ? usd(waste.costUsd) : "not measured"} | ${seen} | ${usd(r.metrics.judgeCostUsd)} |`,
    );
  });
  lines.push(
    "",
    "Retry waste counts only attempts whose traces Langfuse still holds. Tokens are what the model reported; cost is an estimate from list prices. These three columns are different things and are not summed.",
  );
  return lines.join("\n");
}

/** The share of scheduled cases that never got a valid result, per run. */
export function renderReliability(runs: LoadedRun[]): string {
  const lines = [
    "| Run | Architecture | Exit | Valid cases | Errors (infrastructure) | Quality failures | Case re-runs | Judge retries | Complete run? |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  runs.forEach((r, i) => {
    const m = r.metrics;
    lines.push(
      `| ${i + 1} | ${m.mode} | ${r.run.summary.exitCode} | ${m.casesMeasured}/${m.cases} | ${m.infrastructureErrors} | ${m.qualityFailures} | ${m.caseReruns} | ${m.judgeRetries} | ${m.infrastructureErrors === 0 ? "yes" : "NO: incomplete"} |`,
    );
  });
  return lines.join("\n");
}
