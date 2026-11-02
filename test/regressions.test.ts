/** One reproducer per bug fixed on this branch. Each reproducer fails on the code before its fix; the "still accepts" and "allows" cases are controls that pass on both. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOnlySqlProblem, runInvestigator } from "../src/agents/investigator.ts";
import { buildPeriodInput, num, quantQueries, rateBridge } from "../src/agents/quant.ts";
import { isPeriod } from "../src/agents/types.ts";
import { citedIds, factsBlock, reviewMemo, unknownAmounts } from "../src/agents/writer.ts";
import { DetectiveMemory } from "../src/memory/hmem.ts";
import { runInvestigation } from "../src/orchestrator.ts";
import { computeMarginBridge, type PeriodCell, type PeriodInput } from "../src/quant/bridge.ts";
import { ZetarisClient, ZetarisError } from "../src/zetaris/client.ts";
import { fakeLlm, sqlResult, toolCall } from "./helpers/fakes.ts";

const period = (cells: PeriodCell[], packagingCad = 0): PeriodInput => ({ cells, packagingCad, bookingErrorPkgCad: 0 });
const usdCell = (channel: string, qty: number, usd: number, fx: number): PeriodCell => ({ sku: "NUT-ALM", channel, qty, unitPriceCad: 20, unitCostCad: usd * fx, unitPriceUsd: usd, fxRate: fx, contractUnitPriceUsd: usd, isUsd: true });

describe("bridge: a new USD cell is not FX", () => {
  it("selling an unchanged USD SKU in a new channel moves no FX or supplier price", () => {
    const a = period([usdCell("retail", 100, 8, 1.3)]);
    const b = period([usdCell("retail", 100, 8, 1.3), usdCell("wholesale", 50, 8, 1.3)]);
    const br = computeMarginBridge(a, b);
    expect(br.fx).toBe(0); // was -520: the new line's whole CAD cost
    expect(br.supplierPrice).toBe(0);
    expect(br.residual).toBeCloseTo(0, 10);
  });

  it("still splits FX on cells present in both periods", () => {
    const br = computeMarginBridge(period([usdCell("retail", 100, 8, 1.3)]), period([usdCell("retail", 100, 8, 1.4), usdCell("online", 10, 8, 1.4)]));
    expect(br.fx).toBeCloseTo(-100 * 8 * 0.1, 10);
  });
});

describe("bridge: duplicate (sku, channel) rows", () => {
  it("are merged, not dropped into the residual", () => {
    const c: PeriodCell = { sku: "A", channel: "retail", qty: 10, unitPriceCad: 5, unitCostCad: 3 };
    const br = computeMarginBridge(period([c]), period([c, { ...c, unitPriceCad: 6 }]));
    expect(br.deltaGm).toBeCloseTo(30, 10);
    expect(br.residual).toBeCloseTo(0, 10); // was 20 (= the dropped row's whole margin)
    expect(br.price).toBeCloseTo(10, 10);
  });

  it("merged USD rows keep u × fx equal to the CAD cost", () => {
    const a = period([usdCell("retail", 100, 8, 1.3)]);
    const b = period([usdCell("retail", 60, 8, 1.3), usdCell("retail", 40, 9, 1.5)]);
    const br = computeMarginBridge(a, b);
    expect(br.fx + br.supplierPrice + br.otherCost).toBeCloseTo(br.goodsCost, 10);
    expect(br.residual).toBeCloseTo(0, 10);
  });
});

describe("quant: malformed ledger values", () => {
  it("num() refuses non-numeric values instead of returning NaN", () => {
    expect(num("12.5")).toBe(12.5);
    expect(num("")).toBe(0);
    expect(num(" 7 ")).toBe(7);
    for (const bad of ["N/A", "1,234.50", "12abc", "NaN", "Infinity"]) expect(() => num(bad)).toThrow(/non-numeric/);
  });

  it("buildPeriodInput names the field, period and SKU of a bad value", () => {
    expect(() => buildPeriodInput("2026-09", [{ period: "2026-09", sku: "BAR-01", channel: "retail", qty: "N/A", revenue_cad: "100" }], [], 0, 0)).toThrow('Quant: non-numeric sales qty (2026-09 BAR-01) "N/A"');
  });
});

describe("quant: cost rows of one SKU in two currencies", () => {
  const sales = [{ period: "2026-09", sku: "A", channel: "retail", qty: "20", revenue_cad: "200" }];
  const cad = { period: "2026-09", sku: "A", currency: "CAD", qty: "10", amount_cad: "50", amount_orig: "50", contract_unit_price: "", fx_rate: "" };
  const usd = { period: "2026-09", sku: "A", currency: "USD", qty: "10", amount_cad: "130", amount_orig: "100", contract_unit_price: "10", fx_rate: "1.3" };

  it("unit cost is blended over all rows, whatever their order", () => {
    expect(buildPeriodInput("2026-09", sales, [cad, usd], 0, 0).cells[0].unitCostCad).toBe(9); // was 13
    expect(buildPeriodInput("2026-09", sales, [usd, cad], 0, 0).cells[0].unitCostCad).toBe(9); // was 5
  });

  it("a mixed-currency SKU gets no USD split", () => {
    expect(buildPeriodInput("2026-09", sales, [cad, usd], 0, 0).cells[0].isUsd).toBeUndefined();
  });

  it("a missing contract price stays missing instead of becoming 0", () => {
    const cell = buildPeriodInput("2026-09", sales, [{ ...usd, contract_unit_price: "" }], 0, 0).cells[0];
    expect(cell.isUsd).toBe(true);
    expect(cell.contractUnitPriceUsd).toBeUndefined(); // was 0 → overContract = full cost
  });
});

describe("quant: pp lines add up to the printed change", () => {
  it("after rounding, Σ items = deltaPp = gmPctB − gmPctA exactly", () => {
    // Three lines of +0.004 pp each: independent rounding printed 0.00 + 0.00 + 0.00 for a +0.01 change.
    const revenue = 1_000_000;
    const step = 0.00004 * revenue;
    const br = computeMarginBridge(
      period([{ sku: "A", channel: "r", qty: 1000, unitPriceCad: revenue / 1000, unitCostCad: 600 }]),
      period([{ sku: "A", channel: "r", qty: 1000, unitPriceCad: revenue / 1000, unitCostCad: 600 - (3 * step) / 1000 }]),
    );
    const rate = rateBridge({ ...br, mix: step, price: step, otherCost: step, volume: 0, fx: 0, supplierPrice: 0, bookingError: 0, packagingReal: 0, residual: 0 });
    const sum = Math.round(rate.items.reduce((s, i) => s + i.pp, 0) * 100);
    expect(sum).toBe(Math.round(rate.deltaPp * 100));
    expect(Math.round((rate.gmPctB - rate.gmPctA) * 100)).toBe(Math.round(rate.deltaPp * 100));
  });

  it("holds on random bridges", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 500; n++) {
      const mk = () => period(["a", "b", "c"].map((sku) => ({ sku, channel: "x", qty: Math.round(r() * 1000) + 1, unitPriceCad: 10 + r() * 5, unitCostCad: 5 + r() * 4 })), Math.round(r() * 1000));
      const rate = rateBridge(computeMarginBridge(mk(), mk()));
      expect(Math.round(rate.items.reduce((s, i) => s + i.pp, 0) * 100)).toBe(Math.round(rate.deltaPp * 100));
      expect(Math.round((rate.gmPctB - rate.gmPctA) * 100)).toBe(Math.round(rate.deltaPp * 100));
    }
  });
});

describe("writer: untraced amounts and citations", () => {
  const facts = "Gross margin change -CAD 10,034. Booking error -CAD 12,450.";

  it.each([
    ["CAD −45,000", "Unicode minus"],
    ["CAD – 45,000", "en dash"],
    ["45,000 CAD", "amount before the currency"],
    ["CAD 48k", "k suffix"],
    ["CAD 1.2 million", "million suffix"],
    ["C$ 45,000", "C$"],
  ])("flags %s (%s)", (amount) => {
    expect(unknownAmounts(`The vendor owes ${amount} [Q-gl].`, facts)).toEqual([amount]);
  });

  it("still accepts traced figures in those forms", () => {
    expect(unknownAmounts("CAD −12,450, 10,034 CAD, CAD 12.45k", facts)).toEqual([]);
  });

  it("checks every id in a citation list and ignores bracketed words", () => {
    expect(citedIds("x [E1-1, E7-3] [Q-gl; Q-sales] [Exhibit] [E2]")).toEqual(["E1-1", "E7-3", "Q-gl", "Q-sales", "E2"]);
    expect(reviewMemo("Margin fell [E1-1, E7-3]. Residual CAD 0.", facts, new Set(["E1-1"]))).toEqual(["Unknown evidence ids: E7-3"]);
  });

  it("factsBlock lists only existing evidence ids for unresolved findings", () => {
    const plan = { metric: "gross_margin" as const, periodA: "2026-08", periodB: "2026-09", answerable: true, missingData: null, hypotheses: [] };
    const f = { id: "F-h4-r2", hypothesisId: "h4", driverType: "fx" as const, claim: "fx moved", amountCad: null, evidenceIds: ["E4-1", "E4-9"], entities: [], agent: "I", round: 2, supported: false, sqlCalls: 1, repairs: 0, verdict: { verdict: "needs_more" as const, reason: "not traced", by: "Skeptic" } };
    const evidence = new Map([["E4-1", { id: "E4-1", sql: "S", sources: [], headers: [], rows: [], rowCount: 1, agent: "I" }]]);
    const facts2 = factsBlock(plan, null, [f], evidence, []);
    expect(facts2).toContain("[E4-1]");
    expect(facts2).not.toContain("E4-9");
  });
});

describe("security: periods are validated before SQL is built", () => {
  const INJECTION = "2026-08') OR 1=1 --";

  it("isPeriod accepts YYYY-MM only", () => {
    expect(isPeriod("2026-09")).toBe(true);
    for (const bad of ["2026-13", "2026-9", "202609", INJECTION, "", 202609]) expect(isPeriod(bad)).toBe(false);
  });

  it("quantQueries refuses to build SQL from a malformed period", () => {
    expect(() => quantQueries(INJECTION, "2026-09")).toThrow(/YYYY-MM/);
  });

  it("runInvestigation fails the run before sending any SQL", async () => {
    const sent: string[] = [];
    const zetaris = new ZetarisClient({ restUrl: "http://zetaris.test", orgId: "1", apiKey: "test", mode: "live", fetchImpl: (async (_u: unknown, init?: RequestInit) => (sent.push(String(init?.body)), new Response("{}"))) as typeof fetch });
    const dir = mkdtempSync(join(tmpdir(), "fm-inj-"));
    const out = await runInvestigation({ question: "q", periodA: INJECTION, periodB: "2026-09" }, { zetaris, llm: fakeLlm([]).llm, memory: new DetectiveMemory(join(dir, "m")), logDir: join(dir, "logs") });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/Invalid period/);
    expect(sent).toEqual([]);
  });
});

describe("security: Investigator SQL must be read-only", () => {
  it.each([
    ["DROP TABLE finance_usl.vendor", /only SELECT/],
    ["SELECT 1; DELETE FROM finance_usl.vendor", /one statement/],
    ["WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", /INSERT/],
    ["SELECT 1 -- '\n; DROP TABLE x --'", /one statement/],
    ["/* hi */ ALTER TABLE t ADD COLUMNS (x INT)", /only SELECT/],
  ])("refuses %j", (sql, why) => {
    expect(readOnlySqlProblem(sql)).toMatch(why);
  });

  it.each(["SELECT * FROM t WHERE note = 'DELETE; me'", "-- delete old rows?\nSELECT 1", "SELECT 'it''s -- fine' AS a", "select updated_at from t ;", "DESCRIBE finance_usl.vendor", "SHOW TABLES IN finance_usl"])("allows %j", (sql) => {
    expect(readOnlySqlProblem(sql)).toBeNull();
  });

  it("a refused query never reaches Zetaris and gets no evidence id", async () => {
    const { llm, provider } = fakeLlm([{ toolCalls: [toolCall("c1", { sql: "DROP TABLE finance_usl.vendor" })] }, JSON.stringify({ supported: false, claim: "nothing found", amount_cad: null, evidence: [], entities: [], confidence: "low" })]);
    let ran = 0;
    let n = 0;
    const { finding, evidence } = await runInvestigator({ llm, runSql: async () => (ran++, sqlResult([], [])), hypothesis: { id: "h1", driverType: "mix", text: "mix shifted", checks: "" }, periodA: "2026-08", periodB: "2026-09", schema: "", memoryHints: "", agent: "Investigator-h1", round: 1, nextEvidenceId: () => `E1-${++n}`, emit: () => {} });
    expect(ran).toBe(0);
    expect(evidence).toEqual([]);
    expect(finding.sqlCalls).toBe(0);
    expect(provider.requests[1].messages.at(-1)!.content).toMatch(/query refused/);
  });
});

describe("Zetaris: malformed 200 responses", () => {
  const client = (body: string) => new ZetarisClient({ restUrl: "http://zetaris.test", orgId: "1", apiKey: "test", mode: "live", fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch });

  it("a non-JSON body is a ZetarisError carrying the SQL", async () => {
    const err = await client("<html>proxy login</html>").runSql("SELECT 1").catch((e) => e);
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.sql).toBe("SELECT 1");
    expect(err.message).toMatch(/non-JSON/);
  });

  it("data that is not an array of rows is a ZetarisError", async () => {
    for (const body of ['{"headers": ["a"], "data": "oops"}', '{"headers": ["a"], "data": [1, 2]}', '{"headers": "a", "data": []}']) {
      await expect(client(body).runSql("SELECT 1")).rejects.toBeInstanceOf(ZetarisError);
    }
  });
});
