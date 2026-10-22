import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Llm, extractJson } from "../src/llm/index.js";
import { MeterlessProvider, autoDetect, normaliseBaseUrl, parseConnectLink, probe, validateToken } from "../src/llm/providers/meterless.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("Meterless contract v4: base URL", () => {
  it.each([
    ["127.0.0.1:8088", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1/", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/healthz", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1/v1", "http://127.0.0.1:8088/v1"],
    ["https://box.lan:8090/v1", "https://box.lan:8090/v1"],
    ["[::1]:8088", "http://[::1]:8088/v1"],
  ])("%s → %s", (input, out) => {
    expect(normaliseBaseUrl(input)).toBe(out);
    expect(normaliseBaseUrl(input)).not.toMatch(/\/v1\/v1/);
  });

  it("parses a connect link", () => {
    expect(parseConnectLink("http://10.0.0.5:8088/connect#k=abc123")).toEqual({ baseUrl: "http://10.0.0.5:8088/v1", token: "abc123" });
    expect(parseConnectLink("http://10.0.0.5:8088/other#k=abc")).toBeNull();
  });

  it("rejects the rt-local placeholder and empty tokens", () => {
    expect(() => validateToken("rt-local")).toThrow(/rt-local/);
    expect(() => validateToken("")).toThrow(/No Meterless Runtime token/);
    expect(validateToken(" real ")).toBe("real");
  });
});

describe("Meterless contract v4: status from /v1/models", () => {
  const f = (status: number, body: unknown) => (async () => json(status, body)) as unknown as typeof fetch;
  it("401 and 403 are unauthorized", async () => {
    expect((await probe("http://h/v1", "bad", f(401, {}))).status).toBe("unauthorized");
    expect((await probe("http://h/v1", "bad", f(403, {}))).status).toBe("unauthorized");
  });
  it("200 with meterless ids is online and keeps unknown meterless ids", async () => {
    const r = await probe("http://h/v1", "t", f(200, { data: [{ id: "meterless/auto" }, { id: "meterless/brand-new.mode" }, { id: "x/y" }] }));
    expect(r.status).toBe("online");
    expect(r.models).toContain("meterless/brand-new.mode");
  });
  it("200 without meterless ids, 500 and network errors are offline", async () => {
    expect((await probe("http://h/v1", "t", f(200, { data: [{ id: "llama3" }] }))).status).toBe("offline");
    expect((await probe("http://h/v1", "t", f(500, {}))).status).toBe("offline");
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await probe("http://h/v1", "t", boom)).status).toBe("offline");
  });
  it("auto detect returns the first online or unauthorized port", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.startsWith("http://localhost:8090")) return json(401, {});
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await autoDetect("t", fetchImpl)).toEqual({ baseUrl: "http://localhost:8090/v1", status: "unauthorized" });
    expect(seen[0]).toBe("http://127.0.0.1:8088/v1/models");
  });
});

describe("Meterless contract v4: chat", () => {
  it("sends Bearer, meterless-app and meterless-scope, returns a string and the routed model", async () => {
    let headers: Record<string, string> = {};
    let body: any;
    const fetchImpl = (async (_u: string, init: any) => {
      headers = init.headers;
      body = JSON.parse(init.body);
      return json(200, {
        model: "meterless/auto",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        meterless: { routed_model: "local-runtime/nemotron-3-super-ollama", receipt_id: "rcpt_1" },
      });
    }) as unknown as typeof fetch;
    const p = new MeterlessProvider({ baseUrl: "127.0.0.1:8088/v1/models", meterless_runtime_token: "tok", modelDeep: "meterless/auto", fetchImpl });
    const r = await p.chat({ role: "deep", messages: [{ role: "user", content: "hi" }] });
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["meterless-app"]).toBe("finmozg-variance-detective");
    expect(headers["meterless-scope"]).toBe("user");
    expect(body.model).toBe("meterless/auto");
    expect(typeof body.messages[0].content).toBe("string");
    expect(r.content).toBe("hello");
    expect(r.servedBy).toBe("local-runtime/nemotron-3-super-ollama");
    expect(r.receiptId).toBe("rcpt_1");
  });

  it("parses tool calls", async () => {
    const fetchImpl = (async () =>
      json(200, { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run_sql", arguments: '{"sql":"SELECT 1"}' } }] } }] })) as unknown as typeof fetch;
    const p = new MeterlessProvider({ meterless_runtime_token: "tok", fetchImpl });
    const r = await p.chat({ role: "fast", messages: [{ role: "user", content: "q" }], tools: [{ type: "function", function: { name: "run_sql", description: "d", parameters: {} } }] });
    expect(r.toolCalls[0].function.name).toBe("run_sql");
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ sql: "SELECT 1" });
  });
});

describe("JSON helpers", () => {
  it("extracts JSON after think blocks and fences", () => {
    expect(extractJson('<think>{"no":1}</think>Sure:\n```json\n{"a":[1,{"b":"}"}]}\n```')).toEqual({ a: [1, { b: "}" }] });
  });
  it("chatJson retries once with the validation error", async () => {
    const replies = ['{"n":"x"}', '{"n":2}'];
    const sent: any[] = [];
    const provider = {
      id: "fake",
      name: "fake",
      status: async () => ({ status: "online" as const, models: [], baseUrl: "" }),
      chat: async (req: any) => {
        sent.push(req.messages);
        return { content: replies.shift()!, toolCalls: [], provider: "fake", requestedModel: "m", servedBy: "m", latencyMs: 1 };
      },
    };
    const llm = new Llm({ provider, mode: "live" });
    const { value } = await llm.chatJson({ role: "deep", messages: [{ role: "user", content: "n?" }] }, z.object({ n: z.number() }));
    expect(value).toEqual({ n: 2 });
    expect(sent[1].at(-1).content).toMatch(/not valid JSON/);
  });
});
