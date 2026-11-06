/**
 * Regression tests for the 2026-11 bug hunt. All offline: fake fetch, fake model, temp dirs; the server test
 * listens on 127.0.0.1 only and never reaches Zetaris or a model.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlySql, runInvestigator } from "../src/agents/investigator.js";
import { assertPeriod, quantQueries } from "../src/agents/quant.js";
import { Llm, type ChatRequest, type ChatResult, type Provider } from "../src/llm/index.js";
import { DetectiveMemory, reloadMemoryIfIdle } from "../src/memory/hmem.js";
import { runInvestigation } from "../src/orchestrator.js";
import { ZetarisClient } from "../src/zetaris/client.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function fakeProvider(replies: Partial<ChatResult>[]): Provider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    id: "fake",
    name: "fake",
    seen,
    async status() {
      return { status: "online" as const, models: [], baseUrl: "" };
    },
    async chat(req) {
      seen.push(req);
      const r = replies.shift() ?? { content: "{}" };
      return { content: "", toolCalls: [], provider: "fake", requestedModel: "m", servedBy: "m", latencyMs: 0, ...r };
    },
  };
}

describe("periods are validated before they reach SQL", () => {
  const injection = "2026-08') OR 1=1 --";

  it("assertPeriod / quantQueries reject anything but YYYY-MM", () => {
    expect(assertPeriod("2026-09")).toBe("2026-09");
    expect(() => assertPeriod(injection)).toThrow(/YYYY-MM/);
    expect(() => assertPeriod(42)).toThrow(/YYYY-MM/);
    expect(() => quantQueries("2026-08", injection)).toThrow(/periodB/);
    expect(quantQueries("2026-08", "2026-09").gl).toContain("('2026-08', '2026-09')");
  });

  it("a run with an injected periodA fails cleanly and sends no SQL", async () => {
    const sqls: string[] = [];
    const fetchImpl = (async (_u: string, init: any) => {
      sqls.push(JSON.parse(init.body).sql);
      return new Response(JSON.stringify({ headers: ["period"], data: [["2026-08"], ["2026-09"]] }), { status: 200 });
    }) as unknown as typeof fetch;
    const root = tmp("fm-bh-run-");
    // Warm schema map: without the fix the Cartographer is skipped and the payload reaches the P&L and Quant SQL.
    const memory = new DetectiveMemory(join(root, "hmem"));
    memory.rememberSchemaMap(["a", "b", "c", "d", "e"].map((t) => ({ table: t, columns: ["x int"] })), "seed");
    const out = await runInvestigation(
      { question: "Why did gross margin fall?", periodA: injection, periodB: "2026-09" },
      {
        zetaris: new ZetarisClient({ restUrl: "http://z", orgId: "1", apiKey: "", mode: "live", fetchImpl }),
        llm: new Llm({ provider: fakeProvider([]), mode: "live" }),
        memory,
        logDir: join(root, "logs"),
        runId: "r-test-injection",
      },
    );
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/periodA must be a 'YYYY-MM' string/);
    expect(sqls.filter((s) => s.includes("OR 1=1"))).toEqual([]);
    expect(sqls).toEqual([]);
  });
});

describe("Investigator SQL is read-only", () => {
  it("accepts every SQL statement in the recorded runs", () => {
    const dir = join("recordings", "zetaris");
    const all = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).sql as string);
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((s) => !isReadOnlySql(s))).toEqual([]);
  });

  it.each([
    "SELECT 1",
    "with x as (select 1 as a) select * from x",
    "(SELECT 1) UNION (SELECT 2)",
    "-- don't worry\nSELECT 'drop table x; delete' AS s",
    "DESCRIBE lightning.metastore.finmozg.finance_usl.vendor",
    "SHOW TABLES IN lightning.metastore.finmozg.finance_usl",
    "SELECT updated_at, created_by FROM t;",
  ])("allows %s", (sql) => expect(isReadOnlySql(sql)).toBe(true));

  it.each([
    "DROP TABLE lightning.metastore.finmozg.finance_usl.vendor",
    "INSERT INTO t VALUES (1)",
    "SELECT 1; DROP TABLE t",
    "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
    "/* SELECT */ DELETE FROM t",
    "CREATE TABLE t AS SELECT 1",
    "SELECT 1 /* ; */ ; TRUNCATE TABLE t",
  ])("rejects %s", (sql) => expect(isReadOnlySql(sql)).toBe(false));

  it("does not send a write statement proposed by the model to Zetaris", async () => {
    const provider = fakeProvider([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "run_sql", arguments: JSON.stringify({ sql: "DROP TABLE lightning.metastore.finmozg.finance_usl.vendor" }) } }] },
      { content: '{"supported": false, "claim": "nothing found", "amount_cad": null, "evidence": [], "entities": []}' },
    ]);
    const ran: string[] = [];
    const events: string[] = [];
    let n = 0;
    const r = await runInvestigator({
      llm: new Llm({ provider, mode: "live" }),
      runSql: async (sql) => {
        ran.push(sql);
        return { headers: [], rows: [], total: 0, timeUsedMs: 0, queryId: "q" };
      },
      hypothesis: { id: "h1", driverType: "mix", text: "mix shifted", checks: "" },
      periodA: "2026-08",
      periodB: "2026-09",
      schema: "",
      memoryHints: "",
      agent: "Investigator-h1",
      round: 1,
      nextEvidenceId: () => `E1-${++n}`,
      emit: (_a, type) => events.push(type),
    });
    expect(ran).toEqual([]);
    expect(events).toContain("sql_rejected");
    const toolMsg = provider.seen[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/read-only/);
    expect(r.evidence).toEqual([]);
  });
});

