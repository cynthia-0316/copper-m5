// Module 5: Langfuse tracing. A mock model runs real Ask Copper turns and an
// in-memory exporter stands in for Langfuse, so no keys or network are used.
// The tests check the shape of what would be sent (session, agents, model
// calls, tools, handoff, tokens, cost) and that tracing never changes the
// answer.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
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
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}
const desk: Desk = { limitUsd: 50, refunds: [] };

type Request = Parameters<
  typeof import("@/lib/copper/assistant/ask").askCopper
>[0];

let exporter: InMemorySpanExporter;
let flushes: number;

/** Runs one turn with tracing recorded in memory; returns the spans. */
async function traced(request: Request) {
  exporter.reset();
  flushes = 0;
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { setSpanProcessorsForTests } = await import("@/lib/ai/langfuse");
  const processor = new SimpleSpanProcessor(exporter);
  const forceFlush = processor.forceFlush.bind(processor);
  processor.forceFlush = async () => {
    flushes++;
    return forceFlush();
  };
  setSpanProcessorsForTests([processor]);
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  const progress = await finalValue((await askCopper(request)).progress);
  // The trace is closed and sent just after the reply.
  await vi.waitFor(() => expect(flushes).toBeGreaterThan(0));
  return { progress, spans: exporter.getFinishedSpans() };
}

const attr = (span: ReadableSpan, key: string) => span.attributes[key];
const type = (span: ReadableSpan) => attr(span, "langfuse.observation.type");
// Langfuse stores objects as JSON text and plain strings as they are.
const json = (span: ReadableSpan, key: string) => {
  const value = attr(span, key);
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const ofType = (spans: ReadableSpan[], t: string) =>
  spans.filter((s) => type(s) === t);
const parentOf = (spans: ReadableSpan[], span: ReadableSpan) =>
  spans.find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId);

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  flushes = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Langfuse tracing", () => {
  it("records a plain chat turn: one trace, one agent, one model call with tokens and cost", async () => {
    model = modelStreaming(says("Copper Home is $149."));
    const { progress, spans } = await traced({
      messages: [{ role: "user", content: "How much is Copper Home?" }],
      useTools: false,
      sessionId: "chat-session-0001",
    });
    expect(progress.reply).toBe("Copper Home is $149.");

    const [root] = ofType(spans, "chain");
    expect(root.name).toBe("ask-copper-turn");
    expect(root.parentSpanContext).toBeUndefined();
    expect(attr(root, "session.id")).toBe("chat-session-0001");
    expect(json(root, "langfuse.observation.input")).toBe(
      "How much is Copper Home?",
    );
    expect(json(root, "langfuse.observation.output")).toBe(
      "Copper Home is $149.",
    );

    const [agent] = ofType(spans, "agent");
    expect(agent.name).toBe("Copper");
    expect(parentOf(spans, agent)).toBe(root);

    const [call] = ofType(spans, "generation");
    expect(parentOf(spans, call)).toBe(agent);
    expect(attr(call, "langfuse.observation.model.name")).toBe(
      "gemini-3.5-flash-lite",
    );
    // The usage the model reported, and cost from the list prices.
    expect(json(call, "langfuse.observation.usage_details")).toMatchObject({
      input: 500,
      output: 50,
    });
    expect(json(call, "langfuse.observation.cost_details")).toMatchObject({
      total: (500 * 0.3 + 50 * 2.5) / 1_000_000,
    });
    // Every span belongs to the same trace.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it("counts the wait for the model as the model call's time", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { stream: convertArrayToReadableStream(says("Slow answer.")) };
      },
    });
    const { spans } = await traced({
      messages: [{ role: "user", content: "hi" }],
      useTools: false,
      sessionId: "chat-session-0007",
    });
    const [call] = ofType(spans, "generation");
    const [start, nanos] = call.duration;
    expect(start * 1000 + nanos / 1e6).toBeGreaterThanOrEqual(50);
  });

  it("records a tool call with its input and output under the agent", async () => {
    model = modelStreaming(calls("get_prices", {}), says("It comes to $307."));
    const { spans } = await traced({
      messages: [{ role: "user", content: "What do your products cost?" }],
      useTools: true,
      sessionId: "chat-session-0002",
    });
    const [tool] = ofType(spans, "tool");
    expect(tool.name).toBe("get_prices");
    expect(parentOf(spans, tool)).toBe(ofType(spans, "agent")[0]);
    expect(json(tool, "langfuse.observation.input")).toEqual({});
    expect(json(tool, "langfuse.observation.output")).toBeDefined();
    expect(attr(tool, "langfuse.observation.level")).toBeUndefined();
    // Two model steps (call the tool, then answer), each with its own usage.
    expect(ofType(spans, "generation")).toHaveLength(2);
  });

  it("records the handoff to the Refund agent, and the two agents' own work", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund order #1004" }),
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor needs to approve it."),
    );
    const { spans } = await traced({
      messages: [{ role: "user", content: "Refund order #1004" }],
      useTools: true,
      desk,
      sessionId: "chat-session-0003",
    });
    const agents = ofType(spans, "agent");
    expect(agents.map((a) => a.name).sort()).toEqual([
      "Copper",
      "Refund agent",
    ]);
    const copper = agents.find((a) => a.name === "Copper")!;
    const refund = agents.find((a) => a.name === "Refund agent")!;

    const [handoff] = ofType(spans, "event");
    expect(handoff.name).toBe("handoff: Copper → Refund agent");
    expect(parentOf(spans, handoff)).toBe(copper);

    const tools = ofType(spans, "tool");
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(parentOf(spans, byName("transfer_to_refund_agent"))).toBe(copper);
    expect(parentOf(spans, byName("request_refund"))).toBe(refund);
    expect(
      json(byName("request_refund"), "langfuse.observation.output"),
    ).toMatchObject({ status: "needs_approval" });
    // Both agents are in one turn's trace, under one root.
    expect(ofType(spans, "chain")).toHaveLength(1);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    // 3 model steps in total, none counted twice.
    expect(ofType(spans, "generation")).toHaveLength(3);
  });

  it("keeps two turns of one chat as two traces of one session, and two chats apart", async () => {
    const turn = async (sessionId: string, text: string) => {
      model = modelStreaming(says(text));
      return traced({
        messages: [{ role: "user", content: text }],
        useTools: false,
        sessionId,
      });
    };
    const first = await turn("session-aaaaaaaa", "a");
    const second = await turn("session-aaaaaaaa", "b");
    const other = await turn("session-bbbbbbbb", "c");
    const traceOf = (r: { spans: ReadableSpan[] }) =>
      r.spans[0].spanContext().traceId;
    const sessionOf = (r: { spans: ReadableSpan[] }) =>
      attr(ofType(r.spans, "chain")[0], "session.id");
    expect(traceOf(first)).not.toBe(traceOf(second));
    expect(sessionOf(first)).toBe("session-aaaaaaaa");
    expect(sessionOf(second)).toBe("session-aaaaaaaa");
    expect(sessionOf(other)).toBe("session-bbbbbbbb");
  });

  it("replaces a malformed session id instead of trusting it", async () => {
    model = modelStreaming(says("Hi."));
    const { spans } = await traced({
      messages: [{ role: "user", content: "hi" }],
      useTools: false,
      sessionId: "bad id with spaces!",
    });
    const session = attr(ofType(spans, "chain")[0], "session.id");
    expect(session).not.toBe("bad id with spaces!");
    expect(session).toMatch(/^[\w-]{8,100}$/);
  });

  it("marks a failed turn as an error, ends every span, and still answers", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model exploded");
      },
    });
    const { progress, spans } = await traced({
      messages: [{ role: "user", content: "hi" }],
      useTools: false,
      sessionId: "chat-session-0005",
    });
    expect(progress.status).toBe("error");
    expect(progress.reply).toMatch(/Sorry/);
    const [root] = ofType(spans, "chain");
    expect(attr(root, "langfuse.observation.level")).toBe("ERROR");
    expect(attr(root, "langfuse.observation.status_message")).toMatch(
      /model exploded/,
    );
    // Finished spans only are exported, so the agent being here means it ended.
    expect(ofType(spans, "agent")).toHaveLength(1);
  });

  it("gives no cost when the model reports no tokens (unknown, not made up)", async () => {
    model = modelStreaming([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hi." },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
          },
        },
      },
    ]);
    const { spans } = await traced({
      messages: [{ role: "user", content: "hi" }],
      useTools: false,
      sessionId: "chat-session-0006",
    });
    const [call] = ofType(spans, "generation");
    expect(attr(call, "langfuse.observation.cost_details")).toBeUndefined();
    expect(
      String(attr(call, "langfuse.observation.metadata.costBasis")),
    ).toMatch(/unknown/);
  });
});

