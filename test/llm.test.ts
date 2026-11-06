/** Llm wrapper (retry, record/replay, events, generator) and the OpenAI-compatible provider. All fetches are fakes. */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChatRequest, type ChatResult, Llm, LlmError, type LlmEvent, type Provider, extractJson, providerFromEnv } from "../src/llm/index.js";
import { MeterlessProvider } from "../src/llm/providers/meterless.js";
import { OpenAiCompatProvider, nvidiaSettingsFromEnv, openAiCompatSettingsFromEnv } from "../src/llm/providers/openaiCompat.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fm-llm-"));

function result(content: string, extra: Partial<ChatResult> = {}): ChatResult {
  return { content, toolCalls: [], provider: "fake", requestedModel: "m", servedBy: "m-served", latencyMs: 3, ...extra };
}

/** Provider whose replies come from a script: a ChatResult or an Error per call. */
class ScriptedProvider implements Provider {
  id = "fake";
  name = "Fake";
  calls: ChatRequest[] = [];
  constructor(private script: (ChatResult | Error)[]) {}
  async chat(req: ChatRequest) {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
  async status() {
    return { status: "online" as const, models: [], baseUrl: "" };
  }
}

const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ role: "deep", agent: "Tester", messages: [{ role: "user", content: "hi" }], ...extra });

describe("Llm.chat retry policy", () => {
  it("retries a 5xx once with a doubled token budget", async () => {
    const p = new ScriptedProvider([new LlmError("HTTP 502", "fake", 502), result("ok")]);
    const events: LlmEvent[] = [];
    const llm = new Llm({ provider: p, mode: "live", onEvent: (e) => events.push(e) });
    const r = await llm.chat(req({ maxTokens: 3000 }));
    expect(r.content).toBe("ok");
    expect(p.calls.map((c) => c.maxTokens)).toEqual([3000, 6000]);
    expect(events.map((e) => e.ok)).toEqual([false, true]);
    expect(events[0].error).toMatch(/^retrying after: HTTP 502/);
  });

  it("retry budget defaults from 4096 and is capped at 16000", async () => {
    const p1 = new ScriptedProvider([new Error("model call timed out after 180s"), result("ok")]);
    await new Llm({ provider: p1, mode: "live" }).chat(req());
    expect(p1.calls[1].maxTokens).toBe(8192);
    const p2 = new ScriptedProvider([new Error("exhausted_budget"), result("ok")]);
    await new Llm({ provider: p2, mode: "live" }).chat(req({ maxTokens: 12000 }));
    expect(p2.calls[1].maxTokens).toBe(16000);
  });

  it("does not retry client errors and reports them as a failed call", async () => {
    const p = new ScriptedProvider([new LlmError("HTTP 400: bad", "fake", 400), result("never")]);
    const events: LlmEvent[] = [];
    const llm = new Llm({ provider: p, mode: "live", onEvent: (e) => events.push(e) });
    await expect(llm.chat(req())).rejects.toThrow("HTTP 400");
    expect(p.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: false, agent: "Tester", error: "HTTP 400: bad" });
  });

  it("a second transient failure is not retried again", async () => {
    const p = new ScriptedProvider([new Error("ECONNRESET"), new Error("ECONNRESET again"), result("never")]);
    await expect(new Llm({ provider: p, mode: "live" }).chat(req())).rejects.toThrow("ECONNRESET again");
    expect(p.calls).toHaveLength(2);
  });

  it("counts calls and emits served-by / receipt on success", async () => {
    const p = new ScriptedProvider([result("a", { receiptId: "rc-1", toolCalls: [{ id: "t", type: "function", function: { name: "run_sql", arguments: "{}" } }] })]);
    const events: LlmEvent[] = [];
    const llm = new Llm({ provider: p, mode: "live", onEvent: (e) => events.push(e) });
    await llm.chat(req());
    expect(llm.calls).toBe(1);
    expect(events[0]).toMatchObject({ ok: true, servedBy: "m-served", receiptId: "rc-1", toolCalls: 1, role: "deep" });
  });
});

