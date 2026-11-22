// npm run compare-agents -- --single dirA,dirB --multi dirC,dirD [--out file.md]
// Each dir holds the results.json that `npm run eval -- --out dir` wrote.
// Prints, and optionally writes, the single vs multi comparison tables.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compare, renderComparison, type SavedRun } from "@/evals/compare";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function load(dirs: string | undefined, expected: "single" | "multi") {
  return (dirs?.split(",").filter(Boolean) ?? []).map((dir) => {
    const run = JSON.parse(
      readFileSync(join(dir, "results.json"), "utf8"),
    ) as SavedRun;
    const mode = run.info.agentMode ?? "multi";
    if (mode !== expected)
      throw new Error(`${dir} is a ${mode}-agent run, listed as ${expected}`);
    return { run, label: dir };
  });
}

const runs = [
  ...load(option("single"), "single"),
  ...load(option("multi"), "multi"),
];
if (!runs.length) {
  console.error("Pass --single dir,dir and --multi dir,dir");
  process.exit(2);
}
// Only runs of one case set can be compared.
const versions = new Set(runs.map((r) => r.run.info.goldenSetVersion));
if (versions.size > 1) {
  console.error(
    `These runs used different case sets: ${[...versions].join(", ")}`,
  );
  process.exit(2);
}
const md = renderComparison(compare(runs));
console.log(md);
const out = option("out");
if (out) writeFileSync(out, md);
