/**
 * Registers the synthetic sources in Zetaris (idempotent).
 * Usage: npm run zetaris:register [-- --dry-run]
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ZetarisClient, isAlreadyExists, zetarisConfigFromEnv } from "../src/zetaris/client.js";
import { readStatements } from "../src/zetaris/statements.js";

const dryRun = process.argv.includes("--dry-run");
const driver = process.env.ZETARIS_DRIVER_CONTAINER ?? "zetaris-driver-1";
const sharedDir = "/home/zetaris/customer-data/shared/finmozg";
const vars = { PG_USER: process.env.POSTGRES_USER ?? "finmozg", PG_PASSWORD: process.env.POSTGRES_PASSWORD ?? "finmozg" };
const mask = (s: string) => s.replace(/password "[^"]*"/g, 'password "***"');

function copyOrderFiles() {
  const dir = "data/generated/orders";
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  console.log(`[files] copy ${files.length} CSV files into ${driver}:${sharedDir}`);
  if (dryRun) return;
  execFileSync("docker", ["exec", driver, "mkdir", "-p", sharedDir]);
  for (const f of files) execFileSync("docker", ["cp", join(dir, f), `${driver}:${sharedDir}/`]);
}

async function main() {
  const statements = readStatements("sql/zetaris/register_sources.sql", vars);
  copyOrderFiles();
  const z = new ZetarisClient({ ...zetarisConfigFromEnv(), mode: "live" });
  let ok = 0;
  for (const sql of statements) {
    const head = mask(sql).slice(0, 110);
    if (dryRun) {
      console.log(`[dry-run] ${mask(sql)}`);
      continue;
    }
    try {
      await z.runSql(sql, { timeoutMs: 120_000 });
      console.log(`[ok]     ${head}`);
      ok++;
    } catch (err) {
      if (isAlreadyExists(err)) {
        console.log(`[reuse]  ${head}`);
        ok++;
      } else {
        console.error(`[fail]   ${head}\n         ${(err as Error).message.split("\n")[0]}`);
        process.exitCode = 1;
      }
    }
  }
  if (!dryRun) {
    const check = await z.runSql("SHOW LIGHTNING DATABASES");
    console.log(`[check] lightning databases: ${check.rows.map((r) => r[0]).join(", ")}`);
    const ds = await z.runSql("SHOW DATASOURCES");
    console.log(`[check] datasources: ${ds.rows.map((r) => r[0]).join(", ")}`);
    console.log(`${ok}/${statements.length} statements ok or reused`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
