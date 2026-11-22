# Single agent vs multi-agent: comparison report

_Fictional — for educational use._

**Question:** would you ship the single support agent, or Copper plus the Refund
agent? This report holds the setup, the four runs exactly as they happened
(including the incomplete one), what was and was not recorded in Langfuse, and
the recommendation. The raw per-run files are in
[`docs/agent-comparison/runs/`](agent-comparison/runs/) and the generated tables
in [`docs/agent-comparison/results.md`](agent-comparison/results.md).

## 1. Objective and experimental setup

| | Single agent | Multi agent (the baseline, unchanged) |
|---|---|---|
| Agents | One support agent | Copper + the Refund agent |
| Tools | Copper's 5 tools + `get_orders`, `request_refund` | Copper: 5 tools + `transfer_to_refund_agent`. Refund agent: `get_orders`, `request_refund`, `transfer_to_copper` |
| Instructions | `SINGLE_AGENT_INSTRUCTIONS`: Copper's instructions + the shared `REFUND_RULES` (3,135 characters) | `COPPER_INSTRUCTIONS` + `COPPER_HANDOFF`; `REFUND_AGENT_INSTRUCTIONS`, which includes the same `REFUND_RULES` (3,364 characters in all) |
| Handoff | None | Copper ⇄ Refund agent |
| Refund decision | `requestRefund` in `lib/copper/orders.ts`, unchanged | the same function |
| Switch | `AGENT_MODE=single`, or `npm run eval -- --agent-mode single` | `AGENT_MODE=multi` (the default) |

Both run through the same `startAskCopper()` (`lib/copper/assistant/run.ts`), the
same tools, the same Langfuse tracing and the same evaluation. The multi-agent
instructions and tool definitions are byte-for-byte what they were; a test checks
their fingerprints. The single agent gets the same step budget per turn as one
agent had before (5 model steps); a refund needs about 3, so the budget decides
no case.

## 2. Fairness controls

Written before the runs (commit `ce68fd1`) and followed as written:

- **Cases:** `golden-v3-neutral` (18 cases), derived from golden-v3 by
  `evals/neutral.ts`. golden-v3 is untouched and still gates pull requests. Nine
  checks in seven cases test the handoff itself (`handoff`, `no_handoff`,
  `final_agent`); a single agent can't pass them by design, so they are removed
  for **both** architectures. Everything else is kept unchanged for both: facts,
  critical flags, and every business check (the app's refund decision per order,
  tools used, the console's final state, no false refund claim, citations,
  internal documents). One removed "no handoff" check is replaced by the outcome it
  stood for ("a policy question doesn't request a refund"). Wording that named the
  handoff now states the same outcome without it.
- **Same everything else:** one model for answering (`google/gemini-3.5-flash-lite`)
  and for judging, the judge at temperature 0, the same rubric (`rubric-v1`),
  thresholds and pass rules, the same starting orders, limit and refunds, tools
  and business rules.
- **Blind judge:** the judge sees "Assistant" for every turn; handoffs and
  `transfer_to_*` calls are left out of what it reads.
- **Conditions:** one case at a time, requests held to 12 a minute (Gemini's free
  tier allows 15), runs one after another. Order: single, multi, multi, single.
  Two runs of each architecture. All four on commit `ce68fd1`, with the same case
  set and rubric.
- **Retries:** the same limited rule for both: only temporary service errors and a
  turn where the model gave no answer at all are run again. A wrong or low-scoring
  answer is never run again.
- **Reporting:** every run is reported, none dropped.

### What did not go to plan

1. **Run 3 was interrupted** by a network or machine outage (see section 7). It
   is kept as it is, as an incomplete run, and was not repeated or replaced.
2. **The Langfuse experiment records were never created** for these four runs, by
   a bug of mine (section 8). The answers, scores and checks are intact in each
   run's results files; Langfuse holds the traces but not the experiments, items
   or scores.
3. **Code changed after the runs**, in tooling only: the Langfuse dataset ids, the
   Langfuse read-back, and the report tools. Nothing that answers, checks, judges
   or scores changed. The four runs are from `ce68fd1`; the pull request head
   differs by those tooling changes.
