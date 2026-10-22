/**
 * Planner: question → metric, periods and a hypothesis tree. Recalls H-MEM first, so confirmed findings from
 * earlier closes shape the plan (and are checked first). Falls back to a default tree if the model's JSON is invalid.
 */
import type { Llm } from "../llm/index.js";
import type { Recall } from "../memory/hmem.js";
import { DRIVER_TYPES, type Emit, type Plan, PlanSchema } from "./types.js";

export function defaultPlan(periodA: string, periodB: string): Plan {
  return {
    metric: "gross_margin",
    periodA,
    periodB,
    answerable: true,
    missingData: null,
    hypotheses: [
      { id: "h1", driverType: "mix", text: "Sales shifted toward lower-margin customers or channels (wholesale)", checks: "revenue and qty by channel and customer, both periods" },
      { id: "h2", driverType: "supplier_price", text: "A supplier invoiced above the contracted unit price", checks: "purchase_line unit_price_orig vs contract_unit_price by vendor and sku" },
      { id: "h3", driverType: "booking_error", text: "A vendor invoice was booked twice in AP/GL but paid once", checks: "vendor_bill duplicates vs vendor_payment" },
      { id: "h4", driverType: "fx", text: "The USD/CAD rate raised the CAD cost of USD purchases", checks: "fx_rate on USD invoices, both periods" },
      { id: "h5", driverType: "price", text: "Selling prices changed", checks: "unit_price_cad by sku and channel" },
      { id: "h6", driverType: "opex", text: "Operating expenses (e.g. marketing) rose", checks: "gl_balance opex accounts; is it below gross margin?" },
    ],
  };
}

export async function runPlanner(
  llm: Llm,
  args: { question: string; periods: string[]; schema: string; recall: Recall; periodA?: string; periodB?: string },
  emit: Emit,
): Promise<{ plan: Plan; fallback: boolean }> {
  const lastTwo = args.periods.slice(-2);
  const memoryBlock = args.recall.memories.length
    ? `What we remember from earlier closes (H-MEM, cite by id if it shapes the plan):\n${args.recall.memories.map((m) => `- [${m.id}] ${m.content}`).join("\n")}`
    : "No memories from earlier closes yet.";
  const system = `You are the Planner in a finance variance investigation team for a controller at month-end close.
Turn the question into a JSON plan. Hypotheses must be testable with the available tables. Use these driverType values only: ${DRIVER_TYPES.join(", ")}.
Gross margin drivers: price, volume, mix, supplier_price, fx, booking_error, packaging, other_cost. Operating expenses are "opex" (below gross margin).
If the question needs data that no table holds (for example payroll or headcount), set answerable=false, explain in missingData, and add one data_gap hypothesis.
For gross margin, cover the drivers a controller checks: selling price, volume, customer/channel mix, supplier unit price vs contract, USD/CAD rate on USD purchases, booking errors (an AP invoice booked more times than the bank paid it), and packaging.
Also add one hypothesis for the largest movement elsewhere in the P&L that a reader might blame (for example an operating expense), so the team can confirm or reject it with evidence.
Name concrete tables and columns in "checks". If memory says a finding was confirmed, add a hypothesis that checks it first. Max 7 hypotheses. Reply with JSON only.`;
  const user = `Question: ${args.question}
Available periods: ${args.periods.join(", ")} (latest two: ${lastTwo.join(", ")}). ${args.periodA && args.periodB ? `The user fixed periodA=${args.periodA}, periodB=${args.periodB}.` : "If the question names months, use them; otherwise compare the latest two."}
${args.schema}
${memoryBlock}

JSON shape: {"metric":"gross_margin|cogs|opex|fx|other","periodA":"YYYY-MM","periodB":"YYYY-MM","answerable":true,"missingData":null,"hypotheses":[{"id":"h1","driverType":"mix","text":"...","checks":"which tables/columns to compare"}]}`;
  try {
    const { value } = await llm.chatJson({ role: "deep", agent: "Planner", maxTokens: 4096, messages: [{ role: "system", content: system }, { role: "user", content: user }] }, PlanSchema);
    const plan = { ...value, hypotheses: value.hypotheses.map((h, i) => ({ ...h, id: `h${i + 1}` })) };
    if (args.periodA && args.periodB) Object.assign(plan, { periodA: args.periodA, periodB: args.periodB });
    emit("Planner", "plan", { metric: plan.metric, periodA: plan.periodA, periodB: plan.periodB, answerable: plan.answerable, hypotheses: plan.hypotheses });
    return { plan, fallback: false };
  } catch (err) {
    const plan = defaultPlan(args.periodA ?? lastTwo[0], args.periodB ?? lastTwo[1]);
    emit("Planner", "plan_fallback", { error: (err as Error).message.slice(0, 300), hypotheses: plan.hypotheses });
    return { plan, fallback: true };
  }
}
