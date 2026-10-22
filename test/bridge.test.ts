import { describe, expect, it } from "vitest";
import {
  computeMarginBridge,
  periodTotals,
  type PeriodInput,
} from "../src/quant/bridge.ts";

/** Tiny hand-made dataset: every component is known analytically. */
function handmade(): { a: PeriodInput; b: PeriodInput } {
  const a: PeriodInput = {
    cells: [
      {
        sku: "SKU-1",
        channel: "retail",
        qty: 100,
        unitPriceCad: 10,
        unitCostCad: 6,
      },
      {
        sku: "SKU-1",
        channel: "wholesale",
        qty: 50,
        unitPriceCad: 8,
        unitCostCad: 6,
      },
    ],
    packagingCad: 100,
    bookingErrorPkgCad: 0,
  };
  const b: PeriodInput = {
    cells: [
      {
        sku: "SKU-1",
        channel: "retail",
        qty: 120,
        unitPriceCad: 11,
        unitCostCad: 6.5,
      },
      {
        sku: "SKU-1",
        channel: "wholesale",
        qty: 40,
        unitPriceCad: 8,
        unitCostCad: 7,
      },
    ],
    packagingCad: 150,
    bookingErrorPkgCad: 50,
  };
  return { a, b };
}

describe("periodTotals", () => {
  it("computes revenue, goods cost, packaging, and GM", () => {
    const { a } = handmade();
    const t = periodTotals(a);
    expect(t.qty).toBe(150);
    expect(t.revenue).toBe(1400);
    expect(t.goodsCost).toBe(900);
    expect(t.packaging).toBe(100);
    expect(t.gmGoods).toBe(500);
    expect(t.gm).toBe(400);
    expect(t.gmPct).toBeCloseTo(400 / 1400, 10);
  });
});

describe("computeMarginBridge", () => {
  it("matches known analytic components on the hand-made dataset", () => {
    const { a, b } = handmade();
    const bridge = computeMarginBridge(a, b);

    // Volume = (160-150) * (500/150)
    expect(bridge.volume).toBeCloseTo(10 * (500 / 150), 10);
    // Mix = (120 - 160*100/150)*4 + (40 - 160*50/150)*2
    expect(bridge.mix).toBeCloseTo(
      (120 - (160 * 100) / 150) * 4 + (40 - (160 * 50) / 150) * 2,
      10,
    );
    // Price = 120*(11-10) + 40*(8-8)
    expect(bridge.price).toBeCloseTo(120, 10);
    // Goods cost = -(120*(6.5-6) + 40*(7-6))
    expect(bridge.goodsCost).toBeCloseTo(-100, 10);
    expect(bridge.packaging).toBeCloseTo(-50, 10);
    expect(bridge.bookingError).toBeCloseTo(-50, 10);
    expect(bridge.packagingReal).toBeCloseTo(0, 10);
    expect(bridge.gmA).toBeCloseTo(400, 10);
    expect(bridge.gmB).toBeCloseTo(430, 10);
    expect(bridge.deltaGm).toBeCloseTo(30, 10);
  });

  it("components + residual equal the GM change exactly", () => {
    const { a, b } = handmade();
    const bridge = computeMarginBridge(a, b);
    const sum =
      bridge.volume +
      bridge.mix +
      bridge.price +
      bridge.fx +
      bridge.supplierPrice +
      bridge.otherCost +
      bridge.packaging +
      bridge.residual;
    expect(sum).toBeCloseTo(bridge.deltaGm, 10);
    expect(bridge.residual).toBeCloseTo(0, 10);
    expect(bridge.fx + bridge.supplierPrice + bridge.otherCost).toBeCloseTo(
      bridge.goodsCost,
      10,
    );
    expect(bridge.bookingError + bridge.packagingReal).toBeCloseTo(
      bridge.packaging,
      10,
    );
  });

  it("splits USD goods-cost change into FX and supplier price", () => {
    const a: PeriodInput = {
      cells: [
        {
          sku: "NUT-01",
          channel: "retail",
          qty: 100,
          unitPriceCad: 20,
          unitCostCad: 10, // 8 USD * 1.25
          unitPriceUsd: 8,
          fxRate: 1.25,
          contractUnitPriceUsd: 8,
          isUsd: true,
        },
      ],
      packagingCad: 0,
      bookingErrorPkgCad: 0,
    };
    const b: PeriodInput = {
      cells: [
        {
          sku: "NUT-01",
          channel: "retail",
          qty: 100,
          unitPriceCad: 20,
          unitCostCad: 12.32, // 8.8 USD * 1.40
          unitPriceUsd: 8.8,
          fxRate: 1.4,
          contractUnitPriceUsd: 8,
          isUsd: true,
        },
      ],
      packagingCad: 0,
      bookingErrorPkgCad: 0,
    };
    const bridge = computeMarginBridge(a, b);
    // FX = -100 * 8.8 * (1.40 - 1.25) = -132
    expect(bridge.fx).toBeCloseTo(-132, 10);
    // Supplier = -100 * (8.8 - 8) * 1.25 = -100
    expect(bridge.supplierPrice).toBeCloseTo(-100, 10);
    // Over-contract = 100 * (8.8 - 8) * 1.40 = 112
    expect(bridge.overContract).toBeCloseTo(112, 10);
    expect(bridge.goodsCost).toBeCloseTo(-232, 10);
    expect(bridge.otherCost).toBeCloseTo(0, 10);
    expect(bridge.residual).toBeCloseTo(0, 10);
  });
});
