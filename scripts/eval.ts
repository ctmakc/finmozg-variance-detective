/**
 * Scores agent runs against the planted ground truth (eval/ground_truth.json, never read by the agents).
 *   npm run eval                      # scores the latest run of input 01 in logs/
 *   npm run eval -- --run <runId>     # scores one run
 *   npm run eval -- --all             # scores every completed gross-margin run in logs/
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { RunOutput } from "../src/agents/types.js";

const gt = JSON.parse(readFileSync("eval/ground_truth.json", "utf8"));

interface Check {
  id: string;
  pass: boolean;
  detail: string;
}

const BRIDGE_KEYS = ["volume", "mix", "price", "supplierPrice", "fx", "otherCost", "bookingError", "packagingReal", "residual"];

export function scoreRun(run: RunOutput): { runId: string; checks: Check[]; score: number; max: number } {
  const checks: Check[] = [];
  const text = (run.memo + " " + run.findings.map((f) => `${f.claim} ${f.entities.join(" ")}`).join(" ")).toLowerCase();
  const memo = run.memo.toLowerCase();
  const evidenceText = run.evidence.map((e) => e.rows.flat().join(" ")).join(" ").toLowerCase();
  const accepted = (dt: string) => run.findings.find((f) => f.driverType === dt && f.verdict?.verdict === "accepted");

  // 1. Deterministic bridge matches ground truth (CAD 1 tolerance).
  for (const k of BRIDGE_KEYS) {
    const got = run.bridge.find((c) => c.key === k)?.amountCad;
    const want = gt.bridge[k];
    checks.push({ id: `bridge.${k}`, pass: got !== undefined && Math.abs(got - want) <= 1, detail: `got ${got?.toFixed(2)} want ${Number(want).toFixed(2)}` });
  }
  // 2. Planted causes found, accepted by the Skeptic and named.
  const dup = accepted("booking_error");
  checks.push({ id: "cause.duplicate_invoice", pass: !!dup && /mrp-88213/.test(text), detail: dup ? `accepted: ${dup.claim.slice(0, 120)}` : "not accepted" });
  const bankBacked = !!dup && dup.evidenceIds.some((id) => run.evidence.find((e) => e.id === id)?.sources.some((s) => /vendor_payment|fm_bank/.test(s)));
  checks.push({ id: "cause.duplicate_invoice.bank_confirmed", pass: bankBacked, detail: bankBacked ? "bank feed cited" : "no bank evidence cited" });
  const sp = accepted("supplier_price");
  checks.push({ id: "cause.supplier_price", pass: !!sp, detail: sp ? `accepted: ${sp.claim.slice(0, 120)}` : "not accepted" });
  checks.push({ id: "cause.supplier_price.vendor_named_in_memo", pass: /vend-snc|sierra nut/.test(memo), detail: /vend-snc|sierra nut/.test(memo) ? "Sierra Nut named in memo" : /vend-snc|sierra nut/.test(text) ? "named in findings only" : "not named" });
  const mix = run.findings.find((f) => f.driverType === "mix");
  checks.push({ id: "cause.mix", pass: !!mix && mix.verdict?.verdict !== "rejected", detail: mix ? `${mix.verdict?.verdict}: ${mix.claim.slice(0, 120)}` : "no mix finding" });
  checks.push({ id: "cause.mix.named_in_memo", pass: /cust-w01|capital wholesale|wholesale/.test(memo), detail: /cust-w01|capital wholesale/.test(memo) ? "customer named" : /wholesale/.test(memo) ? "channel named" : "not named in memo" });
  const fx = run.findings.find((f) => f.driverType === "fx");
  checks.push({ id: "cause.fx_measured", pass: !!fx && fx.verdict?.verdict !== "rejected", detail: fx ? `${fx.verdict?.verdict}: ${fx.verdict?.reason.slice(0, 100)}` : "no fx finding" });
  // 3. Red herring rejected (or at least never reported as a gross-margin driver).
  const opex = run.findings.find((f) => f.driverType === "opex");
  const opexReportedAsDriver = /##\s*drivers[\s\S]*?(marketing|6100)[\s\S]*?##\s*rejected/i.test(run.memo);
  checks.push({ id: "red_herring.rejected", pass: (!opex || opex.verdict?.verdict === "rejected") && !opexReportedAsDriver, detail: opex ? `${opex.verdict?.verdict}: ${opex.verdict?.reason.slice(0, 100)}` : "not investigated; not in drivers" });
  // 4. Honesty and form.
  checks.push({ id: "memo.complete", pass: /##\s*answer/i.test(run.memo) && /##\s*open questions/i.test(run.memo) && !/reviewer notes/i.test(run.memo), detail: "all sections, no unresolved reviewer notes" });
  checks.push({ id: "memo.residual_stated", pass: /##\s*unexplained residual/i.test(run.memo), detail: "" });
  checks.push({ id: "memo.signoff_caveat", pass: /sign off/i.test(run.memo), detail: "" });
  const cited = [...run.memo.matchAll(/\[((?:E|Q-)[\w-]+)\]/g)].map((m) => m[1]);
  const known = new Set(run.evidence.map((e) => e.id));
  checks.push({ id: "memo.citations_resolve", pass: cited.length > 0 && cited.every((c) => known.has(c)), detail: `${cited.length} citations` });
  checks.push({ id: "evidence.rows_exist", pass: /mrp-88213/.test(evidenceText), detail: "duplicate invoice appears in returned rows" });

  const score = checks.filter((c) => c.pass).length;
  return { runId: run.runId, checks, score, max: checks.length };
}

function main() {
  const args = process.argv.slice(2);
  const files = readdirSync("logs").filter((f) => /^run-.*\.json$/.test(f)).sort();
  const runs: RunOutput[] = files.map((f) => JSON.parse(readFileSync(`logs/${f}`, "utf8")));
  const gmRuns = runs.filter((r) => r.status === "completed" && r.plan.metric === "gross_margin" && /gross margin/i.test(r.question));
  let selected: RunOutput[];
  if (args.includes("--run")) selected = runs.filter((r) => r.runId === args[args.indexOf("--run") + 1]);
  else if (args.includes("--all")) selected = gmRuns;
  else selected = gmRuns.slice(-1);
  if (!selected.length) {
    console.error("No matching completed gross-margin run in logs/. Run: npm run agent -- --input input_examples/01-gm-drop-sep.json");
    process.exit(1);
  }
  const results = selected.map(scoreRun);
  for (const r of results) {
    console.log(`\n${r.runId}: ${r.score}/${r.max}`);
    for (const c of r.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id.padEnd(42)} ${c.detail}`);
  }
  const summary = {
    at: new Date().toISOString(),
    runs: results.length,
    meanScore: results.reduce((s, r) => s + r.score / r.max, 0) / results.length,
    perCheckPassRate: Object.fromEntries(results[0].checks.map((c) => [c.id, results.filter((r) => r.checks.find((x) => x.id === c.id)?.pass).length / results.length])),
    results,
  };
  const out = `eval/results-${summary.at.slice(0, 10)}.json`;
  writeFileSync(out, JSON.stringify(summary, null, 1));
  console.log(`\nmean ${(summary.meanScore * 100).toFixed(1)}% over ${results.length} run(s) → ${out}`);
}

if (process.argv[1]?.endsWith("eval.ts")) main();
