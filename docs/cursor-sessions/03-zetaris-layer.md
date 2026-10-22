# Cursor session 03: zetaris-layer

- Start: 2026-10-22T00:35:56Z
- Tool: cursor-agent 2026.10.19-6bbf2c4, model auto

## Prompt

````text
Read docs/ARCHITECTURE.md section 4, .cursor/rules/zetaris.mdc and the files in docs/reference/ (zetaris-AGENTS.md, zetaris-lightning-sql-commands.md sections 4 and 5, zetaris-usl-howto.md, zetaris-usl-companion-sec8.md, 01_sic_usl_create.sql, 02_sic_edgar_usl_create.sql).
Note: .env exists locally (do not print it). Use PORT=8795 as the app default everywhere (8787 is taken on this host); update .env.example accordingly and add METERLESS_TOKEN_FILE, METERLESS_MODEL_DEEP, METERLESS_MODEL_FAST to it.

The data layer exists (scripts/generate-data.ts, data/generated/*, docker-compose.yml). Zetaris runs locally: REST at ZETARIS_REST_URL (http://localhost:18888/api/v1.0), org 1, API key in .env (ZETARIS_API_KEY). The Zetaris containers are on the docker network zetaris_default; the Spark driver container is named zetaris-driver-1 and reads files under /home/zetaris/customer-data/shared/.

Task:
1. src/zetaris/client.ts: `runSql(sql, {limit, timeoutMs=30000, label})` → `{headers, rows, total, timeUsedMs, queryId}`; throws a typed ZetarisError with the server message on HTTP or query errors. One statement per call. Fresh UUIDs for queryId and X-Request-ID. Optional recorder hook (used later for SAMPLE_MODE): every call can be recorded to/replayed from recordings/zetaris/<sha256(sql)>.json. Unit tests with a mocked fetch.

2. scripts/zetaris-register.ts (`npm run zetaris:register`, `--dry-run` prints statements only): idempotent registration of
   - CREATE DATASOURCE FM_ERP and FM_PROCURE (Postgres JDBC: jdbc:postgresql://erp-db:5432/erp and procure-db:5432/procure, credentials from env) then REGISTER DATASOURCE TABLE for each table;
   - copy data/generated/orders/*.csv into the driver container (`docker cp` into /home/zetaris/customer-data/shared/finmozg/), CREATE LIGHTNING DATABASE FM_ORDERS and FILESTORE CSV tables (header true, inferSchema true);
   - CREATE LIGHTNING DATABASE FM_BANK and a LIGHTNING REST TABLE for http://bankfeed:8080/transactions;
   - CREATE LIGHTNING DATABASE FM_BOC and a LIGHTNING REST TABLE for the Bank of Canada Valet FXUSDCAD observations endpoint.
   Find the exact REST TABLE syntax in docs/reference (PokeAPI example in zetaris-lightning-sql-commands.md) and in /data/projects/grantops-open-agent/prep/zetaris/getting-started/open_data/rest_apis/sql/ (read-only examples). Treat "already exists" as success. Log each statement and result.

3. sql/usl/finance_usl_create.sql and sql/usl/finance_usl_select.sql: the finance_usl Unified Semantic Layer per ARCHITECTURE section 4 (namespace lightning.metastore.finmozg; COMPILE USL with PK/FK; ACTIVATE each table from the registered raw sources; RUN DQ). scripts/zetaris-usl.ts (`npm run zetaris:usl`) sends the create file statement by statement (keep a multi-table COMPILE as one statement; split on a `-- @@` separator line, not on semicolons), then runs the select checks and prints row counts and DQ results.

4. Bring it up and prove it live: `docker compose up -d` (our compose), wait for the DBs, run `npm run zetaris:register`, `npm run zetaris:usl`. Then run one cross-source query through Zetaris that joins AP invoices (FM_PROCURE) with bank payments (FM_BANK) on vendor invoice number for 2026-09 and show the duplicated MRP-88213 lines with zero/one payment. Save its output to docs/evidence/zetaris-first-join.txt.

If a Lightning statement fails, read the error, check the reference docs, fix and retry. If the REST table cannot reach http://bankfeed:8080 from Zetaris, check that our bankfeed container is attached to zetaris_default with the alias bankfeed; as a last resort register the bank JSON file as a FILESTORE JSON table and note it in docs/evidence/. Run npm test and npm run typecheck at the end.
````

## Agent output

````text
ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.
````

- End: 2026-10-22T00:37:01Z (exit 1)
- Changed: 
