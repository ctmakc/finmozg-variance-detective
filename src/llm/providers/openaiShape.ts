import { type ChatRequest, type ChatResult, LlmError, type ToolCall } from "../types.js";

export const MODEL_TIMEOUT_MS = 180_000;

interface PostArgs {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  req: ChatRequest;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/** POST {baseUrl}/chat/completions in the OpenAI shape and normalise the reply. */
export async function postChat({ provider, baseUrl, headers, model, req, fetchImpl, timeoutMs }: PostArgs): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature ?? 0.2,
    stream: false,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? MODEL_TIMEOUT_MS);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? `model call timed out after ${(timeoutMs ?? MODEL_TIMEOUT_MS) / 1000}s` : String(err);
    throw new LlmError(msg, provider);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, provider, res.status);
  }
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new LlmError(`non-JSON reply: ${text.slice(0, 200)}`, provider, res.status);
  }
  const msg = j.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
    id: tc.id ?? `call_${i}`,
    type: "function",
    function: {
      name: tc.function?.name ?? "",
      arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }));
  const receipt = j.meterless;
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    reasoning: msg.reasoning ?? msg.reasoning_content ?? undefined,
    toolCalls,
    provider,
    requestedModel: model,
    servedBy: receipt?.routed_model ?? j.model ?? model,
    receiptId: receipt?.receipt_id,
    latencyMs: Date.now() - started,
    usage: j.usage ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens } : undefined,
  };
}
