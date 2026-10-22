import { z } from "zod";

export const DRIVER_TYPES = ["price", "volume", "mix", "supplier_price", "fx", "booking_error", "packaging", "other_cost", "opex", "data_gap"] as const;
export type DriverType = (typeof DRIVER_TYPES)[number];

export const HypothesisSchema = z.object({
  id: z.string().min(1),
  driverType: z.enum(DRIVER_TYPES),
  text: z.string().min(3),
  checks: z.string().default(""),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const PlanSchema = z.object({
  metric: z.enum(["gross_margin", "cogs", "opex", "fx", "other"]),
  periodA: z.string().regex(/^\d{4}-\d{2}$/),
  periodB: z.string().regex(/^\d{4}-\d{2}$/),
  answerable: z.boolean(),
  missingData: z.string().optional().nullable(),
  hypotheses: z.array(HypothesisSchema).max(9),
});
export type Plan = z.infer<typeof PlanSchema>;

export const FindingSchema = z.object({
  supported: z.boolean().default(true),
  claim: z.string().min(3),
  amount_cad: z.number().nullable().optional(),
  evidence: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
export type FindingDraft = z.infer<typeof FindingSchema>;

export interface EvidenceItem {
  id: string;
  sql: string;
  sources: string[];
  headers: string[];
  rows: string[][];
  rowCount: number;
  queryId?: string;
  agent: string;
  error?: string;
}

export interface Finding {
  id: string;
  hypothesisId: string;
  driverType: DriverType;
  claim: string;
  amountCad: number | null;
  evidenceIds: string[];
  entities: string[];
  agent: string;
  round: number;
  supported: boolean;
  sqlCalls: number;
  repairs: number;
  verdict?: { verdict: "accepted" | "rejected" | "needs_more"; reason: string; by: string };
  review?: { verdict: string; reasons: string[]; chunks: number; savedPercent: number };
}

export interface BridgeComponent {
  key: string;
  label: string;
  driverType: DriverType | "residual";
  amountCad: number;
  ppOfRevenueB: number;
}

export interface TraceEvent {
  ts: string;
  runId: string;
  seq: number;
  agent: string;
  type: string;
  [k: string]: unknown;
}

export type Emit = (agent: string, type: string, data?: Record<string, unknown>) => void;

export interface RunInput {
  question: string;
  periodA?: string;
  periodB?: string;
}

export interface RunStats {
  sqlCalls: number;
  sqlErrors: number;
  sqlRepairs: number;
  llmCalls: number;
  skepticRounds: number;
  memoryRecalled: number;
  warmStart: boolean;
  durationMs: number;
  provider: string;
  servedBy: string[];
}

export interface RunOutput {
  runId: string;
  question: string;
  company: string;
  syntheticData: true;
  plan: Plan;
  periodA: string;
  periodB: string;
  headline: Record<string, number>;
  bridge: BridgeComponent[];
  findings: Finding[];
  evidence: EvidenceItem[];
  rejected: { hypothesis: string; reason: string }[];
  openQuestions: string[];
  memo: string;
  memoryUsed: { id: string; content: string; relevance: number }[];
  stats: RunStats;
  status: "completed" | "partial" | "failed";
  error?: string;
}
