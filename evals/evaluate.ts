import { type CheckResult, type CaseRun, runChecks } from "@/evals/checks";
import type { GoldenCase } from "@/evals/golden-set";
import { judgeCase, type JudgeOutcome, verdictPasses } from "@/evals/judge";
import { isTransient, withRetries } from "@/evals/retry";
import {
  CASE_MIN_DIMENSION,
  CASE_MIN_OVERALL,
  DIMENSIONS,
  SUITE_MIN_AVERAGE,
  SUITE_MIN_PASS_RATE,
} from "@/evals/rubric";
import { CaseRunError, runCase, type RunMeta } from "@/evals/runner";

export type CaseResult = {
  caseId: string;
  title: string;
  category: string;
  critical: boolean;
  status: "passed" | "failed" | "error";
  /** Failed, and the case or one of the failed checks is critical. */
  criticalFailure: boolean;
  failures: string[];
  /** How many times the case was run (more than 1 only after temporary errors). */
  attempts: number;
  checks: CheckResult[];
  judge?: JudgeOutcome;
  /** Why no valid judge verdict exists. */
  judgeError?: string;
  /** Why the conversation could not be run. */
  error?: string;
  turns: {
    input: string;
    reply: string;
    agent: string;
    tools: string[];
    traceId?: string;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
  }[];
  /** The trace of the judged reply (the last turn). Scores attach to it. */
  finalTraceId?: string;
  candidate: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
  };
};

