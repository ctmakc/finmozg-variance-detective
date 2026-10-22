import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZetarisClient, ZetarisError, asObjects, isAlreadyExists } from "../src/zetaris/client.js";
import { splitStatements } from "../src/zetaris/statements.js";

function fakeFetch(status: number, body: unknown, seen: { headers?: Record<string, string>; body?: any }[] = []) {
  return (async (_url: string, init: any) => {
    seen.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("ZetarisClient", () => {
  it("sends one statement with bearer, org and fresh UUIDs", async () => {
    const seen: any[] = [];
    const z = new ZetarisClient({ restUrl: "http://z/api/v1.0/", orgId: "1", apiKey: "k", fetchImpl: fakeFetch(200, { headers: ["one"], data: [[1]], total: 1, timeUsed: 5 }, seen) });
    const r = await z.runSql("SELECT 1 AS one", { limit: 1 });
    expect(r.rows).toEqual([["1"]]);
    expect(seen[0].headers.Authorization).toBe("Bearer k");
    expect(seen[0].headers["X-Org-ID"]).toBe("1");
    expect(seen[0].headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0].body).toMatchObject({ sql: "SELECT 1 AS one", source: "SqlEditor", limit: 1 });
    expect(asObjects(r)).toEqual([{ one: "1" }]);
  });

  it("raises ZetarisError with the server message and drops stack frames", async () => {
    const z = new ZetarisClient({ restUrl: "http://z", orgId: "1", apiKey: "k", fetchImpl: fakeFetch(400, { msg: "Table not found: x\n\tat org.apache.Foo(Foo.scala:1)" }) });
    await expect(z.runSql("SELECT * FROM x")).rejects.toThrowError(/Table not found: x$/);
  });

  it("recognises already-exists errors as reuse", () => {
    expect(isAlreadyExists(new ZetarisError("Object already exists", 400, "x"))).toBe(true);
    expect(isAlreadyExists(new ZetarisError("syntax error", 400, "x"))).toBe(false);
  });

  it("records live results and replays them in sample mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-rec-"));
    const live = new ZetarisClient({ restUrl: "http://z", orgId: "1", apiKey: "k", mode: "record", recordingsDir: dir, fetchImpl: fakeFetch(200, { headers: ["a"], data: [["x"]] }) });
    await live.runSql("SELECT  a\nFROM t");
    const replay = new ZetarisClient({ restUrl: "http://z", orgId: "1", apiKey: "", mode: "replay", recordingsDir: dir });
    const r = await replay.runSql("SELECT a FROM t");
    expect(r.rows).toEqual([["x"]]);
    expect(r.recorded).toBe(true);
    await expect(replay.runSql("SELECT b FROM t")).rejects.toThrow(/No recording/);
  });
});

describe("splitStatements", () => {
  it("splits on separator lines, strips comments and fills variables", () => {
    const parts = splitStatements("-- head\nCREATE A user \"${U}\"\n-- @@\n-- note\nSELECT 1;\n-- @@\n", { U: "me" });
    expect(parts).toEqual(['CREATE A user "me"', "SELECT 1;"]);
  });
});
