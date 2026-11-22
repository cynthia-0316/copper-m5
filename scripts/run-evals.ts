// npm run eval: runs the golden set through the real Ask Copper, checks and
// judges each answer, sends the scores to Langfuse and writes the results to
// eval-results/. The exit code is what CI looks at:
//   0 = passed, 1 = quality below the bar (a failed or critical case),
//   2 = could not finish (a missing key, errors, Langfuse not reached).
// Flags: --only id,id   --concurrency N   --out dir   --calibrate   --no-langfuse
//   --agent-mode single|multi   which architecture answers (AGENT_MODE, else multi)
//   --set original|neutral      golden-v3, or golden-v3-neutral (no handoff
//                               checks) for comparing the two architectures
//   --verify   (read every score back from Langfuse)
//   --ci       (Langfuse is required, and everything is read back from it)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { calibrate } from "@/evals/calibration";
import { evaluateCase, summarize, type CaseResult } from "@/evals/evaluate";
import {
  GOLDEN_SET,
  GOLDEN_SET_VERSION,
  type GoldenCase,
} from "@/evals/golden-set";
import { judgeCase, judgeModel } from "@/evals/judge";
import { NEUTRAL_SET, NEUTRAL_VERSION } from "@/evals/neutral";
import { agentMode, parseAgentMode } from "@/lib/copper/assistant/mode";
import {
  readBack,
  DATASET_NAME,
  evaluationsFor,
  flushLangfuse,
  openLangfuse,
  projectId,
  recordJudgeTrace,
  syncDataset,
} from "@/evals/langfuse";
import { writeReport, type RunInfo } from "@/evals/report";
import { RUBRIC_VERSION } from "@/evals/rubric";
import { enableModelThrottle } from "@/evals/throttle";
import { isAiConfigured } from "@/lib/ai/call";
import {
  ensureTracing,
  langfuseConfig,
  registerTracingGlobally,
} from "@/lib/ai/langfuse";
import { defaultModel } from "@/lib/ai/models";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const CI = flag("ci");
const OUT = option("out") ?? "eval-results";
const CONCURRENCY = Math.max(1, Number(option("concurrency") ?? 2));
/** A case that takes longer than this is reported as an error, not waited on. */
const CASE_TIMEOUT_MS = 540_000;

function blocked(message: string): never {
  console.error(`\nEVALUATION BLOCKED: ${message}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Golden-set evaluation: ⚠️ BLOCKED\n\n${message}\n`,
    );
  process.exit(2);
}

