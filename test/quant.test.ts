import { describe, expect, it } from "vitest";
import { buildPeriodInput, COMPONENT_META, quantQueries, rateBridge, runQuant, USL } from "../src/agents/quant.ts";
import { computeMarginBridge } from "../src/quant/bridge.ts";
import type { SqlResult } from "../src/zetaris/client.ts";
import { recorder, sqlResult } from "./helpers/fakes.ts";

const A = "2026-08";
const B = "2026-09";

/** A small two-period ledger, as the finance_usl queries would return it. */
function fixture(opts: { glRevenueB?: number } = {}): Record<string, SqlResult> {
  const sales = sqlResult(
    ["period", "sku", "channel", "qty", "revenue_cad"],
    [
      [A, "NUT-ALM", "retail", 1000, 20000],
      [A, "NUT-ALM", "wholesale", 500, 7500],
      [A, "BAR-01", "retail", 800, 8000],
      [B, "NUT-ALM", "retail", 900, 18000],
      [B, "NUT-ALM", "wholesale", 1200, 18000],
      [B, "BAR-01", "retail", 800, 8400],
    ],
  );
  // NUT-ALM bought in USD: A 8.00 USD @1.30 (contract 8.00), B 8.40 USD @1.35 (contract 8.00)
  const costs = sqlResult(
    ["period", "sku", "currency", "qty", "amount_cad", "amount_orig", "contract_unit_price", "fx_rate", "vendor_id"],
    [
      [A, "BAR-01", "CAD", 800, 4000, 4000, null, null, "VEND-CAD"],
      [A, "NUT-ALM", "USD", 1500, 15600, 12000, 8, 1.3, "VEND-SNC"],
      [B, "BAR-01", "CAD", 800, 4400, 4400, null, null, "VEND-CAD"],
      [B, "NUT-ALM", "USD", 2100, 23814, 17640, 8, 1.35, "VEND-SNC"],
    ],
  );
  const revenueA = 20000 + 7500 + 8000;
  const revenueB = 18000 + 18000 + 8400;
  const gl = sqlResult(
    ["period", "account_code", "account_name", "account_type", "amount_cad"],
    [
      [A, "4000", "Sales", "revenue", revenueA],
      [A, "5000", "COGS goods", "cogs", 4000 + 15600],
      [A, "5100", "Packaging", "cogs", 1000],
      [A, "6100", "Marketing", "opex", 3000],
      [B, "4000", "Sales", "revenue", opts.glRevenueB ?? revenueB],
      [B, "5000", "COGS goods", "cogs", 4400 + 23814],
      [B, "5100", "Packaging", "cogs", 1700],
      [B, "6100", "Marketing", "opex", 9000],
    ],
  );
  const duplicates = sqlResult(["period", "vendor_invoice_no", "ap_docs", "payments", "amount_cad"], [[B, "MRP-1", 2, 1, 600]]);
  const overContract = sqlResult(["vendor_id", "vendor_name", "lines", "excess_cad"], [["VEND-SNC", "Sierra Nut Co.", 3, 1134]]);
  const customerShift = sqlResult(["customer_id", "customer_name", "channel", "qty_a", "qty_b"], [["CUST-W01", "Capital Wholesale", "wholesale", 500, 1200]]);
  const vendorNames = sqlResult(["vendor_id", "vendor_name"], [["VEND-SNC", "Sierra Nut Co."], ["VEND-CAD", "Prairie Bars"]]);
  return { sales, costs, gl, duplicates, overContract, customerShift, vendorNames };
}

function fakeRunSql(results: Record<string, SqlResult>) {
  const calls: { sql: string; label: string }[] = [];
  const runSql = async (sql: string, label: string) => {
    calls.push({ sql, label });
    const key = label.replace(/^quant:/, "");
    const r = results[key];
    if (!r) throw new Error(`unexpected query ${label}`);
    return r;
  };
  return { runSql, calls };
}

describe("quantQueries", () => {
  it("targets the finance_usl semantic layer for both periods and excludes packaging from goods cost", () => {
    const q = quantQueries(A, B);
    expect(Object.keys(q)).toEqual(["sales", "costs", "gl", "duplicates", "overContract", "customerShift", "vendorNames"]);
    for (const sql of Object.values(q)) expect(sql).toContain(USL);
    expect(q.sales).toContain(`('${A}', '${B}')`);
    expect(q.costs).toContain("sku <> 'PKG'");
    expect(q.overContract).toContain(`l.period = '${B}'`);
  });
});

