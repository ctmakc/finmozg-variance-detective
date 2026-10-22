/**
 * Memory steward: turns the controller's feedback on a finding into H-MEM memories, so the next close starts warm
 * and checks confirmed issues first. Rejections are remembered too, so the same explanation is not repeated.
 */
import type { DetectiveMemory } from "../memory/hmem.js";
import type { RunOutput } from "./types.js";

export interface Feedback {
  findingId: string;
  verdict: "confirmed" | "rejected";
  note?: string;
}

export function applyFeedback(memory: DetectiveMemory, run: RunOutput, fb: Feedback) {
  const f = run.findings.find((x) => x.id === fb.findingId);
  if (!f) throw new Error(`Finding ${fb.findingId} is not in run ${run.runId}`);
  const ev = run.evidence.filter((e) => f.evidenceIds.includes(e.id));
  const evidenceSummary = ev.length
    ? ev.map((e) => `${e.id} ${e.sources.join("+")} ${e.rowCount} rows`).join("; ")
    : "no row evidence";
  const bridgeAmount = run.bridge.find((c) => c.driverType === f.driverType)?.amountCad;
  const rec = memory.rememberFinding({
    question: run.question,
    claim: f.claim,
    amountCad: bridgeAmount ?? f.amountCad ?? undefined,
    evidenceSummary,
    verdict: fb.verdict,
    note: fb.note,
    runId: run.runId,
    findingId: f.id,
    entities: f.entities,
  });
  // Memories that were recalled for this run and led to a confirmed finding get a helpful signal.
  for (const m of run.memoryUsed) memory.feedback(m.id, fb.verdict === "confirmed");
  return { memoryId: rec.id, content: rec.content, stats: memory.stats() };
}
