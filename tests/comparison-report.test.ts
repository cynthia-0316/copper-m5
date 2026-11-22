// The single vs multi report tooling: it reads saved results only. These tests
// use made-up results, so they need no keys and no Gemini.
import { describe, expect, it } from "vitest";
import { metricsOf, type SavedRun } from "@/evals/compare";
import {
  loadRun,
  renderFinal,
  renderPerRun,
  renderRetries,
  renderRetryDetails,
  retriedAttempts,
} from "@/evals/compare-report";
import type { CaseResult } from "@/evals/evaluate";
import {
  classify,
  collectRetryTrace,
  type RetryTrace,
} from "@/evals/retry-trace";

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  caseId: "c1",
  title: "",
  category: "",
  critical: false,
  status: "passed",
  criticalFailure: false,
  failures: [],
  attempts: 1,
  checks: [],
  judge: {
    verdict: {
      correctness: 5,
      groundedness: 5,
      ruleCompliance: 5,
      toolFidelity: 5,
      overall: 5,
      criticalViolation: false,
      reasoning: "ok",
    },
    model: "google/gemini-3.5-flash-lite",
    usage: { inputTokens: 100, outputTokens: 10 },
    costUsd: 0.001,
    latencyMs: 10,
    startedAt: new Date(),
    attempts: 1,
    prompt: "",
  },
  turns: [],
  activity: { toolCalls: 2, toolErrors: 0, handoffs: 0, rateLimitWaitMs: 2000 },
  candidate: {
    modelCalls: 3,
    inputTokens: 3000,
    outputTokens: 300,
    costUsd: 0.01,
    latencyMs: 8000,
  },
  ...over,
});

const saved = (
  mode: "single" | "multi",
  runId: string,
  results: CaseResult[],
  times: [string, string] = [
    "2026-11-21T10:00:00.000Z",
    "2026-11-21T10:12:00.000Z",
  ],
): SavedRun => ({
  info: {
    runId,
    commit: "ce68fd1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    agentMode: mode,
    goldenSetVersion: "golden-v3-neutral",
    rubricVersion: "rubric-v1",
    candidateModel: "google/gemini-3.5-flash-lite",
    judgeModel: "google/gemini-3.5-flash-lite",
    startedAt: times[0],
    finishedAt: times[1],
    langfuse: {
      enabled: true,
      complete: true,
      detail: "",
      experimentUrl: `https://langfuse.example/experiments/${runId}`,
    },
  },
  summary: {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    errors: results.filter((r) => r.status === "error").length,
    passRate: 0,
    averageOverall: 5,
    criticalFailures: [],
    verdict: "pass",
    reasons: [],
    exitCode: 0,
  },
  results,
});

describe("per-run metrics", () => {
  it("measures wall-clock, re-runs, judge retries, and separates quality failures from infrastructure errors", () => {
    const run = saved("multi", "r2", [
      result({ caseId: "a" }),
      result({ caseId: "b", attempts: 3 }),
      result({
        caseId: "c",
        status: "failed",
        failures: ["check x"],
        judge: { ...result().judge!, attempts: 2 },
      }),
      result({ caseId: "d", status: "error", judge: undefined }),
    ]);
    const m = metricsOf(run, "r2");
    expect(m).toMatchObject({
      wallClockMs: 12 * 60_000,
      caseReruns: 2,
      judgeRetries: 1,
      casesRetried: 1,
      qualityFailures: 1,
      infrastructureErrors: 1,
      commit: "ce68fd1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      goldenSetVersion: "golden-v3-neutral",
      rubricVersion: "rubric-v1",
      candidateModel: "google/gemini-3.5-flash-lite",
    });
    expect(m.experimentUrl).toContain("r2");
  });

  it("says 'not measured' for a wall-clock it cannot work out, never a made-up number", () => {
    const run = saved("single", "r1", [result()], ["", ""]);
    const loaded = loadRun(run, "r1");
    expect(loaded.metrics.wallClockMs).toBeNull();
    expect(renderPerRun([loaded])).toContain("not measured");
  });

  it("separates end-to-end latency from execution latency (the limiter's waits taken out)", () => {
    const m = metricsOf(
      saved("single", "r1", [result(), result({ caseId: "d" })]),
      "r1",
    );
    expect(m.averageLatencyMs).toBe(8000);
    expect(m.averageLatencyExRateLimitMs).toBe(6000);
  });
});

