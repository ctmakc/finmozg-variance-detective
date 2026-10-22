/** Any OpenAI-compatible endpoint: NVIDIA build.nvidia.com (NVIDIA_*) or another host (OPENAI_COMPAT_*). */
import type { ChatRequest, ChatResult, Provider, ProviderStatus } from "../types.js";
import { postChat } from "./openaiShape.js";

export interface OpenAiCompatSettings {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelDeep: string;
  modelFast: string;
  fetchImpl?: typeof fetch;
}

export function nvidiaSettingsFromEnv(env = process.env): OpenAiCompatSettings {
  const model = env.NVIDIA_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
  return {
    id: "nvidia",
    name: "NVIDIA API (build.nvidia.com)",
    baseUrl: (env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
    apiKey: env.NVIDIA_API_KEY ?? "",
    modelDeep: model,
    modelFast: env.NVIDIA_MODEL_FAST ?? model,
  };
}

export function openAiCompatSettingsFromEnv(env = process.env): OpenAiCompatSettings {
  const model = env.OPENAI_COMPAT_MODEL ?? "nemotron-3-super:cloud";
  return {
    id: "openai_compat",
    name: "OpenAI-compatible endpoint",
    baseUrl: (env.OPENAI_COMPAT_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
    apiKey: env.OPENAI_COMPAT_API_KEY ?? "none",
    modelDeep: model,
    modelFast: env.OPENAI_COMPAT_MODEL_FAST ?? model,
  };
}

export class OpenAiCompatProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly s: OpenAiCompatSettings) {
    this.id = s.id;
    this.name = s.name;
    this.fetchImpl = s.fetchImpl ?? fetch;
  }

  get baseUrl() {
    return this.s.baseUrl;
  }

  async status(): Promise<{ status: ProviderStatus; models: string[]; baseUrl: string; detail?: string }> {
    try {
      const res = await this.fetchImpl(`${this.s.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.s.apiKey}` } });
      if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [], baseUrl: this.s.baseUrl };
      if (!res.ok) return { status: "offline", models: [], baseUrl: this.s.baseUrl, detail: `HTTP ${res.status}` };
      const j: any = await res.json();
      return { status: "online", models: (j.data ?? []).map((m: any) => m.id), baseUrl: this.s.baseUrl };
    } catch (err) {
      return { status: "offline", models: [], baseUrl: this.s.baseUrl, detail: String(err) };
    }
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return postChat({
      provider: this.id,
      baseUrl: this.s.baseUrl,
      headers: { Authorization: `Bearer ${this.s.apiKey}` },
      model: req.role === "fast" ? this.s.modelFast : this.s.modelDeep,
      req,
      fetchImpl: this.fetchImpl,
    });
  }
}
