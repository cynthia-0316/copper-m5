// Module 5, Part 4: the single support agent next to the multi-agent baseline.
// Mock model, no keys: these tests check that the multi-agent Copper + Refund
// agent is exactly what it was, that the single agent has the same business
// tools and refund rules and no handoff, that the mode can be switched, that
// traces say which architecture ran, and that the architecture-neutral golden
// set only drops checks about the arrangement of agents.
import { createHash } from "node:crypto";
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRun, TurnRun } from "@/evals/checks";
import {
  compare,
  metricsOf,
  renderComparison,
  type SavedRun,
} from "@/evals/compare";
import type { CaseResult } from "@/evals/evaluate";
import { GOLDEN_SET } from "@/evals/golden-set";
import { buildJudgePrompt } from "@/evals/judge";
import {
  isArchitectureCheck,
  NEUTRAL_SET,
  NEUTRAL_VERSION,
  removedChecks,
} from "@/evals/neutral";
import { finalValue } from "@/lib/ai/live";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  REFUND_RULES,
  SINGLE_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import { agentMode, parseAgentMode } from "@/lib/copper/assistant/mode";
import {
  copperTools,
  refundAgentTools,
  refundTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];
const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
const streaming = (...steps: StreamPart[][]) => {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[i++] ?? says("")),
    }),
  });
};
const desk = (limitUsd = 50): Desk => ({ limitUsd, refunds: [] });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const described = (tools: Record<string, unknown>) =>
  JSON.stringify(
    Object.entries(tools).map(([k, v]) => [
      k,
      (v as { description?: string }).description,
    ]),
  );

async function run(
  request: Parameters<
    typeof import("@/lib/copper/assistant/run").startAskCopper
  >[0],
  options: Parameters<
    typeof import("@/lib/copper/assistant/run").startAskCopper
  >[1] = {},
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "");
  vi.stubEnv("LANGFUSE_BASE_URL", "");
  const { startAskCopper } = await import("@/lib/copper/assistant/run");
  const started = startAskCopper(request, options);
  const progress = await finalValue(started.progress);
  return { progress, outcome: await started.finished };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the multi-agent baseline is exactly what it was", () => {
  it("keeps Copper's, the handoff's and the Refund agent's instructions byte for byte", () => {
    // Fingerprints taken from main before the single agent was added.
    expect(sha(COPPER_INSTRUCTIONS)).toBe(
      "5d29d40e5ced39f0efad4fe74289d5bb079a3a12269f5fa3630a818e96adc424",
    );
    expect(sha(COPPER_HANDOFF)).toBe(
      "7c9ae337ae778fee4d28bcb222bb89d7cbc65a861397c69e7eade8b8b5bcaad6",
    );
    expect(sha(REFUND_AGENT_INSTRUCTIONS)).toBe(
      "a5d8111778828a590db5d2ebef7edc95ebcb5fc8e759e980826de3787bcbf058",
    );
  });

  it("keeps each agent's tools: names, order and descriptions", () => {
    expect(Object.keys(copperTools)).toEqual([
      "get_products",
      "get_prices",
      "calculate_cost",
      "check_availability",
      "search_docs",
    ]);
    expect(Object.keys(refundAgentTools(desk()))).toEqual([
      "get_orders",
      "request_refund",
      "transfer_to_copper",
    ]);
    expect(sha(described(copperTools))).toBe(
      "98f6695bff3e25aa4b5dd260f8beef4f564b95c4750156722322b0c938f76431",
    );
    expect(sha(described(refundAgentTools(desk())))).toBe(
      "90d7bbeb2b0f5ea8c7da9227129adf53189486592015c9e158262ebe217c374a",
    );
    expect(
      sha(described({ transfer_to_refund_agent: transferToRefundAgent })),
    ).toBe("05540834d1def8be28bc1aa70ad1ef1d3ea3609397005def5af0a31252cfaefe");
  });

  it("still hands refunds to the Refund agent when multi is chosen explicitly or by default", async () => {
    for (const options of [{ agentMode: "multi" as const }, {}]) {
      model = streaming(
        calls("transfer_to_refund_agent", { reason: "refund 1004" }),
        calls("request_refund", { orderId: "1004" }),
        says("A supervisor will review it."),
      );
      const { progress } = await run(
        {
          messages: [{ role: "user", content: "Refund order #1004" }],
          useTools: true,
          desk: desk(),
        },
        options,
      );
      expect(progress.agent).toBe("refund");
      expect(progress.steps.some((s) => s.type === "handoff")).toBe(true);
      expect(model.doStreamCalls).toHaveLength(3);
    }
  });
});

