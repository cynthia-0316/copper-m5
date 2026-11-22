import {
  type Check,
  GOLDEN_SET,
  GOLDEN_SET_VERSION,
  type GoldenCase,
} from "@/evals/golden-set";

// The architecture-neutral golden set, for comparing the single support agent
// with the multi-agent Copper + Refund agent (Module 5, Part 4).
//
// golden-v3 (evals/golden-set.ts) is kept exactly as it is: it is the original
// set, it still gates pull requests, and it still checks the multi-agent
// handoffs. Some of its cases test the HANDOFF itself, which a single agent
// can't do by design, so judging the single agent on them would fail it for its
// architecture rather than for a wrong, unsafe or missing answer.
//
// This file derives golden-v3-neutral from golden-v3, never by editing it:
//  1. Checks that only make sense with two agents are REMOVED, and nothing else:
//     `handoff`, `no_handoff` and `final_agent` (9 checks in 7 cases).
//  2. Where a case's expected text talks about handing off, it is rewritten
//     below to state the same business outcome without naming an architecture.
//     Facts are never changed.
//  3. A removed "no hand-off" check is replaced by the outcome it stood for
//     ("the policy question did not turn into a refund request"), which both
//     architectures can fail.
// Every business check stays for BOTH architectures: the app's refund decision
// for each order, tools used, the console's final state, no false refund claim,
// citations, facts, internal documents. The same cases, the same critical flags,
// the same rubric and thresholds, the same judge. In the neutral judge prompt the
// speaker is just "Assistant" and handoff plumbing is hidden, so the judge can't
// tell (or prefer) an architecture.
// Change this file only with golden-set.ts, and raise the version if you do.

export const NEUTRAL_VERSION = `${GOLDEN_SET_VERSION}-neutral`;

const ARCHITECTURE_KINDS = new Set(["handoff", "no_handoff", "final_agent"]);

/** A check about how the agents are arranged, not about the customer's outcome. */
export const isArchitectureCheck = (check: Check) =>
  ARCHITECTURE_KINDS.has(check.kind);

type Override = {
  title?: string;
  behaviors?: string[];
  forbidden?: string[];
  sources?: GoldenCase["sources"];
  /** Added in place of removed architecture checks (the same outcome). */
  checks?: Check[];
};

const OVERRIDES: Record<string, Override> = {
  "docs-annual-refund-policy": {
    title:
      "Annual plan refund policy (a policy question is not a refund request)",
    behaviors: [
      "Answers from the documents with citations.",
      "Answers the policy question; it is not a refund request, so no refund is requested, promised or approved.",
    ],
    forbidden: [
      "Requesting, promising or approving any refund.",
      "A refund window other than 14 days.",
    ],
    sources: [
      {
        ref: "Copper State Labs Terms and Conditions p. 4, section 4.6",
        version: "2026 PDF",
        applies:
          "Annual: full refund within 14 days; after that, not refunded.",
      },
      {
        ref: "Copper Plus FAQ p. 5",
        version: "March 2026 PDF",
        applies: "Same rule.",
      },
      {
        ref: "lib/copper/assistant/instructions.ts › COPPER_INSTRUCTIONS, REFUND_RULES",
        version: "Module 4",
        applies:
          "Questions about the refund policy itself are answered from the documents.",
      },
    ],
    checks: [
      {
        id: "no-refund-requested",
        kind: "tool_not_called",
        tool: "request_refund",
      },
    ],
  },
  "clarify-refund-no-order": {
    behaviors: [
      "Looks at the customer's orders and asks which order to refund.",
    ],
    sources: [
      {
        ref: "lib/copper/assistant/instructions.ts › REFUND_RULES",
        version: "Module 4",
        applies: '"If you can\'t tell which order they mean, ask."',
      },
    ],
  },
  "refund-under-limit": {
    behaviors: [
      "Asks the app for the refund with request_refund.",
      "Tells the customer $7.99 is refunded.",
    ],
  },
  "refund-at-limit": {
    behaviors: [
      "Asks the app for the refund with request_refund; tells the customer $79 is refunded.",
    ],
  },
  "handoff-back-to-copper": {
    title: "A stock question in the middle of a refund conversation",
    behaviors: ["Checks stock with a tool and answers the stock question."],
    forbidden: ["Answering a stock question without checking stock."],
    sources: [
      {
        ref: "lib/copper/data/inventory.json (CH-POL: 240)",
        version: "2026 inventory",
        applies: "check_availability reads stock fresh each time.",
      },
    ],
  },
};

/** The architecture-neutral version of one golden-v3 case. */
export function neutralCase(testCase: GoldenCase): GoldenCase {
  const override = OVERRIDES[testCase.id] ?? {};
  return {
    ...testCase,
    ...(override.title && { title: override.title }),
    expected: {
      ...testCase.expected,
      ...(override.behaviors && { behaviors: override.behaviors }),
      ...(override.forbidden && { forbidden: override.forbidden }),
    },
    sources: override.sources ?? testCase.sources,
    checks: [
      ...testCase.checks.filter((check) => !isArchitectureCheck(check)),
      ...(override.checks ?? []),
    ],
  };
}

export const NEUTRAL_SET: GoldenCase[] = GOLDEN_SET.map(neutralCase);

/** The checks the neutral version removed, for the report. */
export function removedChecks() {
  return GOLDEN_SET.flatMap((testCase) =>
    testCase.checks.filter(isArchitectureCheck).map((check) => ({
      caseId: testCase.id,
      checkId: check.id,
      kind: check.kind,
    })),
  );
}
