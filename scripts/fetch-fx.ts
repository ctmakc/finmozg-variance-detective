/**
 * Fetch Bank of Canada FXUSDCAD observations and snapshot to data/public/.
 * Attribution: Bank of Canada Valet API (real FX; company data is synthetic).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FX_URL =
  "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-03-25&end_date=2026-10-01";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outPath = path.join(root, "data", "public", "boc_fxusdcad_2026.json");

async function main(): Promise<void> {
  const res = await fetch(FX_URL);
  if (!res.ok) {
    throw new Error(`BoC Valet fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const snapshot = {
    ...raw,
    header: {
      source: FX_URL,
      fetchedAt: new Date().toISOString(),
      terms: "Bank of Canada Valet API",
      ...(typeof raw.header === "object" && raw.header !== null
        ? (raw.header as Record<string, unknown>)
        : {}),
    },
  };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  const observations = (snapshot as { observations?: unknown }).observations;
  const obs = Array.isArray(observations) ? observations.length : 0;
  console.log(`Wrote ${outPath} (${obs} observations). Source: Bank of Canada Valet API.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
