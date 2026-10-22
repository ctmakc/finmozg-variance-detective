# FINMOZG Variance Detective — architecture spec

Design spec written by the builder on 22 Oct 2026 (after the build window opened). All product code is generated in Cursor from this spec; see `docs/cursor-sessions.md`.

## 1. What it does

A controller asks: "Why did gross margin fall in September vs August?" A team of agents investigates four systems that do not share keys (general ledger, procurement/AP, order system export, bank feed) plus the live Bank of Canada USD/CAD rate, all through **one Zetaris SQL surface** and a **Zetaris Unified Semantic Layer (USL)**. Output: a variance memo with a margin bridge, every driver tied to SQL + rows + source, rejected hypotheses with reasons, the unexplained residual shown openly, and open questions.

Company and data are **synthetic** ("Northbound Pantry Co.", fictional Ottawa specialty-food importer). FX rates are **real** Bank of Canada data.

## 2. Stack

- TypeScript, Node 20, ESM, `tsx` runner, `vitest` tests, `zod` for validating every LLM JSON output.
- Data: Zetaris (local Docker install, REST API `POST {ZETARIS_REST_URL}/sql-editor/sqls/run`).
- Sources run in this repo's `docker-compose.yml` on the **external** Docker network `zetaris_default` (the host has no free address pools; never create a new network).
- LLM: one injected `generator` (Meterless engine contract) behind a provider layer. Providers: `meterless` (Meterless Runtime / Nightshift, PRIMARY), `nvidia` (build.nvidia.com), `openai_compat` (any OpenAI-compatible endpoint, e.g. Ollama Cloud serving Nemotron). Models: NVIDIA Nemotron 3 (Super for planning/skeptic/writer, Nano for SQL drafts).
- Meterless engines vendored from github.com/Meterless/Meterless (Apache-2.0) into `src/engines/{hmem,world-model,markovian}/` with their LICENSE and a NOTICE line.

## 3. Synthetic data (deterministic, seed 20261022)

Generator: `scripts/generate-data.ts`. Months: 2026-04 … 2026-09. Functional currency CAD.

Entities:
- 12 SKUs in 4 categories (nuts, olive oil, preserves, coffee). Each has a CAD list price (retail) and a wholesale price = list × 0.78.
- Customers: 18 retail stores (channel `retail`) and 3 wholesale distributors (channel `wholesale`). One wholesale customer, "Capital Wholesale Grocers" (CUST-W01), is the low-margin one.
- Vendors: 6. Two invoice in USD: "Sierra Nut Co." (VEND-SNC, nuts) and "Lakeshore Olive Imports" (VEND-LOI, olive oil). Others CAD, incl. "Maple Ridge Packaging" (VEND-MRP, packaging, CAD).
- Contracts: vendor × SKU contracted unit price (USD for USD vendors), valid 2026-01-01 … 2026-12-31.
- Simplification (documented in README): goods are bought in the month they are sold (no inventory carry); SKU unit cost in a month = that month's AP invoice line unit price × FX rate on the invoice date (USD vendors) or the CAD price.

Planted causes for September (2026-09) vs August (2026-08):
1. **Supplier price above contract:** Sierra Nut Co. invoices all September nut SKUs at contract × 1.12.
2. **FX:** USD invoices convert at the real BoC FXUSDCAD rate on the invoice date. Whatever reality says is the FX effect.
3. **Duplicate invoice (booking error):** Maple Ridge Packaging's regular September invoice `MRP-88213` (CAD 12,450.00, packaging, account 5100; it replaces the usual monthly packaging invoice, so the real packaging spend stays flat) is entered twice in AP (two AP document ids) and posted twice in GL; the bank feed shows one payment.
4. **Mix shift:** CUST-W01 volume in September is ~2.2× its April–August average (wholesale price, so lower margin).
5. **Red herring:** a September marketing campaign raises opex account 6100 by ~CAD 42,000. It is below gross margin and must be rejected as a margin driver.
Everything else: stable volumes with small seeded noise (±4 %), stable prices.

Ground truth (`eval/ground_truth.json`) is computed from the generated rows with the same bridge formulas as §6 and is **never read by agents**.

