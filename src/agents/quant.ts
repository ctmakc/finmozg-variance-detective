/**
 * Quant: the deterministic margin bridge. Fixed SQL against the finance_usl semantic layer through Zetaris,
 * then pure arithmetic (src/quant/bridge.ts). No LLM touches these numbers.
 */
import { computeMarginBridge, type BridgeResult, type PeriodCell, type PeriodInput } from "../quant/bridge.js";
import { type SqlResult, asObjects } from "../zetaris/client.js";
import type { BridgeComponent, Emit, EvidenceItem } from "./types.js";

export const USL = "lightning.metastore.finmozg.finance_usl";

export type RunSql = (sql: string, label: string) => Promise<SqlResult>;

export interface QuantResult {
  bridge: BridgeResult;
  components: BridgeComponent[];
  /** GM% change split exactly into percentage points: Σ pp = gmPctB − gmPctA. */
  rate: { gmPctA: number; gmPctB: number; deltaPp: number; items: { key: string; pp: number }[] };
  reconciliation: { check: string; periodA: number; periodB: number; ok: boolean }[];
  glByAccount: { period: string; account: string; name: string; type: string; amountCad: number }[];
  duplicates: { period: string; vendorInvoiceNo: string; apDocs: number; payments: number; amountCad: number }[];
  /** Drill-downs for period B: who caused it. */
  overContract: { vendorId: string; vendorName: string; lines: number; excessCad: number }[];
  customerShift: { customerId: string; customerName: string; channel: string; qtyA: number; qtyB: number }[];
  names: Record<string, string>;
  evidence: EvidenceItem[];
}

const num = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s));
const r2 = (x: number) => Math.round(x * 100) / 100;

export function quantQueries(a: string, b: string) {
  const periods = `('${a}', '${b}')`;
  return {
    sales: `SELECT s.period, s.sku, c.channel, SUM(s.qty) AS qty, SUM(s.revenue_cad) AS revenue_cad
FROM ${USL}.sales_line s JOIN ${USL}.customer c ON c.customer_id = s.customer_id
WHERE s.period IN ${periods} GROUP BY s.period, s.sku, c.channel ORDER BY s.period, s.sku, c.channel`,
    costs: `SELECT period, sku, currency, SUM(qty) AS qty, SUM(amount_cad) AS amount_cad, SUM(qty * unit_price_orig) AS amount_orig,
MAX(contract_unit_price) AS contract_unit_price, MAX(fx_rate) AS fx_rate, MAX(vendor_id) AS vendor_id
FROM ${USL}.purchase_line WHERE period IN ${periods} AND sku <> 'PKG' GROUP BY period, sku, currency ORDER BY period, sku`,
    gl: `SELECT period, account_code, account_name, account_type, amount_cad FROM ${USL}.gl_balance WHERE period IN ${periods} ORDER BY period, account_code`,
    duplicates: `SELECT b.period, b.vendor_invoice_no, COUNT(DISTINCT b.ap_doc_id) AS ap_docs, COALESCE(MAX(p.n), 0) AS payments, MAX(b.amount_cad) AS amount_cad
FROM ${USL}.vendor_bill b
LEFT JOIN (SELECT vendor_invoice_no, COUNT(*) AS n FROM ${USL}.vendor_payment GROUP BY vendor_invoice_no) p ON p.vendor_invoice_no = b.vendor_invoice_no
WHERE b.period IN ${periods}
GROUP BY b.period, b.vendor_invoice_no HAVING COUNT(DISTINCT b.ap_doc_id) > GREATEST(COALESCE(MAX(p.n), 0), 1)`,
    overContract: `SELECT l.vendor_id, v.vendor_name, COUNT(*) AS lines, ROUND(SUM((l.unit_price_orig - l.contract_unit_price) * l.qty * l.fx_rate), 2) AS excess_cad
FROM ${USL}.purchase_line l JOIN ${USL}.vendor v ON v.vendor_id = l.vendor_id
WHERE l.period = '${b}' AND l.contract_unit_price IS NOT NULL AND l.unit_price_orig > l.contract_unit_price + 0.0001
GROUP BY l.vendor_id, v.vendor_name ORDER BY excess_cad DESC`,
    customerShift: `SELECT s.customer_id, c.customer_name, c.channel,
SUM(CASE WHEN s.period = '${a}' THEN s.qty ELSE 0 END) AS qty_a, SUM(CASE WHEN s.period = '${b}' THEN s.qty ELSE 0 END) AS qty_b
FROM ${USL}.sales_line s JOIN ${USL}.customer c ON c.customer_id = s.customer_id
WHERE s.period IN ${periods} GROUP BY s.customer_id, c.customer_name, c.channel
ORDER BY SUM(CASE WHEN s.period = '${b}' THEN s.qty ELSE 0 END) - SUM(CASE WHEN s.period = '${a}' THEN s.qty ELSE 0 END) DESC LIMIT 5`,
    vendorNames: `SELECT vendor_id, vendor_name FROM ${USL}.vendor`,
  };
}

