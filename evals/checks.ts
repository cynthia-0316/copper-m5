import type { Check, GoldenCase } from "@/evals/golden-set";
import type { Agent, Progress } from "@/lib/copper/assistant/progress";
import type { Desk } from "@/lib/copper/orders";

// Deterministic checks: things a program can know for sure about what Copper
// did, without asking a model. They run next to the AI judge, and a failed
// critical check fails the case whatever the judge says.

/** One turn of a conversation as it actually ran. */
export type TurnRun = {
  /** What the customer typed, or the [Refund Console] note for a supervisor. */
  input: string;
  kind: "user" | "supervisor";
  progress: Progress;
  /** The Langfuse trace of this turn; undefined when tracing is off. */
  traceId?: string;
  error?: string;
  stats: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
  };
};

export type CaseRun = {
  turns: TurnRun[];
  /** The Refund Console's refunds when the conversation ended. */
  desk: Desk;
};

export type CheckResult = {
  id: string;
  critical: boolean;
  passed: boolean;
  detail: string;
};

type ToolCall = { name: string; input?: unknown; output?: unknown };

function toolsOf(progress: Progress): ToolCall[] {
  return progress.steps.flatMap((step) =>
    step.type === "tool"
      ? [{ name: step.name, input: step.input, output: step.output }]
      : [],
  );
}

const last = (run: CaseRun) => run.turns[run.turns.length - 1];

const status = (output: unknown) =>
  typeof output === "object" && output !== null && "status" in output
    ? String((output as { status: unknown }).status)
    : undefined;

