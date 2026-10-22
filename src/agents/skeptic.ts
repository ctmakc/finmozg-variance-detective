/**
 * Skeptic: holds the veto. Deterministic rules first, then a Markovian review of the evidence rows for cost
 * claims. Can send a hypothesis back to its Investigator with a concrete request (≤2 rounds).
 */
import type { Llm } from "../llm/index.js";
import type { DetectiveMemory } from "../memory/hmem.js";
import { reviewEvidence } from "../review/markovian.js";
import type { QuantResult } from "./quant.js";
import type { DriverType, Emit, EvidenceItem, Finding, Plan } from "./types.js";

export const MAX_SKEPTIC_ROUNDS = 2;

const COMPONENT_FOR: Partial<Record<DriverType, string>> = {
  price: "price",
  volume: "volume",
  mix: "mix",
  supplier_price: "supplierPrice",
  fx: "fx",
  booking_error: "bookingError",
  packaging: "packagingReal",
  other_cost: "otherCost",
};

const GM_DRIVERS: DriverType[] = ["price", "volume", "mix", "supplier_price", "fx", "booking_error", "packaging", "other_cost"];

export interface SkepticDecision {
  findingId: string;
  verdict: "accepted" | "rejected" | "needs_more";
  reason: string;
  sendBack?: string;
  bridgeAmountCad?: number;
}

const touches = (ev: EvidenceItem[], re: RegExp) => ev.some((e) => e.rowCount > 0 && e.sources.some((s) => re.test(s)));

export function tolerance(component: number, revenueB: number) {
  return Math.max(1000, Math.abs(component) * 0.1, revenueB * 0.0005);
}

