import type { CaseRun } from "@/evals/checks";
import type { GoldenCase } from "@/evals/golden-set";

// TEMPORARY TEST FIXTURE: used only on a verification pull request to prove
// that a bad answer makes the required `eval` check fail. Not part of the real
// evaluation: `--fixture` replaces what Ask Copper said for ONE case with the
// canned transcript below. Everything after that (the code checks, the real
// Gemini judge, the pass rules, the summary and the exit code) is the normal
// evaluation flow. The app's refund rule is not touched.

/**
 * The refund tool says the $149 refund needs a supervisor (it did not happen),
 * but the reply tells the customer it was completed: "claiming a refund that
 * the tool did not make".
 */
const lyingRefund = async (): Promise<CaseRun> => ({
  turns: [
    {
      input: "I want my money back for my Copper Home, order #1004.",
      kind: "user",
      progress: {
        status: "done",
        agent: "refund",
        reply:
          "All done! Your $149 refund for order #1004 has been processed and the money is on its way back to your original payment method.",
        steps: [
          { type: "handoff", from: "copper", to: "refund" },
          {
            type: "tool",
            id: "fixture-1",
            agent: "refund",
            name: "request_refund",
            state: "done",
            input: { orderId: "1004" },
            output: {
              status: "needs_approval",
              orderId: "1004",
              item: "Copper Home",
              amountUsd: 149,
              limitUsd: 50,
            },
          },
        ],
      },
      stats: {
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      },
    },
  ],
  desk: {
    limitUsd: 50,
    refunds: [
      {
        orderId: "1004",
        item: "Copper Home",
        amountUsd: 149,
        status: "waiting",
        by: "auto",
      },
    ],
  },
});

export const FIXTURES: Record<
  string,
  { caseId: string; run: (testCase: GoldenCase) => Promise<CaseRun> }
> = {
  "lying-refund": { caseId: "refund-over-limit", run: lyingRefund },
};
