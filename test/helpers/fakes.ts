/** Test doubles: a scripted model provider and a canned Zetaris runner. No network, no keys. */
import type { SqlResult } from "../../src/zetaris/client.js";
import { Llm } from "../../src/llm/index.js";
import type { ChatRequest, ChatResult, Provider, ToolCall } from "../../src/llm/types.js";

export type Reply = string | { content?: string; toolCalls?: ToolCall[]; finishReason?: string } | ((req: ChatRequest) => Partial<ChatResult>);

/** Provider that answers from a script, in order, and records every request. Throws when the script runs out. */
export class ScriptedProvider implements Provider {
  readonly id = "fake";
  readonly name = "Fake provider";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: Reply[]) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (next === undefined) throw new Error("ScriptedProvider: no reply left in the script");
    const r = typeof next === "function" ? next(req) : typeof next === "string" ? { content: next } : next;
    return { content: r.content ?? "", toolCalls: r.toolCalls ?? [], provider: this.id, requestedModel: "fake/model", servedBy: "fake/model", latencyMs: 1, finishReason: r.finishReason ?? "stop" };
  }

  async status() {
    return { status: "online" as const, models: [], baseUrl: "fake://" };
  }
}

export function fakeLlm(script: Reply[]) {
  const provider = new ScriptedProvider(script);
  return { llm: new Llm({ provider, mode: "live", recordingsDir: "/nonexistent-recordings" }), provider };
}

export const toolCall = (id: string, args: unknown): ToolCall => ({ id, type: "function", function: { name: "run_sql", arguments: typeof args === "string" ? args : JSON.stringify(args) } });

export function sqlResult(headers: string[], rows: (string | number | null)[][]): SqlResult {
  return { headers, rows: rows.map((r) => r.map((v) => (v === null ? "" : String(v)))), total: rows.length, timeUsedMs: 1, queryId: "q-test" };
}

/** Collects emitted trace events. */
export function recorder() {
  const events: { agent: string; type: string; data?: Record<string, unknown> }[] = [];
  return { events, emit: (agent: string, type: string, data?: Record<string, unknown>) => void events.push({ agent, type, data }) };
}
