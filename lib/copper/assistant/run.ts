// Ask Copper's logic, shared by the chat (the server action in ask.ts) and the
// golden-set evaluation (evals/), so the evaluation tests exactly what
// customers use. It streams the conversation to the model through callStream
// (lib/ai/call.ts), with or without the tools, and reports each step as it
// happens, so the panel can show Copper thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
import { hasToolCall, stepCountIs } from "ai";
import { after } from "next/server";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel, type ModelId } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import {
  COPPER_HANDOFF,
  SINGLE_AGENT_INSTRUCTIONS,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import { type AgentMode, agentMode } from "@/lib/copper/assistant/mode";
import {
  copperTools,
  refundAgentTools,
  refundTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import { startTurn, type TurnTracer } from "@/lib/copper/assistant/trace";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /** The chat this turn belongs to; Langfuse groups a chat's turns by it. */
  sessionId?: string;
};

export type AskCopperResult = { progress: Live<Progress> };

/** Options only server code can set (the evaluation); never from the browser. */
export type RunOptions = {
  /** Which architecture answers; AGENT_MODE (default multi) if omitted. */
  agentMode?: AgentMode;
  tags?: string[];
  metadata?: Record<string, string>;
  environment?: string;
};

/** What one turn used, added up over its model calls. */
export type TurnStats = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from list prices; null when a model call reported no tokens. */
  costUsd: number | null;
  latencyMs: number;
};

export type TurnOutcome = {
  progress: Progress;
  stats: TurnStats;
  /** The error that ended the turn, if one did (progress.status is "error"). */
  error?: string;
  /** Whether the trace and its spans reached Langfuse. */
  traceSent: boolean;
  /**
   * True when the model ended the turn without any answer, so the panel shows
   * the "Sorry, something went wrong" fallback instead (for example Gemini
   * stopping with finish reason "other" during a demand spike). The chat shows
   * the fallback as before; the evaluation treats it as a temporary failure.
   */
  noAnswer: boolean;
  /** The finish reason of the last model step, when there was one. */
  finishReason?: string;
};

export type RunResult = AskCopperResult & {
  /** The Langfuse trace id of this turn; undefined when tracing is off. */
  traceId: string | undefined;
  /** Resolves, never rejects, once the turn is over and its trace is sent. */
  finished: Promise<TurnOutcome>;
};

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

const SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's call: its instructions and only its own tools. */
function agentCall(
  agent: Agent,
  messages: ChatMessage[],
  model: ModelId,
  desk?: Desk,
  mode: AgentMode = "multi",
) {
  // Single-agent: one agent with Copper's tools and the two refund tools, no
  // handoff tools, so nothing can hand the conversation to anyone else.
  if (mode === "single" && desk)
    return callStream(
      { module: 5, feature: "single-agent", model },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: SINGLE_AGENT_INSTRUCTIONS,
        tools: { ...copperTools, ...refundTools(desk) },
        stopWhen: [stepCountIs(MAX_STEPS)],
      },
    );
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent", model },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper", model },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export function startAskCopper(
  { messages, useTools, desk, agent = "copper", sessionId }: AskCopperRequest,
  options: RunOptions = {},
): RunResult {
  const started = performance.now();
  let finishReason: string | undefined;
  const stats: TurnStats = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  const outcome = Promise.withResolvers<TurnOutcome>();
  const { live, update, done } = createLive<Progress>();
  const mode = options.agentMode ?? agentMode();
  // Single-agent has one agent only; who answered last turn doesn't matter.
  const first: Agent = mode === "multi" && desk && useTools ? agent : "copper";
  const model = defaultModel();
  // One Langfuse trace per turn; its session is the chat. The id comes from
  // the browser, so a bad one is replaced instead of trusted.
  const tracer: TurnTracer = startTurn({
    sessionId:
      sessionId && SESSION_ID.test(sessionId) ? sessionId : crypto.randomUUID(),
    question: messages.at(-1)?.content ?? "",
    useTools,
    firstAgent: first,
    ...options,
    agentMode: mode,
  });
  // Langfuse gets the trace after the reply, and the host keeps the request
  // alive until it is sent.
  const traceSent = Promise.withResolvers<void>();
  try {
    after(() => traceSent.promise);
  } catch {
    // Not inside a request (tests, scripts): nothing to keep alive.
  }
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      tracer.part(part);
      if (part.type === "finish-step") {
        finishReason = part.finishReason;
        stats.modelCalls++;
        const { inputTokens, outputTokens } = part.usage;
        stats.inputTokens += inputTokens ?? 0;
        stats.outputTokens += outputTokens ?? 0;
        stats.costUsd =
          stats.costUsd !== null &&
          inputTokens !== undefined &&
          outputTokens !== undefined
            ? stats.costUsd + costUsd(model, inputTokens, outputTokens)
            : null;
      }
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handoff;
  }

  // Read the stream in the background, so the panel gets the first update now.
  let failure: unknown;
  let noAnswer = false;
  void (async () => {
    try {
      if (!useTools) {
        tracer.startAgent("copper", model);
        // Without tools, send no instructions either: "always use your
        // tools" with no tools makes the model answer with nothing.
        await follow(
          "copper",
          callStream(
            { module: 2, feature: "ask-copper", model },
            { messages, providerOptions: THOUGHT_SUMMARIES },
          ),
        );
        tracer.endAgent(progress.reply);
      } else {
        let current = first;
        for (let handoffs = 0; ; handoffs++) {
          tracer.startAgent(current, model);
          const next = await follow(
            current,
            agentCall(current, messages, model, desk, mode),
          );
          const handingOff =
            next && next !== current && handoffs < MAX_HANDOFFS;
          if (handingOff) tracer.handoff(current, next);
          tracer.endAgent(progress.reply);
          if (!handingOff) break;
          progress.steps.push({ type: "handoff", from: current, to: next });
          progress.agent = current = next;
          progress.reply = "";
          call++;
          update(snapshot());
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) {
        noAnswer = true;
        progress.reply = SORRY;
      }
    } catch (error) {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
      failure = error;
    }
    done(snapshot());
    stats.latencyMs = Math.round(performance.now() - started);
    // After the panel has its answer: close the trace and send it.
    const sent = await tracer.finish({
      status: progress.status === "done" ? "done" : "error",
      reply: progress.reply,
      error: failure,
    });
    traceSent.resolve();
    outcome.resolve({
      progress: snapshot(),
      stats,
      traceSent: sent,
      noAnswer,
      ...(finishReason && { finishReason }),
      ...(failure !== undefined && {
        error: failure instanceof Error ? failure.message : String(failure),
      }),
    });
  })();

  return { progress: live, traceId: tracer.traceId, finished: outcome.promise };
}
