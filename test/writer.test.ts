import { describe, expect, it } from "vitest";
import type { QuantResult } from "../src/agents/quant.ts";
import type { EvidenceItem, Finding, Plan } from "../src/agents/types.ts";
import { completeMemo, DISCLAIMER, factsBlock, normaliseHeadings, reviewMemo, runWriter, unknownAmounts } from "../src/agents/writer.ts";
import { fakeLlm, recorder } from "./helpers/fakes.ts";

const plan: Plan = { metric: "gross_margin", periodA: "2026-08", periodB: "2026-09", answerable: true, missingData: null, hypotheses: [] };

function quant(): QuantResult {
  const comp = (key: string, label: string, driverType: string, amountCad: number) => ({ key, label, driverType: driverType as never, amountCad, ppOfRevenueB: 0 });
  return {
    bridge: { gmA: 114821, gmB: 104787, revenueA: 319567, revenueB: 359468, deltaGm: -10034 } as QuantResult["bridge"],
    components: [comp("bookingError", "Booking error (duplicate invoice)", "booking_error", -12450), comp("mix", "Customer / product mix", "mix", -6517), comp("residual", "Unexplained residual", "residual", 0)],
    rate: { gmPctA: 35.93, gmPctB: 29.15, deltaPp: -6.78, items: [{ key: "bookingError", pp: -3.46 }, { key: "mix", pp: -1.81 }, { key: "residual", pp: 0 }] },
    reconciliation: [{ check: "Revenue: GL 4000 vs order lines", periodA: 0, periodB: 0, ok: true }],
    glByAccount: [{ period: "2026-09", account: "6100", name: "Marketing", type: "opex", amountCad: 21000 }],
    duplicates: [{ period: "2026-09", vendorInvoiceNo: "MRP-88213", apDocs: 2, payments: 1, amountCad: 12450 }],
    overContract: [],
    customerShift: [],
    names: { "VEND-MRP": "Maple Ridge Packaging" },
    evidence: [],
  };
}

const ev = (id: string): EvidenceItem => ({ id, sql: "SELECT 1", sources: ["finance_usl.vendor_bill"], headers: ["x"], rows: [["1"]], rowCount: 1, agent: "Investigator-h1" });
const finding = (over: Partial<Finding>): Finding => ({ id: "F-h1-r1", hypothesisId: "h1", driverType: "booking_error", claim: "MRP-88213 booked twice, paid once", amountCad: -12450, evidenceIds: ["E1-1"], entities: ["VEND-MRP"], agent: "Investigator-h1", round: 1, supported: true, sqlCalls: 1, repairs: 0, ...over });

const GOOD_MEMO = `## Answer
Gross margin fell by CAD 10,034 (-6.78 pp) [Q-sales] [Q-gl], mainly because invoice MRP-88213 was booked twice [E1-1]. The bank feed shows it was paid only once, so the second booking is an error the controller can reverse before the books close for the month [Q-duplicates].

## Drivers
- Booking error: -CAD 12,450 (-3.46 pp), Maple Ridge Packaging (VEND-MRP); reverse the duplicate entry [E1-1] [Q-duplicates].
- Customer / product mix: -CAD 6,517 (-1.81 pp) [Q-sales].

## Rejected explanations
- Marketing: opex sits below gross margin [Q-gl].

## Unexplained residual
CAD 0 (0 pp) [Q-gl].

## Open questions
- Was the duplicate already reversed in October?
- Did the vendor issue a credit note?
`;

describe("factsBlock", () => {
  it("carries every bridge line, its pp, and only evidence ids that exist", () => {
    const evidence = new Map([["E1-1", ev("E1-1")]]);
    const f = finding({ evidenceIds: ["E1-1", "E9-9"], verdict: { verdict: "accepted", reason: "bank shows one payment", by: "Skeptic" } });
    const facts = factsBlock(plan, quant(), [f], evidence, [{ hypothesis: "h6: marketing rose", reason: "opex is below GM" }]);
    expect(facts).toContain("Booking error (duplicate invoice): -CAD 12,450 (-3.46 pp)");
    expect(facts).toContain("Customer / product mix: -CAD 6,517 (-1.81 pp)");
    expect(facts).toContain("MRP-88213 booked 2× paid 1×");
    expect(facts).toContain("Maple Ridge Packaging (VEND-MRP)");
    expect(facts).toContain("evidence [E1-1]");
    expect(facts).not.toContain("E9-9");
    expect(facts).toContain("h6: marketing rose: opex is below GM");
  });

  it("leaves out findings the Skeptic did not accept", () => {
    const f = finding({ claim: "Unverified story", verdict: { verdict: "rejected", reason: "no rows", by: "Skeptic" } });
    expect(factsBlock(plan, quant(), [f], new Map(), [])).not.toContain("Unverified story");
  });

  it("works without a Quant result (data-gap runs)", () => {
    const facts = factsBlock({ ...plan, metric: "other" }, null, [], new Map(), []);
    expect(facts).toContain("Periods: base 2026-08, compared 2026-09");
    expect(facts).not.toContain("CAD");
  });
});

describe("unknownAmounts: no untraced CAD figures in the memo", () => {
  const facts = factsBlock(plan, quant(), [], new Map(), []);

  it("accepts figures copied from the facts, with or without sign and thousands separators", () => {
    expect(unknownAmounts("Fell by CAD 10,034 and -CAD 12,450 and CAD 6517 [Q-gl]", facts)).toEqual([]);
  });

  it("accepts rounding within 1 % of a known figure", () => {
    expect(unknownAmounts("about CAD 12,400", facts)).toEqual([]);
  });

  it("flags an invented figure", () => {
    expect(unknownAmounts("Vendor owes CAD 48,000 [E1-1]", facts)).toEqual(["CAD 48,000"]);
  });

  it("flags a figure written with a dollar sign", () => {
    expect(unknownAmounts("a $77,777 swing", facts)).toEqual(["$77,777"]);
  });

  it("lists each untraced figure once", () => {
    expect(unknownAmounts("CAD 55,555 then CAD 55,555 again", facts)).toEqual(["CAD 55,555"]);
  });

  it("ignores amounts under CAD 1,000", () => {
    expect(unknownAmounts("CAD 999", facts)).toEqual([]);
  });
});

