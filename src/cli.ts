/**
 * CLI.
 *   npm run agent -- --input input_examples/01-gm-drop-sep.json [--out path.json]
 *   npm run agent -- --question "Why did gross margin fall in September vs August?"
 *   npm run feedback -- --run <runId> --finding <findingId> --verdict confirmed|rejected [--note "..."]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { applyFeedback } from "./agents/steward.js";
import type { RunInput, RunOutput } from "./agents/types.js";
import { DetectiveMemory } from "./memory/hmem.js";
import { runInvestigation } from "./orchestrator.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("feedback")) {
    const run: RunOutput = JSON.parse(readFileSync(`logs/run-${arg("run")}.json`, "utf8"));
    const r = applyFeedback(new DetectiveMemory(), run, { findingId: arg("finding")!, verdict: (arg("verdict") as "confirmed" | "rejected") ?? "confirmed", note: arg("note") });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const input: RunInput = arg("input") ? JSON.parse(readFileSync(arg("input")!, "utf8")) : { question: arg("question") ?? "Why did gross margin fall in September vs August?" };
  const out = await runInvestigation(input, {
    onEvent: (e) => {
      if (process.env.QUIET === "true") return;
      const { ts, runId, seq, agent, type, ...rest } = e;
      const brief = JSON.stringify(rest);
      console.error(`${ts.slice(11, 19)} ${agent.padEnd(18)} ${type.padEnd(16)} ${brief.length > 160 ? brief.slice(0, 160) + "…" : brief}`);
    },
  });
  if (arg("out")) writeFileSync(arg("out")!, JSON.stringify(out, null, 1));
  console.log(out.memo);
  console.log(`\nrun ${out.runId} ${out.status} · ${(out.stats.durationMs / 1000).toFixed(0)} s · SQL ${out.stats.sqlCalls} (${out.stats.sqlErrors} errors, ${out.stats.sqlRepairs} repairs) · LLM ${out.stats.llmCalls} via ${out.stats.provider} [${out.stats.servedBy.join(", ")}] · warm ${out.stats.warmStart} · trace logs/trace-${out.runId}.jsonl`);
  if (out.status === "failed") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
