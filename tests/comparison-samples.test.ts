// Sample sizes, exclusions and the like-for-like table. Made-up results only.
import { describe, expect, it } from "vitest";
import type { SavedRun } from "@/evals/compare";
import { loadRun } from "@/evals/compare-report";
import {
  completeCaseIds,
  errorKind,
  renderCostKinds,
  renderExcluded,
  renderLikeForLike,
  renderReliability,
  renderSampleSizes,
} from "@/evals/compare-samples";
import type { CaseResult } from "@/evals/evaluate";

const judge = {
  verdict: {
    correctness: 5,
    groundedness: 5,
    ruleCompliance: 5,
    toolFidelity: 5,
    overall: 5,
    criticalViolation: false,
    reasoning: "ok",
  },
  model: "google/gemini-3.5-flash-lite" as const,
  usage: { inputTokens: 100, outputTokens: 10 },
  costUsd: 0.001,
  latencyMs: 10,
  startedAt: new Date(),
  attempts: 1,
  prompt: "",
};

const ok = (caseId: string, over: Partial<CaseResult> = {}): CaseResult => ({
  caseId,
  title: "",
  category: "",
  critical: false,
  status: "passed",
  criticalFailure: false,
  failures: [],
  attempts: 1,
  checks: [],
  judge,
  turns: [],
  activity: { toolCalls: 2, toolErrors: 0, handoffs: 0, rateLimitWaitMs: 0 },
  candidate: {
    modelCalls: 2,
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 0.01,
    latencyMs: 4000,
  },
  ...over,
});

const broken = (caseId: string, message: string): CaseResult =>
  ok(caseId, {
    status: "error",
    judge: undefined,
    failures: [message],
    attempts: 4,
    candidate: {
      modelCalls: 1,
      inputTokens: 40,
      outputTokens: 0,
      costUsd: 0.0001,
      latencyMs: 540000,
    },
  });

const run = (mode: "single" | "multi", id: string, results: CaseResult[]) =>
  loadRun(
    {
      info: {
        runId: id,
        commit: "ce68fd1",
        agentMode: mode,
        goldenSetVersion: "golden-v3-neutral",
        rubricVersion: "rubric-v1",
        candidateModel: "google/gemini-3.5-flash-lite",
        judgeModel: "google/gemini-3.5-flash-lite",
        startedAt: "2026-11-22T06:00:00Z",
        finishedAt: "2026-11-22T06:10:00Z",
        langfuse: { enabled: true, complete: true, detail: "" },
      },
      summary: {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: 0,
        errors: results.filter((r) => r.status === "error").length,
        passRate: 0,
        averageOverall: 5,
        criticalFailures: [],
        verdict: "pass",
        reasons: [],
        exitCode: results.some((r) => r.status === "error") ? 2 : 0,
      },
      results,
    } satisfies SavedRun,
    id,
  );

// Run 3 (multi) lost case "b" to a timeout, like the real run 3.
const runs = [
  run("single", "run1", [ok("a"), ok("b")]),
  run("multi", "run2", [ok("a"), ok("b")]),
  run("multi", "run3", [ok("a"), broken("b", "b timed out after 540s")]),
  run("single", "run4", [ok("a"), ok("b")]),
];

describe("error kinds", () => {
  it("separates network, timeout, service and no-answer, and admits 'other'", () => {
    expect(errorKind("getaddrinfo ENOTFOUND us.cloud.langfuse.com")).toBe(
      "network",
    );
    expect(errorKind("docs-return-window timed out after 540s")).toBe(
      "timeout",
    );
    expect(errorKind("Failed after 3 attempts. high demand")).toBe(
      "Gemini service",
    );
    expect(errorKind("the model ended the turn without an answer")).toBe(
      "model gave no answer",
    );
    expect(errorKind("something new")).toBe("other");
  });
});

describe("effective sample sizes", () => {
  it("counts each architecture's valid and missing cases, never as zeros", () => {
    const table = renderSampleSizes(runs);
    expect(table).toMatch(/Scheduled \(18 per run\) \| 4 \| 4/);
    expect(table).toMatch(/answered and graded[^|]*\| 4 \| 3/);
    expect(table).toMatch(/complete answer \(latency[^|]*\| 4 \| 3/);
    expect(table).toMatch(/known cost[^|]*\| 4 \| 3/);
    expect(table).toMatch(/\| 0 of 4 \(0\.0%\) \| 1 of 4 \(25\.0%\) \|/);
  });

  it("lists every excluded case with its kind and message", () => {
    const table = renderExcluded(runs);
    expect(table).toContain("| 3 | multi | b | timeout |");
    expect(table).toContain("b timed out after 540s");
    expect(renderExcluded([runs[0]])).toBe(
      "No case ended in an error in any run.",
    );
  });
});

describe("like for like", () => {
  it("uses only the cases that are valid in every run, for both architectures", () => {
    expect(completeCaseIds(runs)).toEqual(["a"]);
    const table = renderLikeForLike(runs);
    expect(table).toContain("**1 of 18**");
    expect(table).toMatch(/Case results \(cases x runs\) \| 2 \| 2/);
    expect(table).toMatch(/Passed \| 2 \(100\.0%\) \| 2 \(100\.0%\)/);
  });
});

describe("cost kinds and reliability", () => {
  it("keeps observed, retry waste and unconfirmed apart, and the judge's cost separate", () => {
    const table = renderCostKinds(runs);
    expect(table).toContain("Observed answering cost (valid cases)");
    // Run 3: one valid case observed, the errored case only a lower bound.
    expect(table).toContain(
      "| 3 | multi | $0.0100 | 1 | not measured | unknown for 1 case(s) (Langfuse attempts not collected) | $0.0010 |",
    );
    expect(table).toContain("not summed");
  });

  it("marks a run with an infrastructure error as incomplete, with its exit code", () => {
    const table = renderReliability(runs);
    expect(table).toMatch(
      /\| 3 \| multi \| 2 \| 1\/2 \| 1 \| 0 \| 3 \| 0 \| NO: incomplete \|/,
    );
    expect(table).toMatch(
      /\| 1 \| single \| 0 \| 2\/2 \| 0 \| 0 \| 0 \| 0 \| yes \|/,
    );
  });
});

describe("an errored case whose later attempt finished in the background", () => {
  it("shows the traced attempt as never graded and the missing earlier attempt as unknown", () => {
    const base = runs[2];
    const withTrace = {
      ...base,
      retries: {
        runId: "run3",
        collectedAt: "",
        attempts: [
          {
            caseId: "a",
            attempt: 1,
            traceId: "ta",
            outcome: "answered" as const,
            latencyMs: 4000,
            modelCalls: 2,
            inputTokens: 1000,
            outputTokens: 100,
          },
          {
            caseId: "b",
            attempt: 2,
            traceId: "tb",
            outcome: "answered" as const,
            latencyMs: 8000,
            modelCalls: 2,
            inputTokens: 2000,
            outputTokens: 400,
          },
        ],
      },
    };
    const cost = renderCostKinds([withTrace]);
    expect(cost).toContain(
      "1 later attempt(s) traced in Langfuse, never graded: 2400 tokens",
    );
    expect(cost).toContain("1 earlier attempt(s) with no trace: use unknown");
    expect(cost).toContain("not summed");
  });
});