Outputs:
- `data/generated/erp.sql` → Postgres `erp`: `gl_account(account_code, name, type)` where type ∈ revenue|cogs|opex; `gl_journal_line(line_id, journal_id, posting_date, period, account_code, amount_cad, source_system, source_doc_id, memo)`; revenue and COGS goods lines are posted per invoice/order, packaging per AP document.
- `data/generated/procure.sql` → Postgres `procure`: `vendor(vendor_id, name, currency)`, `contract(contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to)`, `ap_invoice(ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status)`, `ap_invoice_line(ap_doc_id, line_no, sku, qty, unit_price, amount)`. Packaging invoices have lines with sku `PKG`.
- `data/generated/orders/orders.csv`, `order_lines.csv`, `products.csv`, `customers.csv` → Zetaris FILESTORE (CSV). `order_lines(order_id, line_no, sku, qty, unit_price_cad, amount_cad)`, `orders(order_id, customer_id, order_date, period)`.
- `data/generated/bank/transactions.json` → served by `bankfeed` (tiny Node HTTP service, `GET /transactions` and `GET /transactions?period=2026-09`) and registered as a Zetaris REST table. Fields: `txn_id, account, booking_date, amount_cad, amount_orig, currency_orig, counterparty, reference` (reference holds the vendor invoice number for vendor payments).
- `data/public/boc_fxusdcad_2026.json` — snapshot of `https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-03-25&end_date=2026-10-01` (fetched once by `scripts/fetch-fx.ts`, committed, attributed). Zetaris also registers the live Valet endpoint as a REST table.

## 4. Zetaris layer

`scripts/zetaris-register.ts` (idempotent; "already exists" = reuse; `--dry-run` prints statements):
- JDBC datasources (`CREATE DATASOURCE` + `REGISTER DATASOURCE TABLE`) `FM_ERP` and `FM_PROCURE` (Postgres in compose, reachable from Zetaris at `erp-db:5432`, `procure-db:5432`).
- Lightning database `FM_ORDERS` + FILESTORE CSV tables (files copied into the Zetaris driver container under `/home/zetaris/customer-data/shared/finmozg/`).
- Lightning database `FM_BANK` + REST table `transactions` from `http://bankfeed:8080/transactions`.
- Lightning database `FM_BOC` + REST table `fx_usdcad` from the BoC Valet endpoint.
- Exact Lightning SQL syntax: `docs/reference/zetaris-lightning-sql-commands.md` and `docs/reference/zetaris-usl-howto.md`. Send one statement per REST call.

**Unified Semantic Layer** `sql/usl/finance_usl_create.sql` (namespace `lightning.metastore.finmozg`, USL `finance_usl`): business tables with PK/FK:
- `vendor(vendor_id PK, name, currency)`
- `purchase_invoice(ap_doc_id PK, vendor_id FK→vendor, vendor_invoice_no, invoice_date, period, currency, total_amount, total_amount_cad)`
- `vendor_payment(txn_id PK, vendor_invoice_no, booking_date, period, amount_cad, counterparty)`
- `sales_line(order_id, line_no, period, customer_id, channel, sku, qty, revenue_cad)` (PK order_id+line_no if supported, else a surrogate key)
- `cost_line(period, sku, qty, unit_cost_cad, unit_cost_orig, currency, contract_unit_price, fx_rate)`
- `gl_period_account(period, account_code, account_type, amount_cad)`
- `fx_rate(rate_date PK, usdcad)`
ACTIVATE each from the raw sources. `RUN DQ` on the USL; the FK/PK rules surface integrity problems (e.g. the duplicated vendor invoice number). `sql/usl/finance_usl_select.sql` holds verification queries. Agents query the USL first and drop to raw sources for row-level evidence.

## 5. Agents (bounded state machine, shared run state)

All agents read/write shared state through the **World Model** (entities: Question, Hypothesis, Finding, Evidence, Vendor, Invoice, Payment, Sku, Customer, Account; facts carry provenance `{sql, source, rowKeys, queryId}`). Every step appends a JSONL trace event to `logs/trace-<run_id>.jsonl` and emits it on the server's SSE stream.

