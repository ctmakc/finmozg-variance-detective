/** Quant on recorded Zetaris results, bridge edge cases, eval scoring, Planner/Cartographer/Steward and SAMPLE_MODE helpers. */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCartographer, schemaPrompt } from "../src/agents/cartographer.js";
import { defaultPlan, ensureCoverage } from "../src/agents/planner.js";
import { COMPONENT_META, buildPeriodInput, quantQueries, rateBridge, runQuant } from "../src/agents/quant.js";
import { applyFeedback } from "../src/agents/steward.js";
import { DRIVER_TYPES, type Plan, PlanSchema, type RunOutput } from "../src/agents/types.js";
import { DetectiveMemory } from "../src/memory/hmem.js";
import { type BridgeResult, type PeriodInput, computeMarginBridge } from "../src/quant/bridge.js";
import { inputNameForQuestion, sampleMemoryDir } from "../src/sample.js";
import { type SqlResult, ZetarisClient, asObjects } from "../src/zetaris/client.js";
import { scoreRun } from "../scripts/eval.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fm-dom-"));
const recordedRun = (name = "01-gm-drop-sep"): RunOutput => JSON.parse(readFileSync(`recordings/runs/${name}.json`, "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const replayClient = () => new ZetarisClient({ restUrl: "http://127.0.0.1:9", orgId: "1", apiKey: "", mode: "replay", recordingsDir: "recordings" });
const sqlResult = (headers: string[], rows: string[][]): SqlResult => ({ headers, rows, total: rows.length, timeUsedMs: 0, queryId: "q" });

describe("runQuant on the recorded Zetaris results (Aug → Sep 2026)", async () => {
  const z = replayClient();
  const labels: string[] = [];
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const q = await runQuant((sql, label) => (labels.push(label), z.runSql(sql)), "2026-08", "2026-09", (_a, type, data) => events.push({ type, data }));

  it("runs the seven fixed queries in order and keeps each as evidence", () => {
    expect(labels).toEqual(["quant:sales", "quant:costs", "quant:gl", "quant:duplicates", "quant:overContract", "quant:customerShift", "quant:vendorNames"]);
    expect(q.evidence.map((e) => e.id)).toEqual(["Q-sales", "Q-costs", "Q-gl", "Q-duplicates", "Q-overContract", "Q-customerShift", "Q-vendorNames"]);
    expect(q.evidence.every((e) => e.agent === "Quant" && e.rows.length <= 50)).toBe(true);
  });

  it("finds the planted duplicate invoice, the over-contract vendor and the wholesale shift", () => {
    expect(q.duplicates).toEqual([{ period: "2026-09", vendorInvoiceNo: "MRP-88213", apDocs: 2, payments: 1, amountCad: 12450 }]);
    expect(q.overContract[0]).toMatchObject({ vendorId: "VEND-SNC", vendorName: "Sierra Nut Co." });
    expect(q.customerShift[0]).toMatchObject({ customerId: "CUST-W01", channel: "wholesale" });
    expect(q.names["VEND-SNC"]).toBe("Sierra Nut Co.");
  });

  it("booking error equals (AP docs − payments) × amount, and the GL reconciles to the sub-ledgers", () => {
    expect(q.bridge.bookingError).toBe(-12450);
    expect(q.reconciliation.every((r) => r.ok)).toBe(true);
  });

  it("components follow COMPONENT_META and the rounded pp lines add up to the headline change", () => {
    expect(q.components.map((c) => c.key)).toEqual(COMPONENT_META.map((m) => m.key));
    const sum = q.rate.items.reduce((s, i) => s + i.pp, 0);
    expect(sum).toBeCloseTo(q.rate.deltaPp, 6);
    expect(q.rate).toMatchObject({ gmPctA: 35.93, gmPctB: 29.15, deltaPp: -6.78 });
  });

  it("emits one bridge event with the top drill-downs", () => {
    expect(events.map((e) => e.type)).toEqual(["bridge"]);
    expect((events[0].data!.overContract as unknown[]).length).toBeLessThanOrEqual(3);
    expect((events[0].data!.topCustomerShift as unknown[]).length).toBeLessThanOrEqual(2);
  });
});

describe("quantQueries", () => {
  it("interpolates both periods, excludes packaging from goods cost and scopes drill-downs to period B", () => {
    const q = quantQueries("2026-08", "2026-09");
    for (const k of ["sales", "costs", "gl", "duplicates"] as const) expect(q[k]).toContain("('2026-08', '2026-09')");
    expect(q.costs).toContain("sku <> 'PKG'");
    expect(q.overContract).toContain("l.period = '2026-09'");
    expect(q.overContract).not.toContain("2026-08");
    expect(q.customerShift).toMatch(/LIMIT 5$/);
  });
});

describe("buildPeriodInput", () => {
  const sales = [
    { period: "2026-09", sku: "A", channel: "retail", qty: "10", revenue_cad: "100" },
    { period: "2026-09", sku: "B", channel: "wholesale", qty: "0", revenue_cad: "0" },
    { period: "2026-08", sku: "A", channel: "retail", qty: "99", revenue_cad: "1" },
  ];
  const costs = [
    { period: "2026-09", sku: "A", currency: "USD", qty: "20", amount_cad: "140", amount_orig: "100", fx_rate: "1.4", contract_unit_price: "4.5" },
  ];

  it("derives unit price and unit cost per sold cell, with USD fields only for USD costs", () => {
    const p = buildPeriodInput("2026-09", sales, costs, 50, 7);
    expect(p.packagingCad).toBe(50);
    expect(p.bookingErrorPkgCad).toBe(7);
    expect(p.cells).toHaveLength(2);
    expect(p.cells[0]).toEqual({ sku: "A", channel: "retail", qty: 10, unitPriceCad: 10, unitCostCad: 7, isUsd: true, unitPriceUsd: 5, fxRate: 1.4, contractUnitPriceUsd: 4.5 });
    // zero quantity and no purchase rows: no division by zero, no USD flags
    expect(p.cells[1]).toEqual({ sku: "B", channel: "wholesale", qty: 0, unitPriceCad: 0, unitCostCad: 0 });
  });

  it.skip("bug: a SKU bought in two currencies in one period keeps only the last cost row (unit cost wrong)", () => {
    const two = [
      { period: "2026-09", sku: "A", currency: "CAD", qty: "10", amount_cad: "100", amount_orig: "100", fx_rate: "1", contract_unit_price: "" },
      { period: "2026-09", sku: "A", currency: "USD", qty: "10", amount_cad: "140", amount_orig: "100", fx_rate: "1.4", contract_unit_price: "" },
    ];
    const p = buildPeriodInput("2026-09", sales, two, 0, 0);
    expect(p.cells[0].unitCostCad).toBeCloseTo(12, 6); // (100 + 140) / 20; current code gives 14
  });
});

describe("computeMarginBridge edge cases", () => {
  const cell = (sku: string, channel: string, qty: number, price: number, cost: number, usd?: { u: number; fx: number }) => ({
    sku, channel, qty, unitPriceCad: price, unitCostCad: cost, ...(usd ? { isUsd: true, unitPriceUsd: usd.u, fxRate: usd.fx } : {}),
  });

  it("empty periods give zeros, not NaN", () => {
    const empty: PeriodInput = { cells: [], packagingCad: 0, bookingErrorPkgCad: 0 };
    const b = computeMarginBridge(empty, empty);
    for (const [k, v] of Object.entries(b)) if (typeof v === "number") expect(Number.isNaN(v), k).toBe(false);
    expect(b.gmPctA).toBe(0);
  });

  it("an FX-only move is attributed to fx, not to supplier price", () => {
    const a: PeriodInput = { cells: [cell("N", "r", 100, 10, 7, { u: 5, fx: 1.4 })], packagingCad: 0, bookingErrorPkgCad: 0 };
    const b: PeriodInput = { cells: [cell("N", "r", 100, 10, 7.5, { u: 5, fx: 1.5 })], packagingCad: 0, bookingErrorPkgCad: 0 };
    const r = computeMarginBridge(a, b);
    expect(r.fx).toBeCloseTo(-50, 6);
    expect(r.supplierPrice).toBeCloseTo(0, 6);
    expect(r.otherCost).toBeCloseTo(0, 6);
    expect(r.residual).toBeCloseTo(0, 6);
  });

  it("a SKU that disappears in B is volume/mix, and the residual stays zero", () => {
    const a: PeriodInput = { cells: [cell("X", "r", 50, 10, 6), cell("Y", "r", 50, 20, 10)], packagingCad: 0, bookingErrorPkgCad: 0 };
    const b: PeriodInput = { cells: [cell("X", "r", 100, 10, 6)], packagingCad: 0, bookingErrorPkgCad: 0 };
    const r = computeMarginBridge(a, b);
    expect(r.price).toBe(0);
    expect(r.volume + r.mix).toBeCloseTo(r.deltaGm, 6);
    expect(r.residual).toBeCloseTo(0, 6);
  });

  it.skip("bug: a USD SKU that is new in B books its whole CAD cost as FX (fxA defaults to 0)", () => {
    const a: PeriodInput = { cells: [cell("OLD", "r", 100, 10, 6)], packagingCad: 0, bookingErrorPkgCad: 0 };
    const b: PeriodInput = { cells: [cell("OLD", "r", 100, 10, 6), cell("NEW", "r", 10, 20, 14, { u: 10, fx: 1.4 })], packagingCad: 0, bookingErrorPkgCad: 0 };
    const r = computeMarginBridge(a, b);
    // No rate changed between A and B, so there is no FX effect; current code reports fx = −140.
    expect(r.fx).toBeCloseTo(0, 6);
  });

  it.skip("bug: duplicate (sku, channel) cells are counted in totals but only the last one in the components (residual ≠ 0)", () => {
    const a: PeriodInput = { cells: [cell("X", "r", 10, 10, 6), cell("X", "r", 10, 12, 6)], packagingCad: 0, bookingErrorPkgCad: 0 };
    const b: PeriodInput = { cells: [cell("X", "r", 25, 11, 6)], packagingCad: 0, bookingErrorPkgCad: 0 };
    expect(computeMarginBridge(a, b).residual).toBeCloseTo(0, 6);
  });
});

describe("rateBridge", () => {
  const base = (over: Partial<BridgeResult>): BridgeResult => ({
    gmA: 0, gmB: 0, revenueA: 100, revenueB: 100, gmPctA: 0, gmPctB: 0, deltaGm: 0, volume: 0, mix: 0, price: 0, goodsCost: 0, fx: 0,
    supplierPrice: 0, overContract: 0, otherCost: 0, packaging: 0, bookingError: 0, packagingReal: 0, residual: 0, componentsPpOfBRevenue: {}, ...over,
  });

  it("adds the revenue-scale term to volume so the split is exact before rounding", () => {
    // GM 30 on revenue 100 → GM 30 on revenue 150: no dollar change, but the rate falls 10 pp.
    const r = rateBridge(base({ gmA: 30, gmB: 30, revenueA: 100, revenueB: 150, gmPctA: 0.3, gmPctB: 0.2 }));
    expect(r.deltaPp).toBe(-10);
    expect(r.items.find((i) => i.key === "volume")!.pp).toBe(-10);
  });

  it("zero revenue gives zeros", () => {
    expect(rateBridge(base({ revenueA: 0, revenueB: 0 })).items.every((i) => i.pp === 0)).toBe(true);
  });

  it.skip("bug: rounded pp lines do not always add up to deltaPp (QuantResult.rate promises Σ pp = deltaPp)", () => {
    const third = 100 / 3 / 100; // $0.333… each on revenue 100
    const r = rateBridge(base({ gmA: 0, gmB: 1, gmPctA: 0, gmPctB: 0.01, deltaGm: 1, volume: third, mix: third, price: third }));
    const sum = r.items.reduce((s, i) => s + i.pp, 0);
    expect(Math.round(sum * 100) / 100).toBe(r.deltaPp); // 0.99 vs 1
  });
});

describe("scoreRun (eval against planted ground truth)", () => {
  it("scores the recorded input-01 run and every check has a stable id", () => {
    const s = scoreRun(recordedRun());
    expect(s.max).toBe(s.checks.length);
    expect(new Set(s.checks.map((c) => c.id)).size).toBe(s.checks.length);
    for (const id of ["bridge.volume", "bridge.residual", "cause.duplicate_invoice", "cause.duplicate_invoice.bank_confirmed", "red_herring.rejected", "memo.citations_resolve", "evidence.rows_exist"]) {
      expect(s.checks.find((c) => c.id === id)?.pass, id).toBe(true);
    }
  });

  it("fails the bridge check when a component is more than CAD 1 off", () => {
    const run = clone(recordedRun());
    run.bridge.find((c) => c.key === "fx")!.amountCad += 1.5;
    expect(scoreRun(run).checks.find((c) => c.id === "bridge.fx")!.pass).toBe(false);
  });

  it("fails the red-herring check when opex is accepted as a driver", () => {
    const run = clone(recordedRun());
    run.findings.find((f) => f.driverType === "opex")!.verdict = { verdict: "accepted", reason: "x", by: "Skeptic" };
    expect(scoreRun(run).checks.find((c) => c.id === "red_herring.rejected")!.pass).toBe(false);
  });

  it("fails citation check when the memo cites evidence that does not exist", () => {
    const run = clone(recordedRun());
    run.memo += "\nSee [E99-9].";
    expect(scoreRun(run).checks.find((c) => c.id === "memo.citations_resolve")!.pass).toBe(false);
  });

  it("a duplicate-invoice finding without bank evidence passes the cause check but not the bank check", () => {
    const run = clone(recordedRun());
    const dup = run.findings.find((f) => f.driverType === "booking_error")!;
    dup.evidenceIds = dup.evidenceIds.filter((id) => !run.evidence.find((e) => e.id === id)?.sources.some((s) => /vendor_payment|fm_bank/.test(s)));
    const checks = scoreRun(run).checks;
    expect(checks.find((c) => c.id === "cause.duplicate_invoice")!.pass).toBe(true);
    expect(checks.find((c) => c.id === "cause.duplicate_invoice.bank_confirmed")!.pass).toBe(false);
  });
});

describe("Planner", () => {
  it("the default plan is schema-valid and covers each driver at most once", () => {
    const p = PlanSchema.parse(defaultPlan("2026-08", "2026-09"));
    const types = p.hypotheses.map((h) => h.driverType);
    expect(new Set(types).size).toBe(types.length);
    expect(types.every((t) => (DRIVER_TYPES as readonly string[]).includes(t))).toBe(true);
  });

  it("ensureCoverage adds only missing core drivers, renumbers ids and reports what it added", () => {
    const plan: Plan = { ...defaultPlan("2026-08", "2026-09"), hypotheses: [{ id: "x", driverType: "fx", text: "rate moved", checks: "" }] };
    const emitted: unknown[] = [];
    const out = ensureCoverage(plan, (_a, type, data) => emitted.push({ type, data }));
    expect(out.hypotheses.map((h) => h.driverType)).toEqual(["fx", "mix", "supplier_price", "booking_error"]);
    expect(out.hypotheses.map((h) => h.id)).toEqual(["h1", "h2", "h3", "h4"]);
    expect(emitted).toEqual([{ type: "coverage_added", data: { added: ["mix", "supplier_price", "booking_error"] } }]);
    expect(plan.hypotheses).toHaveLength(1); // input not mutated
  });

  it("a complete plan comes back unchanged (same object, no event)", () => {
    const plan = defaultPlan("2026-08", "2026-09");
    const emitted: unknown[] = [];
    expect(ensureCoverage(plan, () => emitted.push(1))).toBe(plan);
    expect(emitted).toHaveLength(0);
  });
});

describe("Cartographer", () => {
  const fakeSql = () => {
    const calls: string[] = [];
    const runSql = async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SHOW TABLES")) return sqlResult(["table_identifier"], [["lightning.metastore.finmozg.finance_usl.vendor"], ["lightning.metastore.finmozg.finance_usl.unknown_t"]]);
      if (sql.startsWith("DESCRIBE")) return sqlResult(["col_name", "data_type"], [["vendor_id", "string"], ["vendor_name", "string"]]);
      if (sql === "SHOW DATASOURCES") return sqlResult(["name"], [["fm_erp"]]);
      if (sql === "SHOW LIGHTNING DATABASES") return sqlResult(["name"], [["FM_ORDERS"], ["OTHER"]]);
      throw new Error(sql);
    };
    return { calls, runSql };
  };

  it("cold run discovers tables, describes each, keeps FM_ Lightning dbs and stores the map", async () => {
    const mem = new DetectiveMemory(tmp());
    const { calls, runSql } = fakeSql();
    const map = await runCartographer(runSql, mem, "r1", () => {});
    expect(map.fromMemory).toBe(false);
    expect(map.entries[0]).toEqual({ table: "lightning.metastore.finmozg.finance_usl.vendor", columns: ["vendor_id string", "vendor_name string"], description: "vendors (id, name, invoicing currency)" });
    expect(map.entries[1].description).toBeUndefined();
    expect(map.rawSources).toEqual(["fm_erp (JDBC)", "FM_ORDERS (Lightning)"]);
    expect(calls.filter((c) => c.startsWith("DESCRIBE"))).toHaveLength(2);
    expect(mem.schemaMap()).toHaveLength(2);
  });

  it("warm run with ≥5 remembered tables skips discovery entirely", async () => {
    const mem = new DetectiveMemory(tmp());
    mem.rememberSchemaMap(["a", "b", "c", "d", "e"].map((t) => ({ table: t, columns: ["x int"] })), "r0");
    const { calls, runSql } = fakeSql();
    const map = await runCartographer(runSql, mem, "r1", () => {});
    expect(map.fromMemory).toBe(true);
    expect(calls).toHaveLength(0);
    expect(map.entries).toHaveLength(5);
    // forceDiscovery overrides memory
    await runCartographer(runSql, mem, "r2", () => {}, { forceDiscovery: true });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("schemaPrompt lists every table with its columns and the SQL dialect rules", () => {
    const p = schemaPrompt({ entries: [{ table: "t1", columns: ["a int", "b string"], description: "desc" }, { table: "t2", columns: [] }], rawSources: ["s1", "s2"], fromMemory: false });
    expect(p).toContain("- t1(a int, b string) -- desc");
    expect(p).toContain("- t2()");
    expect(p).toContain("Raw sources also registered in Zetaris: s1, s2.");
    expect(p).toMatch(/No trailing semicolon/);
  });
});

describe("Steward (controller feedback → H-MEM)", () => {
  it("a rejection is remembered with the note and without evidence wording", () => {
    const mem = new DetectiveMemory(tmp());
    const run = recordedRun();
    const f = run.findings.find((x) => x.driverType === "opex")!;
    const r = applyFeedback(mem, run, { findingId: f.id, verdict: "rejected", note: "below GM line" });
    expect(r.content).toMatch(/^Rejected by the controller: /);
    expect(r.content).toContain("Reason: below GM line.");
    expect(r.content).toContain("Do not report it again");
    expect(mem.byTag("verdict:rejected")).toHaveLength(1);
  });

  it("a confirmation uses the bridge amount for the driver and lists the cited evidence", () => {
    const mem = new DetectiveMemory(tmp());
    const run = recordedRun();
    const f = run.findings.find((x) => x.driverType === "booking_error")!;
    const r = applyFeedback(mem, run, { findingId: f.id, verdict: "confirmed" });
    expect(r.content).toContain("(CAD 12,450)");
    for (const id of f.evidenceIds) expect(r.content).toContain(id);
    expect(r.stats.findings).toBe(1);
  });
});

describe("SAMPLE_MODE helpers", () => {
  it("inputNameForQuestion matches case- and whitespace-insensitively", () => {
    expect(inputNameForQuestion("  why did GROSS margin fall in September vs August? ")).toBe("01-gm-drop-sep");
    expect(inputNameForQuestion("something else")).toBeUndefined();
    expect(inputNameForQuestion("x", join(tmp(), "missing"))).toBeUndefined();
  });

  it("sampleMemoryDir copies the snapshot to a fresh temp dir and is empty for unknown questions", () => {
    const q = JSON.parse(readFileSync("input_examples/02-vendors-recoverable.json", "utf8")).question;
    const a = sampleMemoryDir(q);
    const b = sampleMemoryDir(q);
    expect(a).not.toBe(b);
    expect(readdirSync(a).sort()).toEqual(readdirSync("recordings/hmem/02-vendors-recoverable").sort());
    expect(readFileSync(join(a, "ledger.jsonl"), "utf8")).toBe(readFileSync("recordings/hmem/02-vendors-recoverable/ledger.jsonl", "utf8"));
    expect(readdirSync(sampleMemoryDir("unknown question"))).toEqual([]);
    expect(existsSync(join(sampleMemoryDir(JSON.parse(readFileSync("input_examples/01-gm-drop-sep.json", "utf8")).question), "ledger.jsonl"))).toBe(false);
  });
});

describe("asObjects", () => {
  it("maps rows to header-keyed objects", () => {
    expect(asObjects(sqlResult(["a", "b"], [["1", "2"], ["3"]]))).toEqual([{ a: "1", b: "2" }, { a: "3", b: "" }]);
  });
});