describe("a case that ended in an error", () => {
  it("is counted as an infrastructure error and kept out of the latency and usage averages", () => {
    const run = saved("multi", "r3", [
      result({ caseId: "a" }),
      result({
        caseId: "b",
        status: "error",
        judge: undefined,
        failures: ["b timed out after 540s"],
        candidate: {
          modelCalls: 1,
          inputTokens: 50,
          outputTokens: 0,
          costUsd: 0.0001,
          latencyMs: 540000,
        },
      }),
    ]);
    const m = metricsOf(run, "r3");
    expect(m).toMatchObject({
      cases: 2,
      casesMeasured: 1,
      infrastructureErrors: 1,
      qualityFailures: 0,
      modelCalls: 3,
      averageLatencyMs: 8000,
    });
    expect(renderFinal([loadRun(run, "r3")])).toContain(
      "Cases with a complete answer, the base of the averages below",
    );
  });
});

describe("the side-by-side table", () => {
  const runs = [
    loadRun(
      saved("single", "run1", [result(), result({ caseId: "b" })]),
      "run1",
    ),
    loadRun(
      saved("multi", "run2", [
        result({
          activity: {
            toolCalls: 3,
            toolErrors: 1,
            handoffs: 1,
            rateLimitWaitMs: 0,
          },
        }),
        result({ caseId: "b", attempts: 2 }),
      ]),
      "run2",
    ),
    loadRun(
      saved("multi", "run3", [result(), result({ caseId: "b" })]),
      "run3",
    ),
    loadRun(
      saved("single", "run4", [
        result(),
        result({ caseId: "b", status: "failed", criticalFailure: true }),
      ]),
      "run4",
    ),
  ];

  it("lists both architectures, two runs each, with every run in brackets", () => {
    const table = renderFinal(runs);
    expect(table).toMatch(/\| Runs \| 2 \| 2 \|/);
    expect(table).toMatch(/Cases evaluated \(all runs\) \| 4 \| 4/);
    expect(table).toMatch(
      /Cases passed \(all runs\) \| 3 \(2 \/ 1\) \| 4 \(2 \/ 2\)/,
    );
    expect(table).toMatch(
      /Critical violations \(cases, all runs\) \| 1 \(0 \/ 1\) \| 0 \(0 \/ 0\)/,
    );
    expect(table).toMatch(
      /Handoff count \(all runs\) \| 0 \(0 \/ 0\) \| 1 \(1 \/ 0\)/,
    );
    expect(table).toMatch(
      /Retry count: case re-runs \(all runs\) \| 0 \(0 \/ 0\) \| 1 \(1 \/ 0\)/,
    );
    expect(table).toMatch(
      /Tool execution errors \(all runs\) \| 0 \(0 \/ 0\) \| 1 \(1 \/ 0\)/,
    );
    expect(table).toContain("without our request-limiter waits");
    expect(table).toContain("12.0 min");
  });

  it("lists every run with its own id, commit and wall-clock", () => {
    const table = renderPerRun(runs);
    for (const id of ["run1", "run2", "run3", "run4"])
      expect(table).toContain(`\`${id}\``);
    expect(table.split("\n").filter((l) => l.startsWith("| ")).length).toBe(5);
    expect(table).toContain("`ce68fd1`");
  });
});

