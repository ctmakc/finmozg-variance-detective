/**
 * Writer: the variance memo. The model writes prose only from the facts it is given; a deterministic reviewer then
 * checks that every CAD figure in the memo exists in those facts, that cited evidence ids exist, and that the
 * residual and the human sign-off caveat are present. One rewrite on failure; otherwise the issues are appended.
 */
import type { Llm } from "../llm/index.js";
import type { QuantResult } from "./quant.js";
import type { Emit, EvidenceItem, Finding, Plan } from "./types.js";

export const DISCLAIMER = "Decision support on synthetic data. A controller must review the evidence and sign off before any entry, vendor claim or report.";

const fmt = (x: number) => `${x < 0 ? "-" : ""}CAD ${Math.abs(x).toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;

export function factsBlock(plan: Plan, quant: QuantResult | null, findings: Finding[], evidence: Map<string, EvidenceItem>, rejected: { hypothesis: string; reason: string }[]): string {
  const lines: string[] = [`Periods: base ${plan.periodA}, compared ${plan.periodB}. Metric: ${plan.metric}.`];
  if (quant) {
    const b = quant.bridge;
    lines.push(`Revenue ${fmt(b.revenueA)} → ${fmt(b.revenueB)}. Gross margin ${fmt(b.gmA)} (${quant.rate.gmPctA}%) → ${fmt(b.gmB)} (${quant.rate.gmPctB}%), change ${fmt(b.deltaGm)} and ${quant.rate.deltaPp} pp. [Q-sales] [Q-gl]`);
    lines.push("Deterministic margin bridge (Quant, exact; CAD and percentage points of margin):");
    for (const c of quant.components) {
      const pp = quant.rate.items.find((i) => i.key === c.key)?.pp ?? 0;
      lines.push(`- ${c.label}: ${fmt(c.amountCad)} (${pp >= 0 ? "+" : ""}${pp} pp) [Q-sales] [Q-costs] [Q-gl]`);
    }
    if (quant.duplicates.length) lines.push(`Invoices booked more times than paid: ${quant.duplicates.map((d) => `${d.vendorInvoiceNo} booked ${d.apDocs}× paid ${d.payments}×, ${fmt(d.amountCad)} each`).join("; ")}. [Q-duplicates]`);
    lines.push(`Reconciliation: ${quant.reconciliation.map((r) => `${r.check}: ${r.ok ? "ties" : `differs by ${r.periodB}`}`).join("; ")}.`);
    const opex = quant.glByAccount.filter((g) => g.type === "opex");
    if (opex.length) lines.push(`Opex accounts: ${opex.map((g) => `${g.period} ${g.account} ${g.name} ${fmt(g.amountCad)}`).join("; ")}. [Q-gl]`);
  }
  lines.push("Accepted findings (Skeptic-approved):");
  for (const f of findings.filter((x) => x.verdict?.verdict === "accepted")) {
    const ev = f.evidenceIds.filter((id) => evidence.has(id));
    lines.push(`- ${f.id} [${f.driverType}] ${f.claim} | Skeptic: ${f.verdict?.reason} | evidence ${ev.map((e) => `[${e}]`).join(" ") || "none"}`);
  }
  if (rejected.length) {
    lines.push("Rejected hypotheses:");
    for (const r of rejected) lines.push(`- ${r.hypothesis}: ${r.reason}`);
  }
  return lines.join("\n");
}

/** CAD amounts ≥ 1,000 written in the memo that match no figure in the facts (within 1 %). */
export function unknownAmounts(memo: string, facts: string): string[] {
  const parse = (s: string) => Number(s.replace(/[,\s]/g, ""));
  const known = [...facts.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?/g)].map((m) => parse(m[1]));
  const out: string[] = [];
  for (const m of memo.matchAll(/(?:CAD|\$)\s?-?(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?/g)) {
    const v = parse(m[1]);
    if (v < 1000) continue;
    if (!known.some((k) => Math.abs(k - v) <= Math.max(1, k * 0.01))) out.push(m[0]);
  }
  return [...new Set(out)];
}

export function reviewMemo(memo: string, facts: string, evidenceIds: Set<string>): string[] {
  const issues: string[] = [];
  const unknown = unknownAmounts(memo, facts);
  if (unknown.length) issues.push(`Amounts not in the facts: ${unknown.join(", ")}`);
  const cited = [...memo.matchAll(/\[((?:E|Q-)[\w-]+)\]/g)].map((m) => m[1]);
  const bad = cited.filter((c) => !evidenceIds.has(c));
  if (bad.length) issues.push(`Unknown evidence ids: ${[...new Set(bad)].join(", ")}`);
  if (!/residual|unexplained/i.test(memo)) issues.push("The memo must state the unexplained residual.");
  return issues;
}

export async function runWriter(args: {
  llm: Llm;
  question: string;
  plan: Plan;
  quant: QuantResult | null;
  findings: Finding[];
  evidence: Map<string, EvidenceItem>;
  rejected: { hypothesis: string; reason: string }[];
  emit: Emit;
}): Promise<{ memo: string; openQuestions: string[]; issues: string[] }> {
  const facts = factsBlock(args.plan, args.quant, args.findings, args.evidence, args.rejected);
  const ids = new Set([...args.evidence.keys()]);
  const system = `You are the Writer. Write a variance memo for a controller and the company owner.
Use ONLY the facts given. Every sentence with a number cites its evidence id in square brackets, e.g. [E3] or [Q-gl]. Never compute new numbers; copy them.
Structure (markdown): "## Answer" (2-3 sentences), "## Drivers" (bullets for every non-zero bridge line, largest first, amount and pp, the named vendor/SKU/customer/invoice when a finding names it, evidence, and the action for the controller, e.g. claim a credit from a vendor or reverse a duplicate entry), "## Rejected explanations" (bullets with the reason), "## Unexplained residual" (one line), "## Open questions" (at most 4 bullets the data cannot answer). Plain business English, no hype.`;
  let messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Question: ${args.question}\n\nFACTS:\n${facts}` },
  ];
  let memo = "";
  let issues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await args.llm.chat({ role: "deep", agent: "Writer", maxTokens: 6000, messages });
    memo = r.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    issues = reviewMemo(memo, facts, ids);
    args.emit("Writer", attempt === 0 ? "memo_draft" : "memo_rewrite", { chars: memo.length, issues });
    if (!issues.length) break;
    messages = [...messages, { role: "assistant" as const, content: memo } as never, { role: "user" as const, content: `Reviewer found problems: ${issues.join(" | ")}. Rewrite the whole memo and fix them, using only the facts.` }];
  }
  if (issues.length) memo += `\n\n> Reviewer notes (unresolved after one rewrite): ${issues.join("; ")}`;
  if (!memo.includes(DISCLAIMER)) memo += `\n\n_${DISCLAIMER}_`;
  const oq = memo.split(/##\s*Open questions/i)[1] ?? "";
  const openQuestions = [...oq.split(/\n##/)[0].matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 8);
  return { memo, openQuestions, issues };
}
