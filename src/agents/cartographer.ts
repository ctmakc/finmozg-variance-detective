/**
 * Cartographer: maps the business concepts to tables through Zetaris metadata (SHOW TABLES / DESCRIBE on the
 * finance_usl semantic layer, plus the raw source catalogs). Cold run: discovers and stores the map in H-MEM.
 * Warm run: reuses the map from H-MEM and skips discovery.
 */
import type { DetectiveMemory, SchemaMapEntry } from "../memory/hmem.js";
import { asObjects } from "../zetaris/client.js";
import type { RunSql } from "./quant.js";
import { USL } from "./quant.js";
import type { Emit } from "./types.js";

export interface SchemaMap {
  entries: SchemaMapEntry[];
  rawSources: string[];
  fromMemory: boolean;
}

const DESCRIPTIONS: Record<string, string> = {
  vendor: "vendors (id, name, invoicing currency)",
  vendor_bill: "one row per vendor invoice number booked in AP (PK = vendor_invoice_no; DQ flags invoices entered twice); amount_cad uses the BoC rate on the invoice date",
  vendor_payment: "vendor payments from the bank feed; vendor_invoice_no comes from the payment reference",
  product: "SKUs with category, retail list price and wholesale price",
  customer: "customers with channel retail or wholesale",
  sales_line: "order lines: period, customer, sku, qty, revenue_cad",
  purchase_line: "AP invoice lines: vendor, sku (PKG = packaging), qty, unit_price_orig in invoice currency, contract_unit_price, fx_rate, unit_cost_cad, amount_cad",
  gl_balance: "monthly general ledger balance per account: account_type revenue (positive), cogs (5000 goods, 5100 packaging), opex (6100 marketing …)",
  fx_rate: "Bank of Canada USD/CAD daily rate (live REST source)",
};

export function schemaPrompt(map: SchemaMap): string {
  const lines = map.entries.map((e) => `- ${e.table}(${e.columns.join(", ")})${e.description ? ` -- ${e.description}` : ""}`);
  return [
    `Unified Semantic Layer tables in Zetaris (query them with these full names):`,
    ...lines,
    `Raw sources also registered in Zetaris: ${map.rawSources.join(", ")}.`,
    `Dialect: Spark SQL (Zetaris Lightning). Periods are 'YYYY-MM' strings. One statement per call. No trailing semicolon.`,
  ].join("\n");
}

export async function runCartographer(runSql: RunSql, memory: DetectiveMemory, runId: string, emit: Emit, opts: { forceDiscovery?: boolean } = {}): Promise<SchemaMap> {
  const remembered = memory.schemaMap();
  if (!opts.forceDiscovery && remembered.length >= 5) {
    emit("Cartographer", "schema_from_memory", { tables: remembered.length });
    return { entries: remembered, rawSources: ["fm_erp (JDBC Postgres)", "fm_procure (JDBC Postgres)", "fm_orders (CSV file store)", "fm_bank (REST)", "fm_boc (REST, Bank of Canada)"], fromMemory: true };
  }
  const tables = asObjects(await runSql(`SHOW TABLES IN ${USL}`, "cartographer:show-tables"));
  const entries: SchemaMapEntry[] = [];
  for (const t of tables) {
    const full = t.table_identifier;
    const cols = asObjects(await runSql(`DESCRIBE ${full}`, `cartographer:describe:${full.split(".").pop()}`));
    const short = full.split(".").pop() ?? full;
    entries.push({ table: full, columns: cols.map((c) => `${c.col_name} ${c.data_type}`), description: DESCRIPTIONS[short] });
  }
  const ds = asObjects(await runSql("SHOW DATASOURCES", "cartographer:datasources")).map((d) => `${d.name} (JDBC)`);
  const dbs = asObjects(await runSql("SHOW LIGHTNING DATABASES", "cartographer:lightning-dbs"))
    .map((d) => d.name)
    .filter((n) => n.startsWith("FM_"))
    .map((n) => `${n} (Lightning)`);
  const stored = memory.rememberSchemaMap(entries, runId);
  emit("Cartographer", "schema_discovered", { tables: entries.length, storedInMemory: stored.length });
  return { entries, rawSources: [...ds, ...dbs], fromMemory: false };
}