export type Deps = {
  run?: typeof runCase;
  judge?: typeof judgeCase;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

function describe(testCase: GoldenCase, run: CaseRun | undefined) {
  const turns = (run?.turns ?? []).map((turn) => ({
    input: turn.input,
    reply: turn.progress.reply,
    agent: turn.progress.agent ?? "copper",
    tools: turn.progress.steps.flatMap((s) =>
      s.type === "tool" ? [s.name] : [],
    ),
    traceId: turn.traceId,
    modelCalls: turn.stats.modelCalls,
    inputTokens: turn.stats.inputTokens,
    outputTokens: turn.stats.outputTokens,
    costUsd: turn.stats.costUsd,
    latencyMs: turn.stats.latencyMs,
  }));
  const candidate = turns.reduce(
    (sum, t) => ({
      modelCalls: sum.modelCalls + t.modelCalls,
      inputTokens: sum.inputTokens + t.inputTokens,
      outputTokens: sum.outputTokens + t.outputTokens,
      costUsd:
        sum.costUsd === null || t.costUsd === null
          ? null
          : sum.costUsd + t.costUsd,
      latencyMs: sum.latencyMs + t.latencyMs,
    }),
    {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0 as number | null,
      latencyMs: 0,
    },
  );
  return { turns, candidate, finalTraceId: turns.at(-1)?.traceId, testCase };
}

/** Runs one case through Copper, checks it, judges it, and decides pass/fail. */
export async function evaluateCase(
  testCase: GoldenCase,
  meta: Omit<RunMeta, "attempt">,
  deps: Deps = {},
): Promise<CaseResult> {
  const run = deps.run ?? runCase;
  const judge = deps.judge ?? judgeCase;
  const base = {
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    critical: testCase.critical,
  };

  // 1. Run it. Only a temporary error runs it again, from a fresh start.
  let conversation: CaseRun | undefined;
  let attempts = 1;
  let error: string | undefined;
  try {
    const result = await withRetries(
      (attempt) => run(testCase, { ...meta, attempt }),
      {
        retries: 2,
        retryable: (e) =>
          e instanceof CaseRunError
            ? isTransient(new Error(e.message))
            : isTransient(e),
        sleep: deps.sleep,
      },
    );
    conversation = result.value;
    attempts = result.attempts;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (e instanceof CaseRunError) conversation = e.partial;
    attempts = 3;
  }
  if (!conversation || error) {
    const info = describe(testCase, conversation);
    return {
      ...base,
      status: "error",
      criticalFailure: false,
      failures: [`could not run the conversation: ${error ?? "no result"}`],
      attempts,
      checks: [],
      error: error ?? "no result",
      turns: info.turns,
      finalTraceId: info.finalTraceId,
      candidate: info.candidate,
    };
  }

  // 2. Checks a program can make, then the AI judge.
  const checks = runChecks(testCase, conversation);
  let verdict: JudgeOutcome | undefined;
  let judgeError: string | undefined;
  try {
    verdict = await judge(testCase, conversation);
  } catch (e) {
    judgeError = e instanceof Error ? e.message : String(e);
  }

  // 3. Decide.
  const failures: string[] = [];
  for (const check of checks)
    if (!check.passed)
      failures.push(
        `${check.critical ? "[critical] " : ""}check ${check.id}: ${check.detail}`,
      );
  if (verdict) {
    const v = verdict.verdict;
    if (v.overall < CASE_MIN_OVERALL)
      failures.push(`judge overall ${v.overall} is below ${CASE_MIN_OVERALL}`);
    for (const d of DIMENSIONS)
      if (v[d] < CASE_MIN_DIMENSION)
        failures.push(`judge ${d} ${v[d]} is below ${CASE_MIN_DIMENSION}`);
    if (v.criticalViolation) failures.push("judge: critical violation");
    if (!verdictPasses(v) && failures.length === 0)
      failures.push("judge verdict does not pass");
  } else {
    failures.push(`no valid judge verdict: ${judgeError}`);
  }
  const info = describe(testCase, conversation);
  const status: CaseResult["status"] = !verdict
    ? "error"
    : checks.every((c) => c.passed) && verdictPasses(verdict.verdict)
      ? "passed"
      : "failed";
  return {
    ...base,
    status,
    criticalFailure:
      status === "failed" &&
      (testCase.critical || checks.some((c) => !c.passed && c.critical)),
    failures: status === "passed" ? [] : failures,
    attempts,
    checks,
    ...(verdict && { judge: verdict }),
    ...(judgeError && { judgeError }),
    turns: info.turns,
    finalTraceId: info.finalTraceId,
    candidate: info.candidate,
  };
}

export type Summary = {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  /** Average of the judge's overall scores (judged cases only). */
  averageOverall: number | null;
  criticalFailures: string[];
  verdict: "pass" | "fail" | "incomplete";
  reasons: string[];
  /** 0 pass, 1 quality failed, 2 incomplete (errors). */
  exitCode: 0 | 1 | 2;
};

/** The whole evaluation's verdict. See evals/rubric.ts for the rules. */
export function summarize(results: CaseResult[], expected: number): Summary {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const errors = results.filter((r) => r.status === "error").length;
  const judged = results.filter((r) => r.judge);
  const averageOverall = judged.length
    ? judged.reduce((s, r) => s + r.judge!.verdict.overall, 0) / judged.length
    : null;
  const passRate = expected ? passed / expected : 0;
  const criticalFailures = results
    .filter((r) => r.criticalFailure)
    .map((r) => r.caseId);
  const reasons: string[] = [];
  if (results.length < expected)
    reasons.push(`only ${results.length} of ${expected} cases finished`);
  if (errors)
    reasons.push(
      `${errors} case(s) ended in an error, so the evaluation is incomplete`,
    );
  if (criticalFailures.length)
    reasons.push(`critical failure(s): ${criticalFailures.join(", ")}`);
  if (passRate < SUITE_MIN_PASS_RATE)
    reasons.push(
      `pass rate ${(passRate * 100).toFixed(0)}% is below ${SUITE_MIN_PASS_RATE * 100}%`,
    );
  if (averageOverall === null || averageOverall < SUITE_MIN_AVERAGE)
    reasons.push(
      `average judge score ${averageOverall?.toFixed(2) ?? "n/a"} is below ${SUITE_MIN_AVERAGE}`,
    );
  const incomplete = results.length < expected || errors > 0;
  const verdict = incomplete ? "incomplete" : reasons.length ? "fail" : "pass";
  return {
    total: expected,
    passed,
    failed,
    errors,
    passRate,
    averageOverall,
    criticalFailures,
    verdict,
    reasons,
    exitCode: verdict === "pass" ? 0 : verdict === "incomplete" ? 2 : 1,
  };
}
