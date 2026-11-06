/**
 * HTTP API routing, against a real server process in SAMPLE_MODE (recordings only). The server runs from a temp
 * working directory (logs/ and H-MEM land there); Zetaris and the model endpoints point at a closed local port, so
 * anything that tried the network would fail rather than reach out.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const Q01 = JSON.parse(readFileSync(join(ROOT, "input_examples/01-gm-drop-sep.json"), "utf8")).question as string;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

interface Srv {
  proc: ChildProcess;
  base: string;
  cwd: string;
  output: () => string;
}

async function startServer(): Promise<Srv> {
  const cwd = mkdtempSync(join(tmpdir(), "fm-srv-"));
  for (const d of ["ui", "recordings", "input_examples"]) symlinkSync(join(ROOT, d), join(cwd, d));
  const port = await freePort();
  const proc = spawn(process.execPath, [TSX, join(ROOT, "src/server.ts")], {
    cwd,
    env: {
      ...process.env,
      SAMPLE_MODE: "true",
      SAMPLE_PACE_MS: "0",
      PORT: String(port),
      HOST: "127.0.0.1",
      HMEM_DIR: join(cwd, ".hmem"),
      RECORDINGS_DIR: "recordings",
      LLM_PROVIDER: "meterless",
      ZETARIS_REST_URL: "http://127.0.0.1:9/api/v1.0",
      METERLESS_BASE_URL: "http://127.0.0.1:9/v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start:\n${out}`)), 30_000);
    const check = () => (/Variance Detective on/.test(out) ? (clearTimeout(t), res()) : setTimeout(check, 50));
    proc.once("exit", (code) => rej(new Error(`server exited ${code}:\n${out}`)));
    check();
  });
  return { proc, base: `http://127.0.0.1:${port}`, cwd, output: () => out };
}

const post = (base: string, path: string, body: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("HTTP API in SAMPLE_MODE", () => {
  let s: Srv;
  let runId = "";
  beforeAll(async () => {
    s = await startServer();
  }, 40_000);
  afterAll(() => {
    s?.proc.kill();
  });

  it("GET /health reports recorded sources and does not probe the network", async () => {
    const r = await fetch(`${s.base}/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.sampleMode).toBe(true);
    expect(j.zetaris).toMatchObject({ status: "recorded", mode: "replay" });
    expect(j.llm).toMatchObject({ provider: "meterless", status: "recorded" });
    expect(j.running).toBe(0);
  });

  it("serves the UI at / and its assets with a MIME type", async () => {
    const index = await fetch(`${s.base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    const js = await fetch(`${s.base}/app.js`);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    const css = await fetch(`${s.base}/style.css`);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("unknown paths and path traversal attempts are 404, never files outside ui/", async () => {
    expect((await fetch(`${s.base}/nope.html`)).status).toBe(404);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
      const r = await fetch(s.base + p);
      expect(r.status, p).toBe(404);
      expect(await r.text()).not.toMatch(/"name":\s*"finmozg-variance-detective"/);
    }
  });

  it("POST /run without a string question is 400", async () => {
    expect((await post(s.base, "/run", "{}")).status).toBe(400);
    expect((await post(s.base, "/run", JSON.stringify({ question: 42 }))).status).toBe(400);
  });

  it("GET /runs/:id for an unknown run is 404 and odd ids do not route", async () => {
    expect((await fetch(`${s.base}/runs/r-unknown`)).status).toBe(404);
    expect((await fetch(`${s.base}/runs/a.b`)).status).toBe(404);
  });

  it("POST /run?wait=1 replays input 01 to a completed result", async () => {
    const r = await post(s.base, "/run?wait=1", JSON.stringify({ question: Q01 }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.status).toBe("completed");
    expect(j.headline.deltaPp).toBeCloseTo(-6.78, 2);
    runId = j.runId;
    expect(runId).toMatch(/^r-\d{8}-\d{6}-[0-9a-f]{4}$/);
  }, 60_000);

  it("the finished run is listed, readable, and its event stream replays and ends with done", async () => {
    const list = await (await fetch(`${s.base}/runs`)).json();
    expect(list.runs.map((r: { runId: string }) => r.runId)).toContain(runId);
    expect(list.live).toEqual([]);

    const r = await (await fetch(`${s.base}/runs/${runId}`)).json();
    expect(r.runId).toBe(runId);

    const ev = await fetch(`${s.base}/runs/${runId}/events`);
    expect(ev.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await ev.text();
    const data = text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
    expect(data.length).toBeGreaterThan(5);
    expect(data.every((e) => e.runId === runId)).toBe(true);
    const seqs = data.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(text).toMatch(new RegExp(`event: done\\ndata: \\{"runId":"${runId}","status":"completed"\\}`));
  });

  it("events of an unknown run end with status unknown", async () => {
    const text = await (await fetch(`${s.base}/runs/r-nothing/events`)).text();
    expect(text).toContain('"status":"unknown"');
  });

  it("POST /feedback validates run and verdict, then stores a memory", async () => {
    expect((await post(s.base, "/feedback", JSON.stringify({ runId: "r-nope", findingId: "x", verdict: "confirmed" }))).status).toBe(404);
    expect((await post(s.base, "/feedback", JSON.stringify({ runId, findingId: "x", verdict: "maybe" }))).status).toBe(400);
    const run = await (await fetch(`${s.base}/runs/${runId}`)).json();
    const f = run.findings.find((x: { driverType: string }) => x.driverType === "booking_error");
    const r = await post(s.base, "/feedback", JSON.stringify({ runId, findingId: f.id, verdict: "confirmed", note: "checked with AP" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.content).toMatch(/^Confirmed by the controller: /);
    expect(j.content).toContain("Note: checked with AP");
    expect(j.stats.findings).toBe(1);

    const mem = await (await fetch(`${s.base}/memory`)).json();
    expect(mem.memories.some((m: { id: string }) => m.id === j.memoryId)).toBe(true);
    expect(mem.memories.every((m: { tags: string[] }) => !m.tags.includes("schema-map"))).toBe(true);
  });

  it("feedback on a finding that is not in the run is an error, not a stored memory", async () => {
    const r = await post(s.base, "/feedback", JSON.stringify({ runId, findingId: "F-none", verdict: "rejected" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await r.json()).error).toMatch(/not in run/);
  });

  it.skip("bug: a malformed JSON body to POST /run answers 500 instead of 400", async () => {
    expect((await post(s.base, "/run", "{bad")).status).toBe(400);
  });

  it("server is still alive after the bad requests above", async () => {
    expect((await fetch(`${s.base}/health`)).status).toBe(200);
  });
});

describe("HTTP API robustness", () => {
  // new URL("//", "http://x") throws "Invalid URL" on the first line of the request handler, outside its try/catch;
  // the async handler's rejection is unhandled and Node exits, so one request takes the whole server down.
  it.skip("bug: GET // (or any request path starting with //) crashes the server process", async () => {
    const s = await startServer();
    try {
      await new Promise<void>((res) => {
        const sock = connect(Number(new URL(s.base).port), "127.0.0.1", () => {
          sock.end("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        });
        sock.on("close", () => res());
        sock.on("error", () => res());
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(s.proc.exitCode).toBeNull();
      expect((await fetch(`${s.base}/health`)).status).toBe(200);
    } finally {
      s.proc.kill();
    }
  }, 40_000);
});
