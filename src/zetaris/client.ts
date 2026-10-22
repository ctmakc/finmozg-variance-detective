import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SqlResult {
  headers: string[];
  rows: string[][];
  total: number;
  timeUsedMs: number;
  queryId: string;
  recorded?: boolean;
}

export class ZetarisError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly sql: string,
  ) {
    super(message);
    this.name = "ZetarisError";
  }
}

export interface ZetarisConfig {
  restUrl: string;
  orgId: string;
  apiKey: string;
  /** "live" talks to Zetaris; "record" talks and saves; "replay" reads recordings only (SAMPLE_MODE). */
  mode?: "live" | "record" | "replay";
  recordingsDir?: string;
  fetchImpl?: typeof fetch;
}

export interface RunOptions {
  limit?: number;
  timeoutMs?: number;
  label?: string;
}

export function zetarisConfigFromEnv(env = process.env): ZetarisConfig {
  const sample = env.SAMPLE_MODE === "true";
  return {
    restUrl: env.ZETARIS_REST_URL ?? "http://localhost:18888/api/v1.0",
    orgId: env.ZETARIS_ORG_ID ?? "1",
    apiKey: env.ZETARIS_API_KEY ?? "",
    mode: sample ? "replay" : env.ZETARIS_RECORD === "true" ? "record" : "live",
    recordingsDir: env.RECORDINGS_DIR ?? "recordings",
  };
}

export function sqlKey(sql: string, limit: number): string {
  const norm = sql.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${limit}|${norm}`).digest("hex").slice(0, 32);
}

/** One SQL statement per call, as the Zetaris REST contract requires. */
export class ZetarisClient {
  private readonly fetchImpl: typeof fetch;
  calls = 0;

  constructor(private readonly cfg: ZetarisConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get mode() {
    return this.cfg.mode ?? "live";
  }

  private recordingPath(key: string) {
    return join(this.cfg.recordingsDir ?? "recordings", "zetaris", `${key}.json`);
  }

  async runSql(sql: string, opts: RunOptions = {}): Promise<SqlResult> {
    const limit = opts.limit ?? 1000;
    const key = sqlKey(sql, limit);
    this.calls++;

    if (this.mode === "replay") {
      const p = this.recordingPath(key);
      if (!existsSync(p)) {
        throw new ZetarisError(`No recording for this query (SAMPLE_MODE). Key ${key}`, 404, sql);
      }
      const saved = JSON.parse(readFileSync(p, "utf8"));
      if (saved.error) throw new ZetarisError(saved.error, saved.status ?? 400, sql);
      return { ...saved.result, recorded: true };
    }

    const queryId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    const started = Date.now();
    let status = 0;
    let text = "";
    try {
      const res = await this.fetchImpl(`${this.cfg.restUrl.replace(/\/+$/, "")}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "X-Org-ID": this.cfg.orgId,
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId, sql, source: "SqlEditor", limit }),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const msg = (err as Error).name === "AbortError" ? `Zetaris query timed out after ${opts.timeoutMs ?? 30_000} ms` : String(err);
      throw new ZetarisError(msg, 0, sql);
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      const message = extractMessage(text) ?? `HTTP ${status}`;
      if (this.mode === "record") this.save(key, sql, { error: message, status });
      throw new ZetarisError(message, status, sql);
    }
    const body = JSON.parse(text) as { headers?: string[]; data?: unknown[][]; total?: number; timeUsed?: number };
    const result: SqlResult = {
      headers: body.headers ?? [],
      rows: (body.data ?? []).map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v)))),
      total: body.total ?? (body.data ?? []).length,
      timeUsedMs: body.timeUsed ?? Date.now() - started,
      queryId,
    };
    if (this.mode === "record") this.save(key, sql, { result });
    return result;
  }

  private save(key: string, sql: string, payload: object) {
    const p = this.recordingPath(key);
    mkdirSync(join(this.cfg.recordingsDir ?? "recordings", "zetaris"), { recursive: true });
    writeFileSync(p, JSON.stringify({ sql, ...payload }, null, 1));
  }
}

function extractMessage(text: string): string | undefined {
  try {
    const j = JSON.parse(text);
    const msg: string | undefined = j.msg ?? j.message ?? j.error;
    if (!msg) return undefined;
    // Spark stack traces are long; keep the head and the parser hint.
    const lines = String(msg).split("\n").filter((l) => !l.trim().startsWith("at "));
    return lines.slice(0, 12).join("\n").slice(0, 1500);
  } catch {
    return text.slice(0, 500) || undefined;
  }
}

/** Rows as objects keyed by header. */
export function asObjects(r: SqlResult): Record<string, string>[] {
  return r.rows.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i] ?? ""])));
}

export function isAlreadyExists(err: unknown): boolean {
  return err instanceof ZetarisError && /already exist/i.test(err.message);
}
