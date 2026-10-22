/**
 * The run's shared evidence graph on the Meterless World Model engine (vendored in src/engines/world-model).
 * Every agent reads and writes the investigation through this graph:
 *   Question <-investigates- Hypothesis <-supports- Finding <-backs- Evidence -mentions-> Vendor | Invoice | Payment | Sku | Customer | Account
 * Verdicts are facts on the Finding. Every write carries provenance naming the agent that made it.
 * Writes go through the engine's single-writer queue, so parallel investigators never lose each other's writes.
 */
import { externalId, WorldModel, type Entity } from "../engines/world-model/index.js";

export type Verdict = "accepted" | "rejected" | "needs_more";
export type BusinessType = "Vendor" | "Invoice" | "Payment" | "Sku" | "Customer" | "Account";

export interface EvidenceInput {
  id: string;
  findingId: string;
  sql: string;
  sources: string[];
  rowCount: number;
  headers: string[];
  sampleRows: string[][];
  queryId?: string;
  mentions?: { type: BusinessType; id: string; name?: string }[];
}

export interface FindingInput {
  id: string;
  hypothesisId: string;
  claim: string;
  amountCad?: number;
  driverType: string;
  agent: string;
}

const SYSTEM = "finmozg";

export class EvidenceGraph {
  readonly wm: WorldModel;
  /** Observation time for every record in this run: fixed, so re-ingesting the same evidence is a no-op. */
  private readonly at: string;

  constructor(
    readonly runId: string,
    opts: { storage?: "memory" | "local"; directory?: string; startedAt?: string } = {},
  ) {
    this.wm = new WorldModel({ namespace: `run-${runId}`, storage: opts.storage ?? "local", directory: opts.directory ?? ".worldmodel" });
    this.at = opts.startedAt ?? new Date().toISOString();
  }

  private src(agent: string) {
    return { kind: "agent", by: agent, at: this.at, runId: this.runId };
  }

  private key(type: string, id: string) {
    return externalId(type, this.runId, id);
  }

  async addQuestion(text: string, agent = "Planner") {
    return this.wm.upsertEntity({ type: "Question", externalKey: { system: this.runId, id: "q" }, name: text.slice(0, 120), attrs: { text }, source: this.src(agent) });
  }

  async addHypothesis(h: { id: string; driverType: string; text: string; status?: string }, agent = "Planner") {
    await this.wm.upsertEntity({ type: "Hypothesis", externalKey: { system: this.runId, id: h.id }, attrs: { driverType: h.driverType, text: h.text, status: h.status ?? "open" }, source: this.src(agent) });
    await this.wm.relate({ from: this.key("Hypothesis", h.id), type: "investigates", to: this.key("Question", "q"), source: this.src(agent) });
  }

  async setHypothesisStatus(id: string, status: string, agent: string) {
    await this.wm.assertFact({ about: this.key("Hypothesis", id), predicate: "status", value: status, confidence: 1, source: this.src(agent) });
  }

  async addFinding(f: FindingInput) {
    await this.wm.upsertEntity({
      type: "Finding",
      externalKey: { system: this.runId, id: f.id },
      attrs: { claim: f.claim, amountCad: f.amountCad, driverType: f.driverType, agent: f.agent, hypothesisId: f.hypothesisId },
      source: this.src(f.agent),
    });
    await this.wm.relate({ from: this.key("Finding", f.id), type: "supports", to: this.key("Hypothesis", f.hypothesisId), source: this.src(f.agent) });
  }

  async addEvidence(e: EvidenceInput, agent: string) {
    await this.wm.upsertEntity({
      type: "Evidence",
      externalKey: { system: this.runId, id: e.id },
      attrs: { sql: e.sql, sources: e.sources, rowCount: e.rowCount, headers: e.headers, sampleRows: e.sampleRows.slice(0, 20), queryId: e.queryId },
      source: this.src(agent),
    });
    await this.wm.relate({ from: this.key("Evidence", e.id), type: "backs", to: this.key("Finding", e.findingId), source: this.src(agent) });
    for (const m of e.mentions ?? []) {
      const id = externalId(m.type, SYSTEM, m.id);
      await this.wm.upsertEntity({ type: m.type, externalKey: { system: SYSTEM, id: m.id }, name: m.name, attrs: { id: m.id }, source: this.src(agent) });
      await this.wm.relate({ from: this.key("Evidence", e.id), type: "mentions", to: id, source: this.src(agent) });
    }
  }

  async setVerdict(findingId: string, verdict: Verdict, reason: string, agent: string) {
    await this.wm.assertFact({ about: this.key("Finding", findingId), predicate: "verdict", value: { verdict, reason }, confidence: 1, source: this.src(agent) });
  }

  // ---------------------------------------------------------------- reads

  hypotheses(): Entity[] {
    return this.wm.view("graph").query({ type: "Hypothesis" });
  }

  findings(hypothesisId?: string): Entity[] {
    const all = this.wm.view("graph").query({ type: "Finding" });
    return hypothesisId ? all.filter((f) => f.attrs.hypothesisId === hypothesisId) : all;
  }

  evidenceFor(findingId: string): Entity[] {
    return this.wm.view("graph").incoming(this.key("Finding", findingId), { via: "backs" });
  }

  verdictOf(findingId: string): { verdict: Verdict; reason: string; by?: string } | undefined {
    const facts = this.wm.view("facts").about(this.key("Finding", findingId)).filter((f) => f.predicate === "verdict" && !f.supersededBy);
    const last = facts.at(-1);
    return last ? { ...(last.value as { verdict: Verdict; reason: string }), by: last.source.by } : undefined;
  }

  /** Who wrote what: the engine's audit log, used to show that parallel agents' writes all landed. */
  writersSummary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.wm.audit()) out[e.actor ?? "system"] = (out[e.actor ?? "system"] ?? 0) + 1;
    return out;
  }

  /** Compact text of the evidence behind one hypothesis (or all), bounded for prompts. */
  buildContext(hypothesisId: string | "all", maxChars = 6000): string {
    const hyps = this.hypotheses().filter((h) => hypothesisId === "all" || h.id === this.key("Hypothesis", hypothesisId));
    const lines: string[] = [];
    for (const h of hyps) {
      lines.push(`HYPOTHESIS ${h.id.split(":").pop()} [${h.attrs.driverType}]: ${h.attrs.text}`);
      for (const f of this.findings(String(h.id.split(":").pop()))) {
        const fid = String(f.id.split(":").pop());
        const v = this.verdictOf(fid);
        lines.push(`  FINDING ${fid} by ${f.attrs.agent}: ${f.attrs.claim} | amount_cad=${f.attrs.amountCad ?? "n/a"}${v ? ` | verdict=${v.verdict} (${v.reason})` : ""}`);
        for (const ev of this.evidenceFor(fid)) {
          const a = ev.attrs as { sql: string; sources: string[]; rowCount: number; headers: string[]; sampleRows: string[][] };
          lines.push(`    EVIDENCE ${ev.id.split(":").pop()} rows=${a.rowCount} sources=${a.sources.join(",")}`);
          lines.push(`      SQL: ${a.sql.replace(/\s+/g, " ").slice(0, 400)}`);
          if (a.headers?.length) lines.push(`      ${a.headers.join(" | ")}`);
          for (const r of (a.sampleRows ?? []).slice(0, 6)) lines.push(`      ${r.join(" | ")}`);
        }
      }
    }
    const text = lines.join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n[... truncated at ${maxChars} chars]` : text;
  }
}