describe("tracing is optional and harmless", () => {
  it("without Langfuse keys the chat works as before and says tracing is off once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund" }),
      calls("request_refund", { orderId: "1004" }),
      says("Waiting for approval."),
    );
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const ask = async () =>
      finalValue(
        (
          await askCopper({
            messages: [{ role: "user", content: "Refund order #1004" }],
            useTools: true,
            desk,
          })
        ).progress,
      );
    const result = await ask();
    expect(result.status).toBe("done");
    expect(result.reply).toBe("Waiting for approval.");
    // A second turn doesn't repeat the warning.
    model = modelStreaming(says("Hello again."));
    await ask();
    const off = warn.mock.calls.filter(([m]) =>
      String(m).includes("[langfuse]"),
    );
    expect(off).toHaveLength(1);
    expect(String(off[0][0])).toContain("LANGFUSE_PUBLIC_KEY");
    expect(String(off[0][0])).not.toMatch(/AIza/);
  });

  it("if sending to Langfuse fails, the reply still arrives, the refund ran once, and a warning says the trace is incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    const { setSpanProcessorsForTests } = await import("@/lib/ai/langfuse");
    const processor = new SimpleSpanProcessor(exporter);
    processor.forceFlush = async () => {
      throw new Error("network down");
    };
    setSpanProcessorsForTests([processor]);
    const orders = await import("@/lib/copper/orders");
    const decided = vi.spyOn(orders, "requestRefund");
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund" }),
      calls("request_refund", { orderId: "1001" }),
      says("Refunded."),
    );
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order #1001" }],
          useTools: true,
          desk,
        })
      ).progress,
    );
    await vi.waitFor(() =>
      expect(
        warn.mock.calls.some(([m]) => String(m).includes("incomplete")),
      ).toBe(true),
    );
    expect(result.status).toBe("done");
    expect(result.reply).toBe("Refunded.");
    expect(decided).toHaveBeenCalledTimes(1);
  });
});
