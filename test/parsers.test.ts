import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultPlan, ensureCoverage, runPlanner } from "../src/agents/planner.ts";
import { applyFeedback } from "../src/agents/steward.ts";
import { PlanSchema, type RunOutput } from "../src/agents/types.ts";
import { extractJson } from "../src/llm/index.ts";
import { DetectiveMemory } from "../src/memory/hmem.ts";
import { snapshotClock } from "../src/sample.ts";
import { asObjects, ZetarisClient, ZetarisError } from "../src/zetaris/client.ts";
import { fakeLlm, recorder, sqlResult } from "./helpers/fakes.ts";

const emptyRecall = { memories: [], context: "", trace: {} as never };

describe("extractJson on malformed model output", () => {
  it("finds the first balanced object after <think> and code fences", () => {
    expect(extractJson('<think>{"no": 1}</think>Here:\n```json\n{"a": {"b": [1, 2]}, "s": "} {"}\n```')).toEqual({ a: { b: [1, 2] }, s: "} {" });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJson('{"claim": "invoice \\"MRP-1\\" twice"}')).toEqual({ claim: 'invoice "MRP-1" twice' });
  });

  it("returns arrays too", () => {
    expect(extractJson("result: [1, 2]")).toEqual([1, 2]);
  });

  it("throws on no JSON and on unterminated JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
    expect(() => extractJson('{"a": 1')).toThrow(/unterminated/);
  });
});

describe("Llm.chatJson (provider mocked)", () => {
  it("retries once with the validation error, then succeeds", async () => {
    const { llm, provider } = fakeLlm(['{"n": "x"}', '{"n": 3}']);
    const { value } = await llm.chatJson({ role: "fast", messages: [{ role: "user", content: "n?" }] }, z.object({ n: z.number() }));
    expect(value).toEqual({ n: 3 });
    expect(provider.requests[1].messages.at(-1)!.content).toContain("not valid JSON for the required schema");
  });

  it("gives up after the retry", async () => {
    const { llm } = fakeLlm(["nope", "still nope"]);
    await expect(llm.chatJson({ role: "fast", messages: [{ role: "user", content: "n?" }] }, z.object({ n: z.number() }))).rejects.toThrow(/invalid JSON after retry/);
  });
});

describe("Planner", () => {
  const base = { question: "Why did gross margin fall?", periods: ["2026-07", "2026-08", "2026-09"], schema: "s", pnl: "p", recall: emptyRecall };

  it("PlanSchema rejects malformed periods and unknown driver types", () => {
    expect(() => PlanSchema.parse({ ...defaultPlan("2026-8", "2026-09") })).toThrow();
    expect(() => PlanSchema.parse({ ...defaultPlan("2026-08", "2026-09"), hypotheses: [{ id: "h1", driverType: "weather", text: "rain" }] })).toThrow();
  });

  it("ensureCoverage adds the core gross-margin drivers the model forgot and renumbers", () => {
    const plan = ensureCoverage({ ...defaultPlan("2026-08", "2026-09"), hypotheses: [{ id: "h9", driverType: "price", text: "prices", checks: "" }] });
    expect(plan.hypotheses.map((h) => [h.id, h.driverType])).toEqual([["h1", "price"], ["h2", "mix"], ["h3", "supplier_price"], ["h4", "booking_error"], ["h5", "fx"]]);
  });

  it("ensureCoverage leaves non-gross-margin and unanswerable plans alone", () => {
    const opex = { ...defaultPlan("2026-08", "2026-09"), metric: "opex" as const, hypotheses: [] };
    expect(ensureCoverage(opex)).toBe(opex);
  });

  it("falls back to the default plan on the latest two periods when the model's JSON is invalid", async () => {
    const { llm } = fakeLlm(["not json", "still not json"]);
    const { emit, events } = recorder();
    const r = await runPlanner(llm, base, emit);
    expect(r.fallback).toBe(true);
    expect(r.plan).toMatchObject({ periodA: "2026-08", periodB: "2026-09", metric: "gross_margin" });
    expect(events[0].type).toBe("plan_fallback");
  });

  it("uses the model's plan, renumbers hypotheses and applies user-fixed periods", async () => {
    const reply = JSON.stringify({ metric: "gross_margin", periodA: "2026-07", periodB: "2026-08", answerable: true, missingData: null, hypotheses: [{ id: "x", driverType: "mix", text: "mix shifted" }, { id: "y", driverType: "supplier_price", text: "vendor over contract" }, { id: "z", driverType: "booking_error", text: "duplicate AP invoice" }, { id: "w", driverType: "fx", text: "USD/CAD rate moved" }] });
    const { llm } = fakeLlm([reply]);
    const r = await runPlanner(llm, { ...base, periodA: "2026-08", periodB: "2026-09" }, () => {});
    expect(r.fallback).toBe(false);
    expect(r.plan.hypotheses.map((h) => h.id)).toEqual(["h1", "h2", "h3", "h4"]);
    expect([r.plan.periodA, r.plan.periodB]).toEqual(["2026-08", "2026-09"]);
  });
});

