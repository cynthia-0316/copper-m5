import {
  LangfuseOtelSpanAttributes,
  startObservation,
  type LangfuseAgent,
  type LangfuseChain,
  type LangfuseGeneration,
  type LangfuseTool,
} from "@langfuse/tracing";
import { ensureTracing, flushTraces } from "@/lib/ai/langfuse";
import { MODELS, type ModelId } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import { AGENT_NAMES, type Agent } from "@/lib/copper/assistant/progress";

// Langfuse tracing for one Ask Copper turn (Module 5). The shape in Langfuse:
//
//   session (one chat)            sessionId, sent by the panel
//   └─ trace (one turn)           "ask-copper-turn": the question and the reply
//      ├─ agent "Copper"
//      │  ├─ generation          one model step: tokens, cost, time
//      │  ├─ tool                one tool call: input, output or error
//      │  └─ event "handoff"     Copper → Refund agent
//      └─ agent "Refund agent"
//         └─ …
//
// Tracing only watches. Every method here swallows its own errors, so a
// Langfuse problem can never change what Copper answers or run a tool twice.

/** The parts of the AI SDK's `fullStream` that the tracer reads. */
type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
};
export type TracedPart =
  | { type: "start-step" }
  | { type: "reasoning-delta" | "text-delta"; text: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; error: unknown }
  | {
      type: "finish-step";
      usage: Usage;
      finishReason: string;
      response?: { modelId?: string };
    }
  | { type: "error"; error: unknown }
  | { type: string };

export type TurnInfo = {
  /** The chat this turn belongs to (the Langfuse session). */
  sessionId: string;
  question: string;
  useTools: boolean;
  firstAgent: Agent;
  /** The architecture answering: shown on the trace, as a tag and in metadata. */
  agentMode?: "single" | "multi";
  /**
   * Makes the trace publicly viewable by anyone with its link (Langfuse's
   * "share"). Server code only, for a trace made to be shown: a demo
   * conversation. Never set from anything a visitor sends.
   */
  publicTrace?: boolean;
  /** Langfuse tags and metadata for the trace (the evaluation sets these). */
  tags?: string[];
  metadata?: Record<string, string>;
  /** Langfuse environment, e.g. "eval", to keep test traces apart. */
  environment?: string;
};

export type TurnTracer = {
  /** The Langfuse trace id of this turn, when tracing is on. */
  traceId: string | undefined;
  /** An agent starts answering (the first one, or after a handoff). */
  startAgent(agent: Agent, model: ModelId): void;
  /** Feed every stream part of the current agent's call. */
  part(part: TracedPart): void;
  /** The current agent ends its turn. */
  endAgent(reply: string): void;
  /** Copper and the Refund agent pass the chat to each other. */
  handoff(from: Agent, to: Agent): void;
  /** Ends the turn and sends it to Langfuse. Call once, last. */
  finish(result: {
    status: "done" | "error";
    reply: string;
    error?: unknown;
  }): Promise<boolean>;
};

