/**
 * Investigator: one per hypothesis. A tool-calling loop with a single tool, run_sql, against Zetaris.
 * On a SQL error the model reads the error and repairs the query (≤3 repairs). Every query result becomes an
 * evidence item (E#) with its SQL, sources, row count and rows; the finding must cite evidence ids.
 */
import type { ChatMessage, Llm, ToolDef } from "../llm/index.js";
import { extractJson } from "../llm/index.js";
import { ZetarisError } from "../zetaris/client.js";
import type { RunSql } from "./quant.js";
import { type Emit, type EvidenceItem, type Finding, FindingSchema, type Hypothesis } from "./types.js";

export const MAX_TOOL_CALLS = 6;
export const MAX_REPAIRS = 3;
const ROWS_TO_MODEL = 30;

const RUN_SQL: ToolDef = {
  type: "function",
  function: {
    name: "run_sql",
    description: "Run ONE read-only SQL statement on Zetaris (Spark SQL) and get the rows back. Use full table names from the schema.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string", description: "one SELECT statement, no trailing semicolon" }, purpose: { type: "string", description: "what this query checks" } },
      required: ["sql"],
    },
  },
};

export function sourcesOf(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/finance_usl\.(\w+)/gi)) out.add(`finance_usl.${m[1].toLowerCase()}`);
  for (const m of sql.matchAll(/\b(fm_(?:erp|procure|orders|bank|boc))\.(\w+)/gi)) out.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  return [...out];
}

function rowsForModel(headers: string[], rows: string[][], total: number): string {
  const shown = rows.slice(0, ROWS_TO_MODEL);
  return [`columns: ${headers.join(" | ")}`, ...shown.map((r) => r.join(" | ")), total > shown.length ? `(${total - shown.length} more rows not shown)` : `(${total} rows)`].join("\n");
}

export interface InvestigatorArgs {
  llm: Llm;
  runSql: RunSql;
  hypothesis: Hypothesis;
  periodA: string;
  periodB: string;
  schema: string;
  memoryHints: string;
  agent: string;
  round: number;
  skepticRequest?: string;
  nextEvidenceId: () => string;
  emit: Emit;
}