4. Run 1's files are in `runs/ab-single-1` (I started it by hand); runs 2 to 4 are
   `ab-run2-multi`, `ab-run3-multi` and `ab-run4-single`.

## 3. Per-run results

Runs in the order they were run. Latency is the final attempt of each case; time lost to re-runs shows in the wall-clock.

| Run | Architecture | Run ID | Commit | Passed | Avg judge | Critical | Quality fails | Infra errors | End-to-end s/case | Execution s/case | Model calls/case | Tokens/case | Answering cost | Judge cost | Case re-runs | Judge retries | Wall-clock |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | single | `20261122-0616-ce68fd1-single-ig6a` | `ce68fd1` | 18/18 | 5.00 | 0 | 0 | 0 | 14.0 | 3.3 | 2.22 | 3769 | $0.0410 | $0.0116 | 0 | 0 | 8.4 min |
| 2 | multi | `20261122-0625-ce68fd1-multi-f8yp` | `ce68fd1` | 18/18 | 5.00 | 0 | 0 | 0 | 9.9 | 4.6 | 2.83 | 3367 | $0.0388 | $0.0117 | 0 | 0 | 9.3 min |
| 3 | multi | `20261122-0634-ce68fd1-multi-5fmw` | `ce68fd1` | 16/18 | 5.00 | 0 | 0 | 2 | 14.1 | 8.9 | 2.81 | 3157 | $0.0320 | $0.0102 | 0 | 0 | 571.8 min |
| 4 | single | `20261122-1606-ce68fd1-single-uq8v` | `ce68fd1` | 17/18 | 4.89 | 1 | 1 | 0 | 11.7 | 6.2 | 2.22 | 3637 | $0.0363 | $0.0116 | 0 | 0 | 8.6 min |

## 4. Aggregated performance comparison

2 runs of each architecture. The mean is shown first, then each run in brackets (or the total, then each run). Two runs are not enough for a significance test; treat differences smaller than the change between the two runs of one architecture as noise.

| Metric | Single Agent | Multi Agent |
|---|---|---|
| Runs | 2 | 2 |
| Cases evaluated (all runs) | 36 | 36 |
| Cases with a complete answer, the base of the averages below | 36 (18 / 18) | 34 (18 / 16) |
| Cases passed (all runs) | 35 (18 / 17) | 34 (18 / 16) |
| Pass rate, mean of runs | 97.2% (100.0% / 94.4%) | 94.4% (100.0% / 88.9%) |
| Average judge score (1-5) | 4.94 (5.00 / 4.89) | 5.00 (5.00 / 5.00) |
| Critical violations (cases, all runs) | 1 (0 / 1) | 0 (0 / 0) |
| Quality failures (answered, did not pass) | 1 (0 / 1) | 0 (0 / 0) |
| Infrastructure errors (no valid result) | 0 (0 / 0) | 2 (0 / 2) |
| Average end-to-end latency per case (s), final attempt, as measured | 12.9 (14.0 / 11.7) | 12.0 (9.9 / 14.1) |
| Average execution latency per case (s), without our request-limiter waits | 4.7 (3.3 / 6.2) | 6.7 (4.6 / 8.9) |
| Average model calls per case | 2.22 (2.22 / 2.22) | 2.82 (2.83 / 2.81) |
| Average tokens per case, answering (input + output) | 3703 (3769 / 3637) | 3262 (3367 / 3157) |
| Answering cost per valid case (estimate) | 0.00215 (0.00228 / 0.00202) | 0.00208 (0.00216 / 0.00200) |
| Answering cost, total over valid cases (estimate) | $0.0774 ($0.0410 / $0.0363) | $0.0707 ($0.0388 / $0.0320) |
| Retry count: case re-runs (all runs) | 0 (0 / 0) | 0 (0 / 0) |
| Retry count: judge retries (all runs) | 0 (0 / 0) | 0 (0 / 0) |
| Handoff count (all runs) | 0 (0 / 0) | 18 (9 / 9) |
| Tool execution errors (all runs) | 0 (0 / 0) | 0 (0 / 0) |
| Evaluation wall-clock per run | 8.5 min (8.4 min / 8.6 min) | 290.5 min (9.3 min / 571.8 min) |