function commit() {
  if (process.env.EVAL_COMMIT) return process.env.EVAL_COMMIT;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function main() {
  if (!isAiConfigured())
    blocked(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set, so Ask Copper and the judge cannot run.",
    );

  // Stay under the model's requests-per-minute limit (evals/throttle.ts).
  enableModelThrottle();

  if (flag("calibrate")) {
    console.log(
      `Calibrating the judge (${judgeModel()}) on hand-written answers...`,
    );
    const results = await calibrate();
    for (const r of results)
      console.log(
        `${r.ok ? "ok  " : "FAIL"} ${r.id}: overall ${r.judge.verdict.overall}, critical=${r.judge.verdict.criticalViolation} (${r.describe})${r.problem ? ` -> ${r.problem}` : ""}`,
      );
    const bad = results.filter((r) => !r.ok);
    if (bad.length) {
      console.error(
        `\n${bad.length} calibration sample(s) were not graded as they should be.`,
      );
      process.exit(1);
    }
    console.log(
      "\nThe judge separated good, wrong and lying answers as expected.",
    );
    return;
  }

  const wantLangfuse = !flag("no-langfuse");
  if (CI && !langfuseConfig().config)
    blocked(
      `Langfuse is not configured (missing: ${langfuseConfig().missing.join(", ")}). Set these as repository secrets.`,
    );
  const tracing = wantLangfuse && ensureTracing();
  const lf = tracing ? openLangfuse() : undefined;

  // Which architecture answers, and which set of cases is asked.
  const requestedMode = option("agent-mode");
  const mode =
    requestedMode === undefined ? agentMode() : parseAgentMode(requestedMode);
  if (!mode) blocked(`--agent-mode must be "single" or "multi"`);
  const setName = option("set") ?? "original";
  if (setName !== "original" && setName !== "neutral")
    blocked(`--set must be "original" or "neutral"`);
  const neutral = setName === "neutral";
  const setCases = neutral ? NEUTRAL_SET : GOLDEN_SET;
  const setVersion = neutral ? NEUTRAL_VERSION : GOLDEN_SET_VERSION;
  const datasetName = neutral ? `${DATASET_NAME}-neutral` : DATASET_NAME;

  const only = option("only")?.split(",");
  const cases = only ? setCases.filter((c) => only.includes(c.id)) : setCases;
  if (only && cases.length !== only.length)
    blocked(
      `unknown case id in --only: ${only.filter((id) => !cases.some((c) => c.id === id)).join(", ")}`,
    );

  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 13)
    .replace("T", "-");
  const sha = commit();
  const meta = {
    agentMode: mode,
    runId: `${stamp}-${sha.slice(0, 7)}-${mode}-${Math.random().toString(36).slice(2, 6)}`,
    commit: sha,
    goldenSetVersion: setVersion,
  };
  console.log(
    `Evaluating ${cases.length} case(s): run ${meta.runId}, ${mode}-agent, ${setVersion}, ${RUBRIC_VERSION}, Ask Copper ${defaultModel()}, judge ${judgeModel()}, concurrency ${CONCURRENCY}` +
      (lf ? ", Langfuse on" : ", Langfuse off"),
  );

  /** One case: run it, check it, judge it. Never throws. */
  async function runOne(testCase: GoldenCase): Promise<CaseResult> {
    let result: CaseResult;
    try {
      result = await withTimeout(
        evaluateCase(
          testCase,
          meta,
          // Comparing architectures: the judge must not be able to tell them
          // apart, so it sees "Assistant" and no handoff plumbing.
          neutral
            ? {
                judge: (c, r) => judgeCase(c, r, undefined, { blind: true }),
              }
            : {},
        ),
        CASE_TIMEOUT_MS,
        testCase.id,
      );
    } catch (error) {
      result = {
        caseId: testCase.id,
        title: testCase.title,
        category: testCase.category,
        critical: testCase.critical,
        status: "error",
        criticalFailure: false,
        failures: [errorMessage(error)],
        attempts: 1,
        checks: [],
        error: errorMessage(error),
        turns: [],
        candidate: {
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          latencyMs: 0,
        },
      };
    }
    const v = result.judge?.verdict;
    console.log(
      `${result.status === "passed" ? "PASS " : result.status === "failed" ? "FAIL " : "ERROR"} ${result.caseId}` +
        (v ? `  overall ${v.overall}` : "") +
        (result.status === "passed"
          ? ""
          : `\n      ${result.failures.join("\n      ")}`),
    );
    return result;
  }

  const byId = new Map<string, CaseResult>();
  const langfuse: RunInfo["langfuse"] = {
    enabled: Boolean(lf),
    complete: false,
    detail: lf
      ? ""
      : wantLangfuse
        ? "Langfuse is not configured"
        : "turned off with --no-langfuse",
  };

  if (lf) {
    // Langfuse's experiment runner needs the global provider; with it, each
    // case's Ask Copper turns are recorded inside the experiment item's trace.
    registerTracingGlobally();
    try {
      await syncDataset(lf, RUBRIC_VERSION, setCases, datasetName, setVersion);
      const dataset = await lf.client.dataset.get(datasetName);
      // Items are matched by the case id kept in their metadata: their own ids
      // carry the dataset name (see datasetItemId in evals/langfuse.ts).
      const wanted = new Set(cases.map((c) => c.id));
      const items = dataset.items.filter((item) =>
        wanted.has(
          (item.metadata as { caseId?: string } | undefined)?.caseId ?? item.id,
        ),
      );
      if (items.length !== cases.length)
        lf.problems.push(
          `the dataset has ${items.length} of the ${cases.length} cases`,
        );
      const experiment = await lf.client.experiment.run({
        name: `Ask Copper ${mode}-agent (${setVersion})`,
        runName: meta.runId,
        description: `${mode}-agent, golden set ${setVersion}, rubric ${RUBRIC_VERSION}, on commit ${meta.commit.slice(0, 7)}`,
        metadata: {
          agentMode: mode,
          commit: meta.commit,
          goldenSetVersion: setVersion,
          rubricVersion: RUBRIC_VERSION,
          candidateModel: defaultModel(),
          judgeModel: judgeModel(),
        },
        data: items,
        maxConcurrency: CONCURRENCY,
        task: async (item) => {
          const testCase = cases.find(
            (c) =>
              c.id ===
              (item.metadata as { caseId?: string } | undefined)?.caseId,
          )!;
          const result = await runOne(testCase);
          byId.set(testCase.id, result);
          // What Langfuse shows as the item's output: the replies and verdict.
          return {
            caseId: result.caseId,
            status: result.status,
            replies: result.turns.map((t) => ({
              agent: t.agent,
              reply: t.reply,
            })),
          };
        },
        evaluators: [
          async ({ output }) => {
            const result = byId.get((output as { caseId: string }).caseId);
            if (!result) return [];
            // The judge's own call is its own trace; the scores go on the
            // case's trace (Ask Copper's), which holds the agents and tools.
            recordJudgeTrace(result, meta, RUBRIC_VERSION);
            return evaluationsFor(result, meta, RUBRIC_VERSION);
          },
        ],
      });
      langfuse.experimentUrl = experiment.experimentUrl;
      langfuse.datasetRunId = experiment.datasetRunId;
    } catch (error) {
      // Say it now, and keep it: without the experiment, the cases below run
      // without Langfuse experiment items or scores.
      console.warn(
        "[langfuse] the experiment could not be recorded; cases run without it:",
        errorMessage(error),
      );
      lf.problems.push(`experiment: ${errorMessage(error)}`);
    }
  }
  // Without Langfuse, or for any case it didn't run, run the rest here.
  const rest = cases.filter((c) => !byId.has(c.id));
  let next = 0;
  async function worker() {
    for (;;) {
      const testCase = rest[next++];
      if (!testCase) return;
      byId.set(testCase.id, await runOne(testCase));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const results = cases.map((c) => byId.get(c.id)!);

  // Everything must reach Langfuse before the run counts as complete.
  if (lf) {
    const sent = await flushLangfuse(lf);
    langfuse.projectId = await projectId();
    langfuse.baseUrl = langfuseConfig().config?.baseUrl.replace(/\/$/, "");
    if (!sent) langfuse.detail = "sending traces or scores failed";
    if (lf.problems.length) langfuse.detail = lf.problems.join("; ");
    if (CI || flag("verify")) {
      // Read it all back: a score that was sent but isn't there means the
      // Langfuse record is incomplete.
      const traceIds = results.flatMap((r) =>
        r.finalTraceId ? [r.finalTraceId] : [],
      );
      const expected = results
        .filter((r) => r.finalTraceId)
        .reduce(
          (n, r) => n + evaluationsFor(r, meta, RUBRIC_VERSION).length,
          0,
        );
      const want = { scores: expected, items: traceIds.length };
      const found = await readBack(meta.runId, traceIds, want, {
        since: now.toISOString(),
      });
      langfuse.complete =
        sent &&
        lf.problems.length === 0 &&
        !found.error &&
        found.scores >= want.scores &&
        found.items >= want.items;
      // What was recorded while running (lf.problems) stays in the detail: the
      // read-back adds to it, never replaces it.
      const readback = found.error
        ? `the read-back query FAILED (${found.errorKind ?? "other"}), so this says nothing about whether the data is there: ${found.error}`
        : found.items < want.items
          ? `${found.items} of ${want.items} experiment items were MISSING from Langfuse after waiting`
          : found.scores < want.scores
            ? `${found.scores} of ${want.scores} scores were MISSING from Langfuse after waiting`
            : `${found.items} experiment items and ${found.scores} scores read back`;
      langfuse.detail = [...lf.problems, readback].join(" | ");
    } else {
      langfuse.complete = sent && lf.problems.length === 0;
      if (langfuse.complete) langfuse.detail = "traces and scores sent";
    }
  }

  const summary = summarize(results, cases.length);
  // A required Langfuse record that is missing makes the run incomplete.
  if (CI && !langfuse.complete) {
    summary.reasons.push(`Langfuse record incomplete: ${langfuse.detail}`);
    summary.verdict = "incomplete";
    summary.exitCode = 2;
  }
  const info: RunInfo = {
    runId: meta.runId,
    commit: meta.commit,
    agentMode: mode,
    goldenSetVersion: setVersion,
    rubricVersion: RUBRIC_VERSION,
    candidateModel: defaultModel(),
    judgeModel: judgeModel(),
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    langfuse,
  };
  const md = writeReport(OUT, info, summary, results);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

  console.log(
    `\n${summary.verdict.toUpperCase()}: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errors} errors, average judge score ${summary.averageOverall?.toFixed(2) ?? "n/a"}`,
  );
  for (const reason of summary.reasons) console.log(`  - ${reason}`);
  if (langfuse.experimentUrl)
    console.log(`Langfuse experiment: ${langfuse.experimentUrl}`);
  console.log(`Results: ${OUT}/results.json, results.csv, summary.md`);
  process.exit(summary.exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