describe("buildPeriodInput", () => {
  const f = fixture();
  const rows = (r: SqlResult) => r.rows.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])));

  it("derives unit price from revenue/qty and unit cost from AP amount/qty", () => {
    const p = buildPeriodInput(A, rows(f.sales), rows(f.costs), 1000, 0);
    const bar = p.cells.find((c) => c.sku === "BAR-01")!;
    expect(bar).toMatchObject({ qty: 800, unitPriceCad: 10, unitCostCad: 5 });
    expect(bar.isUsd).toBeUndefined();
    const nut = p.cells.find((c) => c.sku === "NUT-ALM" && c.channel === "wholesale")!;
    expect(nut.unitPriceCad).toBe(15);
    expect(nut.unitCostCad).toBeCloseTo(10.4, 10);
    expect(nut).toMatchObject({ isUsd: true, unitPriceUsd: 8, fxRate: 1.3, contractUnitPriceUsd: 8 });
    expect(p.packagingCad).toBe(1000);
  });

  it("only takes rows of the requested period", () => {
    const p = buildPeriodInput(B, rows(f.sales), rows(f.costs), 0, 0);
    expect(p.cells).toHaveLength(3);
    expect(p.cells.every((c) => c.qty > 0)).toBe(true);
  });

  it("a zero-quantity sales row gets zero unit price instead of Infinity/NaN", () => {
    const p = buildPeriodInput(A, [{ period: A, sku: "X", channel: "retail", qty: "0", revenue_cad: "0" }], [], 0, 0);
    expect(p.cells[0]).toMatchObject({ qty: 0, unitPriceCad: 0, unitCostCad: 0 });
  });

  it("a SKU sold without any AP purchase has zero unit cost (shows up in the COGS reconciliation)", () => {
    const p = buildPeriodInput(A, [{ period: A, sku: "X", channel: "retail", qty: "5", revenue_cad: "50" }], [], 0, 0);
    expect(p.cells[0].unitCostCad).toBe(0);
  });

  it("missing SQL values (NULL → empty string) parse as zero", () => {
    const p = buildPeriodInput(A, [{ period: A, sku: "X", channel: "retail", qty: "", revenue_cad: "" }], [], 0, 0);
    expect(p.cells[0]).toMatchObject({ qty: 0, unitPriceCad: 0 });
  });
});

describe("rateBridge", () => {
  it("splits the GM% change into pp that add up to the change", () => {
    const f = fixture();
    const rows = (r: SqlResult) => r.rows.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])));
    const br = computeMarginBridge(buildPeriodInput(A, rows(f.sales), rows(f.costs), 1000, 0), buildPeriodInput(B, rows(f.sales), rows(f.costs), 1700, 600));
    const rate = rateBridge(br);
    expect(rate.gmPctA).toBeCloseTo(Math.round(br.gmPctA * 10000) / 100, 10);
    expect(rate.items.map((i) => i.key)).toEqual(["volume", "mix", "price", "supplierPrice", "fx", "otherCost", "bookingError", "packagingReal", "residual"]);
    const sum = rate.items.reduce((s, i) => s + i.pp, 0);
    expect(Math.abs(sum - rate.deltaPp)).toBeLessThanOrEqual(0.05);
    for (const i of rate.items) expect(Math.round(i.pp * 100) / 100).toBe(i.pp);
  });

  it("returns zeros (not NaN) when a period has no revenue", () => {
    const br = computeMarginBridge({ cells: [], packagingCad: 0, bookingErrorPkgCad: 0 }, { cells: [], packagingCad: 0, bookingErrorPkgCad: 0 });
    const rate = rateBridge(br);
    expect(rate.deltaPp).toBe(0);
    for (const i of rate.items) expect(i.pp).toBe(0);
  });
});

