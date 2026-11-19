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

**Merge rules for `main`:** changes go in only through a pull request, and the
`check` job must pass before the merge button works. No direct pushes to `main`.

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
