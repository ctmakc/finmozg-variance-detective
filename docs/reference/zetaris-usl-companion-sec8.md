## 8. The Unified Semantic Layer (USL): a scriptable alternative/successor to VDM

The examples below use the supplied USL User Guide and the [`open_data/usl/`](../../open_data/usl/) package. See [USL source status](../../open_data/usl/usl-sources.md) and the [archived build record](../plans/archive/usl-build-plan.md). Claims based only on the guide are identified below.

### 8.1 Why this matters for this repo specifically

A SchemaStore view and a USL table can use the same flattening `SELECT`. USL adds a declared table schema and a lifecycle around that query. This example shows the shape; see the package scripts for complete SQL:

```text
Design (DDL)  →  Compile & Deploy  →  Activate (blue)  →  Query
                                            │
                                            ├─→  Data Quality rules → valid / invalid records → export
                                            └─→  Materialize (purple) → fast queries on large tables
```

```sql
-- What this repo does today (SchemaStore):
CREATE SCHEMASTORE VIEW sic_codes_table WITH CONTAINER company_dns AS
SELECT sic_code, sic_val.description AS description, ...
FROM company_dns.sic_codes_raw
LATERAL VIEW explode(from_json(to_json(data.sics), 'map<string, struct<...>>')) AS sic_code, sic_val;

-- The USL equivalent shape:
CREATE TABLE sic_code (
  sic_code           varchar(4) NOT NULL PRIMARY KEY,
  description        varchar(200),
  division           varchar(1),
  division_desc      varchar(200),
  major_group        varchar(2),
  major_group_desc   varchar(200),
  industry_group     varchar(3),
  industry_group_desc varchar(200)
);
-- then, after COMPILE USL DEPLOY:
ACTIVATE USL TABLE lightning.metastore.company_dns.sic_usl.sic_code AS
SELECT sic_code, sic_val.description AS description, ...
FROM company_dns.sic_codes_raw
LATERAL VIEW explode(from_json(to_json(data.sics), 'map<string, struct<...>>')) AS sic_code, sic_val;
```

The JSON conversion and `LATERAL VIEW explode()` still do the flattening. USL changes the destination and adds the declared schema; it does not remove that work.

### 8.2 What USL adds beyond a SchemaStore view

The supplied USL guide describes these capabilities. The table is a guide summary, not confirmation of every option.

| Capability | SchemaStore view | USL table |
|---|---|---|
| Types and constraints | Inferred output columns | Declared types, keys and checks |
| Relationships | Written as joins | Foreign keys shown in the ERD |
| Data quality | Separate queries | Constraint-generated and custom rules |
| Materialization | Separate pipeline | Export to configured storage |
| Descriptions and access | SQL comments and source permissions | Model/table/column descriptions and access controls |

### 8.3 Practical implications for this repo's REST sources

- `CACHE TABLE` is a session cache. `MATERIALIZE USL TABLE` is described as a persistent export. The repo has not live-tested materialization or its interaction with a cache.
- A foreign key checks that a referenced value exists. In the EDGAR/SIC fixture, the `sic` rule found IBM's code `3570` missing from the reference list; it does not check whether two description strings match. See [USL source status](../../open_data/usl/usl-sources.md) and the [archived build record](../plans/archive/usl-build-plan.md).
- The current USL example uses zero-padded string `cik` values from submissions. It does not join to revenue tables where `cik` is numeric; normalize that difference before adding such a join.
- Activation queries are ordinary `SELECT` statements. The self-join workaround in section 4 may apply, but the USL-specific case has not been tested.

<a id="84-usl-quirks-worth-flagging-per-the-guide-not-yet-live-tested"></a>
### 8.4 USL quirks and validation limits

Some items below come from the supplied guide; others were checked live on 12 October 2026, Zetaris 2.4.3.1.

