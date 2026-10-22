/** Deterministic margin bridge (§6). Pure functions — no I/O. */

export interface PeriodCell {
  sku: string;
  channel: string;
  qty: number;
  unitPriceCad: number;
  unitCostCad: number;
  /** USD unit price from AP (USD vendors only). */
  unitPriceUsd?: number;
  fxRate?: number;
  contractUnitPriceUsd?: number;
  isUsd?: boolean;
}

export interface PeriodInput {
  cells: PeriodCell[];
  packagingCad: number;
  /** Duplicate packaging booked in AP/GL but not paid in bank. */
  bookingErrorPkgCad: number;
}

export interface PeriodTotals {
  qty: number;
  revenue: number;
  goodsCost: number;
  packaging: number;
  gmGoods: number;
  gm: number;
  gmPct: number;
}

export interface BridgeResult {
  gmA: number;
  gmB: number;
  revenueA: number;
  revenueB: number;
  gmPctA: number;
  gmPctB: number;
  deltaGm: number;
  volume: number;
  mix: number;
  price: number;
  goodsCost: number;
  fx: number;
  supplierPrice: number;
  /** Informational: Σ q_B × (u_B − contract) × fx_B for USD cells. */
  overContract: number;
  otherCost: number;
  packaging: number;
  bookingError: number;
  packagingReal: number;
  residual: number;
  /** Each component as percentage points of B revenue. */
  componentsPpOfBRevenue: Record<string, number>;
}

function cellKey(sku: string, channel: string): string {
  return `${sku}||${channel}`;
}

export function periodTotals(period: PeriodInput): PeriodTotals {
  let qty = 0;
  let revenue = 0;
  let goodsCost = 0;
  for (const c of period.cells) {
    qty += c.qty;
    revenue += c.qty * c.unitPriceCad;
    goodsCost += c.qty * c.unitCostCad;
  }
  const packaging = period.packagingCad;
  const gmGoods = revenue - goodsCost;
  const gm = gmGoods - packaging;
  return {
    qty,
    revenue,
    goodsCost,
    packaging,
    gmGoods,
    gm,
    gmPct: revenue === 0 ? 0 : gm / revenue,
  };
}

function indexCells(cells: PeriodCell[]): Map<string, PeriodCell> {
  const m = new Map<string, PeriodCell>();
  for (const c of cells) {
    m.set(cellKey(c.sku, c.channel), c);
  }
  return m;
}

function emptyCell(sku: string, channel: string): PeriodCell {
  return {
    sku,
    channel,
    qty: 0,
    unitPriceCad: 0,
    unitCostCad: 0,
  };
}

function pp(amount: number, revenueB: number): number {
  return revenueB === 0 ? 0 : (amount / revenueB) * 100;
}

/**
 * Margin bridge between base period A and comparison period B (§6).
 * Residual = ΔGM − Σ components; should be ~0 when inputs are consistent.
 */
export function computeMarginBridge(
  periodA: PeriodInput,
  periodB: PeriodInput,
): BridgeResult {
  const totA = periodTotals(periodA);
  const totB = periodTotals(periodB);
  const mapA = indexCells(periodA.cells);
  const mapB = indexCells(periodB.cells);
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);

  const Q_A = totA.qty;
  const Q_B = totB.qty;
  const gmGoodsA = totA.gmGoods;

  const volume = Q_A === 0 ? 0 : (Q_B - Q_A) * (gmGoodsA / Q_A);

  let mix = 0;
  let price = 0;
  let goodsCost = 0;
  let fx = 0;
  let supplierPrice = 0;
  let overContract = 0;

  for (const key of keys) {
    const sep = key.indexOf("||");
    const sku = key.slice(0, sep);
    const channel = key.slice(sep + 2);
    const a = mapA.get(key) ?? emptyCell(sku, channel);
    const b = mapB.get(key) ?? emptyCell(sku, channel);
    const sA = Q_A === 0 ? 0 : a.qty / Q_A;
    const mA = a.unitPriceCad - a.unitCostCad;

    mix += (b.qty - Q_B * sA) * mA;
    price += b.qty * (b.unitPriceCad - a.unitPriceCad);
    goodsCost += -b.qty * (b.unitCostCad - a.unitCostCad);

    const usd =
      a.isUsd === true ||
      b.isUsd === true ||
      a.unitPriceUsd !== undefined ||
      b.unitPriceUsd !== undefined;

    if (usd) {
      const uA = a.unitPriceUsd ?? 0;
      const uB = b.unitPriceUsd ?? 0;
      const fxA = a.fxRate ?? 0;
      const fxB = b.fxRate ?? 0;
      const contract = b.contractUnitPriceUsd ?? a.contractUnitPriceUsd ?? uA;

      fx += -b.qty * uB * (fxB - fxA);
      supplierPrice += -b.qty * (uB - uA) * fxA;
      overContract += b.qty * (uB - contract) * fxB;
    }
  }

  const otherCost = goodsCost - fx - supplierPrice;

  const packaging = -(totB.packaging - totA.packaging);
  const bookingErrorDelta =
    periodB.bookingErrorPkgCad - periodA.bookingErrorPkgCad;
  const bookingError = -bookingErrorDelta;
  const packagingReal = packaging - bookingError;

  const deltaGm = totB.gm - totA.gm;
  const residual =
    deltaGm -
    (volume + mix + price + fx + supplierPrice + otherCost + packaging);

  const revenueB = totB.revenue;
  const componentsPpOfBRevenue: Record<string, number> = {
    volume: pp(volume, revenueB),
    mix: pp(mix, revenueB),
    price: pp(price, revenueB),
    goodsCost: pp(goodsCost, revenueB),
    fx: pp(fx, revenueB),
    supplierPrice: pp(supplierPrice, revenueB),
    otherCost: pp(otherCost, revenueB),
    packaging: pp(packaging, revenueB),
    bookingError: pp(bookingError, revenueB),
    packagingReal: pp(packagingReal, revenueB),
    residual: pp(residual, revenueB),
    deltaGm: pp(deltaGm, revenueB),
  };

  return {
    gmA: totA.gm,
    gmB: totB.gm,
    revenueA: totA.revenue,
    revenueB,
    gmPctA: totA.gmPct,
    gmPctB: totB.gmPct,
    deltaGm,
    volume,
    mix,
    price,
    goodsCost,
    fx,
    supplierPrice,
    overContract,
    otherCost,
    packaging,
    bookingError,
    packagingReal,
    residual,
    componentsPpOfBRevenue,
  };
}