describe("runQuant (Zetaris mocked)", () => {
  it("runs the seven fixed queries and records each as Q-* evidence with its SQL and sources", async () => {
    const { runSql, calls } = fakeRunSql(fixture());
    const { emit, events } = recorder();
    const q = await runQuant(runSql, A, B, emit);
    expect(calls.map((c) => c.label)).toEqual(["quant:sales", "quant:costs", "quant:gl", "quant:duplicates", "quant:overContract", "quant:customerShift", "quant:vendorNames"]);
    expect(q.evidence.map((e) => e.id)).toEqual(["Q-sales", "Q-costs", "Q-gl", "Q-duplicates", "Q-overContract", "Q-customerShift", "Q-vendorNames"]);
    for (const e of q.evidence) {
      expect(e.sql).toContain(USL);
      expect(e.sources.length).toBeGreaterThan(0);
      expect(e.agent).toBe("Quant");
      expect(e.rowCount).toBe(e.rows.length);
    }
    expect(events.find((e) => e.type === "bridge")).toBeTruthy();
  });

  it("every bridge component is traceable to Q-* evidence rows and reconciles to ΔGM", async () => {
    const { runSql } = fakeRunSql(fixture());
    const q = await runQuant(runSql, A, B, () => {});
    // ΔGM from the raw GL rows: revenue − goods COGS − packaging
    const gmA = 35500 - 19600 - 1000;
    const gmB = 44400 - 28214 - 1700;
    expect(q.bridge.deltaGm).toBeCloseTo(gmB - gmA, 6);
    const sum = q.components.reduce((s, c) => s + c.amountCad, 0);
    expect(sum).toBeCloseTo(q.bridge.deltaGm, 1); // cents rounding per line only
    expect(q.components.map((c) => c.key)).toEqual(COMPONENT_META.map((m) => m.key));
    for (const c of q.components) expect(Math.round(c.amountCad * 100) / 100).toBe(c.amountCad);
  });

  it("booking error = (AP docs − payments) × amount, and moves packaging out of real spend", async () => {
    const { runSql } = fakeRunSql(fixture());
    const q = await runQuant(runSql, A, B, () => {});
    expect(q.duplicates).toEqual([{ period: B, vendorInvoiceNo: "MRP-1", apDocs: 2, payments: 1, amountCad: 600 }]);
    expect(q.components.find((c) => c.key === "bookingError")!.amountCad).toBe(-600);
    // packaging 1000 → 1700, of which 600 is the duplicate
    expect(q.components.find((c) => c.key === "packagingReal")!.amountCad).toBe(-100);
  });

  it("splits the USD goods-cost change into FX and supplier price at B quantities", async () => {
    const { runSql } = fakeRunSql(fixture());
    const q = await runQuant(runSql, A, B, () => {});
    // NUT-ALM: B qty 2100, uB 8.40 USD, fx 1.30 → 1.35, uA 8.00
    expect(q.bridge.fx).toBeCloseTo(-2100 * 8.4 * 0.05, 6);
    expect(q.bridge.supplierPrice).toBeCloseTo(-2100 * 0.4 * 1.3, 6);
    // BAR-01 CAD cost 5.00 → 5.50 on 800 units
    expect(q.bridge.otherCost).toBeCloseTo(-400, 6);
  });

  it("reconciliation ties when GL matches the order lines, and flags the gap when it does not", async () => {
    const ok = await runQuant(fakeRunSql(fixture()).runSql, A, B, () => {});
    expect(ok.reconciliation.every((r) => r.ok)).toBe(true);
    const bad = await runQuant(fakeRunSql(fixture({ glRevenueB: 44400 + 250 })).runSql, A, B, () => {});
    const rev = bad.reconciliation.find((r) => r.check.startsWith("Revenue"))!;
    expect(rev).toMatchObject({ periodA: 0, periodB: 250, ok: false });
  });

  it("names vendors and customers from the drill-down queries", async () => {
    const q = await runQuant(fakeRunSql(fixture()).runSql, A, B, () => {});
    expect(q.names).toMatchObject({ "VEND-SNC": "Sierra Nut Co.", "CUST-W01": "Capital Wholesale" });
    expect(q.overContract[0]).toEqual({ vendorId: "VEND-SNC", vendorName: "Sierra Nut Co.", lines: 3, excessCad: 1134 });
    expect(q.customerShift[0]).toMatchObject({ customerId: "CUST-W01", qtyA: 500, qtyB: 1200 });
    expect(q.glByAccount.filter((g) => g.type === "opex").map((g) => g.amountCad)).toEqual([3000, 9000]);
  });

  it("propagates a Zetaris failure instead of producing a partial bridge", async () => {
    const results = fixture();
    delete (results as Record<string, unknown>).gl;
    await expect(runQuant(fakeRunSql(results).runSql, A, B, () => {})).rejects.toThrow(/unexpected query quant:gl/);
  });
});
