// npm run build-comparison -- --runs dir1,dir2,dir3,dir4 [--out file.md] [--keep dir]
// The directories are the evaluations in the order they were run. Reads each
// results.json (and retries.json if collect-retries was run), prints the full
// set of tables, and with --keep copies the raw per-run files into the project
// so every run is kept, not just the average.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { SavedRun } from "@/evals/compare";
import {
  loadRun,
  renderCases,
  renderFailures,
  renderFinal,
  renderJudgeCost,
  renderPerRun,
  renderRetries,
  renderRetryDetails,
} from "@/evals/compare-report";
import {
  renderCostKinds,
  renderExcluded,
  renderLikeForLike,
  renderReliability,
  renderSampleSizes,
} from "@/evals/compare-samples";
import type { RetryTrace } from "@/evals/retry-trace";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const dirs = option("runs")?.split(",").filter(Boolean) ?? [];
if (!dirs.length) {
  console.error("Pass --runs dir1,dir2,... in the order they were run.");
  process.exit(2);
}

const runs = dirs.map((dir) => {
  const run = JSON.parse(
    readFileSync(join(dir, "results.json"), "utf8"),
  ) as SavedRun;
  const retriesPath = join(dir, "retries.json");
  const retries = existsSync(retriesPath)
    ? (JSON.parse(readFileSync(retriesPath, "utf8")) as RetryTrace)
    : undefined;
  return loadRun(run, basename(dir), retries);
});

const versions = new Set(runs.map((r) => r.run.info.goldenSetVersion));
if (versions.size > 1) {
  console.error(`Runs used different case sets: ${[...versions].join(", ")}`);
  process.exit(2);
}

const links = runs.map(
  (r, i) =>
    `- Run ${i + 1} (${r.metrics.mode}-agent), \`${r.metrics.runId}\`: ${r.metrics.experimentUrl ?? "no Langfuse experiment link"}`,
);

const md = [
  "## Per-run results",
  "",
  "Runs in the order they were run. Latency is the final attempt of each case; time lost to re-runs shows in the wall-clock.",
  "",
  renderPerRun(runs),
  "",
  "## Side by side",
  "",
  `${runs.filter((r) => r.metrics.mode === "single").length} runs of each architecture. The mean is shown first, then each run in brackets (or the total, then each run). Two runs are not enough for a significance test; treat differences smaller than the change between the two runs of one architecture as noise.`,
  "",
  renderFinal(runs),
  "",
  renderJudgeCost(runs),
  "",
  "## Sample sizes, and what was excluded",
  "",
  renderSampleSizes(runs),
  "",
  renderExcluded(runs),
  "",
  "## Like-for-like: the cases that are valid in every run",
  "",
  renderLikeForLike(runs),
  "",
  "## Cost: observed, retried, unconfirmed",
  "",
  renderCostKinds(runs),
  "",
  "## Reliability by run",
  "",
  renderReliability(runs),
  "",
  "## Cases, run by run",
  "",
  renderCases(runs),
  "",
  "### Failures and errors",
  "",
  renderFailures(runs),
  "",
  "## Retries",
  "",
  renderRetries(runs),
  "",
  renderRetryDetails(runs),
  "",
  "## Langfuse",
  "",
  ...links,
  "",
].join("\n");

console.log(md);
const out = option("out");
if (out) writeFileSync(out, md);
const keep = option("keep");
if (keep) {
  for (const dir of dirs) {
    const target = join(keep, basename(dir));
    mkdirSync(target, { recursive: true });
    for (const file of [
      "results.json",
      "results.csv",
      "summary.md",
      "retries.json",
      "langfuse-verification.json",
    ])
      if (existsSync(join(dir, file)))
        copyFileSync(join(dir, file), join(target, file));
  }
  console.log(`Raw results of ${dirs.length} runs kept in ${keep}`);
}