| Agent | Job |
|---|---|
| Planner | Question → `{metric, periodA, periodB, hypotheses[]}` (zod). Recalls H-MEM first (schema map, confirmed findings, policies). Default hypothesis tree if the model output is invalid (logged as fallback). Re-plans when the Skeptic asks. |
| Cartographer | Lists USL/raw tables and columns via Zetaris (`SHOW`, `DESCRIBE`), writes the schema map to the World Model and H-MEM. Warm run: reuse the map from H-MEM, skip discovery. |
| Investigator (one per hypothesis, ≤3 in parallel) | Tool-calling loop with one tool `run_sql`. On SQL error: read the message, repair (≤3 tries). ≤6 tool calls. Returns findings `{claim, amountCad, evidence[]}`; each evidence item holds the SQL, source tables, row count and up to 20 sample rows. |
| Quant | Deterministic margin bridge (§6) from fixed aggregate SQL through Zetaris. No LLM in arithmetic. Unit-tested. |
| Skeptic | Veto. Deterministic rules first: no evidence rows → reject; cost claims need GL + AP + bank agreement; amounts must match the Quant bridge within 2 % or CAD 500; opex accounts are not gross-margin drivers. Then an LLM review of long evidence sets through **Markovian** in bounded chunks with compressed carryover. Can send a hypothesis back (≤2 rounds) with a concrete request. |
| Writer | Memo (markdown) + JSON. Every sentence cites evidence ids. Final reviewer check: drivers + residual sum to the observed gap; caveats present ("decision support, human sign-off required"). |
| Memory steward | `POST /feedback {runId, findingId, verdict: confirmed|rejected, note}` → H-MEM mining + feedback; the next run starts warm. |

Caps: 30 s per Zetaris call, 180 s per model call (Meterless contract), ≤2 Skeptic rounds, ≤3 SQL repairs, 8 min per run. On failure: structured error + partial result.

## 6. Margin bridge (Quant)

Per period P: SKU×channel cells i with qty `q`, revenue `R=Σq·p`, cost `C=Σq·c` (goods cost per unit from AP lines × FX), plus non-SKU COGS (account 5100 packaging). GM = R − C − Pkg.
Between A (base) and B:
- Volume = (Q_B − Q_A) × (GM_goods_A / Q_A)
- Mix = Σ_i (q_B,i − Q_B·s_A,i) × m_A,i, where s = qty share, m = p − c per unit in A
- Price = Σ_i q_B,i × (p_B,i − p_A,i)
- Goods cost = −Σ_i q_B,i × (c_B,i − c_A,i), split into:
  - FX = −Σ_USD q_B,i × u_B,i × (fx_B,i − fx_A,i) (u = USD unit price)
  - Supplier price vs contract = −Σ_USD q_B,i × (u_B,i − u_A,i) × fx_A,i … reported together with the over-contract amount Σ q_B,i × (u_B,i − contract_i) × fx_B,i
  - Other cost = remainder
- Packaging/other COGS = −(Pkg_B − Pkg_A), split into booking error (duplicate invoices: posted in GL/AP, no bank payment) and real change.
- Residual = (GM_B − GM_A) − Σ components (should be ~0; shown openly).
Also report GM % for A and B and each component in percentage points of B revenue.

## 7. Interfaces

- CLI: `npm run agent -- --input input_examples/01-gm-drop-sep.json`
- API (`src/server.ts`, port `PORT`, default 8787 — check it is free): `POST /run`, `GET /runs/:id`, `GET /runs/:id/events` (SSE), `POST /feedback`, `GET /health` (Zetaris + provider status).
- UI (`ui/`, served by the server): question → live agent timeline → margin waterfall → drivers with evidence drawer (SQL + rows + source) → rejected hypotheses → feedback buttons. Provider badge shows Meterless Runtime status (online / unauthorized / offline) and the route used.
- `SAMPLE_MODE=true`: replays recorded Zetaris results and model replies from a real live run (`recordings/`), labelled as recordings, no network.
- `.env.example`, `metadata.json`, Dockerfile (CPU-only).

## 8. Inputs (`input_examples/`)

1. Why did gross margin fall in September vs August?
2. Which vendors drove the cost-of-goods increase in September, and is any of it recoverable?
3. Was the September FX move material to margin?
4. Why did total operating expenses rise in September vs August? (warm-memory demo after feedback on #1)
5. Why did headcount cost rise? (no payroll source → honest "no data" answer)

## 9. Evaluation

`npm run eval` runs inputs against `eval/ground_truth.json`: drivers found, amounts within tolerance, red herring rejected, duplicate flagged as booking error, residual reported. Writes `eval/results-<date>.json`. Honest numbers go to README and slides.