const TRACE_NAME = "ask-copper-turn";
const LIMIT = 4000;
/** Keeps one huge value from filling a trace. */
function clip(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > LIMIT ? `${value.slice(0, LIMIT)}… (cut)` : value;
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const googleId = (model: ModelId) => {
  const entry = MODELS.find((m) => m.id === model);
  return entry ? entry.googleId : model.slice("google/".length);
};

const NOOP: TurnTracer = {
  traceId: undefined,
  startAgent() {},
  part() {},
  endAgent() {},
  handoff() {},
  async finish() {
    return false;
  },
};

/** Runs tracing code; a failure is reported once and never rethrown. */
function safe(warned: { value: boolean }, run: () => void) {
  try {
    run();
  } catch (error) {
    if (!warned.value) {
      warned.value = true;
      console.warn(
        "[langfuse] tracing hit an error; this chat's trace may be incomplete:",
        message(error),
      );
    }
  }
}

/** Starts the trace for one turn. A no-op tracer when Langfuse isn't set up. */
export function startTurn(info: TurnInfo): TurnTracer {
  if (!ensureTracing()) return NOOP;
  const warned = { value: false };
  // The single support agent isn't "Copper": say which architecture ran.
  const label = (agent: Agent) =>
    info.agentMode === "single" ? "Support agent" : AGENT_NAMES[agent];
  const tags = [
    ...(info.agentMode ? [`arch:${info.agentMode}`] : []),
    ...(info.tags ?? []),
  ];
  const metadata = {
    ...(info.agentMode && { agentMode: info.agentMode }),
    ...info.metadata,
  };
  // The session id goes on every observation, so each one carries it to
  // Langfuse and no other chat's turn can land in this chat's session.
  const tag = (observation: {
    otelSpan: { setAttribute(k: string, v: string): unknown };
  }) =>
    observation.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
      info.sessionId,
    );
  let turn: LangfuseChain;
  try {
    turn = startObservation(
      "ask-copper-turn",
      { input: clip(info.question) },
      { asType: "chain" },
    );
    turn.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_NAME,
      TRACE_NAME,
    );
    tag(turn);
    if (tags.length)
      turn.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, tags);
    if (info.publicTrace)
      turn.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_PUBLIC, true);
    for (const [key, value] of Object.entries(metadata))
      turn.otelSpan.setAttribute(
        `${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`,
        value,
      );
    if (info.environment)
      turn.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.ENVIRONMENT,
        info.environment,
      );
  } catch (error) {
    safe(warned, () => {
      throw error;
    });
    return NOOP;
  }

  let agent: LangfuseAgent | undefined;
  let agentName: Agent = info.firstAgent;
  let model: ModelId | undefined;
  let step: LangfuseGeneration | undefined;
  let steps = 0;
  let stepText = "";
  let firstToken = false;
  // When the next model call was sent: the agent starting, or its last tool
  // returning. A step's stream only starts when the first chunk arrives, so
  // this keeps the wait for the model inside the step's time.
  let readyAt = new Date();
  const tools = new Map<string, LangfuseTool>();
  let handoffs = 0;
  let finished = false;

  const endStep = (error?: string) => {
    if (!step) return;
    if (error) step.update({ level: "ERROR", statusMessage: error });
    step.end();
    step = undefined;
  };
  // Tool ids repeat across agents (each agent's call starts again at 1), so
  // they are kept per agent and cleared when the agent ends.
  const endTools = (error: string) => {
    for (const tool of tools.values())
      tool.update({ level: "ERROR", statusMessage: error }).end();
    tools.clear();
  };
  const toolFor = (id: string, name: string): LangfuseTool | undefined => {
    const known = tools.get(id);
    if (known) return known;
    if (!agent) return undefined;
    const tool = agent.startObservation(name, {}, { asType: "tool" });
    tag(tool);
    tools.set(id, tool);
    return tool;
  };

  return {
    traceId: turn.traceId,

    startAgent(next, nextModel) {
      safe(warned, () => {
        agentName = next;
        readyAt = new Date();
        model = nextModel;
        steps = 0;
        agent = turn.startObservation(
          label(next),
          {
            input: clip(info.question),
            metadata: { agent: next, model: googleId(nextModel) },
          },
          { asType: "agent" },
        );
        tag(agent);
      });
    },

    part(part) {
      safe(warned, () => {
        switch (part.type) {
          case "start-step": {
            if (!agent) return;
            steps++;
            stepText = "";
            firstToken = false;
            step = startObservation(
              `${label(agentName)} model call ${steps}`,
              {
                model: model ? googleId(model) : undefined,
                metadata: { agent: agentName, step: steps },
              },
              {
                asType: "generation",
                parentSpanContext: agent.otelSpan.spanContext(),
                startTime: readyAt,
              },
            );
            tag(step);
            return;
          }
          case "reasoning-delta":
          case "text-delta": {
            const delta = part as { type: string; text: string };
            if (!firstToken && step) {
              firstToken = true;
              step.update({ completionStartTime: new Date() });
            }
            if (delta.type === "text-delta") stepText += delta.text;
            return;
          }
          case "tool-input-start": {
            const p = part as { id: string; toolName: string };
            toolFor(p.id, p.toolName);
            return;
          }
          case "tool-call": {
            const p = part as {
              toolCallId: string;
              toolName: string;
              input: unknown;
            };
            toolFor(p.toolCallId, p.toolName)?.update({ input: p.input });
            return;
          }
          case "tool-result": {
            const p = part as { toolCallId: string; output: unknown };
            tools.get(p.toolCallId)?.update({ output: p.output }).end();
            tools.delete(p.toolCallId);
            if (tools.size === 0) readyAt = new Date();
            return;
          }
          case "tool-error": {
            const p = part as { toolCallId: string; error: unknown };
            tools
              .get(p.toolCallId)
              ?.update({ level: "ERROR", statusMessage: message(p.error) })
              .end();
            tools.delete(p.toolCallId);
            if (tools.size === 0) readyAt = new Date();
            return;
          }
          case "finish-step": {
            const p = part as Extract<TracedPart, { type: "finish-step" }>;
            if (!step) return;
            const input = p.usage.inputTokens;
            const output = p.usage.outputTokens;
            // Tokens are what the model reported; unknown ones are left out
            // rather than guessed. Cost is our estimate from list prices
            // (lib/ai/pricing.ts), so it is left out when tokens are unknown.
            const known = input !== undefined && output !== undefined;
            step.update({
              output: clip(stepText) || undefined,
              usageDetails: {
                ...(input !== undefined && { input }),
                ...(output !== undefined && { output }),
                ...(p.usage.totalTokens !== undefined && {
                  total: p.usage.totalTokens,
                }),
              },
              ...(known &&
                model && {
                  costDetails: {
                    input: costUsd(model, input, 0),
                    output: costUsd(model, 0, output),
                    total: costUsd(model, input, output),
                  },
                }),
              metadata: {
                finishReason: p.finishReason,
                reasoningTokens:
                  p.usage.outputTokenDetails?.reasoningTokens ?? "unknown",
                costBasis: known
                  ? "estimate: reported tokens x Google list prices (lib/ai/pricing.ts)"
                  : "unknown: the model reported no token counts",
              },
            });
            endStep();
            return;
          }
          case "error": {
            const p = part as { error: unknown };
            endStep(message(p.error));
            return;
          }
          default:
            return;
        }
      });
    },

    endAgent(reply) {
      safe(warned, () => {
        endStep();
        endTools("the agent ended before the tool returned");
        agent?.update({ output: clip(reply) }).end();
        agent = undefined;
      });
    },

    handoff(from, to) {
      safe(warned, () => {
        handoffs++;
        // An event: a point in time, a child of the agent handing off.
        const parent = agent ?? turn;
        const event = parent.startObservation(
          `handoff: ${AGENT_NAMES[from]} → ${AGENT_NAMES[to]}`,
          { metadata: { from, to } },
          { asType: "event" },
        );
        tag(event);
        event.end();
      });
    },

    async finish({ status, reply, error }) {
      if (finished) return false;
      finished = true;
      safe(warned, () => {
        const reason = error === undefined ? undefined : message(error);
        endStep(reason ?? (status === "error" ? "turn failed" : undefined));
        endTools(reason ?? "the turn ended before the tool returned");
        if (agent) {
          agent.update({
            output: clip(reply),
            ...(status === "error" && {
              level: "ERROR",
              statusMessage: reason ?? "turn failed",
            }),
          });
          agent.end();
          agent = undefined;
        }
        turn.update({
          output: clip(reply),
          metadata: { status, handoffs },
          ...(status === "error" && {
            level: "ERROR",
            statusMessage: reason ?? "turn failed",
          }),
        });
        turn.end();
      });
      // Nothing waits for Langfuse inside the chat: this runs after the reply.
      return flushTraces();
    },
  };
}