| AI judge (apart from answering) | Single Agent | Multi Agent |
|---|---|---|
| Judge tokens per run | 23988 (24022 / 23953) | 22634 (24352 / 20916) |
| Estimated judge cost per run | $0.0116 ($0.0116 / $0.0116) | $0.0110 ($0.0117 / $0.0102) |

**Two runs per architecture is not a sample that supports a significance test.**
The numbers show what happened in these four runs; differences smaller than the
change between the two runs of one architecture are noise.

### The comparison table

| Metric | Single Agent | Multi Agent |
|---|---|---|
| Runs | 2 | 2 |
| Cases evaluated | 36 scheduled, 36 valid | 36 scheduled, **34 valid** (2 infrastructure errors) |
| Valid sample (n) behind every average below (judge score, latency, model calls, tokens, cost) | n = 36 | n = 34 |
| Excluded from the averages, and why | none | 2 cases: infrastructure errors in run 3 (never graded); not counted as 0 and not counted as wrong answers |
| Pass rate, of valid cases | 97.2% (35/36) | 100% (34/34) |
| Pass rate, scheduled cases (errors count as not passed) | 97.2% | 94.4% |
| Average judge score | 4.94 | 5.00 |
| Critical violations | 1 (a truncated reply, section 5) | 0 |
| Average end-to-end latency per case | 12.9 s | 12.0 s |
| Average execution latency per case (limiter waits removed) | 4.7 s | 6.7 s |
| Average model calls per case | 2.22 | 2.82 |
| Average tokens per case, answering | 3,703 | 3,262 |
| Execution cost per valid case, answering (estimate) | $0.00215 | $0.00208 |
| Retry count: case re-runs recorded in results | 0 | 0 |
| Retry count: judge retries | 0 | 0 |
| Handoff count | 0 | 18 |
| Evaluation wall-clock per run | 8.4 min, 8.6 min | 9.3 min, 571.8 min (run 3 was interrupted) |
| AI judge cost per run, apart from answering (estimate) | $0.0116 | $0.0110 |

The multi-agent wall-clock mean in the generated table above (290.5 minutes) is
almost entirely run 3's outage. The two clean multi-agent and single-agent
evaluations took about the same time (9.3 and 8.4 to 8.6 minutes), and that time is
shaped by the 12-requests-a-minute limiter, so it is not evidence that either
architecture is slower.

## 5. Quality and critical safety results

Quality and safety held in both architectures:

- **Every code check passed in every valid case**: single 110/110, multi 103/103,
  including the app's decision for each order, the Refund Console's final state and
  the "no refund claim the app didn't make" check (14/14 for each architecture).
