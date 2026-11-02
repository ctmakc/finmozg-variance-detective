import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuantResult } from "../src/agents/quant.ts";
import { MAX_SKEPTIC_ROUNDS, ruleCheck, runSkeptic, tolerance } from "../src/agents/skeptic.ts";
import type { EvidenceItem, Finding, Plan } from "../src/agents/types.ts";
import { DetectiveMemory } from "../src/memory/hmem.ts";
import { fakeLlm, recorder } from "./helpers/fakes.ts";

const plan = (metric: Plan["metric"] = "gross_margin"): Plan => ({ metric, periodA: "2026-08", periodB: "2026-09", answerable: true, missingData: null, hypotheses: [] });

function quant(amounts: Record<string, number> = {}): QuantResult {
  const keys = ["volume", "mix", "price", "supplierPrice", "fx", "otherCost", "bookingError", "packagingReal", "residual"];
  return {
    bridge: { revenueB: 360000 } as QuantResult["bridge"],
    components: keys.map((key) => ({ key, label: key, driverType: "other_cost" as never, amountCad: amounts[key] ?? 0, ppOfRevenueB: 0 })),
    rate: { gmPctA: 0, gmPctB: 0, deltaPp: 0, items: [] },
    reconciliation: [],
    glByAccount: [],
    duplicates: [{ period: "2026-09", vendorInvoiceNo: "MRP-88213", apDocs: 2, payments: 1, amountCad: 12450 }],
    overContract: [{ vendorId: "VEND-SNC", vendorName: "Sierra Nut Co.", lines: 3, excessCad: 9116 }],
    customerShift: [{ customerId: "CUST-W01", customerName: "Capital Wholesale", channel: "wholesale", qtyA: 1102, qtyB: 2353 }],
    names: { "VEND-SNC": "Sierra Nut Co.", "CUST-W01": "Capital Wholesale" },
    evidence: [],
  };
}

const ev = (id: string, sources: string[], headers: string[] = ["x"], rowCount = 2): EvidenceItem => ({ id, sql: "SELECT", sources, headers, rows: Array.from({ length: rowCount }, () => headers.map(() => "1")), rowCount, agent: "I" });
const finding = (over: Partial<Finding>): Finding => ({ id: "F-h1-r1", hypothesisId: "h1", driverType: "supplier_price", claim: "Sierra Nut Co. (VEND-SNC) invoiced above contract", amountCad: -9116, evidenceIds: ["E1-1"], entities: ["VEND-SNC"], agent: "I", round: 1, supported: true, sqlCalls: 1, repairs: 0, ...over });

describe("tolerance", () => {
  it("is the largest of CAD 1,000, 10 % of the component and 0.05 % of B revenue", () => {
    expect(tolerance(500, 100000)).toBe(1000);
    expect(tolerance(-50000, 100000)).toBe(5000);
    expect(tolerance(0, 10_000_000)).toBe(5000);
  });
});

describe("ruleCheck: no claim without evidence rows", () => {
  it("a supported claim citing no rows is sent back, then rejected in the last round", () => {
    const f = finding({ evidenceIds: [] });
    expect(ruleCheck(f, [], plan(), quant({ supplierPrice: -9116 }), 1)).toMatchObject({ verdict: "needs_more", sendBack: expect.stringContaining("Cite") });
    expect(ruleCheck(f, [], plan(), quant({ supplierPrice: -9116 }), MAX_SKEPTIC_ROUNDS)).toMatchObject({ verdict: "rejected", reason: "No evidence rows behind the claim." });
  });

  it("evidence that errored or returned zero rows does not count", () => {
    const errored = { ...ev("E1-1", ["finance_usl.purchase_line"]), error: "syntax error" };
    const empty = ev("E1-2", ["finance_usl.purchase_line"], ["contract_unit_price"], 0);
    expect(ruleCheck(finding({}), [errored, empty], plan(), quant(), MAX_SKEPTIC_ROUNDS).verdict).toBe("rejected");
  });

  it("a data gap is accepted because it claims no number", () => {
    expect(ruleCheck(finding({ driverType: "data_gap", evidenceIds: [] }), [], plan("other"), null, 1).verdict).toBe("accepted");
  });
});