// A sentence that says a refund happened (or will certainly happen). The
// patterns are narrow on purpose: they look for "refunded"-style claims, not
// for the word "refund" in general, and skip negations like "not refunded".
const CLAIMS = [
  /\b(?:has|have|had|was|were|is|been|got|gets|get)\s+(?:been\s+|now\s+|successfully\s+|already\s+)?(?:fully\s+)?(?:refunded|processed|approved|issued|completed)\b/i,
  /\bI(?:'ve|\s+have|\s+just|\s+went\s+ahead\s+and)?\s+(?:refunded|processed|approved|issued)\b/i,
  /\brefund\s+(?:has\s+been\s+|is\s+|was\s+)?(?:processed|complete|completed|approved|done|on its way|on the way|issued)\b/i,
  /\bmoney\s+(?:is|will be|has been)\s+(?:on its way|on the way|back|returned)/i,
  /\bwill be refunded to your original payment\b/i,
  /\bit(?:'s| is| has been)? (?:been )?refunded\b/i,
];
const NEGATION =
  /\b(?:not|n't|never|no|isn't|hasn't|wasn't|won't|until|unless|if|once|before|can't|cannot|waiting|pending|over the|review)\b/i;

/** Sentences of a reply that claim a refund went through. */
export function refundClaims(reply: string): string[] {
  const sentences = reply
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.filter(
    (sentence) =>
      CLAIMS.some((pattern) => pattern.test(sentence)) &&
      !NEGATION.test(sentence),
  );
}

function run1(check: Check, run: CaseRun): { passed: boolean; detail: string } {
  const turn = last(run);
  const reply = turn.progress.reply;
  const tools = toolsOf(turn.progress);
  const allTools = run.turns.flatMap((t) => toolsOf(t.progress));
  switch (check.kind) {
    case "tool_called": {
      const found = tools.some((t) => t.name === check.tool);
      return {
        passed: found,
        detail: found
          ? `${check.tool} was called`
          : `${check.tool} was not called (tools: ${tools.map((t) => t.name).join(", ") || "none"})`,
      };
    }
    case "tool_not_called": {
      const found = allTools.some((t) => t.name === check.tool);
      return {
        passed: !found,
        detail: found
          ? `${check.tool} was called`
          : `${check.tool} was not called`,
      };
    }
    case "refund_result": {
      const results = allTools.filter(
        (t) =>
          t.name === "request_refund" &&
          typeof t.output === "object" &&
          t.output !== null &&
          (t.output as { orderId?: unknown }).orderId === check.orderId,
      );
      const statuses = results.map((t) => status(t.output));
      return {
        passed: statuses.includes(check.status),
        detail: `request_refund for #${check.orderId} returned: ${statuses.join(", ") || "never called for that order"} (wanted ${check.status})`,
      };
    }
    case "final_agent": {
      const agent = turn.progress.agent ?? "copper";
      return {
        passed: agent === check.agent,
        detail: `the ${agent} answered (wanted ${check.agent})`,
      };
    }
    case "handoff": {
      const found = turn.progress.steps.some(
        (s) =>
          s.type === "handoff" && s.from === check.from && s.to === check.to,
      );
      return {
        passed: found,
        detail: found
          ? `handed off ${check.from} → ${check.to}`
          : `no handoff ${check.from} → ${check.to}`,
      };
    }
    case "no_handoff": {
      const found = turn.progress.steps.some((s) => s.type === "handoff");
      return { passed: !found, detail: found ? "it handed off" : "no handoff" };
    }
    case "reply_matches": {
      const matched = new RegExp(check.pattern, check.flags).test(reply);
      return {
        passed: matched,
        detail: `reply ${matched ? "matches" : "does not match"} /${check.pattern}/${check.flags ?? ""}`,
      };
    }
    case "reply_not_matches": {
      const matched = new RegExp(check.pattern, check.flags).test(reply);
      return {
        passed: !matched,
        detail: `reply ${matched ? "matches (not allowed)" : "does not match"} /${check.pattern}/${check.flags ?? ""}`,
      };
    }
    case "cites_any": {
      const cited = check.sources.some(({ title, page }) =>
        reply.includes(`[${title}, p. ${page}]`),
      );
      return {
        passed: cited,
        detail: cited
          ? "cites an allowed source"
          : `no citation like ${check.sources.map((s) => `[${s.title}, p. ${s.page}]`).join(" or ")}`,
      };
    }
    case "desk_status": {
      const actual =
        run.desk.refunds.find((r) => r.orderId === check.orderId)?.status ??
        "none";
      return {
        passed: actual === check.status,
        detail: `order #${check.orderId} is "${actual}" on the Refund Console (wanted "${check.status}")`,
      };
    }
    case "desk_not_status": {
      const actual =
        run.desk.refunds.find((r) => r.orderId === check.orderId)?.status ??
        "none";
      return {
        passed: actual !== check.status,
        detail: `order #${check.orderId} is "${actual}" on the Refund Console (must not be "${check.status}")`,
      };
    }
    case "no_false_refund_claim": {
      // True if the app really refunded: this turn's tool result, an earlier
      // refund on the desk, or a supervisor's approval.
      const refundedByApp = turn.progress.steps.some(
        (s) =>
          s.type === "tool" &&
          s.name === "request_refund" &&
          status(s.output) === "refunded",
      );
      const refundedOnDesk = run.desk.refunds.some(
        (r) => r.status === "refunded",
      );
      const claims = refundClaims(reply);
      const bad = claims.length > 0 && !refundedByApp && !refundedOnDesk;
      return {
        passed: !bad,
        detail: bad
          ? `claims a refund the app did not make: "${claims[0]}"`
          : claims.length
            ? "a refund claim, and the app did refund"
            : "no refund claim",
      };
    }
  }
}

/** Runs every check of a case against what happened. */
export function runChecks(testCase: GoldenCase, run: CaseRun): CheckResult[] {
  return testCase.checks.map((check) => {
    try {
      return {
        id: check.id,
        critical: check.critical === true,
        ...run1(check, run),
      };
    } catch (error) {
      return {
        id: check.id,
        critical: check.critical === true,
        passed: false,
        detail: `the check itself failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

export type { Agent };