describe("Zetaris result parsing", () => {
  it("asObjects fills cells missing from short (ragged) rows with empty strings and drops extras", () => {
    const r = { ...sqlResult(["a", "b", "c"], []), rows: [["1"], ["1", "2", "3", "4"]] };
    expect(asObjects(r)).toEqual([{ a: "1", b: "", c: "" }, { a: "1", b: "2", c: "3" }]);
  });

  const client = (status: number, body: string) =>
    new ZetarisClient({ restUrl: "http://zetaris.test/api/v1.0/", orgId: "1", apiKey: "test", mode: "live", fetchImpl: (async () => new Response(body, { status })) as typeof fetch });

  it("stringifies values and maps NULL to an empty string", async () => {
    const r = await client(200, JSON.stringify({ headers: ["x", "y"], data: [[1.5, null]], total: 1 })).runSql("SELECT 1");
    expect(r.rows).toEqual([["1.5", ""]]);
  });

  it("missing headers or data give an empty result, not a crash", async () => {
    const r = await client(200, "{}").runSql("SELECT 1");
    expect(r).toMatchObject({ headers: [], rows: [], total: 0 });
  });

  it("an HTTP error keeps the message head and drops Spark stack frames", async () => {
    const msg = "AnalysisException: column not found\n  at org.apache.spark.Foo\n  at org.apache.spark.Bar\nhint: did you mean qty?";
    const err = await client(400, JSON.stringify({ msg })).runSql("SELECT nope").catch((e) => e);
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("AnalysisException: column not found\nhint: did you mean qty?");
  });

  it("an HTML error page becomes a ZetarisError with the body head", async () => {
    const err = await client(502, "<html>Bad gateway</html>").runSql("SELECT 1").catch((e) => e);
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.message).toBe("<html>Bad gateway</html>");
  });
});

describe("Memory steward", () => {
  const run = (): RunOutput =>
    ({
      runId: "r1",
      question: "Why did GM fall?",
      bridge: [{ key: "bookingError", label: "Booking error", driverType: "booking_error", amountCad: -12450, ppOfRevenueB: -3.46 }],
      findings: [{ id: "F-h3-r1", hypothesisId: "h3", driverType: "booking_error", claim: "MRP-88213 booked twice", amountCad: -12000, evidenceIds: ["E3-1"], entities: ["VEND-MRP"], agent: "I", round: 1, supported: true, sqlCalls: 1, repairs: 0 }],
      evidence: [{ id: "E3-1", sql: "S", sources: ["finance_usl.vendor_bill", "finance_usl.vendor_payment"], headers: [], rows: [], rowCount: 3, agent: "I" }],
      memoryUsed: [],
    }) as unknown as RunOutput;

  it("remembers a confirmed finding with the bridge amount and its evidence", () => {
    const memory = new DetectiveMemory(mkdtempSync(join(tmpdir(), "fm-st-")));
    const r = applyFeedback(memory, run(), { findingId: "F-h3-r1", verdict: "confirmed", note: "checked" });
    expect(r.content).toContain("Confirmed by the controller: MRP-88213 booked twice (CAD 12,450)");
    expect(r.content).toContain("E3-1 finance_usl.vendor_bill+finance_usl.vendor_payment 3 rows");
    expect(r.stats.findings).toBe(1);
  });

  it("refuses feedback on a finding that is not in the run", () => {
    const memory = new DetectiveMemory(mkdtempSync(join(tmpdir(), "fm-st-")));
    expect(() => applyFeedback(memory, run(), { findingId: "F-nope", verdict: "confirmed" })).toThrow(/not in run r1/);
  });
});

describe("SAMPLE_MODE clock", () => {
  it("uses the newest ledger timestamp of the snapshot and skips torn lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-clk-"));
    writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ timestamp: 1000 })}\n${JSON.stringify({ timestamp: 3000 })}\n${JSON.stringify({ timestamp: 2000 })}\n{"timestamp": 99`);
    expect(snapshotClock(dir)?.()).toBe(3000);
  });

  it("keeps the real clock for an empty snapshot", () => {
    expect(snapshotClock(mkdtempSync(join(tmpdir(), "fm-clk-")))).toBeUndefined();
  });
});
