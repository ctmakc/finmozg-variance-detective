/**
 * The investigation as a bounded state machine:
 * memory recall → Cartographer → Planner → Quant ‖ Investigators → Skeptic (≤2 send-back rounds) → Writer.
 * Shared state lives in the World Model evidence graph; every step is a JSONL trace event.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCartographer, schemaPrompt } from "./agents/cartographer.js";
import { runInvestigator } from "./agents/investigator.js";
import { runPlanner } from "./agents/planner.js";
import { type QuantResult, runQuant, USL } from "./agents/quant.js";
import { MAX_SKEPTIC_ROUNDS, runSkeptic } from "./agents/skeptic.js";
import type { EvidenceItem, Finding, Hypothesis, RunInput, RunOutput, TraceEvent } from "./agents/types.js";
import { runWriter } from "./agents/writer.js";
import { EvidenceGraph } from "./evidence/worldModel.js";
import { Llm } from "./llm/index.js";
import { DetectiveMemory } from "./memory/hmem.js";
import { ZetarisClient, ZetarisError, asObjects, zetarisConfigFromEnv } from "./zetaris/client.js";

export const COMPANY = "Northbound Pantry Co. (fictional company, synthetic data)";
const RUN_BUDGET_MS = 8 * 60_000;

export function newRunId() {
  const d = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `r-${d}-${randomBytes(2).toString("hex")}`;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export interface RunDeps {
  zetaris?: ZetarisClient;
  llm?: Llm;
  memory?: DetectiveMemory;
  logDir?: string;
  onEvent?: (e: TraceEvent) => void;
  runId?: string;
}

export async function runInvestigation(input: RunInput, deps: RunDeps = {}): Promise<RunOutput> {
  const runId = deps.runId ?? newRunId();
  const started = Date.now();
  const logDir = deps.logDir ?? "logs";
  mkdirSync(logDir, { recursive: true });
  const tracePath = join(logDir, `trace-${runId}.jsonl`);
  let seq = 0;
  const emit = (agent: string, type: string, data: Record<string, unknown> = {}) => {
    const e: TraceEvent = { ts: new Date().toISOString(), runId, seq: ++seq, agent, type, ...data };
    appendFileSync(tracePath, JSON.stringify(e) + "\n");
    deps.onEvent?.(e);
  };

  const servedBy = new Set<string>();
  const stats = { sqlCalls: 0, sqlErrors: 0, sqlRepairs: 0, llmCalls: 0, skepticRounds: 0, memoryRecalled: 0, warmStart: false, durationMs: 0, provider: "", servedBy: [] as string[] };
  const zetaris = deps.zetaris ?? new ZetarisClient(zetarisConfigFromEnv());
  const llm =
    deps.llm ??
    new Llm({
      onEvent: (e) => {
        stats.llmCalls++;
        if (e.servedBy) servedBy.add(e.servedBy);
        emit(e.agent ?? "llm", "llm_call", { provider: e.provider, requestedModel: e.requestedModel, servedBy: e.servedBy, receiptId: e.receiptId, latencyMs: e.latencyMs, ok: e.ok, toolCalls: e.toolCalls, recorded: e.recorded, error: e.error });
      },
    });
  stats.provider = llm.provider.name;
  const memory = deps.memory ?? new DetectiveMemory();
  const graph = new EvidenceGraph(runId, { directory: join(logDir, "..", ".worldmodel") });

  const runSql = async (sql: string, label: string) => {
    stats.sqlCalls++;
    try {
      const r = await zetaris.runSql(sql, { timeoutMs: 120_000, label });
      if (!label.startsWith("Investigator")) emit(label.split(":")[0].replace(/^./, (c) => c.toUpperCase()), "sql", { label, sql, rowCount: r.total, timeUsedMs: r.timeUsedMs, recorded: r.recorded ?? false });
      return r;
    } catch (err) {
      stats.sqlErrors++;
      throw err;
    }
  };

  emit("Orchestrator", "run_start", { question: input.question, company: COMPANY, provider: llm.provider.name, zetarisMode: zetaris.mode });
  const evidence = new Map<string, EvidenceItem>();
  let evSeq = 0;
  const nextEvidenceId = () => `E${++evSeq}`;
  let quant: QuantResult | null = null;
  const findings: Finding[] = [];

  try {
    // 1. Memory first.
    const recall = memory.recall(input.question, 6);
    stats.memoryRecalled = recall.memories.filter((m) => !m.tags.includes("schema-map")).length;
    emit("Memory", "recall", { memories: recall.memories.map((m) => ({ id: m.id, relevance: m.relevance, content: m.content.slice(0, 200), tags: m.tags })), strategy: recall.trace.strategy });

    // 2. Cartographer.
    const map = await runCartographer(runSql, memory, runId, emit);
    stats.warmStart = map.fromMemory;
    const schema = schemaPrompt(map);

    // 3. Planner.
    const periods = asObjects(await runSql(`SELECT DISTINCT period FROM ${USL}.gl_balance ORDER BY period`, "orchestrator:periods")).map((p) => p.period);
    const { plan } = await runPlanner(llm, { question: input.question, periods, schema, recall, periodA: input.periodA, periodB: input.periodB }, emit);
    await graph.addQuestion(input.question);
    for (const h of plan.hypotheses) await graph.addHypothesis(h);

    // 4. Quant (deterministic) and Investigators (parallel, ≤3).
    const memoryHints = recall.memories.filter((m) => m.tags.includes("finding") || m.tags.includes("ruling")).map((m) => `[${m.id}] ${m.content}`).join(" ");
    const toInvestigate = plan.answerable ? plan.hypotheses.filter((h) => h.driverType !== "data_gap") : [];
    const quantP = plan.answerable
      ? runQuant(runSql, plan.periodA, plan.periodB, emit).catch((err) => {
          emit("Quant", "error", { error: String(err).slice(0, 300) });
          return null;
        })
      : Promise.resolve(null);

    const investigate = (h: Hypothesis, round: number, request?: string) =>
      runInvestigator({ llm, runSql, hypothesis: h, periodA: plan.periodA, periodB: plan.periodB, schema, memoryHints, agent: `Investigator-${h.id}`, round, skepticRequest: request, nextEvidenceId, emit });

    const firstRound = await pool(toInvestigate, 3, (h) => investigate(h, 1));
    quant = await quantP;
    for (const q of quant?.evidence ?? []) evidence.set(q.id, q);

    let current: Finding[] = [];
    const record = async (r: { finding: Finding; evidence: EvidenceItem[] }) => {
      for (const e of r.evidence) evidence.set(e.id, e);
      stats.sqlRepairs += r.finding.repairs;
      await graph.addFinding({ id: r.finding.id, hypothesisId: r.finding.hypothesisId, claim: r.finding.claim, amountCad: r.finding.amountCad ?? undefined, driverType: r.finding.driverType, agent: r.finding.agent });
      for (const e of r.evidence.filter((x) => r.finding.evidenceIds.includes(x.id))) {
        await graph.addEvidence({ id: e.id, findingId: r.finding.id, sql: e.sql, sources: e.sources, rowCount: e.rowCount, headers: e.headers, sampleRows: e.rows.slice(0, 20), queryId: e.queryId, mentions: r.finding.entities.slice(0, 6).map((id) => ({ type: id.startsWith("VEND") ? "Vendor" : id.startsWith("CUST") ? "Customer" : /^\d{4}$/.test(id) ? "Account" : /^[A-Z]{3}-\d/.test(id) ? "Invoice" : "Sku", id })) }, r.finding.agent);
      }
      findings.push(r.finding);
      current.push(r.finding);
    };
    for (const r of firstRound) await record(r);

    if (!plan.answerable) {
      const gap: Finding = { id: "F-gap", hypothesisId: plan.hypotheses[0]?.id ?? "h1", driverType: "data_gap", claim: plan.missingData ?? "The available sources do not hold the data this question needs.", amountCad: null, evidenceIds: [], entities: [], agent: "Planner", round: 1, supported: true, sqlCalls: 0, repairs: 0 };
      findings.push(gap);
      current.push(gap);
    }

    // 5. Skeptic with send-back rounds.
    for (let round = 1; round <= MAX_SKEPTIC_ROUNDS && current.length; round++) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        emit("Orchestrator", "budget_exceeded", { round });
        break;
      }
      stats.skepticRounds = round;
      const decisions = await runSkeptic({ llm, memory, runId, plan, quant, findings: current, evidence, round, emit });
      for (const d of decisions) await graph.setVerdict(d.findingId, d.verdict, d.reason, "Skeptic");
      const back = decisions.filter((d) => d.verdict === "needs_more" && d.sendBack);
      current = [];
      if (round === MAX_SKEPTIC_ROUNDS || !back.length) break;
      const redo = await pool(back, 3, (d) => {
        const f = findings.find((x) => x.id === d.findingId)!;
        const h = plan.hypotheses.find((x) => x.id === f.hypothesisId)!;
        emit("Skeptic", "send_back", { hypothesisId: h.id, request: d.sendBack });
        return investigate(h, round + 1, d.sendBack);
      });
      for (const r of redo) await record(r);
    }

    // Latest finding per hypothesis is the one that counts.
    const latest = new Map<string, Finding>();
    for (const f of findings) latest.set(f.hypothesisId, f);
    const finalFindings = [...latest.values()];
    const rejected = finalFindings
      .filter((f) => f.verdict?.verdict === "rejected")
      .map((f) => ({ hypothesis: `${f.hypothesisId}: ${plan.hypotheses.find((h) => h.id === f.hypothesisId)?.text ?? f.claim}`, reason: f.verdict!.reason }));

    // 6. Writer.
    const { memo, openQuestions } = await runWriter({ llm, question: input.question, plan, quant, findings: finalFindings, evidence, rejected, emit });

    stats.durationMs = Date.now() - started;
    stats.servedBy = [...servedBy];
    const out: RunOutput = {
      runId,
      question: input.question,
      company: COMPANY,
      syntheticData: true,
      plan,
      periodA: plan.periodA,
      periodB: plan.periodB,
      headline: quant ? { revenueA: quant.bridge.revenueA, revenueB: quant.bridge.revenueB, gmA: quant.bridge.gmA, gmB: quant.bridge.gmB, gmPctA: quant.rate.gmPctA, gmPctB: quant.rate.gmPctB, deltaGm: quant.bridge.deltaGm, deltaPp: quant.rate.deltaPp } : {},
      bridge: quant?.components.map((c) => ({ ...c, ppOfRevenueB: quant!.rate.items.find((i) => i.key === c.key)?.pp ?? c.ppOfRevenueB })) ?? [],
      findings: finalFindings,
      evidence: [...evidence.values()],
      rejected,
      openQuestions,
      memo,
      memoryUsed: recall.memories.filter((m) => !m.tags.includes("schema-map")).map((m) => ({ id: m.id, content: m.content, relevance: m.relevance })),
      stats,
      status: "completed",
    };
    emit("Orchestrator", "run_end", { status: out.status, stats, writers: graph.writersSummary() });
    writeFileSync(join(logDir, `run-${runId}.json`), JSON.stringify(out, null, 1));
    return out;
  } catch (err) {
    stats.durationMs = Date.now() - started;
    const message = err instanceof ZetarisError ? `Zetaris: ${err.message.split("\n")[0]}` : String((err as Error).message ?? err);
    emit("Orchestrator", "run_error", { error: message.slice(0, 500) });
    const out: RunOutput = {
      runId,
      question: input.question,
      company: COMPANY,
      syntheticData: true,
      plan: { metric: "other", periodA: input.periodA ?? "", periodB: input.periodB ?? "", answerable: false, missingData: null, hypotheses: [] },
      periodA: input.periodA ?? "",
      periodB: input.periodB ?? "",
      headline: {},
      bridge: quant?.components ?? [],
      findings,
      evidence: [...evidence.values()],
      rejected: [],
      openQuestions: [],
      memo: `The investigation stopped early: ${message}`,
      memoryUsed: [],
      stats,
      status: findings.length || quant ? "partial" : "failed",
      error: message,
    };
    writeFileSync(join(logDir, `run-${runId}.json`), JSON.stringify(out, null, 1));
    return out;
  }
}