describe("the single support agent", () => {
  it("has Copper's tools plus the two refund tools, and no handoff tool", () => {
    expect(Object.keys(refundTools(desk()))).toEqual([
      "get_orders",
      "request_refund",
    ]);
    // The Refund agent's tools are the same two plus its handoff back.
    expect(Object.keys(refundAgentTools(desk()))).toEqual([
      ...Object.keys(refundTools(desk())),
      "transfer_to_copper",
    ]);
  });

  it("follows the same refund rules (written once) and never mentions a handoff", () => {
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain(COPPER_INSTRUCTIONS);
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain(REFUND_RULES);
    expect(REFUND_AGENT_INSTRUCTIONS).toContain(REFUND_RULES);
    expect(SINGLE_AGENT_INSTRUCTIONS).not.toMatch(
      /transfer_to|hand(s|ed)? off|Refund agent/i,
    );
  });

  it("answers a refund itself: one agent, its own two refund tools, the app decides, no handoff", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1004" }),
      says("It needs a supervisor's review."),
    );
    const { progress, outcome } = await run(
      {
        messages: [{ role: "user", content: "Refund order #1004" }],
        useTools: true,
        desk: desk(50),
      },
      { agentMode: "single" },
    );
    expect(progress.status).toBe("done");
    expect(progress.agent).toBe("copper");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    const tool = progress.steps.find((s) => s.type === "tool");
    expect(tool).toMatchObject({
      name: "request_refund",
      output: {
        status: "needs_approval",
        orderId: "1004",
        amountUsd: 149,
        limitUsd: 50,
      },
    });
    // One architecture-wide set of tools and instructions, from one call.
    const first = model.doStreamCalls[0];
    expect(first.tools?.map((t) => t.name).sort()).toEqual(
      [...Object.keys(copperTools), "get_orders", "request_refund"].sort(),
    );
    expect(JSON.stringify(first.prompt)).toContain(
      "You also handle refunds yourself",
    );
    expect(outcome.stats.modelCalls).toBe(2);
  });

  it("applies the same refund rule: at the limit refunds, over it waits", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1002" }),
      says("Refunded."),
    );
    const at = await run(
      {
        messages: [{ role: "user", content: "Refund 1002" }],
        useTools: true,
        desk: desk(79),
      },
      { agentMode: "single" },
    );
    const output = (
      at.progress.steps.find((s) => s.type === "tool") as {
        output: { status: string };
      }
    ).output;
    expect(output.status).toBe("refunded");
  });

  it("ignores which agent answered last (there is only one) and has no refund tools off the Support page", async () => {
    model = streaming(says("Hi."));
    const { progress } = await run(
      {
        messages: [{ role: "user", content: "hi" }],
        useTools: true,
        desk: desk(),
        agent: "refund",
      },
      { agentMode: "single" },
    );
    expect(progress.agent).toBe("copper");
    model = streaming(says("Hi."));
    await run(
      { messages: [{ role: "user", content: "hi" }], useTools: true },
      { agentMode: "single" },
    );
    expect(model.doStreamCalls[0].tools?.map((t) => t.name)).not.toContain(
      "request_refund",
    );
  });
});

describe("choosing the architecture", () => {
  it("reads single or multi, otherwise multi", () => {
    expect(parseAgentMode(" Single ")).toBe("single");
    expect(parseAgentMode("MULTI")).toBe("multi");
    expect(parseAgentMode("both")).toBeUndefined();
    expect(parseAgentMode(undefined)).toBeUndefined();
  });

  it("AGENT_MODE picks the architecture; unset is multi; a typo is multi with one warning", async () => {
    vi.resetModules();
    const { agentMode: fresh } = await import("@/lib/copper/assistant/mode");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AGENT_MODE", "");
    expect(fresh()).toBe("multi");
    vi.stubEnv("AGENT_MODE", "single");
    expect(fresh()).toBe("single");
    vi.stubEnv("AGENT_MODE", "sigle");
    expect(fresh()).toBe("multi");
    expect(fresh()).toBe("multi");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(agentMode).toBeTypeOf("function");
  });

  it("the chat uses AGENT_MODE when no mode is passed", async () => {
    vi.stubEnv("AGENT_MODE", "single");
    model = streaming(
      calls("request_refund", { orderId: "1001" }),
      says("Refunded."),
    );
    const { progress } = await run({
      messages: [{ role: "user", content: "Refund 1001" }],
      useTools: true,
      desk: desk(),
    });
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(model.doStreamCalls[0].tools?.map((t) => t.name)).not.toContain(
      "transfer_to_refund_agent",
    );
  });
});

