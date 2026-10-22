# Cursor session 01: scaffold-data

- Start: 2026-10-22T00:24:26Z
- Tool: cursor-agent 2026.10.19-6bbf2c4, model auto

## Prompt

````text
Read docs/ARCHITECTURE.md (sections 2, 3, 6) and .cursor/rules first.

Task: scaffold the TypeScript project and build the synthetic data layer.

1. package.json (ESM, Node 20): scripts `test` (vitest run), `typecheck` (tsc --noEmit), `fetch-fx` (tsx scripts/fetch-fx.ts), `generate` (tsx scripts/generate-data.ts), `bankfeed` (tsx services/bankfeed/server.ts). Dependencies: zod, dotenv. Dev: typescript, tsx, vitest, @types/node. tsconfig strict, moduleResolution bundler/NodeNext, target ES2022.

2. scripts/fetch-fx.ts: fetch https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-03-25&end_date=2026-10-01 and save the raw JSON plus a header field {source, fetchedAt, terms:"Bank of Canada Valet API"} to data/public/boc_fxusdcad_2026.json. Run it once now.

3. scripts/generate-data.ts: deterministic generator (seeded PRNG, seed 20261022) exactly per ARCHITECTURE section 3: SKUs, customers, vendors, contracts, months 2026-04..2026-09, orders and order lines, AP invoices and lines (USD vendors converted at the BoC rate on the invoice date; if no observation that day use the previous available business day), GL journal lines, bank transactions, and the five planted September causes. Write:
   - data/generated/erp.sql and data/generated/procure.sql (CREATE TABLE + INSERT, idempotent: DROP TABLE IF EXISTS first),
   - data/generated/orders/{orders,order_lines,products,customers}.csv,
   - data/generated/bank/transactions.json,
   - eval/ground_truth.json computed with the margin bridge formulas of section 6 from the generated rows (put the bridge math in src/quant/bridge.ts as pure functions so the agents' Quant reuses it; the generator only imports it).
   Keep volumes modest (about 2,000-4,000 order lines total). Print a summary: GM% per month, and the September components.

4. src/quant/bridge.ts + test/bridge.test.ts: pure functions for the section 6 bridge with unit tests on a tiny hand-made dataset where every component is known, plus a test that components + residual equal the GM change exactly.

5. services/bankfeed/server.ts: tiny node:http server (port from BANKFEED_PORT, default 8080) serving GET /transactions (optional ?period=YYYY-MM) and GET /healthz from data/generated/bank/transactions.json.

6. docker-compose.yml: services erp-db and procure-db (postgres:16-alpine, init from data/generated/*.sql via /docker-entrypoint-initdb.d, credentials from env with defaults finmozg/finmozg), bankfeed (node:20-alpine running the server with tsx, or a small Dockerfile), all on the EXTERNAL network zetaris_default only, no host ports except bankfeed 127.0.0.1:18080. Container names: fm-erp-db, fm-procure-db, fm-bankfeed; network aliases erp-db, procure-db, bankfeed.

7. .env.example with every variable name the project will need (ZETARIS_REST_URL=http://localhost:18888/api/v1.0, ZETARIS_ORG_ID=1, ZETARIS_API_KEY, LLM_PROVIDER=meterless, METERLESS_BASE_URL=http://127.0.0.1:8088/v1, METERLESS_RUNTIME_TOKEN, METERLESS_MODEL=meterless/auto, NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1, NVIDIA_API_KEY, NVIDIA_MODEL=nvidia/nemotron-3-super-120b-a12b, OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_MODEL, OPENAI_COMPAT_MODEL_FAST, SAMPLE_MODE=false, PORT=8787, BANKFEED_PORT=8080).

Then run: npm install, npm run fetch-fx, npm run generate, npm test, npm run typecheck. Fix any failure. Do not start docker. Report the generated September summary.
````

## Agent output

````text
Scaffold and synthetic data layer are in place. `npm install`, `fetch-fx`, `generate`, `test`, and `typecheck` all pass. Docker was not started.

### September summary (seed `20261022`)

Synthetic Northbound Pantry Co. data. FX from Bank of Canada Valet API (131 observations).

| Month | Revenue (CAD) | GM (CAD) | GM% |
|-------|---------------|----------|-----|
| 2026-08 | 198,052 | 90,475 | 45.68% |
| 2026-09 | 232,251 | 63,457 | 27.32% |

**ΔGM Sep vs Aug: −27,018 CAD** (residual 0.00)

| Component | CAD |
|-----------|-----|
| volume | +24,193 |
| mix (CUST-W01 ~2.2×) | −9,066 |
| price | 0 |
| goodsCost | −5,378 |
| → fx | −236 |
| → supplierPrice (SNC ×1.12) | −5,142 |
| → overContract (info) | 5,158 |
| packaging | −36,767 |
| → bookingError (MRP-88213) | −18,450 |
| → packagingReal | −18,317 |
| residual | 0 |

Volumes: **2,753** order lines, 538 orders. Outputs under `data/generated/`, `data/public/boc_fxusdcad_2026.json`, `eval/ground_truth.json`.
````

- End: 2026-10-22T00:29:58Z (exit 0)
- Changed: data/generated/bank/transactions.json data/generated/erp.sql data/generated/orders/customers.csv data/generated/orders/order_lines.csv data/generated/orders/orders.csv data/generated/orders/products.csv data/generated/procure.sql data/public/boc_fxusdcad_2026.json docker-compose.yml .env.example eval/ground_truth.json package.json package-lock.json scripts/fetch-fx.ts scripts/generate-data.ts services/bankfeed/Dockerfile services/bankfeed/server.ts src/quant/bridge.ts test/bridge.test.ts tsconfig.json vitest.config.ts 
