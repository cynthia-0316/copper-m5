import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult, Summary } from "@/evals/evaluate";

export type RunInfo = {
  runId: string;
  commit: string;
  /** Which architecture answered. */
  agentMode?: "single" | "multi";
  goldenSetVersion: string;
  rubricVersion: string;
  candidateModel: string;
  judgeModel: string;
  startedAt: string;
  finishedAt: string;
  langfuse: {
    enabled: boolean;
    /** Whether every trace and score was sent and read back. */
    complete: boolean;
    detail: string;
    projectId?: string;
    baseUrl?: string;
    experimentUrl?: string;
    datasetRunId?: string;
  };
};

const usd = (value: number | null) =>
  value === null ? "unknown" : `$${value.toFixed(4)}`;

const esc = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function traceLink(info: RunInfo, traceId?: string) {
  if (!traceId) return "no trace";
  const { projectId, baseUrl } = info.langfuse;
  return projectId && baseUrl
    ? `[${traceId.slice(0, 8)}](${baseUrl}/project/${projectId}/traces/${traceId})`
    : traceId.slice(0, 8);
}

export function markdownSummary(
  info: RunInfo,
  summary: Summary,
  results: CaseResult[],
): string {
  const icon = {
    pass: "✅ PASSED",
    fail: "❌ FAILED",
    incomplete: "⚠️ INCOMPLETE",
  }[summary.verdict];
  const lines: string[] = [
    `## Golden-set evaluation: ${icon}`,
    "",
    `- Cases: **${summary.total}** | passed **${summary.passed}** | failed **${summary.failed}** | errors **${summary.errors}**`,
    `- Pass rate **${(summary.passRate * 100).toFixed(0)}%**; average judge score **${summary.averageOverall?.toFixed(2) ?? "n/a"}** / 5`,
    `- Architecture: **${info.agentMode ?? "multi"}-agent**`,
    `- Run \`${info.runId}\` on commit \`${info.commit.slice(0, 7)}\`; golden set \`${info.goldenSetVersion}\`, rubric \`${info.rubricVersion}\``,
    `- Ask Copper model \`${info.candidateModel}\`; judge model \`${info.judgeModel}\` (temperature 0)`,
  ];
  if (summary.reasons.length)
    lines.push(
      "",
      "### Why it did not pass",
      ...summary.reasons.map((r) => `- ${r}`),
    );
  const critical = results.filter((r) => r.criticalFailure);
  if (critical.length) {
    lines.push("", "### Critical failures");
    for (const r of critical)
      lines.push(`- **${r.caseId}**: ${esc(r.failures.join("; "))}`);
  }
  const errored = results.filter((r) => r.status === "error");
  if (errored.length) {
    lines.push("", "### Errors (the evaluation is incomplete)");
    for (const r of errored)
      lines.push(`- **${r.caseId}**: ${esc(r.failures.join("; "))}`);
  }
  lines.push(
    "",
    "### Cases",
    "",
    "| Case | Result | Critical | Overall | Correct | Grounded | Rules | Tools | Trace |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
    const v = r.judge?.verdict;
    const result =
      r.status === "passed"
        ? "✅ pass"
        : r.status === "failed"
          ? "❌ fail"
          : "⚠️ error";
    lines.push(
      `| ${r.caseId} | ${result} | ${r.critical ? "yes" : ""} | ${v?.overall ?? "-"} | ${v?.correctness ?? "-"} | ${v?.groundedness ?? "-"} | ${v?.ruleCompliance ?? "-"} | ${v?.toolFidelity ?? "-"} | ${traceLink(info, r.finalTraceId)} |`,
    );
  }
  const failed = results.filter((r) => r.status !== "passed");
  if (failed.length) {
    lines.push("", "### Failed cases");
    for (const r of failed) {
      lines.push("", `**${r.caseId}** (${r.title})`);
      for (const f of r.failures) lines.push(`- ${esc(f)}`);
      if (r.judge) lines.push(`- Judge: ${esc(r.judge.verdict.reasoning)}`);
    }
  }
  const candidateCost = results.every((r) => r.candidate.costUsd !== null)
    ? results.reduce((s, r) => s + (r.candidate.costUsd ?? 0), 0)
    : null;
  const judgeCost = results.every((r) => !r.judge || r.judge.costUsd !== null)
    ? results.reduce((s, r) => s + (r.judge?.costUsd ?? 0), 0)
    : null;
  const tokens = (pick: (r: CaseResult) => number) =>
    results.reduce((s, r) => s + pick(r), 0);
  lines.push(
    "",
    "### Usage (estimated cost from list prices)",
    "",
    "| | Model calls | Input tokens | Output tokens | Cost | Time |",
    "|---|---|---|---|---|---|",
    `| Ask Copper | ${tokens((r) => r.candidate.modelCalls)} | ${tokens((r) => r.candidate.inputTokens)} | ${tokens((r) => r.candidate.outputTokens)} | ${usd(candidateCost)} | ${(tokens((r) => r.candidate.latencyMs) / 1000).toFixed(0)} s |`,
    `| AI judge | ${results.filter((r) => r.judge).length} | ${tokens((r) => r.judge?.usage.inputTokens ?? 0)} | ${tokens((r) => r.judge?.usage.outputTokens ?? 0)} | ${usd(judgeCost)} | ${(tokens((r) => r.judge?.latencyMs ?? 0) / 1000).toFixed(0)} s |`,
  );
  const lf = info.langfuse;
  lines.push(
    "",
    "### Langfuse",
    "",
    lf.enabled
      ? `- ${lf.complete ? "All traces and scores were sent and read back." : "⚠️ Not everything reached Langfuse: " + lf.detail}`
      : `- Not used: ${lf.detail}`,
  );
  if (lf.enabled && lf.projectId && lf.baseUrl)
    lines.push(
      `- Project: ${lf.baseUrl}/project/${lf.projectId}`,
      `- Dataset \`copper-golden-set\`, run \`${info.runId}\`: ${lf.experimentUrl ?? "Datasets in the project, then the run"}`,
      `- Each case's trace holds Ask Copper's agents, model calls and tools, and carries the case's scores. Filter Tracing by tag \`eval-run:${info.runId}\`; the judge's own calls are the \`eval-judge\` traces.`,
    );
  lines.push(
    "",
    "The full per-case results are in the `eval-results` artifact (results.json, results.csv).",
  );
  return lines.join("\n") + "\n";
}

