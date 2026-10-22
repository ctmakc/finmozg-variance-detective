/**
 * Cross-run memory on the Meterless H-MEM engine (vendored in src/engines/hmem).
 * What the detective remembers between month-end closes:
 *  - the schema map the Cartographer discovered (so a warm run skips discovery),
 *  - findings the controller confirmed or rejected (so the next close checks them first),
 *  - accounting rulings the Skeptic made (e.g. "6100 Marketing is opex, not a gross-margin driver").
 */
import { HMEM, type MemoryRecord, type QueryResult } from "../engines/hmem/index.js";

export interface SchemaMapEntry {
  table: string;
  columns: string[];
  description?: string;
}

export interface RecalledMemory {
  id: string;
  content: string;
  relevance: number;
  tags: string[];
  source: string;
  layer: string;
}

export interface Recall {
  memories: RecalledMemory[];
  context: string;
  trace: QueryResult["trace"];
}

export class DetectiveMemory {
  readonly engine: HMEM;

  constructor(persistDir = process.env.HMEM_DIR ?? ".hmem", clock?: () => number) {
    this.engine = new HMEM({ persistDir, clock, actor: "finmozg-detective" });
  }

  recall(question: string, topN = 6): Recall {
    const r = this.engine.query(question, { topN, threshold: 0.2 });
    return {
      memories: r.memories.map((m) => ({
        id: m.memory.id,
        content: m.memory.content,
        relevance: Math.round(m.relevance * 1000) / 1000,
        tags: m.memory.tags,
        source: m.memory.source,
        layer: m.memory.layer,
      })),
      context: r.context,
      trace: r.trace,
    };
  }

  /** All live memories carrying a tag (used for the schema map, which must be complete, not ranked). */
  byTag(tag: string): MemoryRecord[] {
    return this.engine.store.all().filter((m: MemoryRecord) => m.tags.includes(tag) && !m.supersededBy);
  }

  schemaMap(): SchemaMapEntry[] {
    return this.byTag("schema-map").map((m) => JSON.parse(m.content.replace(/^Schema map: /, "")) as SchemaMapEntry);
  }

  rememberSchemaMap(entries: SchemaMapEntry[], runId: string): MemoryRecord[] {
    const existing = new Map(this.byTag("schema-map").map((m) => [m.tags.find((t) => t.startsWith("table:")), m]));
    const out: MemoryRecord[] = [];
    for (const e of entries) {
      const tag = `table:${e.table}`;
      const content = `Schema map: ${JSON.stringify(e)}`;
      const prev = existing.get(tag);
      if (prev && prev.content === content) continue;
      out.push(
        this.engine.add({
          content,
          type: "factual",
          layer: "long_term",
          tags: ["schema-map", tag],
          confidence: 0.95,
          source: `cartographer:${runId}`,
          provenance: { origin: "document", learnedAt: this.engine.clock(), label: "Zetaris DESCRIBE", refs: [e.table] },
          supersedes: prev?.id,
        }),
      );
    }
    return out;
  }

  rememberFinding(f: {
    question: string;
    claim: string;
    amountCad?: number;
    evidenceSummary: string;
    verdict: "confirmed" | "rejected";
    note?: string;
    runId: string;
    findingId: string;
    entities?: string[];
  }): MemoryRecord {
    const amount = f.amountCad !== undefined ? ` (CAD ${Math.abs(f.amountCad).toLocaleString("en-CA", { maximumFractionDigits: 0 })})` : "";
    const content =
      f.verdict === "confirmed"
        ? `Confirmed by the controller: ${f.claim}${amount}. Evidence: ${f.evidenceSummary}.${f.note ? ` Note: ${f.note}.` : ""} Check this first at the next close.`
        : `Rejected by the controller: ${f.claim}${amount}.${f.note ? ` Reason: ${f.note}.` : ""} Do not report it again without new evidence.`;
    return this.engine.add({
      content,
      type: "factual",
      layer: "long_term",
      tags: ["finding", `verdict:${f.verdict}`, ...(f.entities ?? []).map((e) => `entity:${e}`)],
      confidence: f.verdict === "confirmed" ? 0.9 : 0.8,
      source: `controller-feedback:${f.runId}`,
      provenance: { origin: "user_correction", learnedAt: this.engine.clock(), label: `feedback on ${f.findingId}`, refs: [f.runId, f.findingId] },
    });
  }

  rememberRuling(text: string, runId: string): MemoryRecord | null {
    if (this.byTag("ruling").some((m) => m.content === text)) return null;
    return this.engine.add({
      content: text,
      type: "factual",
      layer: "working",
      tags: ["ruling"],
      confidence: 0.75,
      source: `skeptic:${runId}`,
      provenance: { origin: "model_response", learnedAt: this.engine.clock(), label: "Skeptic ruling", refs: [runId] },
    });
  }

  feedback(memoryId: string, helpful: boolean) {
    this.engine.feedback(memoryId, helpful ? "helpful" : "not_helpful");
  }

  audit(memoryId: string) {
    return this.engine.ledger.history(memoryId);
  }

  stats() {
    const all: MemoryRecord[] = this.engine.store.all();
    return {
      total: all.length,
      schemaMap: all.filter((m) => m.tags.includes("schema-map")).length,
      findings: all.filter((m) => m.tags.includes("finding")).length,
      rulings: all.filter((m) => m.tags.includes("ruling")).length,
    };
  }
}