/** Pure rule check, no model. Exported for tests. */
export function ruleCheck(f: Finding, ev: EvidenceItem[], plan: Plan, quant: QuantResult | null, round: number): SkepticDecision {
  const last = round >= MAX_SKEPTIC_ROUNDS;
  const withRows = ev.filter((e) => e.rowCount > 0 && !e.error);
  if (f.driverType === "data_gap") return { findingId: f.id, verdict: "accepted", reason: "Data gap reported honestly; no number is claimed." };
  const key0 = COMPONENT_FOR[f.driverType];
  const comp0 = plan.metric === "gross_margin" && quant && key0 ? (quant.components.find((c) => c.key === key0)?.amountCad ?? 0) : 0;
  if (!f.supported) {
    // Challenge false negatives: the deterministic bridge says this driver moved.
    if (quant && key0 && Math.abs(comp0) >= tolerance(comp0, quant.bridge.revenueB) && !last) {
      return {
        findingId: f.id,
        verdict: "needs_more",
        reason: `Investigator found no support, but the deterministic bridge measures CAD ${comp0.toFixed(0)} for ${key0}.`,
        sendBack: `The margin bridge measures CAD ${comp0.toFixed(0)} for ${key0} in ${plan.periodB} vs ${plan.periodA}. Find the rows behind it: break it down by vendor, SKU, customer or invoice until the responsible items are named.`,
        bridgeAmountCad: comp0,
      };
    }
    if (quant && key0 && Math.abs(comp0) >= tolerance(comp0, quant.bridge.revenueB)) {
      return { findingId: f.id, verdict: "needs_more", reason: `Measured by the bridge (CAD ${comp0.toFixed(0)}) but not traced to named rows after ${round} rounds: reported as an open question, not as a confirmed cause.`, bridgeAmountCad: comp0 };
    }
    if (quant && key0 && Math.abs(comp0) < 100) {
      return { findingId: f.id, verdict: "rejected", reason: `No effect: the deterministic bridge measures CAD ${comp0.toFixed(0)} for ${key0}, and the Investigator found no change either.`, bridgeAmountCad: comp0 };
    }
    return { findingId: f.id, verdict: "rejected", reason: `Investigator's own queries do not support it: ${f.claim}` };
  }
  if (!withRows.length) {
    return last
      ? { findingId: f.id, verdict: "rejected", reason: "No evidence rows behind the claim." }
      : { findingId: f.id, verdict: "needs_more", reason: "No evidence rows cited.", sendBack: "Cite at least one query (E#) whose rows show the effect." };
  }
  if (plan.metric === "gross_margin" && f.driverType === "opex") {
    return { findingId: f.id, verdict: "rejected", reason: "Operating expenses sit below gross margin (account type opex), so they cannot explain a gross-margin change." };
  }
  if (f.driverType === "booking_error" && !touches(withRows, /vendor_payment|fm_bank/)) {
    return last
      ? { findingId: f.id, verdict: "rejected", reason: "A booking error needs the bank feed to show the invoice was paid fewer times than booked; no bank evidence." }
      : { findingId: f.id, verdict: "needs_more", reason: "Booking-error claim lacks bank confirmation.", sendBack: "Confirm against the bank feed (finance_usl.vendor_payment): how many times was each duplicated vendor invoice paid?" };
  }
  if (f.driverType === "supplier_price" && !touches(withRows, /purchase_line|fm_procure/)) {
    return last
      ? { findingId: f.id, verdict: "rejected", reason: "Supplier-price claim has no AP line evidence." }
      : { findingId: f.id, verdict: "needs_more", reason: "No AP invoice line evidence.", sendBack: "Compare unit_price_orig with contract_unit_price in finance_usl.purchase_line for both periods." };
  }
  const headersSeen = withRows.flatMap((e) => e.headers.map((h) => h.toLowerCase()));
  const needEntity: Partial<Record<DriverType, { re: RegExp; ask: string }>> = {
    supplier_price: { re: /contract/, ask: "Show line-level rows from finance_usl.purchase_line with vendor_id, sku, unit_price_orig and contract_unit_price for both periods, and name the vendor invoicing above contract." },
    mix: { re: /channel|customer/, ask: "Break the change down by customer and channel (finance_usl.sales_line join finance_usl.customer) and name the customer or channel whose share grew." },
  };
  const need = needEntity[f.driverType];
  if (need && !headersSeen.some((h) => need.re.test(h)) && !last) {
    return { findingId: f.id, verdict: "needs_more", reason: "Aggregate totals only; the claim does not name who caused it.", sendBack: need.ask };
  }
  // Entity cross-check against Quant's deterministic drill-down: the finding must name who caused it.
  if (quant && !last) {
    const said = `${f.claim} ${f.entities.join(" ")}`.toLowerCase();
    const named = (id: string) => said.includes(id.toLowerCase()) || said.includes((quant.names[id] ?? "~").toLowerCase());
    const topVendor = quant.overContract[0];
    if (f.driverType === "supplier_price" && topVendor && !named(topVendor.vendorId)) {
      return { findingId: f.id, verdict: "needs_more", reason: `The claim does not name the vendor; Quant's drill-down shows ${topVendor.vendorId} invoicing above contract.`, sendBack: `Quant's drill-down shows ${topVendor.vendorId} (${topVendor.vendorName}) invoicing above contract on ${topVendor.lines} lines in ${plan.periodB}. Confirm or refute with line-level rows (vendor_id, sku, qty, unit_price_orig, contract_unit_price) and name the vendor in your claim.` };
    }
    const topCustomer = quant.customerShift[0];
    if (f.driverType === "mix" && topCustomer && !named(topCustomer.customerId) && !/wholesale/.test(said)) {
      return { findingId: f.id, verdict: "needs_more", reason: "The claim does not name the customer or channel behind the mix shift.", sendBack: `Quant's drill-down shows ${topCustomer.customerId} (${topCustomer.customerName}, ${topCustomer.channel}) with the largest volume increase (${topCustomer.qtyA} → ${topCustomer.qtyB} units). Confirm with rows by customer and channel and name them in your claim.` };
    }
  }
  const key = COMPONENT_FOR[f.driverType];
  if (plan.metric === "gross_margin" && quant && key && GM_DRIVERS.includes(f.driverType)) {
    const comp = quant.components.find((c) => c.key === key)?.amountCad ?? 0;
    const tol = tolerance(comp, quant.bridge.revenueB);
    if (Math.abs(comp) < 100) {
      return { findingId: f.id, verdict: "rejected", reason: `The deterministic bridge measures CAD ${comp.toFixed(0)} for this driver: no effect on gross margin${f.amountCad ? `; the claimed CAD ${f.amountCad.toFixed(0)} is not supported` : ""}.`, bridgeAmountCad: comp };
    }
    if (Math.abs(comp) < tol) {
      return { findingId: f.id, verdict: "accepted", reason: `Real but immaterial: the bridge measures CAD ${comp.toFixed(0)} for this driver${f.amountCad !== null && Math.abs(f.amountCad - comp) > 100 ? ` (the Investigator's CAD ${f.amountCad.toFixed(0)} is replaced by the bridge figure)` : ""}.`, bridgeAmountCad: comp };
    }
    if (f.amountCad === null || Math.abs(f.amountCad - comp) > tol) {
      return last
        ? { findingId: f.id, verdict: "accepted", reason: `Direction confirmed by evidence; the amount is taken from the deterministic bridge (CAD ${comp.toFixed(0)}) because the Investigator's figure (${f.amountCad === null ? "none" : f.amountCad.toFixed(0)}) did not reconcile.`, bridgeAmountCad: comp }
        : {
            findingId: f.id,
            verdict: "needs_more",
            reason: `Amount ${f.amountCad === null ? "missing" : f.amountCad.toFixed(0)} does not reconcile with the bridge (CAD ${comp.toFixed(0)}).`,
            sendBack: `Your amount does not reconcile with the deterministic margin bridge, which measures CAD ${comp.toFixed(0)} for ${key}. Recompute the effect on ${plan.periodB} gross margin at ${plan.periodB} quantities and explain any gap.`,
            bridgeAmountCad: comp,
          };
    }
    return { findingId: f.id, verdict: "accepted", reason: `Evidence rows support it and the amount reconciles with the bridge (CAD ${comp.toFixed(0)}).`, bridgeAmountCad: comp };
  }
  return { findingId: f.id, verdict: "accepted", reason: "Evidence rows support the claim." };
}

export async function runSkeptic(args: {
  llm: Llm;
  memory: DetectiveMemory;
  runId: string;
  plan: Plan;
  quant: QuantResult | null;
  findings: Finding[];
  evidence: Map<string, EvidenceItem>;
  round: number;
  emit: Emit;
}): Promise<SkepticDecision[]> {
  const out: SkepticDecision[] = [];
  for (const f of args.findings) {
    const ev = f.evidenceIds.map((id) => args.evidence.get(id)).filter((e): e is EvidenceItem => !!e);
    const d = ruleCheck(f, ev, args.plan, args.quant, args.round);
    if (d.verdict === "rejected" && f.driverType === "opex" && args.plan.metric === "gross_margin") {
      args.memory.rememberRuling("Operating expenses (account type opex, e.g. 6100 Marketing) sit below gross margin: never report them as gross-margin drivers.", args.runId);
    }
    // Markovian review of the rows behind accepted cost claims.
    if (d.verdict === "accepted" && (f.driverType === "booking_error" || f.driverType === "supplier_price")) {
      const rowsEv = ev.filter((e) => e.rowCount > 0);
      const headers = rowsEv[0]?.headers ?? [];
      const rows = rowsEv.flatMap((e) => e.rows.map((r) => (e.headers.join("|") === headers.join("|") ? r : [`${e.id}:`, ...r])));
      args.emit("Skeptic", "review_start", { findingId: f.id, rows: rows.length });
      try {
        const review = await reviewEvidence(
          {
            claim: f.claim,
            headers,
            rows,
            instructions:
              f.driverType === "booking_error"
                ? "Check that each invoice flagged as a duplicate is booked more times in AP than it is paid in the bank, and that amounts match. Contradicted if the rows show a second real payment."
                : "Check that the invoiced unit price exceeds the contracted unit price on the claimed lines and that other lines are at contract. Contradicted if the lines are at contract.",
            batchSize: 20,
          },
          args.llm.generator("Skeptic"),
          { runLabel: `${args.runId}:${f.id}` },
        );
        f.review = { verdict: review.verdict, reasons: review.reasons, chunks: review.chunks, savedPercent: review.tokens.savedPercent };
        args.emit("Skeptic", "review", { findingId: f.id, verdict: review.verdict, chunks: review.chunks, reasons: review.reasons, tokens: review.tokens });
        if (review.verdict === "contradicted") {
          d.verdict = "rejected";
          d.reason = `Markovian evidence review contradicts it: ${review.reasons.join("; ")}`;
        }
      } catch (err) {
        args.emit("Skeptic", "review_error", { findingId: f.id, error: String(err).slice(0, 200) });
      }
    }
    f.verdict = { verdict: d.verdict, reason: d.reason, by: "Skeptic" };
    args.emit("Skeptic", "verdict", { findingId: f.id, hypothesisId: f.hypothesisId, verdict: d.verdict, reason: d.reason, sendBack: d.sendBack });
    out.push(d);
  }
  return out;
}
