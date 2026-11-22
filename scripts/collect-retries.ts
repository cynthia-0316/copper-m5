// npm run collect-retries -- eval-results/ab-run1-single [more dirs...]
// For each evaluation directory, reads every attempt of every case back from
// Langfuse and writes retries.json next to results.json. Run it after the
// evaluation; it only reads.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectRetryTrace } from "@/evals/retry-trace";
import type { SavedRun } from "@/evals/compare";

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dirs.length) {
  console.error("Pass one or more evaluation directories.");
  process.exit(2);
}
async function main() {
  for (const dir of dirs) {
    const saved = JSON.parse(
      readFileSync(join(dir, "results.json"), "utf8"),
    ) as SavedRun;
    const start = Date.parse(saved.info.startedAt) - 5 * 60_000;
    const end = Date.parse(saved.info.finishedAt) + 30 * 60_000;
    const trace = await collectRetryTrace(
      saved.info.runId,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    );
    writeFileSync(join(dir, "retries.json"), JSON.stringify(trace, null, 2));
    const retried = trace.attempts.filter((a) => a.attempt > 1).length;
    console.log(
      `${dir}: ${trace.attempts.length} attempts traced for ${new Set(trace.attempts.map((a) => a.caseId)).size} cases, ${retried} of them re-runs`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
