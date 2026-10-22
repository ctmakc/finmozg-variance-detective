/**
 * Tiny bank-feed HTTP service over data/generated/bank/transactions.json.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const dataPath = path.join(root, "data", "generated", "bank", "transactions.json");

interface BankTxn {
  txn_id: string;
  account: string;
  booking_date: string;
  amount_cad: number;
  amount_orig: number;
  currency_orig: string;
  counterparty: string;
  reference: string;
  period?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function periodOf(txn: BankTxn): string {
  return txn.period ?? txn.booking_date.slice(0, 7);
}

async function loadTxns(): Promise<BankTxn[]> {
  const raw = await readFile(dataPath, "utf8");
  const parsed = JSON.parse(raw) as BankTxn[];
  if (!Array.isArray(parsed)) {
    throw new Error("transactions.json must be an array");
  }
  return parsed;
}

function route(req: IncomingMessage): { pathname: string; period: string | null } {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  return {
    pathname: url.pathname,
    period: url.searchParams.get("period"),
  };
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  const { pathname, period } = route(req);
  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/transactions") {
    const txns = await loadTxns();
    const filtered =
      period === null || period === ""
        ? txns
        : txns.filter((t) => periodOf(t) === period);
    sendJson(res, 200, filtered);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

const port = Number(process.env.BANKFEED_PORT ?? "8080");
const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: "internal_error" });
  });
});

server.listen(port, () => {
  console.log(`bankfeed listening on :${port}`);
});
