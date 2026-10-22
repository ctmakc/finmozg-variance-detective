/**
 * HTTP API + UI.
 *   POST /run            {question, periodA?, periodB?}  → {runId} (add ?wait=1 to get the full result)
 *   GET  /runs           recent runs
 *   GET  /runs/:id       result (or {status:"running"})
 *   GET  /runs/:id/events  server-sent events (replays past events, then live)
 *   POST /feedback       {runId, findingId, verdict: "confirmed"|"rejected", note?}
 *   GET  /health         Zetaris + Meterless Runtime status
 *   GET  /memory         H-MEM contents summary
 */
import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { applyFeedback } from "./agents/steward.js";
import type { RunOutput, TraceEvent } from "./agents/types.js";
import { providerFromEnv } from "./llm/index.js";
import { DetectiveMemory } from "./memory/hmem.js";
import { newRunId, runInvestigation } from "./orchestrator.js";
import { isSampleMode, sampleMemoryDir } from "./sample.js";
import { ZetarisClient, zetarisConfigFromEnv } from "./zetaris/client.js";

const PORT = Number(process.env.PORT ?? 8795);
const UI_DIR = join(process.cwd(), "ui");
const LOG_DIR = "logs";

interface LiveRun {
  events: TraceEvent[];
  clients: Set<ServerResponse>;
  result?: RunOutput;
  done: Promise<RunOutput>;
}
const live = new Map<string, LiveRun>();
let memory = new DetectiveMemory();
let running = 0;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function loadRun(id: string): RunOutput | undefined {
  const r = live.get(id)?.result;
  if (r) return r;
  const p = join(LOG_DIR, `run-${id.replace(/[^\w-]/g, "")}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

function startRun(input: { question: string; periodA?: string; periodB?: string }): string {
  const runId = newRunId();
  const entry: LiveRun = { events: [], clients: new Set(), done: Promise.resolve(null as never) };
  live.set(runId, entry);
  running++;
  const pace = isSampleMode() ? Number(process.env.SAMPLE_PACE_MS ?? 110) : 0;
  let paced = 0;
  entry.done = runInvestigation(input, {
    runId,
    memory: isSampleMode() ? new DetectiveMemory(sampleMemoryDir(input.question)) : memory,
    onEvent: (e) => {
      // Sample mode replays in milliseconds; pace the stream so the timeline is readable (labelled as a replay).
      const send = () => {
        entry.events.push(e);
        for (const c of entry.clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      if (pace) { paced += pace; setTimeout(send, paced); } else send();
    },
  })
    .then(async (r) => {
      if (pace) await new Promise((res) => setTimeout(res, paced + 200));
      entry.result = r;
      for (const c of entry.clients) {
        c.write(`event: done\ndata: ${JSON.stringify({ runId, status: r.status })}\n\n`);
        c.end();
      }
      return r;
    })
    .finally(() => {
      running--;
    });
  return runId;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://x");
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  const p = join(UI_DIR, rel);
  if (!p.startsWith(UI_DIR) || !existsSync(p)) return false;
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(p));
  return true;
}

async function health() {
  const z = new ZetarisClient(zetarisConfigFromEnv());
  let zetaris: { status: string; mode: string; detail?: string } = { status: "offline", mode: z.mode };
  if (z.mode === "replay") zetaris = { status: "recorded", mode: "replay", detail: "SAMPLE_MODE: recorded Zetaris results" };
  else {
    try {
      await z.runSql("SELECT 1 AS one", { timeoutMs: 8000, limit: 1 });
      zetaris = { status: "online", mode: z.mode };
    } catch (err) {
      zetaris = { status: "offline", mode: z.mode, detail: String((err as Error).message).slice(0, 160) };
    }
  }
  const provider = providerFromEnv();
  const st = process.env.SAMPLE_MODE === "true" ? { status: "recorded", models: [], baseUrl: "", detail: "SAMPLE_MODE: recorded model replies" } : await provider.status();
  return {
    zetaris,
    llm: {
      provider: provider.id,
      name: provider.name,
      status: st.status,
      baseUrl: st.baseUrl,
      routes: st.models.filter((m) => m.startsWith("meterless/")),
      pinned: { deep: process.env.METERLESS_MODEL_DEEP ?? process.env.METERLESS_MODEL ?? "meterless/deep", fast: process.env.METERLESS_MODEL_FAST ?? process.env.METERLESS_MODEL ?? "meterless/fast" },
      detail: st.detail,
    },
    memory: memory.stats(),
    sampleMode: process.env.SAMPLE_MODE === "true",
    running,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (req.method === "POST" && path === "/run") {
      const body = await readBody(req);
      if (!body.question || typeof body.question !== "string") return send(res, 400, { error: "question (string) is required" });
      if (running >= 2) return send(res, 429, { error: "two investigations are already running; try again shortly" });
      const runId = startRun({ question: body.question.slice(0, 500), periodA: body.periodA, periodB: body.periodB });
      if (url.searchParams.get("wait") === "1") return send(res, 200, await live.get(runId)!.done);
      return send(res, 202, { runId, events: `/runs/${runId}/events`, result: `/runs/${runId}` });
    }
    if (req.method === "GET" && path === "/runs") {
      const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^run-.*\.json$/.test(f)).sort().reverse().slice(0, 30) : [];
      const runs = files.map((f) => {
        const r: RunOutput = JSON.parse(readFileSync(join(LOG_DIR, f), "utf8"));
        return { runId: r.runId, question: r.question, status: r.status, durationMs: r.stats.durationMs, warmStart: r.stats.warmStart, deltaPp: r.headline.deltaPp };
      });
      return send(res, 200, { runs, live: [...live.entries()].filter(([, v]) => !v.result).map(([k]) => k) });
    }
    const m = path.match(/^\/runs\/([\w-]+)(\/events)?$/);
    if (req.method === "GET" && m) {
      const [, id, events] = m;
      if (events) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const entry = live.get(id);
        if (!entry) {
          const done = loadRun(id);
          const tracePath = join(LOG_DIR, `trace-${id}.jsonl`);
          if (existsSync(tracePath)) for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) res.write(`data: ${line}\n\n`);
          res.write(`event: done\ndata: ${JSON.stringify({ runId: id, status: done?.status ?? "unknown" })}\n\n`);
          return res.end();
        }
        for (const e of entry.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (entry.result) {
          res.write(`event: done\ndata: ${JSON.stringify({ runId: id, status: entry.result.status })}\n\n`);
          return res.end();
        }
        entry.clients.add(res);
        req.on("close", () => entry.clients.delete(res));
        return;
      }
      const r = loadRun(id);
      if (r) return send(res, 200, r);
      if (live.has(id)) return send(res, 200, { runId: id, status: "running", events: live.get(id)!.events.length });
      return send(res, 404, { error: "unknown run" });
    }
    if (req.method === "POST" && path === "/feedback") {
      const body = await readBody(req);
      const run = loadRun(String(body.runId ?? ""));
      if (!run) return send(res, 404, { error: "unknown run" });
      if (!["confirmed", "rejected"].includes(body.verdict)) return send(res, 400, { error: "verdict must be confirmed or rejected" });
      const r = applyFeedback(memory, run, { findingId: String(body.findingId), verdict: body.verdict, note: body.note ? String(body.note).slice(0, 300) : undefined });
      return send(res, 200, r);
    }
    if (req.method === "GET" && path === "/health") return send(res, 200, await health());
    if (req.method === "GET" && path === "/memory") {
      memory = new DetectiveMemory();
      const all = memory.engine.store.all().filter((x) => !x.tags.includes("schema-map"));
      return send(res, 200, { stats: memory.stats(), memories: all.slice(-20).reverse().map((x) => ({ id: x.id, content: x.content, tags: x.tags, layer: x.layer, source: x.source, confidence: x.confidence })) });
    }
    if (req.method === "GET" && serveStatic(req, res)) return;
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String((err as Error).message ?? err) });
  }
});

server.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`FINMOZG Variance Detective on http://${process.env.HOST ?? "127.0.0.1"}:${PORT} (SAMPLE_MODE=${process.env.SAMPLE_MODE === "true"})`);
});
