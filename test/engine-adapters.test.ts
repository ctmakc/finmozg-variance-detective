import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceGraph } from "../src/evidence/worldModel.js";
import { DetectiveMemory } from "../src/memory/hmem.js";
import { parseReviewJson, reviewEvidence } from "../src/review/markovian.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fm-eng-"));

describe("EvidenceGraph (World Model)", () => {
  it("links evidence → finding → hypothesis → question with provenance per agent", async () => {
    const g = new EvidenceGraph("r1", { storage: "memory", startedAt: "2026-10-22T00:00:00Z" });
    await g.addQuestion("Why did GM fall?");
    await g.addHypothesis({ id: "h1", driverType: "booking_error", text: "duplicate AP invoice" });
    await g.addFinding({ id: "f1", hypothesisId: "h1", claim: "MRP-88213 booked twice", amountCad: -12450, driverType: "booking_error", agent: "Investigator-1" });
    await g.addEvidence({ id: "e1", findingId: "f1", sql: "SELECT 1", sources: ["fm_procure.ap_invoice"], rowCount: 2, headers: ["ap_doc_id"], sampleRows: [["AP-30"], ["AP-31"]], mentions: [{ type: "Invoice", id: "MRP-88213" }] }, "Investigator-1");
    await g.setVerdict("f1", "accepted", "GL, AP and bank agree", "Skeptic");
    expect(g.findings("h1")).toHaveLength(1);
    expect(g.evidenceFor("f1")).toHaveLength(1);
    expect(g.verdictOf("f1")).toMatchObject({ verdict: "accepted", by: "Skeptic" });
    const ctx = g.buildContext("all");
    expect(ctx).toContain("MRP-88213 booked twice");
    expect(ctx).toContain("verdict=accepted");
    expect(g.writersSummary()["Investigator-1"]).toBeGreaterThan(0);
  });

  it("re-ingesting the same evidence does not duplicate", async () => {
    const g = new EvidenceGraph("r2", { storage: "memory", startedAt: "2026-10-22T00:00:00Z" });
    await g.addQuestion("q");
    await g.addHypothesis({ id: "h", driverType: "mix", text: "t" });
    await g.addFinding({ id: "f", hypothesisId: "h", claim: "c", driverType: "mix", agent: "A" });
    const ev = { id: "e", findingId: "f", sql: "S", sources: ["x"], rowCount: 1, headers: [], sampleRows: [] };
    await g.addEvidence(ev, "A");
    const before = g.wm.events().length;
    await g.addEvidence(ev, "A");
    expect(g.evidenceFor("f")).toHaveLength(1);
    expect(g.wm.events().filter((e) => e.kind === "relate").length).toBe(g.wm.events().slice(0, before).filter((e) => e.kind === "relate").length);
  });

  it("parallel writers keep both writes and the context stays bounded", async () => {
    const g = new EvidenceGraph("r3", { storage: "memory", startedAt: "2026-10-22T00:00:00Z" });
    await g.addQuestion("q");
    await g.addHypothesis({ id: "h", driverType: "mix", text: "t" });
    await Promise.all(
      [1, 2, 3].map((n) => g.addFinding({ id: `f${n}`, hypothesisId: "h", claim: `claim ${n} ${"x".repeat(500)}`, driverType: "mix", agent: `Investigator-${n}` })),
    );
    expect(g.findings("h")).toHaveLength(3);
    expect(Object.keys(g.writersSummary())).toEqual(expect.arrayContaining(["Investigator-1", "Investigator-2", "Investigator-3"]));
    expect(g.buildContext("all", 300).length).toBeLessThan(360);
  });
});

describe("DetectiveMemory (H-MEM)", () => {
  it("remembers a confirmed finding across instances and recalls it for a related question", () => {
    const dir = tmp();
    const m1 = new DetectiveMemory(dir);
    const rec = m1.rememberFinding({ question: "Why did gross margin fall in September?", claim: "Maple Ridge Packaging invoice MRP-88213 was posted twice", amountCad: 12450, evidenceSummary: "2 AP documents, 1 bank payment", verdict: "confirmed", runId: "r1", findingId: "f1", entities: ["VEND-MRP"] });
    const m2 = new DetectiveMemory(dir);
    const recall = m2.recall("Which vendor invoices were posted twice in packaging?");
    expect(recall.memories.map((x) => x.id)).toContain(rec.id);
    expect(m2.audit(rec.id).length).toBeGreaterThan(0);
  });

  it("keeps a complete schema map and skips unchanged entries", () => {
    const m = new DetectiveMemory(tmp());
    m.rememberSchemaMap([{ table: "finance_usl.vendor_bill", columns: ["vendor_invoice_no"] }], "r1");
    expect(m.rememberSchemaMap([{ table: "finance_usl.vendor_bill", columns: ["vendor_invoice_no"] }], "r2")).toHaveLength(0);
    expect(m.schemaMap()).toEqual([{ table: "finance_usl.vendor_bill", columns: ["vendor_invoice_no"] }]);
  });

  it("feedback changes the ledger", () => {
    const m = new DetectiveMemory(tmp());
    const r = m.rememberRuling("Account 6100 Marketing is opex: never a gross-margin driver.", "r1")!;
    m.feedback(r.id, true);
    expect(m.audit(r.id).some((e: any) => /feedback/i.test(JSON.stringify(e)))).toBe(true);
  });
});

describe("reviewEvidence (Markovian)", () => {
  it("feeds one batch per chunk, carries state, and accounts tokens as estimated", async () => {
    const seen: string[] = [];
    const gen = async (prompt: string) => {
      seen.push(prompt);
      const last = /This is the last batch/.test(prompt);
      return {
        text: last
          ? 'Flagged AP-31.\nVERDICT_JSON: {"verdict":"supported","reasons":["two AP docs, one payment"],"flagged_rows":["AP-31"]}\n[TASK_COMPLETE]'
          : "Reviewed batch.\n[STATE_CHECKPOINT]\nCOMPLETED: batch\nREMAINING: more\nDECISIONS: none\nCONTEXT: AP-30 ok",
      };
    };
    const rows = Array.from({ length: 95 }, (_, i) => [`AP-${i}`, "12450"]);
    const r = await reviewEvidence({ claim: "duplicate", headers: ["ap_doc_id", "amount"], rows, instructions: "check", batchSize: 40 }, gen, { logDir: tmp() });
    expect(r.chunks).toBe(3);
    expect(seen[0]).toContain("BATCH 1 of 3");
    expect(seen[1]).toContain("[CARRYOVER STATE]");
    expect(seen[1]).not.toContain("BATCH 1 of 3");
    expect(r.verdict).toBe("supported");
    expect(r.flaggedRows).toEqual(["AP-31"]);
    expect(r.tokens.label).toBe("estimated");
    expect(r.tokens.projectedFullContextTokens).toBeGreaterThan(r.tokens.actualPromptTokens);
  });

  it("parses VERDICT_JSON", () => {
    expect(parseReviewJson('x VERDICT_JSON: {"verdict":"contradicted","reasons":["a"],"flagged_rows":[]} [TASK_COMPLETE]')?.verdict).toBe("contradicted");
    expect(parseReviewJson("no verdict")).toBeNull();
  });
});
