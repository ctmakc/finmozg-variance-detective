import { describe, expect, it } from "vitest";
import { computeMarginBridge, periodTotals, type PeriodCell, type PeriodInput } from "../src/quant/bridge.ts";

/** Deterministic PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKUS = ["NUT-ALM", "NUT-CAS", "BAR-01", "TEA-02"];
const CHANNELS = ["retail", "wholesale", "online"];

function randomPeriod(r: () => number, fx: number): PeriodInput {
  const cells: PeriodCell[] = [];
  for (const sku of SKUS) {
    const usd = sku.startsWith("NUT");
    const priceUsd = 4 + r() * 6;
    for (const channel of CHANNELS) {
      if (r() < 0.2) continue; // some cells only exist in one period
      const cell: PeriodCell = { sku, channel, qty: Math.round(r() * 2000), unitPriceCad: 8 + r() * 12, unitCostCad: usd ? priceUsd * fx : 3 + r() * 5 };
      if (usd) Object.assign(cell, { isUsd: true, unitPriceUsd: priceUsd, fxRate: fx, contractUnitPriceUsd: 5 });
      cells.push(cell);
    }
  }
  const packagingCad = Math.round(r() * 5000);
  return { cells, packagingCad, bookingErrorPkgCad: r() < 0.5 ? 0 : Math.round(r() * packagingCad) };
}

const sumOfComponents = (b: ReturnType<typeof computeMarginBridge>) => b.volume + b.mix + b.price + b.fx + b.supplierPrice + b.otherCost + b.packaging;

describe("margin bridge: accounting identities hold on random ledgers", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: components reconcile to ΔGM with zero residual`, () => {
      const r = rng(seed);
      const a = randomPeriod(r, 1.3 + r() * 0.1);
      const b = randomPeriod(r, 1.3 + r() * 0.1);
      const br = computeMarginBridge(a, b);
      const tol = 1e-6 * Math.max(1, Math.abs(br.revenueB));
      expect(br.deltaGm).toBeCloseTo(periodTotals(b).gm - periodTotals(a).gm, 6);
      expect(sumOfComponents(br) + br.residual).toBeCloseTo(br.deltaGm, 6);
      expect(Math.abs(br.residual)).toBeLessThan(tol);
      expect(br.fx + br.supplierPrice + br.otherCost).toBeCloseTo(br.goodsCost, 6);
      expect(br.bookingError + br.packagingReal).toBeCloseTo(br.packaging, 6);
      // percentage points of B revenue are the CAD amounts scaled by the same denominator
      for (const k of ["volume", "mix", "price", "fx", "residual"] as const) {
        expect(br.componentsPpOfBRevenue[k]).toBeCloseTo((br[k] / br.revenueB) * 100, 9);
      }
    });
  }
});

describe("margin bridge: price / volume / mix definitions", () => {
  const cell = (sku: string, channel: string, qty: number, price: number, cost: number): PeriodCell => ({ sku, channel, qty, unitPriceCad: price, unitCostCad: cost });
  const period = (cells: PeriodCell[], packagingCad = 0, bookingErrorPkgCad = 0): PeriodInput => ({ cells, packagingCad, bookingErrorPkgCad });

  it("identical periods give an all-zero bridge", () => {
    const p = period([cell("A", "retail", 100, 10, 6), cell("B", "wholesale", 40, 7, 5)], 50);
    const br = computeMarginBridge(p, structuredClone(p));
    for (const k of ["deltaGm", "volume", "mix", "price", "goodsCost", "fx", "supplierPrice", "otherCost", "packaging", "residual"] as const) {
      expect(br[k]).toBeCloseTo(0, 10);
    }
  });

  it("a pure volume change at constant mix is all volume", () => {
    const a = period([cell("A", "retail", 100, 10, 6), cell("B", "wholesale", 50, 8, 6)]);
    const b = period([cell("A", "retail", 200, 10, 6), cell("B", "wholesale", 100, 8, 6)]);
    const br = computeMarginBridge(a, b);
    expect(br.volume).toBeCloseTo(br.deltaGm, 10);
    expect(br.mix).toBeCloseTo(0, 10);
    expect(br.price).toBeCloseTo(0, 10);
  });

  it("a pure mix shift at constant total volume is all mix", () => {
    const a = period([cell("A", "retail", 100, 10, 6), cell("A", "wholesale", 100, 8, 6)]);
    const b = period([cell("A", "retail", 50, 10, 6), cell("A", "wholesale", 150, 8, 6)]);
    const br = computeMarginBridge(a, b);
    expect(br.volume).toBeCloseTo(0, 10);
    // 50 units move from margin 4 to margin 2
    expect(br.mix).toBeCloseTo(-100, 10);
    expect(br.deltaGm).toBeCloseTo(-100, 10);
  });

  it("a pure price change is measured at B quantities", () => {
    const a = period([cell("A", "retail", 100, 10, 6)]);
    const b = period([cell("A", "retail", 100, 10.5, 6)]);
    const br = computeMarginBridge(a, b);
    expect(br.price).toBeCloseTo(50, 10);
    expect(br.deltaGm).toBeCloseTo(50, 10);
  });

  it("a CAD-only cost change lands in other goods cost, not FX or supplier price", () => {
    const a = period([cell("A", "retail", 100, 10, 6)]);
    const b = period([cell("A", "retail", 100, 10, 6.25)]);
    const br = computeMarginBridge(a, b);
    expect(br.fx).toBe(0);
    expect(br.supplierPrice).toBe(0);
    expect(br.otherCost).toBeCloseTo(-25, 10);
  });

  it("a SKU that disappears in B costs its base margin through volume and mix, with no residual", () => {
    const a = period([cell("A", "retail", 100, 10, 6), cell("B", "retail", 100, 10, 8)]);
    const b = period([cell("A", "retail", 100, 10, 6)]);
    const br = computeMarginBridge(a, b);
    expect(br.deltaGm).toBeCloseTo(-200, 10);
    expect(br.volume + br.mix).toBeCloseTo(-200, 10);
    expect(br.residual).toBeCloseTo(0, 10);
  });

  it("an empty base period does not divide by zero", () => {
    const br = computeMarginBridge(period([]), period([cell("A", "retail", 10, 10, 6)]));
    expect(br.volume).toBe(0);
    expect(Number.isFinite(br.mix)).toBe(true);
    expect(br.gmPctA).toBe(0);
    expect(br.deltaGm).toBeCloseTo(40, 10);
    expect(br.residual).toBeCloseTo(0, 10);
  });

  it("an empty comparison period gives zero pp instead of NaN", () => {
    const br = computeMarginBridge(period([cell("A", "retail", 10, 10, 6)]), period([]));
    for (const v of Object.values(br.componentsPpOfBRevenue)) expect(v).toBe(0);
    expect(br.gmPctB).toBe(0);
  });
});