export async function runInvestigator(a: InvestigatorArgs): Promise<{ finding: Finding; evidence: EvidenceItem[] }> {
  const evidence: EvidenceItem[] = [];
  let sqlCalls = 0;
  let repairs = 0;
  let lastFailed = false;
  const system = `You are ${a.agent}, an Investigator on a month-end variance team. You test ONE hypothesis with SQL through Zetaris and report only what the rows show.
${a.schema}
Rules: compare ${a.periodA} (base) with ${a.periodB}. Prefer the finance_usl tables. Aggregate in SQL; never invent numbers. Drill down to the responsible vendor, SKU, customer, invoice or account and name it. For a cost claim, show the rows from more than one system (for example AP lines and bank payments). If a query fails, read the error and fix the SQL. Stop after at most ${MAX_TOOL_CALLS} queries.
When done, reply with JSON only: {"supported": true|false, "claim": "one sentence with the key numbers", "amount_cad": <effect on gross margin in CAD for ${a.periodB} vs ${a.periodA}, negative if it lowers margin, null if not measurable>, "evidence": ["E#", ...], "entities": ["vendor/sku/customer/account ids"], "confidence": "high|medium|low"}`;
  const user = `Hypothesis ${a.hypothesis.id} [${a.hypothesis.driverType}]: ${a.hypothesis.text}
Suggested checks: ${a.hypothesis.checks || "your choice"}
${a.memoryHints ? `Memory from earlier closes: ${a.memoryHints}\n` : ""}${a.skepticRequest ? `The Skeptic sent this back with a request: ${a.skepticRequest}\n` : ""}Each query result you get is labelled with an evidence id (E#). Cite them.`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let final = "";
  for (let turn = 0; turn < MAX_TOOL_CALLS + 2; turn++) {
    const budgetLeft = sqlCalls < MAX_TOOL_CALLS && repairs <= MAX_REPAIRS;
    const r = await a.llm.chat({ role: "fast", agent: a.agent, maxTokens: 4096, messages, tools: budgetLeft ? [RUN_SQL] : undefined, toolChoice: budgetLeft ? "auto" : undefined });
    if (!r.toolCalls.length) {
      final = r.content;
      break;
    }
    messages.push({ role: "assistant", content: r.content || null, tool_calls: r.toolCalls });
    for (const call of r.toolCalls) {
      let args: { sql?: string; purpose?: string } = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* handled below */
      }
      const sql = (args.sql ?? "").trim().replace(/;\s*$/, "");
      if (!sql || sqlCalls >= MAX_TOOL_CALLS) {
        messages.push({ role: "tool", tool_call_id: call.id, content: sql ? "Query budget used up. Give your JSON answer now." : "ERROR: missing sql argument" });
        continue;
      }
      sqlCalls++;
      const id = a.nextEvidenceId();
      try {
        const res = await a.runSql(sql, `${a.agent}:${id}`);
        if (lastFailed) repairs++;
        lastFailed = false;
        const item: EvidenceItem = { id, sql, sources: sourcesOf(sql), headers: res.headers, rows: res.rows.slice(0, 200), rowCount: res.total, queryId: res.queryId, agent: a.agent };
        evidence.push(item);
        a.emit(a.agent, "sql", { evidenceId: id, purpose: args.purpose, sql, rowCount: res.total, timeUsedMs: res.timeUsedMs, recorded: res.recorded ?? false });
        messages.push({ role: "tool", tool_call_id: call.id, content: `${id}:\n${rowsForModel(res.headers, res.rows, res.total)}` });
      } catch (err) {
        const msg = err instanceof ZetarisError ? err.message.split("\n").slice(0, 6).join("\n") : String(err);
        lastFailed = true;
        evidence.push({ id, sql, sources: sourcesOf(sql), headers: [], rows: [], rowCount: 0, agent: a.agent, error: msg.slice(0, 500) });
        a.emit(a.agent, "sql_error", { evidenceId: id, sql, error: msg.slice(0, 300) });
        messages.push({ role: "tool", tool_call_id: call.id, content: `${id}: ERROR from Zetaris:\n${msg}\nFix the SQL and try again.` });
      }
    }
  }

  let draft;
  try {
    draft = FindingSchema.parse(extractJson(final));
  } catch {
    try {
      const { value } = await a.llm.chatJson(
        { role: "fast", agent: a.agent, maxTokens: 2048, messages: [...messages, { role: "assistant", content: final || "(no answer)" }, { role: "user", content: "Reply now with only the JSON finding described in the system message." }] },
        FindingSchema,
      );
      draft = value;
    } catch {
      draft = { supported: false, claim: `${a.agent} could not produce a finding for ${a.hypothesis.id}`, amount_cad: null, evidence: evidence.map((e) => e.id), entities: [], confidence: "low" as const };
    }
  }
  const known = new Set(evidence.map((e) => e.id));
  const finding: Finding = {
    id: `F-${a.hypothesis.id}-r${a.round}`,
    hypothesisId: a.hypothesis.id,
    driverType: a.hypothesis.driverType,
    claim: draft.claim,
    amountCad: draft.amount_cad ?? null,
    evidenceIds: draft.evidence.filter((e) => known.has(e)),
    entities: draft.entities,
    agent: a.agent,
    round: a.round,
    supported: draft.supported,
    sqlCalls,
    repairs,
  };
  a.emit(a.agent, "finding", { findingId: finding.id, hypothesisId: finding.hypothesisId, supported: finding.supported, claim: finding.claim, amountCad: finding.amountCad, evidence: finding.evidenceIds, sqlCalls, repairs });
  return { finding, evidence };
}