describe("Llm record / replay", () => {
  it("record writes one file per request; replay returns it marked recorded, without the provider", async () => {
    const dir = tmp();
    const rec = new Llm({ provider: new ScriptedProvider([result("recorded answer")]), mode: "record", recordingsDir: dir });
    await rec.chat(req());
    const files = readdirSync(join(dir, "llm"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "llm", files[0]), "utf8"))).toMatchObject({ agent: "Tester", result: { content: "recorded answer" } });

    const replayProvider = new ScriptedProvider([]);
    const rep = new Llm({ provider: replayProvider, mode: "replay", recordingsDir: dir });
    const r = await rep.chat(req());
    expect(r).toMatchObject({ content: "recorded answer", recorded: true });
    expect(replayProvider.calls).toHaveLength(0);
  });

  it("the recording key ignores the agent label and maxTokens but not the messages", async () => {
    const dir = tmp();
    await new Llm({ provider: new ScriptedProvider([result("x")]), mode: "record", recordingsDir: dir }).chat(req());
    const rep = new Llm({ provider: new ScriptedProvider([]), mode: "replay", recordingsDir: dir });
    await expect(rep.chat(req({ agent: "Other", maxTokens: 1 }))).resolves.toMatchObject({ content: "x" });
    await expect(rep.chat(req({ messages: [{ role: "user", content: "different" }] }))).rejects.toThrow(/No recorded model reply/);
    await expect(rep.chat(req({ role: "fast" }))).rejects.toBeInstanceOf(LlmError);
  });

  it("live mode never writes recordings", async () => {
    const dir = tmp();
    await new Llm({ provider: new ScriptedProvider([result("x")]), mode: "live", recordingsDir: dir }).chat(req());
    expect(existsSync(join(dir, "llm"))).toBe(false);
  });
});

describe("Llm.chatJson and generator", () => {
  const Schema = z.object({ n: z.number() });

  it("parses fenced JSON after a think block on the first try", async () => {
    const p = new ScriptedProvider([result('<think>{"n":"no"}</think>\n```json\n{"n": 7}\n```')]);
    const { value } = await new Llm({ provider: p, mode: "live" }).chatJson(req(), Schema);
    expect(value).toEqual({ n: 7 });
    expect(p.calls).toHaveLength(1);
  });

  it("feeds the bad reply and the validation error back on retry, from the original messages", async () => {
    const p = new ScriptedProvider([result('{"n":"seven"}'), result('{"n":7}')]);
    await new Llm({ provider: p, mode: "live" }).chatJson(req(), Schema);
    const second = p.calls[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: "assistant", content: '{"n":"seven"}' });
    expect(second[2].content).toMatch(/not valid JSON for the required schema/);
  });

  it("gives up with LlmError after two invalid replies", async () => {
    const p = new ScriptedProvider([result("nope"), result("still nope")]);
    await expect(new Llm({ provider: p, mode: "live" }).chatJson(req(), Schema)).rejects.toThrow(/invalid JSON after retry/);
  });

  it("generator puts the system prompt first and appends attachments by name", async () => {
    const p = new ScriptedProvider([result("text", { receiptId: "r9" })]);
    const gen = new Llm({ provider: p, mode: "live" }).generator("Skeptic-2");
    const out = await gen("Check rows", [{ name: "rows.csv", content: "a,b" }], "Be strict");
    expect(out).toMatchObject({ text: "text", metadata: { receiptId: "r9" } });
    expect(p.calls[0]).toMatchObject({ role: "deep", agent: "Skeptic-2", maxTokens: 4096 });
    expect(p.calls[0].messages).toEqual([
      { role: "system", content: "Be strict" },
      { role: "user", content: "Check rows\n[rows.csv]\na,b" },
    ]);
  });
});

describe("extractJson edge cases", () => {
  it("ignores braces inside strings and returns the first balanced value", () => {
    expect(extractJson('noise {"a":"}{","b":[1,{"c":2}]} trailing {"x":1}')).toEqual({ a: "}{", b: [1, { c: 2 }] });
  });
  it("an array that starts before any object is returned as the array", () => {
    expect(extractJson('[{"a":1}] {"b":2}')).toEqual([{ a: 1 }]);
  });
  it("throws for no JSON and for unterminated JSON", () => {
    expect(() => extractJson("plain words")).toThrow(/no JSON/);
    expect(() => extractJson('{"a": [1, 2')).toThrow(/unterminated/);
  });
});

