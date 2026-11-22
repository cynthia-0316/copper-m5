# Single agent vs multi-agent: comparison

_Fictional — for educational use._

The question: **would you ship the single support agent, or Copper plus the
Refund agent?** This page holds the protocol (written before any comparison run),
the measured results and the recommendation.

## The two architectures

| | Single agent | Multi agent (the baseline, unchanged) |
|---|---|---|
| Agents | One support agent | Copper + the Refund agent |
| Tools | Copper's 5 tools + `get_orders`, `request_refund` | Copper: 5 tools + `transfer_to_refund_agent`. Refund agent: `get_orders`, `request_refund`, `transfer_to_copper` |
| Instructions | `SINGLE_AGENT_INSTRUCTIONS`: Copper's instructions + the shared `REFUND_RULES` | `COPPER_INSTRUCTIONS` + `COPPER_HANDOFF`; `REFUND_AGENT_INSTRUCTIONS` (which now includes the same `REFUND_RULES`) |
| Handoff | None | Copper ⇄ Refund agent |
| Refund decision | `requestRefund` in `lib/copper/orders.ts`, unchanged | the same function |
| Switch | `AGENT_MODE=single`, or `npm run eval -- --agent-mode single` | `AGENT_MODE=multi` (the default) |

Both run through the same `startAskCopper()` (`lib/copper/assistant/run.ts`), the
same tools, the same Langfuse tracing and the same evaluation. The multi-agent
instructions and tool definitions are byte-for-byte what they were: the tests
check their fingerprints.

The single agent gets the same step budget per turn as one agent had before
(5 model steps: tool calls plus the reply). A refund needs about 3, so the budget
does not decide any case here.

## Protocol (fixed before the runs)

- **Cases:** `golden-v3-neutral` (18 cases), derived from golden-v3 by
  `evals/neutral.ts`. golden-v3 is untouched and still gates pull requests for the
  multi-agent default. Nine checks in seven cases test the handoff itself
  (`handoff`, `no_handoff`, `final_agent`); a single agent can't pass them by
  design, so they are removed for BOTH architectures. Everything else is kept
  unchanged for both: facts, critical flags, every business check (the app's
  refund decision per order, tools used, the console's final state, no false
  refund claim, citations, internal documents). One removed "no handoff" check is
  replaced by the outcome it stood for ("a policy question doesn't request a
  refund"), which either architecture can fail. Wording in a few cases that named
  the handoff now states the same outcome without it.
- **Same everything else:** one model for answering (`google/gemini-3.5-flash-lite`,
  `AI_MODEL` unset) and for judging, the judge at temperature 0, the same rubric
  (`rubric-v1`), thresholds and pass rules, the same starting orders, limit and
  refunds, the same tools and business rules.
- **Blind judge:** in this comparison the judge sees "Assistant" for every turn,
  and handoffs and `transfer_to_*` calls are left out of what it reads, so it
  can't tell, or prefer, an architecture.
- **Conditions:** one case at a time (concurrency 1), requests held to 12 a minute
  (Gemini's free tier allows 15), runs one after another, never at the same time.
  Order: single, multi, multi, single, to spread any change in Gemini's load
  over both. Two runs of each architecture, 4 runs.
- **Retries:** the same, limited rule for both: only temporary service errors and
  a turn where the model gave no answer at all are run again (a case 3 more times,
  the judge 4). A wrong or low-scoring answer is never run again. How many cases
  needed a retry is reported.
- **Reporting:** every run is reported, none dropped. A run that ends with errors
  stays in the tables as it is. A run may only be repeated if the process itself
  failed (a crash, a lost connection to Langfuse), and then both attempts are
  mentioned.
- **Latency** is measured per case, end to end, and also without the time our own
  request limiter made the run wait. Gemini's own response time still varies with
  its load, so latency is the least reliable number here.
- **Cost** is an estimate: tokens the model reported times Google's list prices
  (`lib/ai/pricing.ts`). Answering and judging are counted apart.
- **How the choice will be made:** quality first (critical failures dominate, then
  pass rate and judge score), then reliability (errors, retries, tool errors),
  then latency and cost, with maintainability as a judgement. A difference smaller
  than the run-to-run change within one architecture (cases that flip between its
  two runs) is not counted as a difference.