describe("Langfuse says which architecture ran", () => {
  const spans = async (mode: "single" | "multi") => {
    const exporter = new InMemorySpanExporter();
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    const { setSpanProcessorsForTests } = await import("@/lib/ai/langfuse");
    setSpanProcessorsForTests([new SimpleSpanProcessor(exporter)]);
    const { startAskCopper } = await import("@/lib/copper/assistant/run");
    const started = startAskCopper(
      {
        messages: [{ role: "user", content: "Refund order #1004" }],
        useTools: true,
        desk: desk(),
      },
      { agentMode: mode },
    );
    await finalValue(started.progress);
    await started.finished;
    return exporter.getFinishedSpans();
  };
  const attr = (s: ReadableSpan, k: string) => s.attributes[k];
  const type = (s: ReadableSpan) => attr(s, "langfuse.observation.type");

  it("single: one 'Support agent', tagged and labelled single, no handoff", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor will review it."),
    );
    const all = await spans("single");
    const agents = all.filter((s) => type(s) === "agent");
    expect(agents.map((a) => a.name)).toEqual(["Support agent"]);
    expect(all.filter((s) => type(s) === "event")).toHaveLength(0);
    const root = all.find((s) => type(s) === "chain")!;
    expect(attr(root, "langfuse.trace.tags")).toContain("arch:single");
    expect(attr(root, "langfuse.trace.metadata.agentMode")).toBe("single");
    expect(
      all.filter((s) => type(s) === "generation").map((g) => g.name),
    ).toEqual(["Support agent model call 1", "Support agent model call 2"]);
  });

  it("multi: Copper then the Refund agent, a handoff event, tagged multi", async () => {
    model = streaming(
      calls("transfer_to_refund_agent", { reason: "refund" }),
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor will review it."),
    );
    const all = await spans("multi");
    expect(
      all
        .filter((s) => type(s) === "agent")
        .map((a) => a.name)
        .sort(),
    ).toEqual(["Copper", "Refund agent"]);
    expect(all.filter((s) => type(s) === "event")).toHaveLength(1);
    const root = all.find((s) => type(s) === "chain")!;
    expect(attr(root, "langfuse.trace.tags")).toContain("arch:multi");
    expect(attr(root, "langfuse.trace.metadata.agentMode")).toBe("multi");
  });
});

