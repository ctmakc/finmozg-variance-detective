# Cursor session 02: calibrate-data

- Start: 2026-10-22T00:30:29Z
- Tool: cursor-agent 2026.10.19-6bbf2c4, model auto

## Prompt

````text
Calibrate the synthetic data in scripts/generate-data.ts (re-read docs/ARCHITECTURE.md section 3, which was updated).

Problems in the current output:
1. Packaging double count: the bridge shows packaging −36,767 = bookingError −18,450 + packagingReal −18,317. The duplicate is added to packaging twice and the real September packaging also jumps. Fix: in September the regular monthly Maple Ridge packaging invoice IS `MRP-88213` (CAD 12,450.00) — no separate generic packaging invoice that month. It is entered twice in AP (two ap_doc_ids) and posted twice in GL; the bank pays it once. Real packaging spend therefore stays ~flat (~12k ±4 % every month); bookingError = −12,450 exactly; packagingReal ≈ small noise.
2. Margins are unrealistic (Aug GM 45.7 %, Sep 27.3 %). Target a specialty-food distributor: April–August GM% about 33–36 % after packaging, September about 29–31 %. Set contracted goods cost (CAD-equivalent) to about 0.60 × retail list price per SKU (so wholesale at 0.78 × list is low-margin), keep the USD contract prices derived from that with a fixed 1.37 planning rate, keep real FX for actual conversion. Keep the other planted causes as specified (Sierra Nut ×1.12 in September; CUST-W01 ~2.2× volume; marketing +~42k in opex 6100; stable list prices).
3. Make sure the ground truth explains the September gap with the planted causes: mix, supplier price over contract, booking error, FX (whatever it is), with a small residual/noise; print each component's share of the GM change.

Regenerate (npm run generate), update tests if needed, run npm test and npm run typecheck. Report the new monthly GM% table and September components.
````

## Agent output

````text
Calibrated and regenerated. Packaging double-count is fixed; margins sit in the specialty-food bands. Tests and typecheck pass (no test changes needed).

### Monthly GM%

| Period | Revenue | GM | GM% |
|--------|---------|-----|-----|
| 2026-04 | 306,821 | 111,125 | **36.2%** |
| 2026-05 | 326,156 | 118,992 | **36.5%** |
| 2026-06 | 318,225 | 113,048 | **35.5%** |
| 2026-07 | 333,624 | 118,494 | **35.5%** |
| 2026-08 | 319,555 | 114,821 | **35.9%** |
| 2026-09 | 359,444 | 104,787 | **29.2%** |

### September vs August bridge (ΔGM = −10,034)

| Component | CAD | Share of ΔGM |
|-----------|-----|--------------|
| volume | +18,873 | −188% *(offsets)* |
| mix | −6,517 | 65% |
| price | 0 | 0% |
| goodsCost | −9,541 | 95% |
| → fx | −425 | 4% |
| → supplierPrice | −9,116 | 91% |
| → otherCost | ~0 | 0% |
| packaging | −12,849 | 128% |
| → bookingError | **−12,450** | 124% |
| → packagingReal | −399 | 4% |
| residual | **0** | 0% |

### Fixes in `scripts/generate-data.ts`
1. **Packaging:** September’s only Maple Ridge invoice is `MRP-88213` (CAD 12,450) — two AP docs, two GL posts, one bank payment. No extra generic Sep packaging line.
2. **Costs:** Contract CAD-equivalent ≈ **0.585 × list** (about 0.60×), USD from planning FX **1.37**; real BoC FX at invoice. Retail-heavier mix so wholesale stays the low-margin minority.
3. **Planted causes kept:** Sierra ×1.12, W01 ≈2.2×, marketing +42k opex, stable list prices.
````

- End: 2026-10-22T00:35:38Z (exit 0)
- Changed: data/generated/bank/transactions.json data/generated/erp.sql data/generated/orders/order_lines.csv data/generated/orders/orders.csv data/generated/procure.sql eval/ground_truth.json scripts/generate-data.ts 