export function buildPeriodInput(period: string, sales: Record<string, string>[], costs: Record<string, string>[], glPackaging: number, bookingError: number): PeriodInput {
  const costBySku = new Map(costs.filter((c) => c.period === period).map((c) => [c.sku, c]));
  const cells: PeriodCell[] = sales
    .filter((s) => s.period === period)
    .map((s) => {
      const qty = num(s.qty);
      const c = costBySku.get(s.sku);
      const purchasedQty = num(c?.qty);
      const unitCostCad = purchasedQty ? num(c?.amount_cad) / purchasedQty : 0;
      const isUsd = c?.currency === "USD";
      return {
        sku: s.sku,
        channel: s.channel,
        qty,
        unitPriceCad: qty ? num(s.revenue_cad) / qty : 0,
        unitCostCad,
        ...(isUsd
          ? { isUsd: true, unitPriceUsd: purchasedQty ? num(c?.amount_orig) / purchasedQty : 0, fxRate: num(c?.fx_rate), contractUnitPriceUsd: num(c?.contract_unit_price) }
          : {}),
      };
    });
  return { cells, packagingCad: glPackaging, bookingErrorPkgCad: bookingError };
}

/** Exact split of the GM% change: comp/revenueB for each dollar component, plus the scale term GM_A·(1/R_B − 1/R_A). */
export function rateBridge(b: BridgeResult) {
  const pp = (x: number) => (b.revenueB ? (x / b.revenueB) * 100 : 0);
  const scale = b.revenueA && b.revenueB ? b.gmA * (1 / b.revenueB - 1 / b.revenueA) * 100 : 0;
  const items = [
    { key: "volume", pp: pp(b.volume) + scale },
    { key: "mix", pp: pp(b.mix) },
    { key: "price", pp: pp(b.price) },
    { key: "supplierPrice", pp: pp(b.supplierPrice) },
    { key: "fx", pp: pp(b.fx) },
    { key: "otherCost", pp: pp(b.otherCost) },
    { key: "bookingError", pp: pp(b.bookingError) },
    { key: "packagingReal", pp: pp(b.packagingReal) },
    { key: "residual", pp: pp(b.residual) },
  ].map((i) => ({ key: i.key, pp: Math.round(i.pp * 100) / 100 }));
  return { gmPctA: Math.round(b.gmPctA * 10000) / 100, gmPctB: Math.round(b.gmPctB * 10000) / 100, deltaPp: Math.round((b.gmPctB - b.gmPctA) * 10000) / 100, items };
}

export const COMPONENT_META: { key: keyof BridgeResult; label: string; driverType: BridgeComponent["driverType"] }[] = [
  { key: "volume", label: "Volume", driverType: "volume" },
  { key: "mix", label: "Customer / product mix", driverType: "mix" },
  { key: "price", label: "Selling price", driverType: "price" },
  { key: "supplierPrice", label: "Supplier unit price", driverType: "supplier_price" },
  { key: "fx", label: "USD/CAD exchange rate", driverType: "fx" },
  { key: "otherCost", label: "Other goods cost", driverType: "other_cost" },
  { key: "bookingError", label: "Booking error (duplicate invoice)", driverType: "booking_error" },
  { key: "packagingReal", label: "Packaging spend", driverType: "packaging" },
  { key: "residual", label: "Unexplained residual", driverType: "residual" },
];

