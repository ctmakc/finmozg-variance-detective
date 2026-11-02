import { describe, expect, it } from "vitest";
import { MAX_TOOL_CALLS, runInvestigator, sourcesOf, type InvestigatorArgs } from "../src/agents/investigator.ts";
import type { Hypothesis } from "../src/agents/types.ts";
import { ZetarisError } from "../src/zetaris/client.ts";
import { fakeLlm, recorder, sqlResult, toolCall } from "./helpers/fakes.ts";

const hypothesis: Hypothesis = { id: "h2", driverType: "supplier_price", text: "A vendor invoiced above contract", checks: "" };

function args(llm: InvestigatorArgs["llm"], runSql: InvestigatorArgs["runSql"], over: Partial<InvestigatorArgs> = {}): InvestigatorArgs {
  let n = 0;
  return { llm, runSql, hypothesis, periodA: "2026-08", periodB: "2026-09", schema: "schema", memoryHints: "", agent: "Investigator-h2", round: 1, nextEvidenceId: () => `E2-${++n}`, emit: () => {}, ...over };
}

const LINES = sqlResult(["vendor_id", "sku", "unit_price_orig", "contract_unit_price"], [["VEND-SNC", "NUT-ALM", 8.4, 8]]);
const answer = (o: Record<string, unknown>) => JSON.stringify({ supported: true, claim: "VEND-SNC invoiced NUT-ALM above contract", amount_cad: -9116, entities: ["VEND-SNC"], confidence: "high", ...o });

describe("sourcesOf", () => {
  it("lists semantic-layer and source-system tables, lower-cased and de-duplicated", () => {
    expect(sourcesOf("SELECT * FROM lightning.metastore.finmozg.FINANCE_USL.Purchase_Line l JOIN finance_usl.vendor v JOIN fm_bank.payments p JOIN finance_usl.vendor")).toEqual(["finance_usl.purchase_line", "finance_usl.vendor", "fm_bank.payments"]);
  });
});

describe("runInvestigator (model and Zetaris mocked)", () => {
  it("turns each query into evidence and keeps only the evidence ids it actually produced", async () => {
    const { llm } = fakeLlm([{ toolCalls: [toolCall("c1", { sql: "SELECT * FROM finance_usl.purchase_line;", purpose: "lines" })] }, answer({ evidence: ["E2-1", "E9-9", "Q-sales"] })]);
    const sqls: string[] = [];
    const { finding, evidence } = await runInvestigator(args(llm, async (sql) => (sqls.push(sql), LINES)));
    expect(sqls).toEqual(["SELECT * FROM finance_usl.purchase_line"]); // trailing semicolon stripped
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ id: "E2-1", sources: ["finance_usl.purchase_line"], rowCount: 1, headers: LINES.headers });
    expect(finding.evidenceIds).toEqual(["E2-1"]); // invented ids never reach the finding
    expect(finding).toMatchObject({ id: "F-h2-r1", hypothesisId: "h2", driverType: "supplier_price", amountCad: -9116, supported: true, sqlCalls: 1, repairs: 0 });
  });

  it("feeds a Zetaris error back to the model and counts the successful retry as a repair", async () => {
    const { llm, provider } = fakeLlm([{ toolCalls: [toolCall("c1", { sql: "SELEC broken" })] }, { toolCalls: [toolCall("c2", { sql: "SELECT 1 FROM finance_usl.purchase_line" })] }, answer({ evidence: ["E2-1", "E2-2"] })]);
    let n = 0;
    const runSql = async (sql: string) => {
      if (n++ === 0) throw new ZetarisError("ParseException: mismatched input 'SELEC'", 400, sql);
      return LINES;
    };
    const { finding, evidence } = await runInvestigator(args(llm, runSql));
    expect(evidence.map((e) => [e.id, e.error ? "error" : "ok"])).toEqual([["E2-1", "error"], ["E2-2", "ok"]]);
    expect(finding.repairs).toBe(1);
    expect(finding.evidenceIds).toEqual(["E2-1", "E2-2"]);
    const toolMsg = provider.requests[1].messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("ERROR from Zetaris");
    expect(toolMsg.content).toContain("mismatched input");
  });

  it("does not run a tool call whose arguments are not valid JSON", async () => {
    const { llm, provider } = fakeLlm([{ toolCalls: [toolCall("c1", "{not json")] }, answer({ evidence: [] })]);
    let ran = 0;
    const { finding } = await runInvestigator(args(llm, async () => (ran++, LINES)));
    expect(ran).toBe(0);
    expect(finding.sqlCalls).toBe(0);
    expect(provider.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "ERROR: missing sql argument" });
  });

  it(`stops running SQL after ${MAX_TOOL_CALLS} queries and withdraws the tool`, async () => {
    const many = { toolCalls: Array.from({ length: MAX_TOOL_CALLS + 2 }, (_, i) => toolCall(`c${i}`, { sql: `SELECT ${i}` })) };
    const { llm, provider } = fakeLlm([many, answer({ evidence: ["E2-1"] })]);
    let ran = 0;
    const { finding } = await runInvestigator(args(llm, async () => (ran++, LINES)));
    expect(ran).toBe(MAX_TOOL_CALLS);
    expect(finding.sqlCalls).toBe(MAX_TOOL_CALLS);
    expect(provider.requests[1].tools).toBeUndefined();
  });

  it("asks once more for JSON when the final reply is not a finding, then reports an unsupported finding", async () => {
    const { llm } = fakeLlm([{ toolCalls: [toolCall("c1", { sql: "SELECT 1" })] }, "I think the vendor did it.", "still prose", "and again prose"]);
    const { finding } = await runInvestigator(args(llm, async () => LINES));
    expect(finding.supported).toBe(false);
    expect(finding.amountCad).toBeNull();
    expect(finding.claim).toContain("could not produce a finding");
    expect(finding.evidenceIds).toEqual(["E2-1"]);
  });

  it("rejects a finding JSON with the wrong shape instead of trusting it", async () => {
    const { llm } = fakeLlm(['{"supported": "yes", "claim": 7}', answer({ evidence: [] })]);
    const { finding } = await runInvestigator(args(llm, async () => LINES));
    expect(finding.claim).toBe("VEND-SNC invoiced NUT-ALM above contract");
  });

  it("includes the Skeptic's request and memory hints in the prompt", async () => {
    const { llm, provider } = fakeLlm([answer({ evidence: [] })]);
    const { emit, events } = recorder();
    await runInvestigator(args(llm, async () => LINES, { skepticRequest: "name the vendor", memoryHints: "[mem-3] VEND-SNC over contract", round: 2, emit }));
    const user = provider.requests[0].messages[1].content as string;
    expect(user).toContain("The Skeptic sent this back with a request: name the vendor");
    expect(user).toContain("[mem-3] VEND-SNC over contract");
    expect(events.at(-1)).toMatchObject({ type: "finding", data: { findingId: "F-h2-r2" } });
  });
});