- **Model replacement clears activation.** `UPDATE USL ... AS <JSON>` accepted a model containing `activateQuery`, but its next `SELECT` failed with `table(...) is not activated`. Running `ACTIVATE USL TABLE` restored access. The update result alone does not confirm the table remains queryable. See [UPDATE USL](zetaris-lightning-sql-commands.md).
- **Namespace and compile:** `lightning.metastore` must exist before `CREATE NAMESPACE IF NOT EXISTS lightning.metastore.<name>`. The `open_data/usl` create scripts create the parent first (`CREATE NAMESPACE IF NOT EXISTS lightning.metastore;`), then the package namespace. A multi-table `COMPILE USL` worked when sent as one statement over JDBC. These checks were confirmed on 1 October 2026; the SQL Workspace editor and a semicolon-splitting runner did not handle that multi-table form.
- **`IF NOT EXISTS` idempotency:** the supplied guide shows this option for `CREATE NAMESPACE` and `COMPILE USL`. The 2.4.3.1 check did not confirm repeat-run behaviour.
- **Canvas edits:** the supplied guide says card positions and FK edits made on the ERD canvas are session-only; define persistent relationships in DDL.
- **Valid-record materialization:** the guide says `Valid Records Only` requires a DQ rule. The repo has not confirmed that option live.
- **USL removal:** `REMOVE USL` removed the deployed test model on 2.4.3.1; `DROP NAMESPACE` then removed its empty namespace. Non-empty namespace removal and `DROP NAMESPACE ... CASCADE` were not tested.

### 8.5 Known open items in this repo's USL package specifically

The [archived USL build record](../plans/archive/usl-build-plan.md) tracks the full checklist. Remaining limits include:

- Cross-USL foreign keys have not been tested.
- The SQL form of `MATERIALIZE USL TABLE` has not been confirmed to support `Records: Valid Records Only`.
- The current USL model avoids the numeric-versus-string `cik` join rather than resolving it.
- Whether materialization changes cache behaviour and whether preview counts share the SQL Workspace row-display issue remain open.

### 8.6 REGISTER DQ: confirmed limitations (live-tested)

These findings come from the live-tested [`open_data/usl/`](../../open_data/usl/) examples. The supplied USL guide is the only SQL syntax source found for these commands.

- **No row alias:** use `REGISTER DQ <rule> TABLE <table> AS <expr>`. Adding an alias before `AS` failed.
- **No window functions:** rule expressions run as a filter, where Spark rejects window functions.
- **Same-table checks can be blocked by name collisions:** in `sic_usl.sic_code`, the table and column share a name. Three tested correlated-subquery/alias/window forms failed, so the consistency check remains a plain query in [`01_sic_usl_select.sql`](../../open_data/usl/sql/01_sic_usl_select.sql).
- **Cross-table correlation is unconfirmed:** the tested EDGAR/SIC check remains a plain join query in [`02_sic_edgar_usl_select.sql`](../../open_data/usl/sql/02_sic_edgar_usl_select.sql).
- **Constraint rule names use the column name:** check `LIST DQ USL` output rather than guessing a generated name.
- **DQ output shape:** `SHOW DQ ALL INVALID TABLE` returns rows in a JSON `records` column. In the 2.4.3.1 test, individual `SHOW DQ VALID/INVALID RECORD` queries returned ordinary columns. Check the output for your rule and table rather than assuming one shape for every form.

---

## 9. Open questions to close before validating this guide

Use the [archived USL build record](../plans/archive/usl-build-plan.md) for the live-verification checklist. The outstanding items are materialization behaviour, valid-only SQL options, `COMPILE USL` repeat behaviour, cross-USL foreign keys and preview row counts. Treat the guide-only claims above as unverified until a test or product document confirms them.

---

## 10. Related documents in this repo

| Document | Use it for |
|---|---|
| [EDGAR/SIC archived record](../plans/archive/edgar-sic-enrichment-plan.md) | REST/SchemaStore/VDM example and its source-data caveats |
| [USL archived build record](../plans/archive/usl-build-plan.md) | USL verification checklist and outcomes |
| [`open_data/usl/`](../../open_data/usl/) | USL SQL and per-model status |
| [REST API HOWTO](../../open_data/rest_apis/HOWTO.md), [Parquet/CSV HOWTO](../../open_data/parquet_csv/HOWTO.md) | Source setup and verification steps |
| [SQL command reference](zetaris-lightning-sql-commands.md) | Command syntax and examples |
