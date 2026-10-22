export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** deep = planning, skepticism, writing; fast = SQL drafts and repairs. */
export type LlmRole = "deep" | "fast";

export interface ChatRequest {
  role: LlmRole;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
  /** Who is calling, for traces (Planner, Investigator-2, Skeptic…). */
  agent?: string;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  provider: string;
  /** Model id we asked for (a meterless/* route or a concrete model). */
  requestedModel: string;
  /** Model that actually served the request, from the response or the Meterless receipt. */
  servedBy: string;
  receiptId?: string;
  latencyMs: number;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  recorded?: boolean;
}

export type ProviderStatus = "online" | "unauthorized" | "offline";

export interface Provider {
  id: string;
  name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  status(): Promise<{ status: ProviderStatus; models: string[]; baseUrl: string; detail?: string }>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
