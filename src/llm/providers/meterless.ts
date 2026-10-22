/**
 * Meterless Runtime provider (Nightshift hotspot), per docs/reference/meterless-provider-contract-v4.md
 * (Meterless Runtime 1.4, provider contract v4).
 */
import { existsSync, readFileSync } from "node:fs";
import { type ChatRequest, type ChatResult, LlmError, type Provider, type ProviderStatus } from "../types.js";
import { postChat, MODEL_TIMEOUT_MS } from "./openaiShape.js";

export const METERLESS_PROVIDER_ID = "meterless";
export const METERLESS_PROVIDER_NAME = "Meterless Runtime";
export const DEFAULT_METERLESS_BASE_URL = "http://127.0.0.1:8088/v1";
/** Stable lowercase id for this app, sent as meterless-app on every request. */
export const METERLESS_APP_ID = "finmozg-variance-detective";
/** Settings key the runtime token is stored under. */
export const TOKEN_SETTINGS_KEY = "meterless_runtime_token";
export const AUTO_DETECT_PORTS = [8088, 8090, 8787, 11434];
export const AUTO_DETECT_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Normalise whatever the user pasted to <scheme>://<host[:port]>/v1.
 * Accepts no scheme, /v1, /v1/chat/completions, /v1/models, /healthz; never yields /v1/v1.
 */
export function normaliseBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) return DEFAULT_METERLESS_BASE_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(chat\/completions|models|healthz)$/i, "");
  path = path.replace(/(\/v1)+$/i, "");
  // anything left before /v1 (a reverse-proxy prefix) is kept
  return `${u.protocol}//${u.host}${path}/v1`;
}

/** Connect link http://<host>:<port>/connect#k=<key> → { baseUrl, token }. Never log the result. */
export function parseConnectLink(link: string): { baseUrl: string; token: string } | null {
  try {
    const u = new URL(link.trim());
    if (!/\/connect\/?$/.test(u.pathname)) return null;
    const k = new URLSearchParams(u.hash.replace(/^#/, "")).get("k");
    if (!k) return null;
    return { baseUrl: `${u.origin}/v1`, token: k };
  } catch {
    return null;
  }
}

export function validateToken(token: string | undefined): string {
  const t = (token ?? "").trim();
  if (!t) throw new LlmError(`No ${METERLESS_PROVIDER_NAME} token: set METERLESS_RUNTIME_TOKEN or METERLESS_TOKEN_FILE (<stateDir>/proxy-token)`, METERLESS_PROVIDER_ID);
  if (t === "rt-local") throw new LlmError(`The placeholder token "rt-local" is rejected; paste the real token from Nightshift's Console`, METERLESS_PROVIDER_ID);
  return t;
}

export interface MeterlessSettings {
  baseUrl?: string;
  /** settings[meterless_runtime_token] */
  [TOKEN_SETTINGS_KEY]?: string;
  tokenFile?: string;
  modelDeep?: string;
  modelFast?: string;
  fetchImpl?: typeof fetch;
}

export function meterlessSettingsFromEnv(env = process.env): MeterlessSettings {
  const link = env.METERLESS_CONNECT_LINK ? parseConnectLink(env.METERLESS_CONNECT_LINK) : null;
  return {
    baseUrl: link?.baseUrl ?? env.METERLESS_BASE_URL ?? DEFAULT_METERLESS_BASE_URL,
    [TOKEN_SETTINGS_KEY]: link?.token ?? env.METERLESS_RUNTIME_TOKEN,
    tokenFile: env.METERLESS_TOKEN_FILE,
    modelDeep: env.METERLESS_MODEL_DEEP ?? env.METERLESS_MODEL ?? "meterless/deep",
    modelFast: env.METERLESS_MODEL_FAST ?? env.METERLESS_MODEL ?? "meterless/fast",
  };
}

export function readToken(s: MeterlessSettings): string | undefined {
  if (s[TOKEN_SETTINGS_KEY]) return s[TOKEN_SETTINGS_KEY];
  if (s.tokenFile && existsSync(s.tokenFile)) return readFileSync(s.tokenFile, "utf8").trim();
  return undefined;
}

function baseHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "meterless-app": METERLESS_APP_ID };
}

/** GET /v1/models decides: 401/403 unauthorized, 200 with meterless/* ids online, anything else offline. */
export async function probe(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ status: ProviderStatus; models: string[]; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: token ? baseHeaders(token) : { "meterless-app": METERLESS_APP_ID },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [], detail: `HTTP ${res.status}` };
    if (res.status !== 200) return { status: "offline", models: [], detail: `HTTP ${res.status}` };
    const j: any = await res.json().catch(() => ({}));
    const ids: string[] = (j.data ?? []).map((m: any) => String(m.id ?? "")).filter(Boolean);
    // keep every meterless/* id, including ones this app does not recognise
    const meterless = ids.filter((id) => id.startsWith("meterless/"));
    if (!meterless.length) return { status: "offline", models: [], detail: "no meterless/* models in /v1/models" };
    return { status: "online", models: ids };
  } catch (err) {
    return { status: "offline", models: [], detail: (err as Error).name === "AbortError" ? "timeout" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Try 8088, 8090, 8787, 11434 on 127.0.0.1, localhost and [::1]; first online or unauthorized hit wins. */
export async function autoDetect(token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ baseUrl: string; status: ProviderStatus } | null> {
  for (const port of AUTO_DETECT_PORTS) {
    for (const host of AUTO_DETECT_HOSTS) {
      const baseUrl = `http://${host}:${port}/v1`;
      const r = await probe(baseUrl, token, fetchImpl, 1500);
      if (r.status === "online" || r.status === "unauthorized") return { baseUrl, status: r.status };
    }
  }
  return null;
}

export class MeterlessProvider implements Provider {
  readonly id = METERLESS_PROVIDER_ID;
  readonly name = METERLESS_PROVIDER_NAME;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly settings: MeterlessSettings = meterlessSettingsFromEnv()) {
    this.baseUrl = normaliseBaseUrl(settings.baseUrl ?? DEFAULT_METERLESS_BASE_URL);
    this.fetchImpl = settings.fetchImpl ?? fetch;
  }

  modelFor(role: ChatRequest["role"]): string {
    return (role === "fast" ? this.settings.modelFast : this.settings.modelDeep) ?? "meterless/auto";
  }

  async status() {
    const r = await probe(this.baseUrl, readToken(this.settings), this.fetchImpl);
    return { ...r, baseUrl: this.baseUrl };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const token = validateToken(readToken(this.settings));
    return postChat({
      provider: this.id,
      baseUrl: this.baseUrl,
      headers: { ...baseHeaders(token), "meterless-scope": "user" },
      model: this.modelFor(req.role),
      req,
      fetchImpl: this.fetchImpl,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  }
}