const csvCell = (value: unknown) => {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function csvResults(results: CaseResult[]): string {
  const header = [
    "case_id",
    "category",
    "critical",
    "status",
    "critical_failure",
    "overall",
    "correctness",
    "groundedness",
    "rule_compliance",
    "tool_fidelity",
    "judge_critical_violation",
    "checks_failed",
    "attempts",
    "final_trace_id",
    "candidate_tokens_in",
    "candidate_tokens_out",
    "candidate_cost_usd",
    "candidate_ms",
    "judge_tokens_in",
    "judge_tokens_out",
    "judge_cost_usd",
    "judge_ms",
    "failures",
    "judge_reasoning",
  ];
  const rows = results.map((r) => {
    const v = r.judge?.verdict;
    return [
      r.caseId,
      r.category,
      r.critical,
      r.status,
      r.criticalFailure,
      v?.overall,
      v?.correctness,
      v?.groundedness,
      v?.ruleCompliance,
      v?.toolFidelity,
      v?.criticalViolation,
      r.checks
        .filter((c) => !c.passed)
        .map((c) => c.id)
        .join(" "),
      r.attempts,
      r.finalTraceId,
      r.candidate.inputTokens,
      r.candidate.outputTokens,
      r.candidate.costUsd ?? "unknown",
      r.candidate.latencyMs,
      r.judge?.usage.inputTokens ?? "",
      r.judge?.usage.outputTokens ?? "",
      r.judge?.costUsd ?? "",
      r.judge?.latencyMs ?? "",
      r.failures.join(" | "),
      v?.reasoning,
    ]
      .map(csvCell)
      .join(",");
  });
  return [header.join(","), ...rows].join("\n") + "\n";
}

/** Writes results.json, results.csv and summary.md into `dir`. */
export function writeReport(
  dir: string,
  info: RunInfo,
  summary: Summary,
  results: CaseResult[],
) {
  mkdirSync(dir, { recursive: true });
  const slim = results.map((r) => ({
    ...r,
    // The judge's full prompt is large and already in Langfuse.
    judge: r.judge ? { ...r.judge, prompt: undefined } : undefined,
  }));
  writeFileSync(
    join(dir, "results.json"),
    JSON.stringify({ info, summary, results: slim }, null, 2),
  );
  writeFileSync(join(dir, "results.csv"), csvResults(results));
  const md = markdownSummary(info, summary, results);
  writeFileSync(join(dir, "summary.md"), md);
  return md;
}
