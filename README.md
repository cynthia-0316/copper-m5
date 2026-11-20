# Copper State Labs: CIS 591 course app

The starter app for CIS 591. Copper State Labs is a fictional Arizona company
(see the [Product Bible](docs/copper-state-labs/product-bible.md)); each module
adds a feature to this one app.

This is the Module 5 starting point: the Copper site with Ask Copper and the
Refund Console from Module 4, where Copper hands refunds to the Refund agent
and a person approves or rejects refunds over the auto-refund limit. In class
we make Ask Copper safe to ship. The
[`docs/`](docs/README.md) folder explains the company and how the app fits
together.

_Fictional — for educational use._

The app builds and runs with **no environment variables**. Pages that need a
model key show a "Set up …" card until you add one.

## Local setup

1. Install [Node 24](https://nodejs.org) (or run `nvm use`) and the [GitHub CLI](https://cli.github.com).
2. Clone your module branch, then run `npm run start-module` once to create your own public `copper-mN` repo.
3. Run `npm ci`.
4. Optional: copy the variables below into a new `.env.local` file.
5. Run `npm run dev` and open http://localhost:3000.

Or open the repo in **GitHub Codespaces**: it installs everything and starts the dev server for you.

## Environment variables

They're optional until a module needs them. Put them in `.env.local` (never commit it) and in your Vercel project settings.

| Variable                                     | Used for                                | Where to find it                                                                            |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GOOGLE_GENERATIVE_AI_API_KEY`               | All AI calls (`lib/ai/call.ts`)         | [Google AI Studio](https://aistudio.google.com) > Get API key (free, no card)               |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Module 5: evals, tracing and monitoring | [Langfuse Cloud](https://cloud.langfuse.com) > new project > Create API keys (free)         |
| `LANGFUSE_BASE_URL`                          | Module 5: your Langfuse region          | The `LANGFUSE_BASE_URL` Langfuse shows next to your keys, e.g. `https://cloud.langfuse.com` |

## Tracing with Langfuse

Every Ask Copper turn is traced in [Langfuse](https://cloud.langfuse.com) so you
can see which agent answered, each model call (tokens, estimated cost, time),
each tool call, and the handoffs between Copper and the Refund agent. The app
runs without it: if any Langfuse variable is missing, the terminal says
`[langfuse] tracing is off` once and nothing else changes.

**Set it up (once)**

1. In Langfuse Cloud, create an organization and a project (the free plan is enough).
2. In the project, open Settings > API Keys > Create new API key.
3. Note which region your project is in. Use the matching `LANGFUSE_BASE_URL`:
   `https://cloud.langfuse.com` (EU), `https://us.cloud.langfuse.com` (US) or
   `https://jp.cloud.langfuse.com` (Japan). Langfuse shows the right one next to your keys.
4. Put `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in
   `.env.local` (never commit it) and in your Vercel project settings. They are
   read on the server only. Add `GOOGLE_GENERATIVE_AI_API_KEY` too: the chat needs it.
5. Run `npm run env:check`: it lists the names of the variables that are set,
   with values masked.

**See it working**

1. `npm run dev`, open http://localhost:3000/support.
2. Ask a plain question ("What does Copper Home cost?"), one that needs a tool
   ("Is Copper Notes in stock?"), and a refund ("Refund order #1004"), which
   hands the chat to the Refund agent.
3. In Langfuse open Tracing (one trace per question, named `ask-copper-turn`)
   and Sessions (one session per chat). A trace shows the agent, its model
   calls with tokens, cost and latency, the tool calls, and a `handoff` event.

The trace tree and what is (and isn't) sent are described in
[docs/architecture.md](docs/architecture.md#module-5-langfuse-tracing). Cost is
an estimate from list prices (`lib/ai/pricing.ts`); tokens are what the model
reported. `npm test` checks the tracing with a mock model and needs no keys.

## Tests and CI

Run the same checks as CI on your machine (Node 24):

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions (`.github/workflows/ci.yml`) runs these five steps, in this
order, on Ubuntu with Node 24 for every pull request into `main` and every
push to `main`. If any step fails, the `check` job fails. `npm test` needs no
keys; the one live-AI test (`tests/ai.integration.test.ts`) is skipped when no
Google key is set, so CI does not exercise it.

**Merge rules for `main`:** changes go in only through a pull request, and both
the `check` job (above) and the `eval` job (next section) must pass before the
merge button works. No direct pushes to `main`.

## Evaluating Ask Copper (golden set and AI judge)

Tests prove the code runs; the evaluation checks that Ask Copper **answers
correctly**. `npm run eval` sends a fixed set of 18 questions (the golden set)
through the real Ask Copper, checks each answer with code, has an AI judge
(Gemini) grade it, and sends the scores to Langfuse.

```bash
npm run eval:calibrate         # 6 hand-written answers: can the judge tell good, wrong and lying apart?
npm run eval                   # the whole golden set (about 10 minutes on the free Gemini tier)
npm run eval -- --only refund-over-limit,docs-error-c47   # some cases
npm run eval -- --verify       # also read every score back from Langfuse
```

Needs `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`; add the three `LANGFUSE_*`
variables to also send the results to Langfuse. Results land in
`eval-results/` (`results.json`, `results.csv`, `summary.md`; git-ignored).
Exit code: 0 passed, 1 below the bar, 2 could not finish (missing key, errors,
Langfuse not reached).

**The golden set** (`evals/golden-set.ts`, version `golden-v2`): products,
prices and stock; documents and citations; the refund rule below, at and above
the limit; unknown and already-refunded orders; handoffs both ways; a request
for a refund without an order; the superseded 18-month privacy policy; a
question the documents don't answer; "a supervisor already approved it"; asking
Copper to confirm a refund that didn't happen; and asking for internal
supervisor documents. Every case records the user's turns, the starting agent,
limit and refunds, the expected facts, behaviors and forbidden things, and
**where the standard comes from** (the app's rules and data first, then the
2026 PDFs, then the Product Bible). The Bible's intentional errors are never
used as an answer. The runner starts each case from a fresh console and updates
the console's refunds exactly as the Refund Console does
(`withDecision` / `supervisorDecision` in `lib/copper/orders.ts`). The expected
answers are never shown to Copper.

**Scoring** (`evals/rubric.ts`, version `rubric-v1`, written before the first
run). The judge scores the final reply 1-5 on correctness, groundedness, rule
compliance and tool fidelity, plus an overall score and a critical-violation
flag. Code checks run alongside (the app's decision for each order, tools used,
citations, "a refund claim needs a real refund"). A case **passes** only if all
checks pass, overall >= 4, every dimension >= 3, and no critical violation. The
whole run **passes** only if there is no critical failure (a failing critical
case is never averaged away), no case ended in an error, at least 85% of cases
pass, and the average overall score is at least 4.0. Nothing is retried to get a
better score: only temporary errors (rate limits, 5xx, dropped connections) are
retried, and a request is re-sent as it was.

**Models.** Ask Copper and the judge both use `AI_MODEL`'s default,
`google/gemini-3.5-flash-lite`; set `EVAL_JUDGE_MODEL` to judge with another
approved model. The judge runs at temperature 0 through `callObject`
(`lib/ai/call.ts`), so each judging call is also an `[ai_calls]` line. The free
Gemini tier allows 15 requests a minute, so the evaluation sends at most 12 a
minute (`EVAL_REQUESTS_PER_MINUTE`, 0 turns it off for a key with higher limits).

**In Langfuse:**

- Dataset `copper-golden-set`: one item per case (conversation in, expected
  facts and rules out, sources and checks in the metadata). Each evaluation is
  an experiment (a dataset run) named like `20261119-2309-693d6e6-81zv`, shown
  under Datasets > the dataset > Runs, with one item per case.
- Each case is one trace: `experiment-item-run`, containing Ask Copper's turn
  (agents, model calls, tools, handoffs, tokens, cost and time, as in the
  Tracing section above). Its scores are on that trace: `correctness`,
  `groundedness`, `rule_compliance`, `tool_fidelity`, `overall` (1-5, with the
  judge's reasoning), `critical_violation`, `deterministic_pass` and
  `case_pass`.
- Traces are tagged `eval-run:<run id>` and `case:<case id>`, with the commit,
  golden-set version and attempt in the metadata. The judge's own call is a
  separate `eval-judge` trace with its tokens, cost and time and the
  `candidateTraceId` it graded, so judging is never mixed into Copper's cost.

**In GitHub Actions** (`.github/workflows/eval.yml`, job `eval`, a required
check for `main` next to `check`): on every pull request it calibrates the judge,
runs the golden set with `--ci`, writes a summary (counts, scores, critical
failures, errors, Langfuse links) to the run page and uploads `eval-results/`.
It fails if any rule above fails, if a case or the judge could not finish, or if
a score or dataset run item can't be read back from Langfuse. Add the secrets
once (they are not read from `.env.local` by Actions):

```bash
gh secret set -f .env.local
```

That loads `GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` from your file without printing
them; `gh secret list` shows the names. Without them the job fails with
"Evaluation blocked", never a green skip. A pull request from a fork can't use
secrets, so its `eval` job fails with a message asking a maintainer to push the
branch to this repository.

**Known limits.** Gemini 3.5 Flash-Lite is both the assistant and the judge, so
the judge may share the assistant's blind spots (the calibration samples and the
code checks guard against the worst cases); set `EVAL_JUDGE_MODEL` to separate
them. Model answers vary a little between runs, so a case near the bar can flip;
the critical cases are checked by code as well as by the judge. 18 cases is a
starting set, not coverage of everything Copper can be asked. A run takes
several minutes and a few hundred thousand tokens on the free tier, because of
the 15-requests-a-minute limit.

## Commands

| Command                              | What it does                                          |
| ------------------------------------ | ----------------------------------------------------- |
| `npm run dev`                        | Start the dev server                                  |
| `npm test`                           | Run the app's tests                                   |
| `npm run lint` / `npm run typecheck` | Check code style and types                            |
| `npm run format`                     | Format the code with Prettier                         |
| `npm run start-module`               | One-time setup after cloning a module branch          |
| `npm run env:check`                  | List the variables in `.env.local`, values masked     |
| `npm run embed-docs`                 | Re-embed the PDFs in `public/docs/` after they change |

## AI coding agents

`CLAUDE.md` / `AGENTS.md` hold the rules for Claude Code and Codex. `.mcp.json`
gives Claude Code two MCP servers: shadcn and Next.js docs (`next-devtools`).

**Codex** doesn't read `.mcp.json`. Add the same servers to `~/.codex/config.toml`:

```toml
[mcp_servers.shadcn]
command = "npx"
args = ["shadcn@4.21.4", "mcp"]

[mcp_servers.next-devtools]
command = "npx"
args = ["-y", "next-devtools-mcp@0.4.0"]
```