- **The judge raised no critical-violation flag** in either architecture.
- **All eight refund and safety cases** passed their code checks in every valid run,
  for both architectures (run 4's one judge failure is described next): refunds at, under and over the limit, an unknown order, an
  already-refunded order, a request without an order, "a supervisor already approved
  it", asking Copper to confirm a refund that hadn't happened, and the internal
  documents.

What failed:

- **Single, run 4: `refund-unknown-order`** (quality failure, critical case). The
  answer was right (it couldn't find the order and listed the real ones) but the
  list stopped in the middle of a sentence, after order #1003, and the judge gave 3.
  The trace shows the last model call ended with finish reason `other`: Gemini
  stopped the reply early, the same kind of abnormal ending seen in a no-answer
  case earlier in the project. No refund rule was broken. It counts as a quality
  failure under the protocol because the case was answered and graded; the cause
  looks like the provider, not the architecture, and the same event could hit
  either one.
- **Multi, run 3: two cases ended in an error** (infrastructure, not an answer):
  see section 7.

Like-for-like, over the 16 cases that have a valid result in all four runs:

Cases with a valid result in every one of the 4 runs: **16 of 18** (product-plan-prices, product-total-cost, stock-out-of-stock, docs-error-c47, conflict-recording-retention, notfound-alexa, clarify-refund-no-order, refund-under-limit, refund-at-limit, refund-over-limit, refund-unknown-order, refund-already-processed, handoff-back-to-copper, safety-claimed-approval, safety-fabricated-confirmation, safety-internal-documents). Each architecture's numbers use exactly these cases.

| Like-for-like | Single Agent | Multi Agent |
|---|---|---|
| Case results (cases x runs) | 32 | 32 |
| Passed | 31 (96.9%) | 32 (100.0%) |
| Critical failures | 1 | 0 |
| Average judge score | 4.94 | 5.00 |
| Average end-to-end latency (s) | 12.3 | 12.4 |
| Average execution latency (s), without our limiter's waits | 4.7 | 6.9 |
| Average model calls | 2.25 | 2.88 |
| Average tokens (input + output) | 3738 | 3288 |
| Answering cost over these cases (estimate) | $0.0682 | $0.0671 |
| Handoffs | 0 | 18 |

The difference in pass rate (31/32 against 32/32) is **one case**. It is not
evidence that either architecture is better.

## 6. Latency, token usage and cost

- **End-to-end latency** per case is about the same (12.9 s against 12.0 s; 12.3 s
  against 12.4 s on the 16 complete cases). It is measured per case, final attempt,
  and includes waits for our own request limiter.
- **Execution latency** removes only the limiter's waits, which are measured per
  turn. It is 4.7 s for single and 6.7 s for multi, but each architecture's own two
  runs differ by 2.9 s (single: 3.3 and 6.2) and 4.3 s (multi: 4.6 and 8.9), so the
  gap between architectures is smaller than the change between runs of the same
  one. Gemini's response time varied with its load, and run 3 ran through the
  outage. **Latency is not a reason to prefer either architecture from this data.**
  The rate-limit waits are not evidence that multi is slower, and they are not
  hidden: they are part of end-to-end latency and listed per run.
- **Model calls** are the one steady difference: 2.22 per case for single in both
  runs, 2.83 and 2.81 for multi. A handoff costs about one extra call.
- **Tokens** go the other way: 3,703 per case for single, 3,262 for multi (3,769 /
  3,637 against 3,367 / 3,157). Each call of the single agent carries the longer
  instructions and all seven tool definitions; each multi-agent call carries only
  its own agent's.
- **Cost** is almost the same: $0.00215 per answered case for single and $0.00208
  for multi, about 3% lower. Cost is an estimate (tokens the model reported times
  Google's list prices), and it counts valid cases only.
- **The AI judge's cost is separate** and about the same for both ($0.0116 and
  $0.0110 per run); it is not part of the answering cost.

| Run | Architecture | Observed answering cost (valid cases) | Valid cases | Retry waste (earlier attempts, Langfuse) | Unconfirmed: usage seen on errored cases (lower bound) | Judge cost (separate) |
|---|---|---|---|---|---|---|
| 1 | single | $0.0410 | 18 | $0.0000 | none | $0.0116 |
| 2 | multi | $0.0388 | 18 | $0.0000 | none | $0.0117 |
| 3 | multi | $0.0320 | 16 | $0.0000 | 2 later attempt(s) traced in Langfuse, never graded: 5994 tokens, $0.0040; 2 earlier attempt(s) with no trace: use unknown | $0.0102 |
| 4 | single | $0.0363 | 18 | $0.0000 | none | $0.0116 |

Retry waste counts only attempts whose traces Langfuse still holds. Tokens are what the model reported; cost is an estimate from list prices. These three columns are different things and are not summed.

## 7. Retry and reliability analysis

Four things are counted apart, because they are not the same:

| Kind | What it is | Single | Multi |
|---|---|---|---|
| Quality failure | The case was answered and graded, and did not pass | 1 (run 4) | 0 |
| Gemini service abnormality | The model ended abnormally (finish reason `other`) | 1 found (run 4, the truncated reply above) | not checked: finish reasons were read only for the failed case |
| Infrastructure error | No valid result: the case timed out or the service or network failed | 0 | 2 (run 3) |
| Case re-run / judge retry | A case run again, or the judge asked again, after a temporary error | 0 / 0 | 0 / 0 recorded in results |

| Run | Architecture | Exit | Valid cases | Errors (infrastructure) | Quality failures | Case re-runs | Judge retries | Complete run? |
|---|---|---|---|---|---|---|---|---|
| 1 | single | 0 | 18/18 | 0 | 0 | 0 | 0 | yes |
| 2 | multi | 0 | 18/18 | 0 | 0 | 0 | 0 | yes |
| 3 | multi | 2 | 16/18 | 2 | 0 | 0 | 0 | NO: incomplete |
| 4 | single | 1 | 18/18 | 0 | 1 | 0 | 0 | yes |

**Run 3** started at 06:34Z and ended at 16:06Z (572 minutes). The log shows
`ENOTFOUND us.cloud.langfuse.com` and two cases hitting the evaluation's own
540-second timeout, so the machine or its network was cut off for hours; the data
does not prove which. The two cases (`docs-return-window`,
`docs-annual-refund-policy`) were recorded as infrastructure errors. Langfuse
holds a trace for a **second attempt** of each that did finish with an answer
(attempt 1 has no trace), but the evaluation had already recorded the case as an
error, so those answers were **never graded and are not in any number here**. The
run stays incomplete (exit code 2); it was not repeated.

| Run | Architecture | Case re-runs (results.json) | Earlier attempts traced: no answer / error | Model calls in them | Tokens in them | Cost of them (estimate) | Earlier attempts with NO trace (use unknown) | Judge retries |
|---|---|---|---|---|---|---|---|---|
| 1 | single | 0 | 0 / 0 (of 0) | 0 | 0 | $0.0000 | 0 | 0 (reason not recorded) |
| 2 | multi | 0 | 0 / 0 (of 0) | 0 | 0 | $0.0000 | 0 | 0 (reason not recorded) |
| 3 | multi | 0 | 0 / 0 (of 0) | 0 | 0 | $0.0000 | 2 | 0 (reason not recorded) |
| 4 | single | 0 | 0 / 0 (of 0) | 0 | 0 | $0.0000 | 0 | 0 (reason not recorded) |

- Run 3 (multi), **docs-annual-refund-policy**: attempt 1 has no trace, then attempt 2 answered. The case is recorded as an infrastructure error (docs-annual-refund-policy timed out after 540s), so a later attempt that did finish was never graded or counted
- Run 3 (multi), **docs-return-window**: attempt 1 has no trace, then attempt 2 answered. The case is recorded as an infrastructure error (docs-return-window timed out after 540s), so a later attempt that did finish was never graded or counted

What this means for the comparison:

- **The samples are not symmetric:** single has 36 valid cases, multi 34. The two
  missing multi cases are missing for an outside reason, not because of anything
  multi did, but they cannot be assumed to have passed.
- **The retries recorded in results are zero in all four runs.** The only retries
  that happened were the two background attempts above, which were not recorded as
  results. Retry cost is therefore not zero in run 3: the two later attempts used
  5,994 tokens (about $0.0040, from Langfuse, ungraded) and the two earlier
  attempts have no trace, so their use is **unknown**.
- **Not measured at all:** why the judge was retried (it never was in these runs),
  how many times the evaluation's own limiter met a 429, and the AI SDK's quick
  retries inside one model call.
- **Sample sizes and what was excluded:**

| Effective sample (cases) | Single Agent | Multi Agent |
|---|---|---|
| Scheduled (18 per run) | 36 | 36 |
| Valid: answered and graded (pass rate, judge score, critical violations) | 36 | 34 |
| Valid: complete answer (latency, model calls, tokens, tool counts, handoffs) | 36 | 34 |
| Valid: complete answer with a known cost (answering cost) | 36 | 34 |
| Missing: ended in an error (infrastructure), excluded from every average | 0 of 36 (0.0%) | 2 of 36 (5.6%) |

A case that ended in an error is excluded from averages and counted here; it is never treated as 0 and never counted as a wrong answer.

| Run | Architecture | Case | Kind | Message | Attempts |
|---|---|---|---|---|---|
| 3 | multi | docs-return-window | timeout | docs-return-window timed out after 540s | 1 |
| 3 | multi | docs-annual-refund-policy | timeout | docs-annual-refund-policy timed out after 540s | 1 |

## 8. Langfuse records: what exists and what does not

Checked after the runs with the Langfuse API, one request at a time and within its
rate limit, asking separately about traces, the experiment, its items and the
scores. A failed query was kept apart from missing data, and a failure says why:
**rate limit** (HTTP 429, with the wait Langfuse asks for), **bad query** (HTTP 400,
404 or 422), **not authorized** (401 or 403), **Langfuse server error** (5xx) or
**network** (the connection never reached Langfuse). A 429 is waited out as told and a
dead connection is tried again a few times, with a growing wait; only a question
that was answered and returned nothing is called "missing". The verification was
run twice, before and after these safeguards, with the same result.

| Run | Traces | Experiment | Experiment items | Scores |
|---|---|---|---|---|
| 1 single | present (18/18) | missing | missing | missing |
| 2 multi | present (18/18) | missing | missing | missing |
| 3 multi | present (16/16 with a result) | missing | missing | missing |
| 4 single | present (18/18) | missing | missing | missing |

"Missing" means the query worked and the data is not there. **The cause was my own
bug**: Langfuse dataset item ids are unique across the whole project, and I gave
the architecture-neutral dataset the same ids as the original one, so creating its
items answered HTTP 409, the experiment never started, and the cases ran without
it. The error text was then overwritten by the read-back result, so the result
files only said "0 of 18 experiment items were found". The earlier read-back also
asked Langfuse faster than its limit (30 requests a minute) and swallowed the
errors.

Fixed after the runs: neutral dataset items get their own ids (the neutral dataset
now holds its 18 items), a failed sync or experiment is reported at once and kept,
and the read-back is rate-limit aware and says "query failed" apart from "missing".
The runs were **not** repeated and **no scores were added to Langfuse afterwards**.

- **Can be checked from the traces in Langfuse:** each case's answer, agents,
  model calls, tools, handoffs, tokens and cost, tagged with the run id, case id
  and `arch:single` or `arch:multi`.
- **Can be checked only from the saved result files** (`results.json`, `.csv`):
  judge scores and reasons, code checks, pass and fail, and the per-case totals.
- **Cannot be checked in Langfuse:** the experiment, its items, the scores, and the
  judge's own traces for these four runs. There is no Langfuse experiment link for
  Part 4. The original-dataset evaluation, which gates pull requests, did record
  and read back an experiment with its scores (see the pull request for Part 3).

## 9. Maintainability analysis

What the code shows (the line counts only help; they are not the judgement):

- **Agents and instructions.** Multi has two agents and three instruction blocks
  (Copper, the handoff paragraph, the Refund agent), single has one block. The
  refund wording is written once (`REFUND_RULES`) and used by both, so it isn't
  duplicated.
- **Tools and duplicated logic.** The two refund tools exist once (`refundTools`)
  and both architectures use them; the refund rule is one function
  (`requestRefund`). Multi adds only the two handoff tools. No business logic is
  copied in either design.
- **What a handoff adds.** In `run.ts` the handoff tools, the stop rule, the loop
  with a cap (`MAX_HANDOFFS`) and the "who answers next" state; in the chat panel
  the active agent travels with each message; the Refund Console's notes must
  reach the Refund agent; tracing gets a handoff event and two agents to read.
  Counting lines that mention the two-agent arrangement: `run.ts` 23,
  `ask-copper.tsx` 21, `trace.ts` 17, `progress.ts` 9, `tools.ts` 8. The golden set
  needed nine handoff checks that a single agent can't have.
- **Failure points.** A handoff can route wrongly (a policy question taken for a
  refund request), loop, or hand back too soon; the cap and the instructions guard
  against it. **In these runs there were 18 handoffs and no handoff error or tool
  error**, so this is a risk the design carries, not one the data showed.
- **Debugging and Langfuse.** A single-agent trace is one agent with its model
  calls and tools. A multi-agent trace shows who held which tool and where the
  conversation changed hands, which helps when a refund goes wrong, at the price of
  two agents and a handoff event to read.
- **Changing the refund rule.** The amount rule: one function, for both. The
  wording of what to tell the customer: `REFUND_RULES`, for both. Multi alone also
  has the routing paragraph, the transfer lines, and the handoff checks in the
  golden set to keep in step.
- **Adding support features.** In single, add a tool and a few lines to the one
  prompt, until the prompt and the tool list (carried on every call, which already
  costs tokens) grow too big for one agent to follow. In multi, add a specialist
  agent with its own tools, but also handoff tools to and from it, routing text,
  agent state, labels and checks; the wiring grows with the number of agents.
- **Least privilege (a design reason, not measured here).** In multi, the agent that
  reads documents and answers product questions has no refund tool. In single, one
  agent reads documents and can request refunds, so text it reads shares a context
  with the refund tool. The app still decides every refund in code, but a
  request for an order under the limit is refunded automatically. The golden set's
  three safety cases passed in both architectures; no wider attack test was run.

## 10. Limitations

- **Two runs per architecture, 18 cases, one judge model.** Nothing here is
  statistically significant. A single failed case moves the pass rate by 5.6
  points per run.
- **Run 3 is incomplete** and the samples are not symmetric (36 valid cases against
  34); two answers that finished in the background were never graded.
- **The model and the judge are the same Gemini model**, so the judge may share the
  assistant's blind spots. All judge scores but one were 5.
- **Gemini's behaviour changes with its load** (a truncated reply, no-answer turns,
  "high demand"), and the free tier's limit shaped the pace; latency is the least
  reliable number.
- **Cost is an estimate** from list prices and reported tokens, over valid cases
  only; the use of the two unrecorded attempts in run 3 is unknown.
- **No Langfuse experiment or scores exist for these four runs** (section 8).
- **The neutral set drops nine handoff checks**, so how well multi hands off is
  only covered by golden-v3, which was not part of this comparison.
- **The safety comparison is thin:** three safety cases and no adversarial test.

## 11. Final recommendation: which would you ship?

**I would ship the multi-agent architecture, and keep the single agent as the
simplification to revisit, because these runs do not show that either one answers
better, and the decision then comes down to risk around refunds.** Quality is
level: refund decisions and every safety check passed in every valid case for both
(single 110/110 checks, multi 103/103, no false refund claim in either), and the
single agent's one failure was a reply that Gemini cut short, not a broken rule,
while multi's two errors were an outage and left two cases ungraded, so the data
cannot say multi is better. Cost is a tie ($0.00215 against $0.00208 per answered
case; multi makes 27% more model calls but sends 12% fewer tokens), and latency
shows no difference beyond run-to-run noise, so neither cost nor speed justifies
changing what already works. What is left is that the multi-agent design keeps the
refund tools away from the agent that reads documents, which is the safer shape for
money, and its handoffs ran 18 times without an error. Single's real advantage is
simplicity: one prompt, no routing, shorter traces; that would matter more if
support grew into many specialists, and it is cheap to reconsider because both
modes run from the same code (`AGENT_MODE`). I would change my answer if a larger
evaluation (more runs, more safety cases) showed multi's extra model calls causing
more failures, or if the handoff plumbing became a maintenance burden.

This rests on two runs each, a run that was interrupted, one judge and 18 cases,
so it is a judgement, not a proof.

## Reproduce

```bash
npm run eval -- --agent-mode single --set neutral --concurrency 1 --verify --out eval-results/single
npm run eval -- --agent-mode multi  --set neutral --concurrency 1 --verify --out eval-results/multi
npm run collect-retries -- eval-results/single eval-results/multi   # every attempt, from Langfuse
npm run verify-langfuse -- eval-results/single eval-results/multi   # traces, experiments, items, scores
npm run build-comparison -- --runs eval-results/single,eval-results/multi
```

Run them one after another: the free Gemini tier cannot serve two evaluations at
once.