describe("the architecture-neutral golden set", () => {
  const byId = (set: typeof GOLDEN_SET, id: string) =>
    set.find((c) => c.id === id)!;

  it("keeps golden-v3 as it was, handoff checks included", () => {
    const handoffs = GOLDEN_SET.flatMap((c) =>
      c.checks.filter(isArchitectureCheck).map((k) => `${c.id}:${k.id}`),
    );
    expect(handoffs).toHaveLength(9);
    expect(handoffs).toContain("refund-over-limit:handoff");
    expect(handoffs).toContain("handoff-back-to-copper:copper-answers");
  });

  it("has the same cases, facts, flags and conversations; only architecture checks differ", () => {
    expect(NEUTRAL_VERSION).toBe("golden-v3-neutral");
    expect(NEUTRAL_SET.map((c) => c.id)).toEqual(GOLDEN_SET.map((c) => c.id));
    for (const original of GOLDEN_SET) {
      const neutral = byId(NEUTRAL_SET, original.id);
      expect(neutral.expected.facts).toEqual(original.expected.facts);
      expect(neutral.turns).toEqual(original.turns);
      expect(neutral.critical).toBe(original.critical);
      expect(neutral.limitUsd).toBe(original.limitUsd);
      expect(neutral.refunds).toEqual(original.refunds);
      // Every original check that isn't about the agents' arrangement survives
      // unchanged, critical flags included.
      for (const check of original.checks.filter(
        (k) => !isArchitectureCheck(k),
      ))
        expect(neutral.checks).toContainEqual(check);
      expect(neutral.checks.filter(isArchitectureCheck)).toEqual([]);
    }
  });

  it("removes only the 9 handoff checks and adds one outcome check for a removed 'no handoff'", () => {
    expect(removedChecks()).toHaveLength(9);
    expect(new Set(removedChecks().map((r) => r.kind))).toEqual(
      new Set(["handoff", "no_handoff", "final_agent"]),
    );
    const policy = byId(NEUTRAL_SET, "docs-annual-refund-policy");
    expect(policy.checks).toContainEqual({
      id: "no-refund-requested",
      kind: "tool_not_called",
      tool: "request_refund",
    });
  });

  it("keeps every critical refund and safety check for both architectures", () => {
    for (const id of [
      "refund-under-limit",
      "refund-at-limit",
      "refund-over-limit",
      "refund-unknown-order",
      "safety-claimed-approval",
      "safety-internal-documents",
    ]) {
      const neutral = byId(NEUTRAL_SET, id);
      expect(neutral.critical).toBe(true);
      expect(neutral.checks.some((k) => k.critical)).toBe(true);
    }
    expect(
      byId(NEUTRAL_SET, "refund-over-limit").checks.map((k) => k.id),
    ).toEqual(
      expect.arrayContaining([
        "app-holds-it",
        "desk-waiting",
        "no-false-claim",
      ]),
    );
  });

  it("states no architecture in what the judge is told the answer must be", () => {
    const bad = /hand(s|ed)? ?off|handoff|Refund agent|transfer_to/i;
    for (const c of NEUTRAL_SET) {
      const text = [
        ...c.expected.facts,
        ...c.expected.behaviors,
        ...c.expected.forbidden,
        ...c.sources.map((s) => `${s.ref} ${s.applies}`),
      ].join(" ");
      expect(text, c.id).not.toMatch(bad);
    }
  });
});

describe("the blind judge prompt", () => {
  const turn: TurnRun = {
    input: "Refund order #1004",
    kind: "user",
    progress: {
      status: "done",
      agent: "refund",
      reply: "A supervisor will review it.",
      steps: [
        {
          type: "tool",
          id: "1",
          agent: "copper",
          name: "transfer_to_refund_agent",
          state: "done",
          input: { reason: "refund" },
          output: { handedTo: "Refund agent" },
        },
        { type: "handoff", from: "copper", to: "refund" },
        {
          type: "tool",
          id: "2",
          agent: "refund",
          name: "request_refund",
          state: "done",
          input: { orderId: "1004" },
          output: { status: "needs_approval", orderId: "1004" },
        },
      ],
    },
    stats: {
      modelCalls: 3,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
    },
  };
  const caseRun: CaseRun = {
    turns: [turn],
    desk: { limitUsd: 50, refunds: [] },
  };
  const testCase = GOLDEN_SET.find((c) => c.id === "refund-over-limit")!;

  it("normally shows the agents and the handoff", () => {
    const prompt = buildJudgePrompt(testCase, caseRun);
    expect(prompt).toContain("Refund agent");
    expect(prompt).toContain("copper → refund");
  });

  it("blind: 'Assistant' only, no handoff, no transfer tool, business tools and results kept", () => {
    const prompt = buildJudgePrompt(testCase, caseRun, { blind: true });
    expect(prompt).not.toMatch(
      /Refund agent|copper → refund|transfer_to_|"agent"/,
    );
    expect(prompt).toContain('"speaker": "Assistant"');
    expect(prompt).toContain("request_refund");
    expect(prompt).toContain("needs_approval");
  });
});

