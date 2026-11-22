// npm run verify-langfuse -- eval-results/ab-single-1 eval-results/ab-run2-multi ...
// Read-only. For each evaluation directory, asks Langfuse (slowly, one request
// at a time, obeying its rate limit) whether the run's traces, experiment,
// experiment items and scores are there, and writes langfuse-verification.json
// next to results.json. Nothing is sent to Langfuse and no model is called.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeCheck, verifyRun } from "@/evals/langfuse-verify";
import { politeGetter } from "@/evals/polite";

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dirs.length) {
  console.error("Pass one or more evaluation directories.");
  process.exit(2);
}
async function main() {
  const get = politeGetter();
  for (const dir of dirs) {
    const saved = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
    const result = await verifyRun(saved, get);
    writeFileSync(
      join(dir, "langfuse-verification.json"),
      JSON.stringify(
        { checkedAt: new Date().toISOString(), ...result },
        null,
        2,
      ),
    );
    console.log(`\n${dir} (${result.runId})`);
    console.log(`  traces:           ${describeCheck(result.traces)}`);
    console.log(`  experiment:       ${describeCheck(result.experiment)}`);
    console.log(`  experiment items: ${describeCheck(result.experimentItems)}`);
    console.log(`  scores:           ${describeCheck(result.scores)}`);
    if (result.scoreShortfall)
      console.log(
        `  score shortfall:  ${JSON.stringify(result.scoreShortfall)}`,
      );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
