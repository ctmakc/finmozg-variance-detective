/**
 * Compiles and activates the finance_usl Unified Semantic Layer, runs DQ, then the verification queries.
 * Usage: npm run zetaris:usl [-- --checks-only]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { ZetarisClient, isAlreadyExists, zetarisConfigFromEnv } from "../src/zetaris/client.js";
import { readStatements } from "../src/zetaris/statements.js";

const checksOnly = process.argv.includes("--checks-only");

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").slice(0, 60).padEnd(widths[i])).join(" | ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("-|-"), ...rows.map(line)].join("\n");
}

async function main() {
  const z = new ZetarisClient({ ...zetarisConfigFromEnv(), mode: "live" });
  const out: string[] = [`finance_usl run ${new Date().toISOString()}`];
  if (!checksOnly) {
    for (const sql of readStatements("sql/usl/finance_usl_create.sql")) {
      const head = sql.split("\n")[0].slice(0, 100);
      try {
        const r = await z.runSql(sql, { timeoutMs: 180_000 });
        if (/^RUN DQ/i.test(sql)) {
          out.push(`\n${head}\n${table(r.headers, r.rows)}`);
        }
        console.log(`[ok]    ${head}`);
      } catch (err) {
        const msg = (err as Error).message;
        if (isAlreadyExists(err) || /already (activated|compiled|registered)/i.test(msg)) {
          console.log(`[reuse] ${head}`);
        } else {
          console.error(`[fail]  ${head}\n        ${msg.split("\n")[0]}`);
          process.exitCode = 1;
        }
      }
    }
  }
  for (const sql of readStatements("sql/usl/finance_usl_select.sql")) {
    const r = await z.runSql(sql, { timeoutMs: 180_000 });
    out.push(`\n${sql}\n\n${table(r.headers, r.rows)}`);
  }
  const text = out.join("\n");
  console.log(text);
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync("docs/evidence/zetaris-usl-checks.txt", text + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