export async function runQuant(runSql: RunSql, periodA: string, periodB: string, emit: Emit): Promise<QuantResult> {
  const q = quantQueries(periodA, periodB);
  const evidence: EvidenceItem[] = [];
  const exec = async (key: keyof typeof q, sources: string[]) => {
    const res = await runSql(q[key], `quant:${key}`);
    evidence.push({ id: `Q-${key}`, sql: q[key], sources, headers: res.headers, rows: res.rows.slice(0, 50), rowCount: res.total, queryId: res.queryId, agent: "Quant" });
    return asObjects(res);
  };
  const sales = await exec("sales", ["finance_usl.sales_line", "finance_usl.customer"]);
  const costs = await exec("costs", ["finance_usl.purchase_line"]);
  const gl = await exec("gl", ["finance_usl.gl_balance"]);
  const dups = await exec("duplicates", ["finance_usl.vendor_bill", "finance_usl.vendor_payment"]);
  const over = await exec("overContract", ["finance_usl.purchase_line", "finance_usl.vendor"]);
  const shift = await exec("customerShift", ["finance_usl.sales_line", "finance_usl.customer"]);
  const vnames = await exec("vendorNames", ["finance_usl.vendor"]);
  const overContract = over.map((o) => ({ vendorId: o.vendor_id, vendorName: o.vendor_name, lines: num(o.lines), excessCad: num(o.excess_cad) }));
  const customerShift = shift.map((s) => ({ customerId: s.customer_id, customerName: s.customer_name, channel: s.channel, qtyA: num(s.qty_a), qtyB: num(s.qty_b) }));
  const names: Record<string, string> = Object.fromEntries([...vnames.map((v) => [v.vendor_id, v.vendor_name]), ...customerShift.map((c) => [c.customerId, c.customerName])]);

  const glAmount = (period: string, account: string) => num(gl.find((g) => g.period === period && g.account_code === account)?.amount_cad);
  const duplicates = dups.map((d) => ({ period: d.period, vendorInvoiceNo: d.vendor_invoice_no, apDocs: num(d.ap_docs), payments: num(d.payments), amountCad: num(d.amount_cad) }));
  const bookingErr = (p: string) => duplicates.filter((d) => d.period === p).reduce((s, d) => s + (d.apDocs - Math.max(d.payments, 1)) * d.amountCad, 0);

  const inA = buildPeriodInput(periodA, sales, costs, glAmount(periodA, "5100"), bookingErr(periodA));
  const inB = buildPeriodInput(periodB, sales, costs, glAmount(periodB, "5100"), bookingErr(periodB));
  const bridge = computeMarginBridge(inA, inB);

  const salesRevenue = (p: string) => sales.filter((s) => s.period === p).reduce((s, x) => s + num(x.revenue_cad), 0);
  const goodsCost = (inp: PeriodInput) => inp.cells.reduce((s, c) => s + c.qty * c.unitCostCad, 0);
  const reconciliation = [
    { check: "Revenue: GL 4000 vs order lines", periodA: r2(glAmount(periodA, "4000") - salesRevenue(periodA)), periodB: r2(glAmount(periodB, "4000") - salesRevenue(periodB)) },
    { check: "Goods COGS: GL 5000 vs units sold × AP unit cost", periodA: r2(glAmount(periodA, "5000") - goodsCost(inA)), periodB: r2(glAmount(periodB, "5000") - goodsCost(inB)) },
  ].map((r) => ({ ...r, ok: Math.abs(r.periodA) < 1 && Math.abs(r.periodB) < 1 }));

  const components: BridgeComponent[] = COMPONENT_META.map((m) => ({
    key: String(m.key),
    label: m.label,
    driverType: m.driverType,
    amountCad: r2(bridge[m.key] as number),
    ppOfRevenueB: r2(bridge.revenueB ? ((bridge[m.key] as number) / bridge.revenueB) * 100 : 0),
  }));
  const rate = rateBridge(bridge);
  const glByAccount = gl.map((g) => ({ period: g.period, account: g.account_code, name: g.account_name, type: g.account_type, amountCad: num(g.amount_cad) }));

  emit("Quant", "bridge", {
    gmPctA: rate.gmPctA,
    gmPctB: rate.gmPctB,
    deltaGm: r2(bridge.deltaGm),
    components: components.map((c) => ({ key: c.key, amountCad: c.amountCad })),
    reconciliation,
    duplicates,
    overContract: overContract.slice(0, 3),
    topCustomerShift: customerShift.slice(0, 2),
  });
  return { bridge, components, rate, reconciliation, glByAccount, duplicates, overContract, customerShift, names, evidence };
}
