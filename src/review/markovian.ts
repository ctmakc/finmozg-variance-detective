/**
 * Skeptic's review of long evidence sets on the Meterless Markovian engine (vendored in src/engines/markovian).
 * The engine runs the chain: one bounded chunk per step, a compressed carryover state between steps
 * ([STATE_CHECKPOINT] … [TASK_COMPLETE]). Our generator wrapper hands the model the next batch of evidence
 * rows at each step, so no step ever sees the whole row set, and the carryover holds what was flagged so far.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Markovian, estimateTokens, type MarkovianRun } from "../engines/markovian/index.js";

export type EngineGenerator = (prompt: string, attachments: { name: string; content: string }[], systemPrompt?: string) => Promise<{ text: string; metadata?: unknown }>;

export interface ReviewInput {
  claim: string;
  headers: string[];
  rows: string[][];
  /** What the Skeptic must check in the rows. */
  instructions: string;
  batchSize?: number;
}

export interface ReviewResult {
  verdict: "supported" | "contradicted" | "inconclusive";
  reasons: string[];
  flaggedRows: string[];
  chunks: number;
  status: MarkovianRun["status"];
  tokens: { label: "estimated"; actualPromptTokens: number; projectedFullContextTokens: number; savedPercent: number; engineTokensSaved: number };
  runId: string;
}

function batches<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out.length ? out : [[]];
}

export function parseReviewJson(text: string): Pick<ReviewResult, "verdict" | "reasons" | "flaggedRows"> | null {
  const m = text.match(/VERDICT_JSON\s*:?\s*(\{[\s\S]*?\})\s*(?:\[TASK_COMPLETE\]|$)/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const verdict = ["supported", "contradicted", "inconclusive"].includes(j.verdict) ? j.verdict : "inconclusive";
    return { verdict, reasons: (j.reasons ?? []).map(String).slice(0, 8), flaggedRows: (j.flagged_rows ?? j.flaggedRows ?? []).map(String).slice(0, 50) };
  } catch {
    return null;
  }
}

export async function reviewEvidence(input: ReviewInput, generator: EngineGenerator, opts: { logDir?: string; runLabel?: string } = {}): Promise<ReviewResult> {
  const size = input.batchSize ?? 40;
  const parts = batches(input.rows, size);
  const header = input.headers.join(" | ");
  const batchText = (k: number) => `[EVIDENCE BATCH ${k + 1} of ${parts.length}]\n${header}\n${parts[k].map((r) => r.join(" | ")).join("\n")}`;

  const goal =
    `Audit evidence rows for this claim: "${input.claim}". ${input.instructions} ` +
    `The rows arrive in ${parts.length} batch(es), one batch per step. In each step, review only the new batch and record what you flagged in the checkpoint state. ` +
    `After the last batch, end with a line "VERDICT_JSON: {\"verdict\": \"supported|contradicted|inconclusive\", \"reasons\": [..], \"flagged_rows\": [row keys]}" followed by [TASK_COMPLETE].`;

  let step = 0;
  let actualPromptTokens = 0;
  let projected = 0;
  let outputsSoFar = 0;
  const wrapped: EngineGenerator = async (prompt, attachments, systemPrompt) => {
    const k = step++;
    const extra = k < parts.length ? `\n\n${batchText(k)}${k === parts.length - 1 ? "\n\nThis is the last batch: give the VERDICT_JSON line now." : ""}` : "";
    const full = prompt + extra;
    actualPromptTokens += estimateTokens(full);
    // naive baseline: every step re-reads all batches so far and all previous outputs
    projected += estimateTokens(goal) + parts.slice(0, Math.min(k + 1, parts.length)).reduce((s, _, i) => s + estimateTokens(batchText(i)), 0) + outputsSoFar;
    const r = await generator(full, attachments, systemPrompt);
    outputsSoFar += estimateTokens(r.text);
    return r;
  };

  const engine = new Markovian({ chunkConfig: { chunkSize: 4000, maxChunks: Math.min(32, parts.length + 1), carryoverTokens: 768, overlapTokens: 0 }, generator: wrapped });
  const run = await engine.run({ goal, mode: "RESEARCH", reflect: false, stopWhen: ({ step: s }) => s >= parts.length + 1 });
  const parsed = parseReviewJson(run.chunks.map((c) => c.content).join("\n")) ?? parseReviewJson(run.output);

  const result: ReviewResult = {
    verdict: parsed?.verdict ?? "inconclusive",
    reasons: parsed?.reasons ?? [run.status === "completed" ? "model gave no VERDICT_JSON line" : `chain ended with status ${run.status}${run.error ? `: ${run.error}` : ""}`],
    flaggedRows: parsed?.flaggedRows ?? [],
    chunks: run.chunks.length,
    status: run.status,
    tokens: {
      label: "estimated",
      actualPromptTokens,
      projectedFullContextTokens: projected,
      savedPercent: projected > 0 ? Math.round((1 - actualPromptTokens / projected) * 1000) / 10 : 0,
      engineTokensSaved: run.totalTokensSaved,
    },
    runId: run.id,
  };
  const dir = opts.logDir ?? "logs";
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "markovian-runs.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), label: opts.runLabel, claim: input.claim, rows: input.rows.length, batches: parts.length, chunkConfig: run.chunkConfig, status: run.status, chunks: run.chunks.map((c) => ({ id: c.id, tokens: c.tokens, carryoverChars: c.carryover.length })), result: { verdict: result.verdict, tokens: result.tokens } }) + "\n",
  );
  return result;
}
