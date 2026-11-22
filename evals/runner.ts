import type { CaseRun, TurnRun } from "@/evals/checks";
import type { GoldenCase } from "@/evals/golden-set";
import {
  startAskCopper,
  type AskCopperRequest,
  type ChatMessage,
} from "@/lib/copper/assistant/run";
import type { AgentMode } from "@/lib/copper/assistant/mode";
import { rateLimitWaitedMs } from "@/evals/throttle";
import type { Agent, ToolStep } from "@/lib/copper/assistant/progress";
import {
  type Desk,
  type RefundResult,
  supervisorDecision,
  withDecision,
} from "@/lib/copper/orders";

// Runs a golden-set case through the real Ask Copper (startAskCopper, the same
// code the chat's server action runs), one fresh conversation per case, and
// keeps the Refund Console's desk the way the console does: the app's refund
// decisions are added with withDecision, a supervisor's with
// supervisorDecision (lib/copper/orders.ts, which the console uses too).
// The expected answers are never given to Copper.

export type RunMeta = {
  /** Which architecture answers (single or multi). */
  agentMode?: AgentMode;
  runId: string;
  commit: string;
  goldenSetVersion: string;
  attempt: number;
};

export class CaseRunError extends Error {
  constructor(
    message: string,
    /** What ran before it failed. */
    readonly partial: CaseRun,
  ) {
    super(message);
    this.name = "CaseRunError";
  }
}

/** The session id (one per case run) every turn of a case shares. */
export const sessionIdFor = (meta: RunMeta, testCase: GoldenCase) =>
  `eval-${meta.runId}-${testCase.id}-a${meta.attempt}`.slice(0, 100);

export async function runCase(
  testCase: GoldenCase,
  meta: RunMeta,
): Promise<CaseRun> {
  // A fresh desk per case, copied so no case can change another's start.
  const desk: Desk = {
    limitUsd: testCase.limitUsd ?? 50,
    refunds: structuredClone(testCase.refunds ?? []),
  };
  const messages: ChatMessage[] = [];
  let agent: Agent = testCase.agent ?? "copper";
  const turns: TurnRun[] = [];
  const sessionId = sessionIdFor(meta, testCase);

  for (const turn of testCase.turns) {
    let text: string;
    let kind: TurnRun["kind"];
    if ("user" in turn) {
      text = turn.user;
      kind = "user";
    } else {
      // The console: decide the waiting refund, then tell the Refund agent.
      const waiting = desk.refunds.find(
        (r) => r.orderId === turn.orderId && r.status === "waiting",
      );
      const decision = waiting
        ? supervisorDecision(
            desk.refunds,
            waiting,
            turn.supervisor === "approve",
          )
        : undefined;
      if (!decision)
        throw new Error(
          `${testCase.id}: no waiting refund for order #${turn.orderId} to ${turn.supervisor}`,
        );
      desk.refunds = decision.refunds;
      text = decision.note;
      kind = "supervisor";
      agent = "refund";
    }
    messages.push({ role: "user", content: text });
    const request: AskCopperRequest = {
      messages: [...messages],
      useTools: true,
      sessionId,
      ...(testCase.surface === "support" && {
        desk: structuredClone(desk),
        agent,
      }),
    };
    const waitBefore = rateLimitWaitedMs();
    const started = startAskCopper(request, {
      ...(meta.agentMode && { agentMode: meta.agentMode }),
      tags: [
        "eval",
        `eval-run:${meta.runId}`,
        `case:${testCase.id}`,
        `golden:${meta.goldenSetVersion}`,
      ],
      metadata: {
        caseId: testCase.id,
        runId: meta.runId,
        commit: meta.commit,
        goldenSetVersion: meta.goldenSetVersion,
        attempt: String(meta.attempt),
        turn: String(turns.length + 1),
        ...(meta.agentMode && { agentMode: meta.agentMode }),
      },
    });
    // The turn is over once its trace has been sent, not when the answer is
    // complete: the root span ends after the answer.
    const outcome = await started.finished;
    const run: TurnRun = {
      input: text,
      kind,
      progress: outcome.progress,
      traceId: started.traceId,
      // With one case at a time, the waits are this turn's own; they are
      // reported apart so latency isn't blamed on our own request limiter.
      stats: {
        ...outcome.stats,
        rateLimitWaitMs: Math.round(rateLimitWaitedMs() - waitBefore),
      },
      ...(outcome.error && { error: outcome.error }),
    };
    turns.push(run);
    if (outcome.progress.status !== "done")
      throw new CaseRunError(outcome.error ?? "the turn ended in an error", {
        turns,
        desk,
      });
    // The chat would show its "Sorry, something went wrong" fallback here.
    // That is the model failing to answer, not an answer to grade: report it
    // as a temporary error so the case can run again (a few times at most).
    if (outcome.noAnswer)
      throw new CaseRunError(
        `the model ended the turn without an answer (finish reason: ${outcome.finishReason ?? "unknown"})`,
        { turns, desk },
      );
    messages.push({ role: "assistant", content: outcome.progress.reply });
    agent = outcome.progress.agent ?? "copper";
    // The console records each refund the app decided.
    for (const step of outcome.progress.steps)
      if (step.type === "tool" && isRefundDecision(step))
        desk.refunds = withDecision(desk.refunds, step.output as RefundResult);
  }
  return { turns, desk };
}

function isRefundDecision(step: ToolStep) {
  return step.name === "request_refund" && Boolean(step.output);
}
