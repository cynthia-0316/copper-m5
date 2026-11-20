import { z } from "zod";
import type { CaseRun } from "@/evals/checks";
import type { GoldenCase } from "@/evals/golden-set";
import {
  CASE_MIN_DIMENSION,
  CASE_MIN_OVERALL,
  DIMENSIONS,
  JUDGE_INSTRUCTIONS,
} from "@/evals/rubric";
import { isTransient, withRetries } from "@/evals/retry";
import { callObject } from "@/lib/ai/call";
import { defaultModel, MODELS, type ModelId } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";

// The AI judge: Gemini, called through callObject (lib/ai/call.ts) like every
// other model call in the app, so each judging call is logged as [ai_calls].
// It is given the question, Copper's real reply, what the tools really
// returned, and the standard; never anything else about how Copper works.

export const verdictSchema = z.object({
  correctness: z.number().int().min(1).max(5),
  groundedness: z.number().int().min(1).max(5),
  ruleCompliance: z.number().int().min(1).max(5),
  toolFidelity: z.number().int().min(1).max(5),
  overall: z.number().int().min(1).max(5),
  criticalViolation: z.boolean(),
  reasoning: z.string().min(1).max(1500),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** The judge's model: EVAL_JUDGE_MODEL if it names an approved one. */
export function judgeModel(): ModelId {
  const id = process.env.EVAL_JUDGE_MODEL;
  return MODELS.find((m) => m.id === id)?.id ?? defaultModel();
}

const clip = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}… (cut)` : text;
};

/**
 * The judge's prompt. Customer text, replies and tool results are put in as
 * JSON strings, so nothing inside them can look like the end of a block or
 * like an instruction from us.
 */
export function buildJudgePrompt(testCase: GoldenCase, run: CaseRun): string {
  const conversation = run.turns.flatMap((turn) => [
    {
      speaker: turn.kind === "supervisor" ? "Refund Console" : "Customer",
      text: turn.input,
    },
    {
      speaker:
        (turn.progress.agent ?? "copper") === "refund"
          ? "Refund agent"
          : "Copper",
      text: turn.progress.reply,
    },
  ]);
  const toolCalls = run.turns.map((turn, index) => ({
    turn: index + 1,
    calls: turn.progress.steps.flatMap<Record<string, unknown>>((step) =>
      step.type === "tool"
        ? [
            {
              agent: step.agent ?? "copper",
              tool: step.name,
              input: step.input,
              result: clip(step.output, 2500),
            },
          ]
        : step.type === "handoff"
          ? [{ handoff: `${step.from} → ${step.to}` }]
          : [],
    ),
  }));
  const standard = {
    facts: testCase.expected.facts,
    expectedBehaviors: testCase.expected.behaviors,
    forbidden: testCase.expected.forbidden,
    sources: testCase.sources.map(
      (s) => `${s.ref} (${s.version}): ${s.applies}`,
    ),
  };
  return [
    "Grade the final assistant reply in this conversation.",
    "<standard>",
    JSON.stringify(standard, null, 2),
    "</standard>",
    "<conversation>",
    JSON.stringify(conversation, null, 2),
    "</conversation>",
    "<tool_calls>",
    JSON.stringify(toolCalls, null, 2),
    "</tool_calls>",
  ].join("\n");
}

export type JudgeOutcome = {
  verdict: Verdict;
  model: ModelId;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Estimated from list prices; null when the call reported no tokens. */
  costUsd: number | null;
  latencyMs: number;
  /** When the judge's call started, for the Langfuse trace. */
  startedAt: Date;
  attempts: number;
  prompt: string;
};

/** True if the verdict meets the case pass rule (checks aside). */
export function verdictPasses(verdict: Verdict): boolean {
  return (
    verdict.overall >= CASE_MIN_OVERALL &&
    DIMENSIONS.every((d) => verdict[d] >= CASE_MIN_DIMENSION) &&
    !verdict.criticalViolation
  );
}

/**
 * Judges one case. Temporary errors and an invalid answer are retried (twice
 * at most); a low score is just the result. Throws when no valid verdict came.
 */
export async function judgeCase(
  testCase: GoldenCase,
  run: CaseRun,
  model: ModelId = judgeModel(),
): Promise<JudgeOutcome> {
  const prompt = buildJudgePrompt(testCase, run);
  return judgePrompt(prompt, model);
}

export async function judgePrompt(
  prompt: string,
  model: ModelId = judgeModel(),
): Promise<JudgeOutcome> {
  const startedAt = new Date();
  const started = performance.now();
  const { value, attempts } = await withRetries(
    () =>
      callObject(
        { module: 5, feature: "eval-judge", model },
        {
          schema: verdictSchema,
          instructions: JUDGE_INSTRUCTIONS,
          prompt,
          // As repeatable as the model allows: same answer, same grade.
          temperature: 0,
        },
      ),
    {
      retries: 2,
      // An answer that doesn't fit the schema is retried too; nothing else is.
      retryable: (error) => isTransient(error) || isInvalidOutput(error),
    },
  );
  const { inputTokens, outputTokens } = value.usage;
  return {
    verdict: value.output,
    model,
    usage: {
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
    },
    costUsd:
      inputTokens !== undefined && outputTokens !== undefined
        ? costUsd(model, inputTokens, outputTokens)
        : null,
    latencyMs: Math.round(performance.now() - started),
    startedAt,
    attempts,
    prompt,
  };
}

function isInvalidOutput(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  return /NoObjectGenerated|NoOutputGenerated|TypeValidation|JSONParse|InvalidResponse/i.test(
    name,
  );
}