describe("the comparison tables", () => {
  const result = (over: Partial<CaseResult>): CaseResult => ({
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
    activity: {
      toolCalls: 2,
      toolErrors: 0,
      handoffs: 0,
      rateLimitWaitMs: 1000,
    },
    candidate: {
      modelCalls: 2,
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 0.01,
      latencyMs: 5000,
    },
    ...over,
  });
  const saved = (
    mode: "single" | "multi",
    results: CaseResult[],
    passed: number,
  ): SavedRun => ({
    info: {
      runId: `r-${mode}`,
      commit: "abc",
      agentMode: mode,
      goldenSetVersion: NEUTRAL_VERSION,
      rubricVersion: "rubric-v1",
      candidateModel: "m",
      judgeModel: "m",
      startedAt: "",
      finishedAt: "",
      langfuse: { enabled: false, complete: false, detail: "" },
    },
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      errors: 0,
      passRate: passed / results.length,
      averageOverall: 5,
      criticalFailures: [],
      verdict: "pass",
      reasons: [],
      exitCode: 0,
    },
    results,
  });

  it("adds up what was measured, apart for answering and judging, and leaves unknown cost as n/a", () => {
    const single = saved(
      "single",
      [result({ caseId: "a" }), result({ caseId: "b" })],
      2,
    );
    const m = metricsOf(single, "s");
    expect(m).toMatchObject({
      cases: 2,
      passed: 2,
      modelCalls: 4,
      totalTokens: 2200,
      toolCalls: 4,
      handoffs: 0,
      judgeTokens: 220,
    });
    expect(m.executionCostUsd).toBeCloseTo(0.02);
    expect(m.judgeCostUsd).toBeCloseTo(0.002);
    // 5 s per case as measured, 4 s once our own limiter's wait is taken out.
    expect(m.averageLatencyMs).toBe(5000);
    expect(m.averageLatencyExRateLimitMs).toBe(4000);
    const unknown = metricsOf(
      saved(
        "single",
        [
          result({
            candidate: {
              modelCalls: 1,
              inputTokens: 1,
              outputTokens: 1,
              costUsd: null,
              latencyMs: 1,
            },
          }),
        ],
        1,
      ),
      "u",
    );
    expect(unknown.executionCostUsd).toBeNull();
  });

  it("shows both architectures, names the cases that differ and counts handoffs", () => {
    const single = saved(
      "single",
      [
        result({ caseId: "x" }),
        result({
          caseId: "y",
          status: "failed",
          failures: ["critical check no-false-claim: lied"],
          criticalFailure: true,
        }),
      ],
      1,
    );
    const multi = saved(
      "multi",
      [
        result({
          caseId: "x",
          activity: {
            toolCalls: 3,
            toolErrors: 1,
            handoffs: 1,
            rateLimitWaitMs: 0,
          },
        }),
        result({ caseId: "y" }),
      ],
      2,
    );
    const table = renderComparison(
      compare([
        { run: single, label: "s1" },
        { run: multi, label: "m1" },
      ]),
    );
    expect(table).toContain("| Metric | Single Agent | Multi Agent |");
    expect(table).toMatch(/Handoffs \| 0\.0 \| 1\.0/);
    expect(table).toMatch(/Tool execution errors \| 0\.0 \| 1\.0/);
    expect(table).toContain("**y**: single 0/1, multi 1/1");
    expect(table).toContain("lied");
  });
});

describe("running the golden set with the single agent", () => {
  it("a correct single-agent refund passes the neutral checks, and only the handoff check of golden-v3 fails it", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1004" }),
      says("That is over our $50 limit, so a supervisor will review it."),
    );
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    const { runCase } = await import("@/evals/runner");
    const { runChecks } = await import("@/evals/checks");
    const original = GOLDEN_SET.find((c) => c.id === "refund-over-limit")!;
    const neutral = NEUTRAL_SET.find((c) => c.id === "refund-over-limit")!;
    const conversation = await runCase(neutral, {
      agentMode: "single",
      runId: "r",
      commit: "abc",
      goldenSetVersion: NEUTRAL_VERSION,
      attempt: 1,
    });
    // The case started from a fresh console, and the app held the refund.
    expect(conversation.desk.refunds).toMatchObject([
      { orderId: "1004", status: "waiting" },
    ]);
    expect(
      conversation.turns[0].progress.steps.some((s) => s.type === "handoff"),
    ).toBe(false);
    expect(runChecks(neutral, conversation).every((c) => c.passed)).toBe(true);
    const failed = runChecks(original, conversation).filter((c) => !c.passed);
    expect(failed.map((c) => c.id)).toEqual(["handoff"]);
  });

  it("a single agent that lies about a refund still fails the neutral set's critical check", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1004" }),
      says("Done! Your $149 refund has been processed."),
    );
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    const { runCase } = await import("@/evals/runner");
    const { runChecks } = await import("@/evals/checks");
    const neutral = NEUTRAL_SET.find((c) => c.id === "refund-over-limit")!;
    const conversation = await runCase(neutral, {
      agentMode: "single",
      runId: "r",
      commit: "abc",
      goldenSetVersion: NEUTRAL_VERSION,
      attempt: 1,
    });
    expect(
      runChecks(neutral, conversation).find((c) => c.id === "no-false-claim"),
    ).toMatchObject({ passed: false, critical: true });
  });
});
