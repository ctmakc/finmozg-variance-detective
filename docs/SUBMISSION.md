# Submission text (HackOS form)

## Project name
FINMOZG Variance Detective

## One sentence
An agent team that tells a controller why gross margin moved this month and proves every driver with rows from the ledger, purchasing, sales and bank systems, queried through one Zetaris semantic layer.

## Short description
At month-end close the same question comes back: gross margin fell, why? The answer is split across systems that share no keys: the general ledger says what moved, purchasing says which vendor and at what price, the order export says which customers, the bank says what cash actually left. FINMOZG Variance Detective recalls what earlier closes taught it (Meterless H-MEM), maps a Zetaris Unified Semantic Layer over all four systems plus live Bank of Canada FX, plans hypotheses, and sends parallel Investigator agents to test them with SQL through Zetaris, repairing queries from Zetaris error messages. A deterministic Quant agent computes the exact margin bridge. A Skeptic holds the veto: no rows, no claim; an amount that does not reconcile, a cost not confirmed by the bank, or a claim that does not name the vendor or customer is sent back, and false negatives are challenged too. The Writer produces a memo where every figure cites its evidence and a reviewer rejects numbers that are not in the facts. On the synthetic September close it finds the planted causes and names them: an invoice booked twice and paid once (CAD 12,450), a supplier billing above contract (CAD 9,143), a shift to a low-margin wholesale customer, an immaterial FX move, and it strikes out the red herring (marketing spend is opex). Scored against planted ground truth: 22 of 22 checks.

## Track
The Agent That Can Explain Why

## Team
Maksym Stepanenko · ctmakc@gmail.com · GitHub ctmakc · everything · primary contact (solo)

## Links
- GitHub: https://github.com/ctmakc/finmozg-variance-detective
- Demo video: https://www.youtube.com/watch?v=ecg3c5Whjeg (2:24; a real live run, recorded and replayed; TTS voice, subtitles)
- Slide deck: https://github.com/ctmakc/finmozg-variance-detective/blob/main/docs/deck.pdf

## Sponsor technology

**Zetaris.** A local Zetaris platform is the only door to the data. `npm run zetaris:register` registers five sources: two Postgres databases over JDBC (`CREATE DATASOURCE` + `REGISTER DATASOURCE TABLES`: general ledger, procurement/AP), the order-system CSV export as a file store, the bank feed as a REST table over our own service, and the live Bank of Canada Valet API as a REST table. On top sits the Unified Semantic Layer `finance_usl`: nine business tables with primary and foreign keys (vendor bills keyed by vendor invoice number, purchase lines with contract price and landed CAD cost at the BoC rate on the invoice date, sales lines with channel, payments from the bank, GL balances). `RUN DQ` on the USL flags the duplicated invoice by itself (31 records, 2 invalid, both MRP-88213) and the payment without an AP bill. Every agent query goes through `POST /sql-editor/sqls/run`; every statement, row count and query id is in the run trace, and the UI opens each memo figure to its SQL and rows.

**Meterless.** Build: three engines are load-bearing. H-MEM stores the schema map (a warm run skips discovery), the controller's confirmed or rejected findings, and the Skeptic's rulings, with a retrieval trace and audit ledger; the next close starts from it. The World Model is the shared evidence graph that every agent reads and writes (Question ← Hypothesis ← Finding ← Evidence → Vendor/Invoice/Customer) through a single-writer queue with provenance per write. Markovian runs the Skeptic's review of evidence rows in bounded chunks with compressed carryover. The reference engines are vendored unchanged (Apache-2.0) and pass the official conformance suites (13/13, 8/8, 8/8). Power: the app implements the Meterless Runtime provider contract v4 (URL normalisation, proxy-token auth, meterless-app/scope headers, status from /v1/models, Auto Detect, connect links) and uses it as the primary provider; every model call in the demo goes app → Meterless Runtime → Nemotron lane, with the signed compute receipt's routed model logged per call. Our dev box is x86 Linux, so we ran the official Runtime 1.4.5 daemon (DGX build) under user-mode emulation with its Nemotron lane forwarding to Ollama; the setup is documented in `ops/meterless-runtime-x86/`.

**Cursor (with SpaceX AI).** The project is a Cursor project (`.cursor/rules/` with the spec, Zetaris and Meterless rules). The first sessions ran in the Cursor Agent CLI: project scaffold, the seeded synthetic data generator, the margin-bridge maths with unit tests, the bank-feed service and compose file, and the data calibration. The Cursor free plan then hit its usage limit and the hackathon Cursor credit was not issued (we asked in Help Cursor), so the rest was written outside Cursor. `docs/cursor-sessions.md` lists every Cursor session with its prompt and files, and separately everything written outside Cursor.

**NVIDIA.** NVIDIA Nemotron 3 Super serves every model call: the Planner's hypothesis tree, the Investigators' tool calls and SQL repairs, the Skeptic's Markovian evidence review, and the memo. It is pinned through a Meterless Runtime lane; the same code runs on build.nvidia.com with `LLM_PROVIDER=nvidia`.

**What was unique.** The Skeptic is deterministic first: it checks every claim against the Quant bridge and drill-down, demands bank confirmation for cost claims, and challenges false negatives ("you found nothing, but the bridge measures CAD 6,517 for mix: find the rows"). Zetaris USL data-quality rules are part of the investigation, so the duplicate invoice is a primary-key violation before any agent asks. Memory turns a confirmed finding into the first check at the next close. And the agent is measured, not eyeballed: a planted ground truth and a 22-check eval took the first run from 16/22 to 22/22.

## Pre-existing components
- Planning documents written 15–21 Oct 2026 (no code): plan, demo outline, submission skeleton.
- FINMOZG, our separate product: domain ideas only (variance analysis concepts); no code copied.
- Meterless reference engines and conformance suites (github.com/Meterless/Meterless, Apache-2.0), vendored unchanged.
- Zetaris getting-started documentation and examples (Apache-2.0), copied into docs/reference for the coding agent.
- Meterless Runtime 1.4.5 (Nightshift DGX build) as the AI runtime, with a local lane shim and one catalog row patch (ops/).
- Bank of Canada Valet FX data (public).
Everything in the repository was written after 22 Oct 2026 00:00 UTC; git history starts then.
