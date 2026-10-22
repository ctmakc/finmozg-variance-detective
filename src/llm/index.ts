import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { MeterlessProvider, meterlessSettingsFromEnv } from "./providers/meterless.js";
import { OpenAiCompatProvider, nvidiaSettingsFromEnv, openAiCompatSettingsFromEnv } from "./providers/openaiCompat.js";
import { type ChatRequest, type ChatResult, LlmError, type Provider } from "./types.js";

export * from "./types.js";

export interface LlmEvent {
  type: "llm_call";
  agent?: string;
  role: ChatRequest["role"];
  provider: string;
  requestedModel: string;
  servedBy?: string;
  receiptId?: string;
  latencyMs: number;
  ok: boolean;
  toolCalls?: number;
  recorded?: boolean;
  error?: string;
}

export interface LlmOptions {
  provider?: Provider;
  mode?: "live" | "record" | "replay";
  recordingsDir?: string;
  onEvent?: (e: LlmEvent) => void;
}

export function providerFromEnv(env = process.env): Provider {
  switch (env.LLM_PROVIDER ?? "meterless") {
    case "meterless":
      return new MeterlessProvider(meterlessSettingsFromEnv(env));
    case "nvidia":
      return new OpenAiCompatProvider(nvidiaSettingsFromEnv(env));
    case "openai_compat":
      return new OpenAiCompatProvider(openAiCompatSettingsFromEnv(env));
    default:
      throw new Error(`Unknown LLM_PROVIDER ${env.LLM_PROVIDER}`);
  }
}

function requestKey(provider: string, req: ChatRequest): string {
  const stable = JSON.stringify({ provider, role: req.role, messages: req.messages, tools: req.tools?.map((t) => t.function.name) });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/** Strip <think> blocks and code fences, return the first balanced JSON object or array. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) throw new Error("no JSON object in reply");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in reply");
}

export class Llm {
  readonly provider: Provider;
  private readonly mode: "live" | "record" | "replay";
  private readonly dir: string;
  private readonly onEvent?: (e: LlmEvent) => void;
  calls = 0;

  constructor(opts: LlmOptions = {}) {
    this.mode = opts.mode ?? (process.env.SAMPLE_MODE === "true" ? "replay" : process.env.LLM_RECORD === "true" ? "record" : "live");
    this.provider = opts.provider ?? providerFromEnv();
    this.dir = join(opts.recordingsDir ?? process.env.RECORDINGS_DIR ?? "recordings", "llm");
    this.onEvent = opts.onEvent;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    const key = requestKey(this.provider.id, req);
    const path = join(this.dir, `${key}.json`);
    if (this.mode === "replay") {
      if (!existsSync(path)) throw new LlmError(`No recorded model reply for this request (SAMPLE_MODE). Key ${key}`, this.provider.id);
      const r: ChatResult = { ...JSON.parse(readFileSync(path, "utf8")).result, recorded: true };
      this.emit(req, r, true);
      return r;
    }
    try {
      const r = await this.provider.chat(req);
      if (this.mode === "record") {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(path, JSON.stringify({ agent: req.agent, result: r }, null, 1));
      }
      this.emit(req, r, true);
      return r;
    } catch (err) {
      this.onEvent?.({ type: "llm_call", agent: req.agent, role: req.role, provider: this.provider.id, requestedModel: "", latencyMs: 0, ok: false, error: (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  private emit(req: ChatRequest, r: ChatResult, ok: boolean) {
    this.onEvent?.({
      type: "llm_call",
      agent: req.agent,
      role: req.role,
      provider: r.provider,
      requestedModel: r.requestedModel,
      servedBy: r.servedBy,
      receiptId: r.receiptId,
      latencyMs: r.latencyMs,
      ok,
      toolCalls: r.toolCalls.length,
      recorded: r.recorded,
    });
  }

  /** Ask for JSON, validate with zod, retry once with the validation error. */
  async chatJson<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<{ value: T; result: ChatResult }> {
    let messages = req.messages;
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.chat({ ...req, messages });
      try {
        const value = schema.parse(extractJson(result.content));
        return { value, result };
      } catch (err) {
        lastErr = (err as Error).message.slice(0, 800);
        messages = [
          ...req.messages,
          { role: "assistant", content: result.content },
          { role: "user", content: `Your reply was not valid JSON for the required schema: ${lastErr}\nReply again with only the corrected JSON.` },
        ];
      }
    }
    throw new LlmError(`invalid JSON after retry: ${lastErr}`, this.provider.id);
  }

  /** Meterless engine generator contract (Markovian section 12): (prompt, attachments, systemPrompt?) → {text}. */
  generator(agent = "Skeptic") {
    return async (prompt: string, attachments: { name: string; content: string }[] = [], systemPrompt?: string) => {
      const att = attachments.map((a) => `\n[${a.name}]\n${a.content}`).join("");
      const r = await this.chat({
        role: "deep",
        agent,
        maxTokens: 4096,
        messages: [...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []), { role: "user", content: prompt + att }],
      });
      return { text: r.content, metadata: { servedBy: r.servedBy, receiptId: r.receiptId, usage: r.usage } };
    };
  }
}