describe("ruleCheck: the deterministic bridge is the reference", () => {
  const rows = [ev("E1-1", ["finance_usl.purchase_line"], ["vendor_id", "unit_price_orig", "contract_unit_price"])];

  it("accepts a named, reconciling supplier-price claim", () => {
    const d = ruleCheck(finding({}), rows, plan(), quant({ supplierPrice: -9116 }), 1);
    expect(d).toMatchObject({ verdict: "accepted", bridgeAmountCad: -9116 });
  });

  it("sends back an amount that does not reconcile, then accepts the bridge figure in the last round", () => {
    const f = finding({ amountCad: -30000 });
    expect(ruleCheck(f, rows, plan(), quant({ supplierPrice: -9116 }), 1)).toMatchObject({ verdict: "needs_more", bridgeAmountCad: -9116 });
    const last = ruleCheck(f, rows, plan(), quant({ supplierPrice: -9116 }), MAX_SKEPTIC_ROUNDS);
    expect(last.verdict).toBe("accepted");
    expect(last.reason).toContain("taken from the deterministic bridge (CAD -9116)");
  });

  it("rejects a driver the bridge measures at (near) zero", () => {
    const d = ruleCheck(finding({ driverType: "price", claim: "prices fell", entities: [] }), [ev("E1-1", ["finance_usl.sales_line"])], plan(), quant({ price: 40 }), 1);
    expect(d).toMatchObject({ verdict: "rejected", bridgeAmountCad: 40 });
  });

  it("challenges an unsupported finding when the bridge says the driver moved", () => {
    const d = ruleCheck(finding({ supported: false, driverType: "fx" }), [], plan(), quant({ fx: -5000 }), 1);
    expect(d).toMatchObject({ verdict: "needs_more", bridgeAmountCad: -5000 });
    expect(d.sendBack).toContain("CAD -5000 for fx");
  });

  it("asks a supplier-price claim to name the vendor from Quant's drill-down", () => {
    const d = ruleCheck(finding({ claim: "a vendor invoiced above contract", entities: [] }), rows, plan(), quant({ supplierPrice: -9116 }), 1);
    expect(d).toMatchObject({ verdict: "needs_more" });
    expect(d.sendBack).toContain("VEND-SNC");
  });

  it("requires bank evidence for a booking error", () => {
    const f = finding({ driverType: "booking_error", claim: "MRP-88213 booked twice", amountCad: -12450 });
    const apOnly = [ev("E1-1", ["finance_usl.vendor_bill"])];
    expect(ruleCheck(f, apOnly, plan(), quant({ bookingError: -12450 }), 1).sendBack).toContain("vendor_payment");
    expect(ruleCheck(f, [...apOnly, ev("E1-2", ["finance_usl.vendor_payment"])], plan(), quant({ bookingError: -12450 }), 1).verdict).toBe("accepted");
  });
});

describe("ruleCheck: chart of accounts", () => {
  it("rejects opex as a gross-margin driver", () => {
    const d = ruleCheck(finding({ driverType: "opex", claim: "marketing rose", entities: [] }), [ev("E1-1", ["finance_usl.gl_balance"])], plan(), quant(), 1);
    expect(d.verdict).toBe("rejected");
    expect(d.reason).toContain("below gross margin");
  });

  it("rejects a COGS driver on an opex question", () => {
    expect(ruleCheck(finding({}), [ev("E1-1", ["finance_usl.purchase_line"])], plan("opex"), quant(), 1).verdict).toBe("rejected");
  });
});

describe("runSkeptic (model mocked)", () => {
  it("rejects an accepted cost claim when the Markovian evidence review contradicts it", async () => {
    const reply = `Checked the batch.\nVERDICT_JSON: ${JSON.stringify({ verdict: "contradicted", reasons: ["lines are at contract"], flagged_rows: [] })}\n[TASK_COMPLETE]`;
    const { llm } = fakeLlm(Array.from({ length: 6 }, () => reply));
    const memory = new DetectiveMemory(mkdtempSync(join(tmpdir(), "fm-sk-")));
    const f = finding({});
    const evidence = new Map([["E1-1", ev("E1-1", ["finance_usl.purchase_line"], ["vendor_id", "unit_price_orig", "contract_unit_price"])]]);
    const { emit, events } = recorder();
    const [d] = await runSkeptic({ llm, memory, runId: "r1", plan: plan(), quant: quant({ supplierPrice: -9116 }), findings: [f], evidence, round: 1, emit });
    expect(d.verdict).toBe("rejected");
    expect(f.verdict?.verdict).toBe("rejected");
    expect(events.some((e) => e.type === "review")).toBe(true);
  });

  it("keeps the rule verdict when the review call fails", async () => {
    const { llm } = fakeLlm([]); // every model call throws
    const memory = new DetectiveMemory(mkdtempSync(join(tmpdir(), "fm-sk-")));
    const f = finding({});
    const evidence = new Map([["E1-1", ev("E1-1", ["finance_usl.purchase_line"], ["vendor_id", "contract_unit_price"])]]);
    const [d] = await runSkeptic({ llm, memory, runId: "r1", plan: plan(), quant: quant({ supplierPrice: -9116 }), findings: [f], evidence, round: 1, emit: () => {} });
    expect(d.verdict).toBe("accepted");
  });

  it("ignores cited evidence ids that are not in the run", async () => {
    const { llm } = fakeLlm([]);
    const memory = new DetectiveMemory(mkdtempSync(join(tmpdir(), "fm-sk-")));
    const f = finding({ evidenceIds: ["E404"] });
    const [d] = await runSkeptic({ llm, memory, runId: "r1", plan: plan(), quant: quant({ supplierPrice: -9116 }), findings: [f], evidence: new Map(), round: MAX_SKEPTIC_ROUNDS, emit: () => {} });
    expect(d.verdict).toBe("rejected");
  });
});
