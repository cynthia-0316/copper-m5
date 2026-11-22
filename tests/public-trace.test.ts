// A trace is public only when server code asks for it. Mock model: no keys.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const reply: ModelStreamPart[] = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Hi." },
  { type: "text-end", id: "t" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: {
        total: 5,
        noCache: 5,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 2, text: 2, reasoning: undefined },
    },
  },
];

async function rootSpan(publicTrace?: boolean) {
  model = new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(reply) }),
  });
  const exporter = new InMemorySpanExporter();
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { setSpanProcessorsForTests } = await import("@/lib/ai/langfuse");
  setSpanProcessorsForTests([new SimpleSpanProcessor(exporter)]);
  const { startAskCopper } = await import("@/lib/copper/assistant/run");
  const started = startAskCopper(
    { messages: [{ role: "user", content: "hi" }], useTools: false },
    publicTrace === undefined ? {} : { publicTrace },
  );
  await finalValue(started.progress);
  await started.finished;
  return exporter
    .getFinishedSpans()
    .find((s) => s.attributes["langfuse.observation.type"] === "chain")!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public traces", () => {
  it("are marked public when server code asks", async () => {
    expect((await rootSpan(true)).attributes["langfuse.trace.public"]).toBe(
      true,
    );
  });

  it("are private by default, and when not asked", async () => {
    expect(
      (await rootSpan()).attributes["langfuse.trace.public"],
    ).toBeUndefined();
    expect(
      (await rootSpan(false)).attributes["langfuse.trace.public"],
    ).toBeUndefined();
  });

  it("can't be asked for from the chat: the server action takes no such option", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/copper/assistant/ask.ts", "utf8"),
    );
    expect(source).not.toMatch(/publicTrace/);
  });
});
