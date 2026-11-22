// The AI judge's scores are printed as GitHub Actions annotations so they show in
// the pull request's checks for anyone, signed in or not.
import { describe, expect, it } from "vitest";
import type { CaseResult, Summary } from "@/evals/evaluate";
import { annotationsFor } from "@/evals/report";

const judge = (overall: number) => ({
  verdict: {
    correctness: overall,
    groundedness: overall,
    ruleCompliance: overall,
    toolFidelity: overall,
    overall,
    criticalViolation: false,
    reasoning: "r",
  },
  model: "google/gemini-3.5-flash-lite" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
  latencyMs: 1,
  startedAt: new Date(),
  attempts: 1,
  prompt: "",
});

const result = (
  caseId: string,
  over: Partial<CaseResult> = {},
): CaseResult => ({
  caseId,
  title: "",
  category: "",
  critical: false,
  status: "passed",
  criticalFailure: false,
  failures: [],
  attempts: 1,
  checks: [],
  judge: judge(5),
  turns: [],
  candidate: {
    modelCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    latencyMs: 1,
  },
  ...over,
});

const info = {
  runId: "r",
  commit: "abc",
  agentMode: "multi" as const,
  goldenSetVersion: "golden-v3",
  rubricVersion: "rubric-v1",
  candidateModel: "m",
  judgeModel: "m",
  startedAt: "",
  finishedAt: "",
  langfuse: { enabled: true, complete: true, detail: "" },
};

const summary = (over: Partial<Summary> = {}): Summary => ({
  total: 2,
  passed: 2,
  failed: 0,
  errors: 0,
  passRate: 1,
  averageOverall: 5,
  criticalFailures: [],
  verdict: "pass",
  reasons: [],
  exitCode: 0,
  ...over,
});

describe("annotations for the pull request's checks", () => {
  it("a passing evaluation is a notice with the overall result and every case's scores", () => {
    const [overall, cases] = annotationsFor(info, summary(), [
      result("refund-over-limit"),
      result("docs-error-c47", { judge: judge(4) }),
    ]);
    expect(overall).toMatch(/^::notice title=AI judge evaluation%3A PASS::/);
    expect(overall).toContain("2/2 cases passed");
    expect(overall).toContain("average judge score 5.00 / 5");
    expect(overall).toContain("multi-agent, golden-v3, rubric-v1");
    expect(cases).toMatch(/^::notice title=AI judge scores%2C case by case::/);
    expect(cases).toContain(
      "PASS refund-over-limit: overall 5/5 (correctness 5, grounded 5, rules 5, tools 5)",
    );
    expect(cases).toContain("PASS docs-error-c47: overall 4/5");
  });

  it("a failing evaluation is an error and an incomplete one a warning", () => {
    const failing = annotationsFor(
      info,
      summary({
        verdict: "fail",
        passed: 1,
        failed: 1,
        reasons: ["critical failure(s): x"],
        criticalFailures: ["x"],
        exitCode: 1,
      }),
      [result("a"), result("x", { status: "failed", judge: judge(2) })],
    );
    expect(failing[0]).toMatch(/^::error title=AI judge evaluation%3A FAIL::/);
    expect(failing[0]).toContain("critical failures 1");
    expect(failing[0]).toContain("critical failure(s): x");
    expect(failing[1]).toContain("FAIL x: overall 2/5");
    const incomplete = annotationsFor(
      info,
      summary({ verdict: "incomplete", errors: 1, passed: 1, exitCode: 2 }),
      [result("a"), result("b", { status: "error", judge: undefined })],
    );
    expect(incomplete[0]).toMatch(/^::warning /);
    expect(incomplete[1]).toContain("ERROR b: not graded");
  });

  it("is safe for GitHub: no raw newline or carriage return inside a line", () => {
    const lines = annotationsFor(info, summary(), [result("a"), result("b")]);
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/);
    // The two cases are separated by an encoded newline.
    expect(lines[1]).toContain("%0A");
  });
});