describe("H-MEM is not re-created while a run writes through it", () => {
  it("two instances on one directory lose writes (the hazard)", () => {
    const dir = tmp("fm-bh-hmem-");
    const runMem = new DetectiveMemory(dir);
    const apiMem = new DetectiveMemory(dir);
    const fb = apiMem.rememberFinding({ question: "q", claim: "controller feedback", evidenceSummary: "x", verdict: "confirmed", runId: "r1", findingId: "F1" });
    const ru = runMem.rememberRuling("skeptic ruling", "r2");
    expect(fb.id).toBe(ru?.id); // ids collide
    expect(new DetectiveMemory(dir).engine.store.all().map((m) => m.content)).toEqual(["skeptic ruling"]); // feedback lost
  });

  it("reloadMemoryIfIdle keeps the shared instance while busy, so both writes survive", () => {
    const dir = tmp("fm-bh-hmem-");
    const runMem = new DetectiveMemory(dir);
    const apiMem = reloadMemoryIfIdle(runMem, true, () => new DetectiveMemory(dir));
    expect(apiMem).toBe(runMem);
    apiMem.rememberFinding({ question: "q", claim: "controller feedback", evidenceSummary: "x", verdict: "confirmed", runId: "r1", findingId: "F1" });
    runMem.rememberRuling("skeptic ruling", "r2");
    const contents = new DetectiveMemory(dir).engine.store.all().map((m) => m.content);
    expect(contents).toHaveLength(2);
    expect(contents.join(" ")).toContain("controller feedback");
    const idle = reloadMemoryIfIdle(runMem, false, () => new DetectiveMemory(dir));
    expect(idle).not.toBe(runMem);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe("server survives a run that fails before the orchestrator's try/catch", () => {
  it("POST /run with an unknown LLM_PROVIDER does not kill the process", async () => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", LLM_PROVIDER: "bogus", SAMPLE_MODE: "false", HMEM_DIR: tmp("fm-bh-srv-"), ZETARIS_REST_URL: "http://127.0.0.1:9/none" };
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let exited: number | null = null;
    child.on("exit", (code) => (exited = code ?? -1));
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("server did not start")), 15_000);
        child.stdout.on("data", (d) => String(d).includes("FINMOZG") && (clearTimeout(t), resolve()));
      });
      const base = `http://127.0.0.1:${port}`;
      const started = await (await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ question: "why?" }) })).json();
      expect(started.runId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 1000));
      expect(exited).toBeNull();
      const run = await (await fetch(`${base}/runs/${started.runId}`)).json();
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/Unknown LLM_PROVIDER/);
      expect((await fetch(`${base}/runs`)).status).toBe(200);
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe("SAMPLE_MODE replays do not depend on today's date", () => {
  const replay = async (clock: (() => number) | undefined) => {
    const { sampleMemoryDir } = await import("../src/sample.js");
    const { MeterlessProvider } = await import("../src/llm/providers/meterless.js");
    const input = JSON.parse(readFileSync("input_examples/05-headcount.json", "utf8"));
    const root = tmp("fm-bh-replay-");
    return runInvestigation(input, {
      zetaris: new ZetarisClient({ restUrl: "http://z", orgId: "1", apiKey: "", mode: "replay", recordingsDir: "recordings" }),
      llm: new Llm({ provider: new MeterlessProvider({}), mode: "replay", recordingsDir: "recordings" }),
      memory: new DetectiveMemory(sampleMemoryDir(input.question, "recordings"), clock),
      logDir: join(root, "logs"),
    });
  };

  it("pins the H-MEM clock to the snapshot, so a warm recorded run replays completely", async () => {
    const { sampleMemoryClock } = await import("../src/sample.js");
    const clock = sampleMemoryClock(JSON.parse(readFileSync("input_examples/05-headcount.json", "utf8")).question, "recordings");
    expect(clock).toBeTypeOf("function");
    const out = await replay(clock);
    expect(out.status).toBe("completed");
    expect(out.stats.warmStart).toBe(true);
  });

  it("without a pinned clock the same replay breaks once the recording is a year old (the bug)", async () => {
    const { sampleMemoryClock } = await import("../src/sample.js");
    const pinned = sampleMemoryClock(JSON.parse(readFileSync("input_examples/05-headcount.json", "utf8")).question, "recordings")!;
    const out = await replay(() => pinned() + 365 * 86_400_000);
    expect(out.status).not.toBe("completed");
    expect(out.error).toMatch(/No recorded model reply/);
  });

  it("returns undefined for a question with no snapshot (cold run keeps the real clock)", async () => {
    const { sampleMemoryClock } = await import("../src/sample.js");
    expect(sampleMemoryClock("a question nobody recorded", "recordings")).toBeUndefined();
  });
});