describe("providerFromEnv", () => {
  it("selects the provider by LLM_PROVIDER and rejects unknown names", () => {
    expect(providerFromEnv({})).toBeInstanceOf(MeterlessProvider);
    expect(providerFromEnv({ LLM_PROVIDER: "nvidia" }).id).toBe("nvidia");
    expect(providerFromEnv({ LLM_PROVIDER: "openai_compat" }).id).toBe("openai_compat");
    expect(() => providerFromEnv({ LLM_PROVIDER: "gpt" })).toThrow(/Unknown LLM_PROVIDER gpt/);
  });

  it("settings trim trailing slashes and fall back fast → deep model", () => {
    const n = nvidiaSettingsFromEnv({ NVIDIA_BASE_URL: "https://h/v1///", NVIDIA_MODEL: "deep-m" });
    expect(n).toMatchObject({ baseUrl: "https://h/v1", modelDeep: "deep-m", modelFast: "deep-m", apiKey: "" });
    const o = openAiCompatSettingsFromEnv({ OPENAI_COMPAT_MODEL: "d", OPENAI_COMPAT_MODEL_FAST: "f" });
    expect(o).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1", modelDeep: "d", modelFast: "f", apiKey: "none" });
  });
});

describe("OpenAiCompatProvider (OpenAI wire shape)", () => {
  const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const make = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
    new OpenAiCompatProvider({ id: "openai_compat", name: "x", baseUrl: "http://fake/v1", apiKey: "k", modelDeep: "deep-m", modelFast: "fast-m", fetchImpl: fetchImpl as unknown as typeof fetch });

  it("posts the OpenAI body, picks the model by role, and adds tools only when given", async () => {
    const seen: { url: string; body: any; headers: any }[] = [];
    const p = make(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init!.body)), headers: init!.headers });
      return json(200, { model: "served-x", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    });
    const r = await p.chat(req({ role: "fast", temperature: 0 }));
    expect(seen[0].url).toBe("http://fake/v1/chat/completions");
    expect(seen[0].headers).toMatchObject({ Authorization: "Bearer k", "content-type": "application/json" });
    expect(seen[0].body).toEqual({ model: "fast-m", messages: req().messages, max_tokens: 4096, temperature: 0, stream: false });
    expect(r).toMatchObject({ content: "hi", servedBy: "served-x", requestedModel: "fast-m", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2 } });

    const tool = { type: "function" as const, function: { name: "run_sql", description: "d", parameters: {} } };
    await p.chat(req({ tools: [tool] }));
    expect(seen[1].body).toMatchObject({ model: "deep-m", tools: [tool], tool_choice: "auto", temperature: 0.2 });
  });

  it("normalises tool calls: object arguments become JSON strings, missing ids get call_<i>", async () => {
    const p = make(async () => json(200, { choices: [{ message: { content: null, tool_calls: [{ function: { name: "run_sql", arguments: { sql: "SELECT 1" } } }] } }] }));
    const r = await p.chat(req());
    expect(r.content).toBe("");
    expect(r.toolCalls).toEqual([{ id: "call_0", type: "function", function: { name: "run_sql", arguments: '{"sql":"SELECT 1"}' } }]);
  });

  it("prefers the Meterless receipt's routed model and keeps reasoning_content", async () => {
    const p = make(async () => json(200, { model: "m", meterless: { routed_model: "nemotron-x", receipt_id: "rcpt" }, choices: [{ message: { content: "c", reasoning_content: "why" } }] }));
    expect(await p.chat(req())).toMatchObject({ servedBy: "nemotron-x", receiptId: "rcpt", reasoning: "why" });
  });

  it("HTTP errors carry the status; non-JSON 200 is an LlmError too", async () => {
    await expect(make(async () => json(503, "busy")).chat(req())).rejects.toMatchObject({ name: "LlmError", status: 503, message: "HTTP 503: busy" });
    await expect(make(async () => json(200, "<html>")).chat(req())).rejects.toThrow(/non-JSON reply: <html>/);
    await expect(make(async () => { throw new TypeError("fetch failed"); }).chat(req())).rejects.toThrow(/fetch failed/);
  });

  it("status maps 401/403 → unauthorized, non-2xx and network errors → offline, 200 → model ids", async () => {
    expect((await make(async () => json(401, {})).status()).status).toBe("unauthorized");
    expect((await make(async () => json(403, {})).status()).status).toBe("unauthorized");
    expect(await make(async () => json(500, {})).status()).toMatchObject({ status: "offline", detail: "HTTP 500" });
    expect((await make(async () => { throw new Error("down"); }).status()).status).toBe("offline");
    expect(await make(async () => json(200, { data: [{ id: "a" }, { id: "b" }] })).status()).toMatchObject({ status: "online", models: ["a", "b"] });
  });
});