describe("retries read back from Langfuse", () => {
  const trace: RetryTrace = {
    runId: "run2",
    collectedAt: "",
    attempts: [
      {
        caseId: "b",
        attempt: 1,
        traceId: "t1",
        outcome: "no_answer",
        latencyMs: 4000,
        modelCalls: 1,
        inputTokens: 900,
        outputTokens: 60,
      },
      {
        caseId: "b",
        attempt: 2,
        traceId: "t2",
        outcome: "answered",
        latencyMs: 6000,
        modelCalls: 3,
        inputTokens: 3000,
        outputTokens: 300,
      },
      {
        caseId: "a",
        attempt: 1,
        traceId: "t3",
        outcome: "answered",
        latencyMs: 5000,
        modelCalls: 3,
        inputTokens: 3000,
        outputTokens: 300,
      },
    ],
  };
  const loaded = loadRun(
    saved("multi", "run2", [
      result({ caseId: "a" }),
      result({ caseId: "b", attempts: 2 }),
    ]),
    "run2",
    trace,
  );

  it("counts only the attempts that were not the graded one, and what they used", () => {
    const w = retriedAttempts(loaded)!;
    expect(w).toMatchObject({
      attempts: 1,
      byOutcome: { no_answer: 1 },
      modelCalls: 1,
      inputTokens: 900,
      outputTokens: 60,
    });
    expect(w.costUsd).toBeCloseTo((900 * 0.3 + 60 * 2.5) / 1_000_000, 8);
    expect(renderRetries([loaded])).toContain(
      "| 1 | multi | 1 | 1 / 0 (of 1) | 1 | 960 | $0.0004 | 0 |",
    );
    expect(renderRetryDetails([loaded])).toContain(
      "attempt 1 no_answer, then attempt 2 answered",
    );
  });

  it("says an earlier attempt has no trace, and that a later answer on an errored case was never graded", () => {
    const errored = loadRun(
      saved("multi", "run3", [
        result({ caseId: "a" }),
        result({
          caseId: "b",
          status: "error",
          judge: undefined,
          failures: ["b timed out after 540s"],
        }),
      ]),
      "run3",
      {
        runId: "run3",
        collectedAt: "",
        attempts: [
          {
            caseId: "a",
            attempt: 1,
            traceId: "ta",
            outcome: "answered",
            latencyMs: 1,
            modelCalls: 1,
            inputTokens: 1,
            outputTokens: 1,
          },
          {
            caseId: "b",
            attempt: 2,
            traceId: "tb",
            outcome: "answered",
            latencyMs: 1,
            modelCalls: 2,
            inputTokens: 2000,
            outputTokens: 400,
          },
        ],
      },
    );
    expect(retriedAttempts(errored)).toMatchObject({
      attempts: 0,
      untracedEarlier: 1,
    });
    const details = renderRetryDetails([errored]);
    expect(details).toContain(
      "**b**: attempt 1 has no trace, then attempt 2 answered",
    );
    expect(details).toContain("never graded or counted");
    expect(renderRetries([errored])).toContain(
      "| 0 / 0 (of 0) | 0 | 0 | $0.0000 | 1 |",
    );
  });

  it("is 'not measured' when the attempts were never collected", () => {
    const bare = loadRun(
      saved("multi", "run9", [result({ attempts: 2 })]),
      "run9",
    );
    expect(retriedAttempts(bare)).toBeNull();
    expect(renderRetries([bare])).toContain("not measured");
  });

  it("classifies an attempt from its trace: an answer, no answer, or an error", () => {
    const root = (over: object) => ({
      id: "o",
      traceId: "t",
      name: "ask-copper-turn",
      type: "CHAIN",
      ...over,
    });
    expect(classify(root({ output: "Copper Home is $149." })).outcome).toBe(
      "answered",
    );
    expect(
      classify(
        root({
          output: "Sorry, something went wrong on my end. Please try again.",
        }),
      ).outcome,
    ).toBe("no_answer");
    expect(
      classify(root({ metadata: { status: "error" }, statusMessage: "503" })),
    ).toEqual({
      outcome: "error",
      detail: "503",
    });
  });

  it("collects the attempts of one run from Langfuse pages, ignoring other runs", async () => {
    const get = async (path: string) => {
      if (path.includes("name=ask-copper-turn"))
        return {
          data: [
            {
              id: "1",
              traceId: "t1",
              name: "ask-copper-turn",
              type: "CHAIN",
              output:
                "Sorry, something went wrong on my end. Please try again.",
              latency: 4,
              metadata: { runId: "RUN", caseId: "b", attempt: 1 },
            },
            {
              id: "2",
              traceId: "t2",
              name: "ask-copper-turn",
              type: "CHAIN",
              output: "ok",
              latency: 6,
              metadata: { runId: "RUN", caseId: "b", attempt: 2 },
            },
            {
              id: "3",
              traceId: "t9",
              name: "ask-copper-turn",
              type: "CHAIN",
              output: "ok",
              metadata: { runId: "OTHER", caseId: "b", attempt: 1 },
            },
          ],
        };
      return {
        data: [
          {
            id: "g",
            traceId: path.includes("traceId=t1") ? "t1" : "t2",
            name: "g",
            type: "GENERATION",
            usageDetails: { input: 100, output: 10 },
          },
        ],
      };
    };
    const out = await collectRetryTrace(
      "RUN",
      "2026-11-21T00:00:00Z",
      "2026-11-22T00:00:00Z",
      get,
    );
    expect(
      out.attempts.map((a) => [
        a.attempt,
        a.outcome,
        a.latencyMs,
        a.modelCalls,
      ]),
    ).toEqual([
      [1, "no_answer", 4000, 1],
      [2, "answered", 6000, 1],
    ]);
  });
});