describe("reviewMemo", () => {
  const facts = factsBlock(plan, quant(), [], new Map(), []);
  const ids = new Set(["E1-1", "Q-sales", "Q-gl", "Q-duplicates"]);

  it("passes a memo whose numbers and citations all trace back", () => {
    expect(reviewMemo(GOOD_MEMO, facts, ids)).toEqual([]);
  });

  it("flags unknown evidence ids", () => {
    expect(reviewMemo(`${GOOD_MEMO}\nSee [E7-3].`, facts, ids)).toEqual(["Unknown evidence ids: E7-3"]);
  });

  it("flags a memo with no residual statement", () => {
    expect(reviewMemo("## Answer\nMargin fell [Q-gl].", facts, ids)).toContain("The memo must state the unexplained residual.");
  });
});

describe("memo post-processing", () => {
  it("normaliseHeadings turns bold or colon section labels into ## headings and leaves other lines alone", () => {
    expect(normaliseHeadings("**Answer**\ntext\nDrivers:\n### open questions\n**Not a section**")).toBe("## Answer\ntext\n## Drivers\n## Open questions\n**Not a section**");
  });

  it("completeMemo inserts the residual from Quant before Open questions when the model left it out", () => {
    const m = completeMemo("## Answer\nx\n\n## Open questions\n- y", quant());
    expect(m).toContain("## Unexplained residual\nCAD 0 (0 pp) after all bridge lines [Q-sales] [Q-costs] [Q-gl].\n\n## Open questions");
  });

  it("completeMemo converts full-width citation brackets", () => {
    expect(completeMemo("see 【E1-1】", null)).toBe("see [E1-1]");
  });
});

describe("runWriter (model mocked)", () => {
  const evidence = new Map([["E1-1", ev("E1-1")], ["Q-sales", ev("Q-sales")], ["Q-gl", ev("Q-gl")], ["Q-duplicates", ev("Q-duplicates")]]);
  const findings = [finding({ verdict: { verdict: "accepted", reason: "bank shows one payment", by: "Skeptic" } })];

  it("asks for one rewrite when the draft has an untraced amount, and keeps the clean rewrite", async () => {
    const { llm, provider } = fakeLlm([GOOD_MEMO.replace("CAD 6,517", "CAD 66,666"), GOOD_MEMO]);
    const { emit, events } = recorder();
    const r = await runWriter({ llm, question: "Why did GM fall?", plan, quant: quant(), findings, evidence, rejected: [], emit });
    expect(provider.requests).toHaveLength(2);
    const rewriteAsk = provider.requests[1].messages.at(-1)!;
    expect(rewriteAsk.content).toContain("Amounts not in the facts: CAD 66,666");
    expect(r.issues).toEqual([]);
    expect(r.memo).not.toContain("66,666");
    expect(r.memo).toContain(DISCLAIMER);
    expect(r.openQuestions).toEqual(["Was the duplicate already reversed in October?", "Did the vendor issue a credit note?"]);
    expect(events.map((e) => e.type)).toEqual(["memo_draft", "memo_rewrite"]);
  });

  it("appends the reviewer notes when the rewrite still has untraced numbers", async () => {
    const bad = GOOD_MEMO.replace("CAD 6,517", "CAD 66,666");
    const { llm } = fakeLlm([bad, bad]);
    const r = await runWriter({ llm, question: "q", plan, quant: quant(), findings, evidence, rejected: [], emit: () => {} });
    expect(r.issues).toEqual(["Amounts not in the facts: CAD 66,666"]);
    expect(r.memo).toContain("> Reviewer notes (unresolved after one rewrite): Amounts not in the facts: CAD 66,666");
  });

  it("re-asks with a bigger budget when the draft is truncated, and strips <think> blocks", async () => {
    const { llm, provider } = fakeLlm([{ content: "## Answer\nshort", finishReason: "length" }, `<think>scratch CAD 99,999</think>${GOOD_MEMO}`]);
    const r = await runWriter({ llm, question: "q", plan, quant: quant(), findings, evidence, rejected: [], emit: () => {} });
    expect(provider.requests[1].maxTokens).toBe(16000);
    expect(r.memo).not.toContain("99,999");
    expect(r.issues).toEqual([]);
  });

  it("the facts sent to the model contain no number that is not in Quant or the findings", async () => {
    const { llm, provider } = fakeLlm([GOOD_MEMO]);
    await runWriter({ llm, question: "q", plan, quant: quant(), findings, evidence, rejected: [], emit: () => {} });
    const user = provider.requests[0].messages.find((m) => m.role === "user")!.content as string;
    const q = quant();
    const allowed = new Set(
      [q.bridge.revenueA, q.bridge.revenueB, q.bridge.gmA, q.bridge.gmB, q.bridge.deltaGm, ...q.components.map((c) => c.amountCad), ...q.duplicates.map((d) => d.amountCad), ...q.glByAccount.map((g) => g.amountCad)].map((x) => Math.abs(Math.round(x))),
    );
    for (const m of user.matchAll(/CAD (\d[\d,]*)/g)) expect(allowed.has(Number(m[1].replace(/,/g, "")))).toBe(true);
  });
});
