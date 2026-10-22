/**
 * Deterministic synthetic data for Northbound Pantry Co. (fictional).
 * Seed 20261022. FX rates are real Bank of Canada data.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMarginBridge,
  periodTotals,
  type PeriodCell,
  type PeriodInput,
} from "../src/quant/bridge.ts";

const SEED = 20261022;
const MONTHS = [
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Mulberry32 seeded PRNG. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randBetween(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(randBetween(rng, lo, hi + 1));
}

function pickN<T>(rng: () => number, arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function periodFromDate(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function daysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dateInMonth(period: string, day: number): string {
  const d = Math.min(day, daysInMonth(period));
  return `${period}-${String(d).padStart(2, "0")}`;
}

// --- Entities ---

interface Sku {
  sku: string;
  name: string;
  category: "nuts" | "olive_oil" | "preserves" | "coffee";
  listPriceCad: number;
  wholesalePriceCad: number;
}

interface Customer {
  customer_id: string;
  name: string;
  channel: "retail" | "wholesale";
}

interface Vendor {
  vendor_id: string;
  name: string;
  currency: "CAD" | "USD";
  categories: Sku["category"][];
}

interface Contract {
  contract_id: string;
  vendor_id: string;
  sku: string;
  unit_price: number;
  currency: "CAD" | "USD";
  valid_from: string;
  valid_to: string;
}

const SKU_DEFS: Omit<Sku, "wholesalePriceCad">[] = [
  { sku: "NUT-ALM", name: "Almonds 1kg", category: "nuts", listPriceCad: 28.0 },
  { sku: "NUT-PEC", name: "Pecans 1kg", category: "nuts", listPriceCad: 34.0 },
  { sku: "NUT-CAS", name: "Cashews 1kg", category: "nuts", listPriceCad: 32.0 },
  { sku: "OIL-EVO", name: "EVOO 750ml", category: "olive_oil", listPriceCad: 22.0 },
  { sku: "OIL-ORG", name: "Organic EVOO 750ml", category: "olive_oil", listPriceCad: 26.0 },
  { sku: "OIL-FLT", name: "Flavoured Oil 500ml", category: "olive_oil", listPriceCad: 18.0 },
  { sku: "PRS-JAM", name: "Berry Jam 250g", category: "preserves", listPriceCad: 12.0 },
  { sku: "PRS-HNY", name: "Wildflower Honey 500g", category: "preserves", listPriceCad: 16.0 },
  { sku: "PRS-OLV", name: "Olive Tapenade 200g", category: "preserves", listPriceCad: 14.0 },
  { sku: "COF-ETH", name: "Ethiopia Beans 1kg", category: "coffee", listPriceCad: 24.0 },
  { sku: "COF-COL", name: "Colombia Beans 1kg", category: "coffee", listPriceCad: 22.0 },
  { sku: "COF-SUM", name: "Sumatra Beans 1kg", category: "coffee", listPriceCad: 20.0 },
];

const SKUS: Sku[] = SKU_DEFS.map((s) => ({
  ...s,
  wholesalePriceCad: round2(s.listPriceCad * 0.78),
}));

const CUSTOMERS: Customer[] = [
  ...Array.from({ length: 18 }, (_, i) => ({
    customer_id: `CUST-R${String(i + 1).padStart(2, "0")}`,
    name: [
      "Byward Market Pantry",
      "Glebe Specialty Foods",
      "Westboro Cellar",
      "Kanata Kitchen Co.",
      "Barrhaven Bites",
      "Orleans Olive Bar",
      "Nepean Nibbles",
      "Hintonburg Hearth",
      "Centretown Cravings",
      "Sandy Hill Spices",
      "Vanier Village Grocer",
      "Riverview Relish",
      "Stittsville Staples",
      "Manotick Mercantile",
      "Carleton Place Cupboard",
      "Almonte Aisle",
      "Perth Pantry",
      "Smiths Falls Select",
    ][i]!,
    channel: "retail" as const,
  })),
  {
    customer_id: "CUST-W01",
    name: "Capital Wholesale Grocers",
    channel: "wholesale",
  },
  {
    customer_id: "CUST-W02",
    name: "Laurentian Foodservice Dist.",
    channel: "wholesale",
  },
  {
    customer_id: "CUST-W03",
    name: "Ottawa Valley Distributors",
    channel: "wholesale",
  },
];

const VENDORS: Vendor[] = [
  {
    vendor_id: "VEND-SNC",
    name: "Sierra Nut Co.",
    currency: "USD",
    categories: ["nuts"],
  },
  {
    vendor_id: "VEND-LOI",
    name: "Lakeshore Olive Imports",
    currency: "USD",
    categories: ["olive_oil"],
  },
  {
    vendor_id: "VEND-MRP",
    name: "Maple Ridge Packaging",
    currency: "CAD",
    categories: [],
  },
  {
    vendor_id: "VEND-PRV",
    name: "Prairie Preserve Co.",
    currency: "CAD",
    categories: ["preserves"],
  },
  {
    vendor_id: "VEND-RCK",
    name: "Rockies Coffee Roasters",
    currency: "CAD",
    categories: ["coffee"],
  },
  {
    vendor_id: "VEND-OTW",
    name: "Ottawa Dry Goods",
    currency: "CAD",
    categories: [],
  },
];

/** Planning FX for deriving USD contract prices from CAD-equivalent cost. Real BoC FX used at invoice. */
const PLANNING_FX_USDCAD = 1.37;

/** Contract unit prices: CAD-equivalent cost ≈ 0.60 × retail list (specialty-food distributor margins). */
function buildContracts(): Contract[] {
  const contracts: Contract[] = [];
  let n = 1;
  for (const sku of SKUS) {
    const vendor = VENDORS.find((v) => v.categories.includes(sku.category));
    if (!vendor) continue;
    // Target CAD cost ≈ 0.585 × retail list (about 0.60×): wholesale at 0.78×list stays
    // low-margin; blended after packaging lands in the 33–36% / 29–31% bands.
    const targetCad = sku.listPriceCad * 0.585;
    const unitPrice =
      vendor.currency === "USD"
        ? round2(targetCad / PLANNING_FX_USDCAD)
        : round2(targetCad);
    contracts.push({
      contract_id: `CTR-${String(n++).padStart(3, "0")}`,
      vendor_id: vendor.vendor_id,
      sku: sku.sku,
      unit_price: unitPrice,
      currency: vendor.currency,
      valid_from: "2026-01-01",
      valid_to: "2026-12-31",
    });
  }
  return contracts;
}

// --- FX ---

interface BocFile {
  observations?: Array<{
    d: string;
    FXUSDCAD?: { v: string };
  }>;
}

function loadFxSeries(raw: BocFile): { dates: string[]; rates: Map<string, number> } {
  const rates = new Map<string, number>();
  const dates: string[] = [];
  for (const obs of raw.observations ?? []) {
    const v = obs.FXUSDCAD?.v;
    if (!v) continue;
    const rate = Number(v);
    if (!Number.isFinite(rate)) continue;
    rates.set(obs.d, rate);
    dates.push(obs.d);
  }
  dates.sort();
  return { dates, rates };
}

/** Rate on date, or previous available business-day observation. */
function fxOnOrBefore(
  date: string,
  dates: string[],
  rates: Map<string, number>,
): number {
  if (rates.has(date)) return rates.get(date)!;
  let lo = 0;
  let hi = dates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) {
    throw new Error(`No BoC FX observation on or before ${date}`);
  }
  return rates.get(dates[best]!)!;
}

// --- Row types ---

interface OrderRow {
  order_id: string;
  customer_id: string;
  order_date: string;
  period: string;
}

interface OrderLineRow {
  order_id: string;
  line_no: number;
  sku: string;
  qty: number;
  unit_price_cad: number;
  amount_cad: number;
}

interface ApInvoice {
  ap_doc_id: string;
  vendor_id: string;
  vendor_invoice_no: string;
  invoice_date: string;
  currency: "CAD" | "USD";
  total_amount: number;
  status: string;
}

interface ApLine {
  ap_doc_id: string;
  line_no: number;
  sku: string;
  qty: number;
  unit_price: number;
  amount: number;
}

interface GlLine {
  line_id: string;
  journal_id: string;
  posting_date: string;
  period: string;
  account_code: string;
  amount_cad: number;
  source_system: string;
  source_doc_id: string;
  memo: string;
}

interface BankTxn {
  txn_id: string;
  account: string;
  booking_date: string;
  amount_cad: number;
  amount_orig: number;
  currency_orig: string;
  counterparty: string;
  reference: string;
  period: string;
}

interface SkuMonthCost {
  unitCostCad: number;
  unitPriceOrig: number;
  currency: "CAD" | "USD";
  fxRate: number;
  contractUnitPrice: number;
}

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const contracts = buildContracts();
  const contractBySku = new Map(contracts.map((c) => [c.sku, c]));
  const customerById = new Map(CUSTOMERS.map((c) => [c.customer_id, c]));
  const vendorById = new Map(VENDORS.map((v) => [v.vendor_id, v]));

  const fxPath = path.join(root, "data", "public", "boc_fxusdcad_2026.json");
  const boc = JSON.parse(await readFile(fxPath, "utf8")) as BocFile;
  const { dates: fxDates, rates: fxRates } = loadFxSeries(boc);
  if (fxDates.length === 0) {
    throw new Error("No FX observations loaded; run npm run fetch-fx first");
  }

  const orders: OrderRow[] = [];
  const orderLines: OrderLineRow[] = [];
  const apInvoices: ApInvoice[] = [];
  const apLines: ApLine[] = [];
  const glLines: GlLine[] = [];
  const bankTxns: BankTxn[] = [];

  let orderSeq = 1;
  let apSeq = 1;
  let glSeq = 1;
  let bankSeq = 1;
  let journalSeq = 1;

  /** Track CUST-W01 total qty by month for mix-shift planting. */
  const w01QtyByMonth = new Map<string, number>();

  function unitPriceFor(customer: Customer, sku: Sku): number {
    return customer.channel === "wholesale"
      ? sku.wholesalePriceCad
      : sku.listPriceCad;
  }

  function noiseFactor(): number {
    // ±4%
    return 1 + randBetween(rng, -0.04, 0.04);
  }

  // --- Orders ---
  // Channel mix: retail-heavy so blended GM% at 0.60×list cost lands ~33–36% after
  // packaging; W01 stays large enough that a 2.2× September spike drives mix.
  for (const period of MONTHS) {
    for (const customer of CUSTOMERS) {
      const isW01 = customer.customer_id === "CUST-W01";
      const nOrders =
        customer.channel === "wholesale"
          ? isW01
            ? 3
            : 2
          : randInt(rng, 5, 6);
      let monthQty = 0;

      for (let o = 0; o < nOrders; o++) {
        const day = randInt(rng, 2, Math.min(27, daysInMonth(period)));
        const orderDate = dateInMonth(period, day);
        const orderId = `ORD-${period.replace("-", "")}-${String(orderSeq++).padStart(5, "0")}`;
        orders.push({
          order_id: orderId,
          customer_id: customer.customer_id,
          order_date: orderDate,
          period,
        });

        const nLines =
          customer.channel === "wholesale"
            ? randInt(rng, 5, 7)
            : randInt(rng, 5, 7);
        const skus = pickN(rng, SKUS, nLines);
        let lineNo = 1;
        for (const sku of skus) {
          let qty: number;
          if (customer.channel === "wholesale") {
            // W01: meaningful baseline; W02/W03: small (low-margin channel stays minority)
            const base = isW01 ? randInt(rng, 45, 75) : randInt(rng, 12, 28);
            qty = Math.max(1, Math.round(base * noiseFactor()));
            if (isW01 && period === "2026-09") {
              // Placeholder; scaled after Apr–Aug average known
              qty = Math.max(1, Math.round(base * noiseFactor()));
            }
          } else {
            qty = Math.max(1, Math.round(randInt(rng, 12, 32) * noiseFactor()));
          }
          const price = unitPriceFor(customer, sku);
          const amount = round2(qty * price);
          orderLines.push({
            order_id: orderId,
            line_no: lineNo++,
            sku: sku.sku,
            qty,
            unit_price_cad: price,
            amount_cad: amount,
          });
          monthQty += qty;
        }
      }
      if (isW01) w01QtyByMonth.set(period, monthQty);
    }
  }

  // Scale CUST-W01 September volume to ~2.2× Apr–Aug average
  const priorMonths = MONTHS.filter((m) => m !== "2026-09");
  const priorAvg =
    priorMonths.reduce((s, m) => s + (w01QtyByMonth.get(m) ?? 0), 0) /
    priorMonths.length;
  const targetSep = Math.round(priorAvg * 2.2);
  const currentSep = w01QtyByMonth.get("2026-09") ?? 0;
  const scale = currentSep > 0 ? targetSep / currentSep : 1;

  const w01OrderIds = new Set(
    orders
      .filter((o) => o.customer_id === "CUST-W01" && o.period === "2026-09")
      .map((o) => o.order_id),
  );
  for (const line of orderLines) {
    if (!w01OrderIds.has(line.order_id)) continue;
    line.qty = Math.max(1, Math.round(line.qty * scale));
    line.amount_cad = round2(line.qty * line.unit_price_cad);
  }
  w01QtyByMonth.set(
    "2026-09",
    orderLines
      .filter((l) => w01OrderIds.has(l.order_id))
      .reduce((s, l) => s + l.qty, 0),
  );

  // --- Sales qty by period × sku ---
  const salesQty = new Map<string, number>(); // period||sku -> qty
  for (const order of orders) {
    for (const line of orderLines) {
      if (line.order_id !== order.order_id) continue;
      const key = `${order.period}||${line.sku}`;
      salesQty.set(key, (salesQty.get(key) ?? 0) + line.qty);
    }
  }

  // Index order lines by order for faster GL posting
  const linesByOrder = new Map<string, OrderLineRow[]>();
  for (const line of orderLines) {
    const arr = linesByOrder.get(line.order_id) ?? [];
    arr.push(line);
    linesByOrder.set(line.order_id, arr);
  }

  const costByPeriodSku = new Map<string, SkuMonthCost>();
  const packagingByPeriod = new Map<string, number>();
  const bookingErrorByPeriod = new Map<string, number>();
  for (const m of MONTHS) {
    packagingByPeriod.set(m, 0);
    bookingErrorByPeriod.set(m, 0);
  }

  function postGl(args: Omit<GlLine, "line_id">): void {
    glLines.push({
      line_id: `GL-${String(glSeq++).padStart(6, "0")}`,
      ...args,
    });
  }

  function addBank(args: Omit<BankTxn, "txn_id">): void {
    bankTxns.push({
      txn_id: `BNK-${String(bankSeq++).padStart(5, "0")}`,
      ...args,
    });
  }

  function createApPayment(
    inv: ApInvoice,
    amountCad: number,
    amountOrig: number,
    payDayOffset = 10,
  ): void {
    const vendor = vendorById.get(inv.vendor_id)!;
    const invDay = Number(inv.invoice_date.slice(8, 10));
    const period = periodFromDate(inv.invoice_date);
    const payDate = dateInMonth(
      period,
      Math.min(daysInMonth(period), invDay + payDayOffset),
    );
    addBank({
      account: "1000",
      booking_date: payDate,
      amount_cad: round2(-Math.abs(amountCad)),
      amount_orig: round2(-Math.abs(amountOrig)),
      currency_orig: inv.currency,
      counterparty: vendor.name,
      reference: inv.vendor_invoice_no,
      period: periodFromDate(payDate),
    });
  }

  // --- AP goods invoices (bought in month sold) ---
  for (const period of MONTHS) {
    const invoiceDate = dateInMonth(period, 15);
    const fx = fxOnOrBefore(invoiceDate, fxDates, fxRates);

    const byVendor = new Map<string, Array<{ sku: string; qty: number }>>();
    for (const sku of SKUS) {
      const qty = salesQty.get(`${period}||${sku.sku}`) ?? 0;
      if (qty <= 0) continue;
      const contract = contractBySku.get(sku.sku);
      if (!contract) continue;
      const arr = byVendor.get(contract.vendor_id) ?? [];
      arr.push({ sku: sku.sku, qty });
      byVendor.set(contract.vendor_id, arr);
    }

    for (const [vendorId, items] of byVendor) {
      const vendor = vendorById.get(vendorId)!;
      const apDocId = `AP-${String(apSeq++).padStart(5, "0")}`;
      const vendorInvoiceNo = `${vendor.vendor_id.replace("VEND-", "")}-${period.replace("-", "")}-01`;
      let totalOrig = 0;
      let lineNo = 1;
      const lines: ApLine[] = [];

      for (const item of items) {
        const contract = contractBySku.get(item.sku)!;
        let unitPrice = contract.unit_price;
        // Planted cause 1: Sierra Nut September at contract × 1.12
        if (
          period === "2026-09" &&
          vendorId === "VEND-SNC" &&
          contract.currency === "USD"
        ) {
          unitPrice = round2(contract.unit_price * 1.12);
        }
        const amount = round2(item.qty * unitPrice);
        totalOrig = round2(totalOrig + amount);
        lines.push({
          ap_doc_id: apDocId,
          line_no: lineNo++,
          sku: item.sku,
          qty: item.qty,
          unit_price: unitPrice,
          amount,
        });

        const unitCostCad =
          vendor.currency === "USD" ? round4(unitPrice * fx) : unitPrice;
        costByPeriodSku.set(`${period}||${item.sku}`, {
          unitCostCad,
          unitPriceOrig: unitPrice,
          currency: vendor.currency,
          fxRate: vendor.currency === "USD" ? fx : 1,
          contractUnitPrice: contract.unit_price,
        });
      }

      apInvoices.push({
        ap_doc_id: apDocId,
        vendor_id: vendorId,
        vendor_invoice_no: vendorInvoiceNo,
        invoice_date: invoiceDate,
        currency: vendor.currency,
        total_amount: totalOrig,
        status: "posted",
      });
      apLines.push(...lines);

      const totalCad =
        vendor.currency === "USD" ? round2(totalOrig * fx) : totalOrig;

      // GL COGS goods (5000)
      postGl({
        journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
        posting_date: invoiceDate,
        period,
        account_code: "5000",
        amount_cad: totalCad,
        source_system: "procure",
        source_doc_id: apDocId,
        memo: `COGS goods ${vendorInvoiceNo}`,
      });

      createApPayment(apInvoices[apInvoices.length - 1]!, totalCad, totalOrig);
    }

    // Packaging AP — stable monthly spend (~CAD 12k ±4%); volume does not drive it.
    // September: the regular invoice IS MRP-88213 (CAD 12,450) — entered twice in AP/GL,
    // bank pays once. No separate generic packaging invoice that month.
    if (period === "2026-09") {
      const dupAmount = 12450.0;
      const dupInvNo = "MRP-88213";
      const dupDate = dateInMonth(period, 15);
      for (let copy = 1; copy <= 2; copy++) {
        const dupDocId = `AP-${String(apSeq++).padStart(5, "0")}`;
        apInvoices.push({
          ap_doc_id: dupDocId,
          vendor_id: "VEND-MRP",
          vendor_invoice_no: dupInvNo,
          invoice_date: dupDate,
          currency: "CAD",
          total_amount: dupAmount,
          status: "posted",
        });
        apLines.push({
          ap_doc_id: dupDocId,
          line_no: 1,
          sku: "PKG",
          qty: 1,
          unit_price: dupAmount,
          amount: dupAmount,
        });
        packagingByPeriod.set(
          period,
          round2((packagingByPeriod.get(period) ?? 0) + dupAmount),
        );
        postGl({
          journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
          posting_date: dupDate,
          period,
          account_code: "5100",
          amount_cad: dupAmount,
          source_system: "procure",
          source_doc_id: dupDocId,
          memo: `Packaging ${dupInvNo} (booking ${copy}/2)`,
        });
      }
      bookingErrorByPeriod.set(period, dupAmount);
      // Bank shows one payment only (real spend stays flat)
      addBank({
        account: "1000",
        booking_date: dateInMonth(period, 25),
        amount_cad: -dupAmount,
        amount_orig: -dupAmount,
        currency_orig: "CAD",
        counterparty: "Maple Ridge Packaging",
        reference: dupInvNo,
        period,
      });
    } else {
      const pkgAmount = round2(12000 * noiseFactor());
      const pkgDocId = `AP-${String(apSeq++).padStart(5, "0")}`;
      const pkgInvNo = `MRP-${period.replace("-", "")}-PKG`;
      apInvoices.push({
        ap_doc_id: pkgDocId,
        vendor_id: "VEND-MRP",
        vendor_invoice_no: pkgInvNo,
        invoice_date: invoiceDate,
        currency: "CAD",
        total_amount: pkgAmount,
        status: "posted",
      });
      apLines.push({
        ap_doc_id: pkgDocId,
        line_no: 1,
        sku: "PKG",
        qty: 1,
        unit_price: pkgAmount,
        amount: pkgAmount,
      });
      packagingByPeriod.set(
        period,
        round2((packagingByPeriod.get(period) ?? 0) + pkgAmount),
      );
      postGl({
        journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
        posting_date: invoiceDate,
        period,
        account_code: "5100",
        amount_cad: pkgAmount,
        source_system: "procure",
        source_doc_id: pkgDocId,
        memo: `Packaging ${pkgInvNo}`,
      });
      createApPayment(
        apInvoices[apInvoices.length - 1]!,
        pkgAmount,
        pkgAmount,
      );
    }

    // Planted cause 5: marketing opex red herring
    if (period === "2026-09") {
      postGl({
        journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
        posting_date: dateInMonth(period, 20),
        period,
        account_code: "6100",
        amount_cad: 42000,
        source_system: "erp",
        source_doc_id: "MKT-SEP-2026",
        memo: "September marketing campaign",
      });
      addBank({
        account: "1000",
        booking_date: dateInMonth(period, 22),
        amount_cad: -42000,
        amount_orig: -42000,
        currency_orig: "CAD",
        counterparty: "Northbound Marketing Agency",
        reference: "MKT-SEP-2026",
        period,
      });
    } else {
      // Stable small marketing spend
      const mkt = round2(8000 * noiseFactor());
      postGl({
        journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
        posting_date: dateInMonth(period, 20),
        period,
        account_code: "6100",
        amount_cad: mkt,
        source_system: "erp",
        source_doc_id: `MKT-${period}`,
        memo: "Monthly marketing",
      });
    }
  }

  // --- GL revenue from orders ---
  for (const order of orders) {
    const lines = linesByOrder.get(order.order_id) ?? [];
    const revenue = round2(lines.reduce((s, l) => s + l.amount_cad, 0));
    if (revenue === 0) continue;
    postGl({
      journal_id: `J-${String(journalSeq++).padStart(5, "0")}`,
      posting_date: order.order_date,
      period: order.period,
      account_code: "4000",
      amount_cad: -revenue, // credit revenue
      source_system: "orders",
      source_doc_id: order.order_id,
      memo: `Revenue ${order.order_id}`,
    });
  }

  // --- Bridge inputs per period ---
  function periodInput(period: string): PeriodInput {
    const agg = new Map<
      string,
      { qty: number; revenue: number; sku: string; channel: string }
    >();
    for (const order of orders) {
      if (order.period !== period) continue;
      const customer = customerById.get(order.customer_id)!;
      for (const line of linesByOrder.get(order.order_id) ?? []) {
        const key = `${line.sku}||${customer.channel}`;
        const cur = agg.get(key) ?? {
          qty: 0,
          revenue: 0,
          sku: line.sku,
          channel: customer.channel,
        };
        cur.qty += line.qty;
        cur.revenue = round2(cur.revenue + line.amount_cad);
        agg.set(key, cur);
      }
    }
    const cells: PeriodCell[] = [];
    for (const cur of agg.values()) {
      const cost = costByPeriodSku.get(`${period}||${cur.sku}`);
      if (!cost) {
        throw new Error(`Missing cost for ${period} ${cur.sku}`);
      }
      const cell: PeriodCell = {
        sku: cur.sku,
        channel: cur.channel,
        qty: cur.qty,
        unitPriceCad: cur.qty === 0 ? 0 : round4(cur.revenue / cur.qty),
        unitCostCad: cost.unitCostCad,
      };
      if (cost.currency === "USD") {
        cell.isUsd = true;
        cell.unitPriceUsd = cost.unitPriceOrig;
        cell.fxRate = cost.fxRate;
        cell.contractUnitPriceUsd = cost.contractUnitPrice;
      }
      cells.push(cell);
    }
    return {
      cells,
      packagingCad: packagingByPeriod.get(period) ?? 0,
      bookingErrorPkgCad: bookingErrorByPeriod.get(period) ?? 0,
    };
  }

  const periodInputs = new Map(MONTHS.map((m) => [m, periodInput(m)]));
  const gmByMonth: Record<string, { revenue: number; gm: number; gmPct: number }> =
    {};
  for (const m of MONTHS) {
    const t = periodTotals(periodInputs.get(m)!);
    gmByMonth[m] = {
      revenue: round2(t.revenue),
      gm: round2(t.gm),
      gmPct: round4(t.gmPct),
    };
  }

  const bridge = computeMarginBridge(
    periodInputs.get("2026-08")!,
    periodInputs.get("2026-09")!,
  );

  const groundTruth = {
    company: "Northbound Pantry Co. (synthetic)",
    question: "Why did gross margin fall in September vs August?",
    periodA: "2026-08",
    periodB: "2026-09",
    seed: SEED,
    fxAttribution: "Bank of Canada Valet API (FXUSDCAD)",
    gmByMonth,
    bridge: {
      gmA: round2(bridge.gmA),
      gmB: round2(bridge.gmB),
      revenueA: round2(bridge.revenueA),
      revenueB: round2(bridge.revenueB),
      gmPctA: round4(bridge.gmPctA),
      gmPctB: round4(bridge.gmPctB),
      deltaGm: round2(bridge.deltaGm),
      volume: round2(bridge.volume),
      mix: round2(bridge.mix),
      price: round2(bridge.price),
      goodsCost: round2(bridge.goodsCost),
      fx: round2(bridge.fx),
      supplierPrice: round2(bridge.supplierPrice),
      overContract: round2(bridge.overContract),
      otherCost: round2(bridge.otherCost),
      packaging: round2(bridge.packaging),
      bookingError: round2(bridge.bookingError),
      packagingReal: round2(bridge.packagingReal),
      residual: round2(bridge.residual),
      componentsPpOfBRevenue: Object.fromEntries(
        Object.entries(bridge.componentsPpOfBRevenue).map(([k, v]) => [
          k,
          round4(v),
        ]),
      ),
    },
    plantedCauses: [
      {
        id: "supplier_price_above_contract",
        vendor: "VEND-SNC",
        description:
          "Sierra Nut Co. invoices all September nut SKUs at contract × 1.12",
      },
      {
        id: "fx",
        description:
          "USD invoices convert at real BoC FXUSDCAD on invoice date",
      },
      {
        id: "duplicate_invoice",
        vendor_invoice_no: "MRP-88213",
        amount_cad: 12450,
        description:
          "September Maple Ridge Packaging invoice MRP-88213 (CAD 12,450) entered twice in AP/GL; bank pays once",
      },
      {
        id: "mix_shift",
        customer_id: "CUST-W01",
        description:
          "Capital Wholesale Grocers September volume ~2.2× Apr–Aug average",
        w01QtyByMonth: Object.fromEntries(w01QtyByMonth),
      },
      {
        id: "red_herring_opex",
        account_code: "6100",
        amount_cad: 42000,
        description:
          "Marketing campaign raises opex; not a gross-margin driver",
      },
    ],
    counts: {
      orders: orders.length,
      orderLines: orderLines.length,
      apInvoices: apInvoices.length,
      apLines: apLines.length,
      glLines: glLines.length,
      bankTxns: bankTxns.length,
    },
  };

  // --- Write outputs ---
  const genDir = path.join(root, "data", "generated");
  const ordersDir = path.join(genDir, "orders");
  const bankDir = path.join(genDir, "bank");
  const evalDir = path.join(root, "eval");
  await mkdir(ordersDir, { recursive: true });
  await mkdir(bankDir, { recursive: true });
  await mkdir(evalDir, { recursive: true });

  // products / customers CSV
  const productsCsv = [
    "sku,name,category,list_price_cad,wholesale_price_cad",
    ...SKUS.map(
      (s) =>
        `${s.sku},${csvEscape(s.name)},${s.category},${s.listPriceCad},${s.wholesalePriceCad}`,
    ),
  ].join("\n");
  const customersCsv = [
    "customer_id,name,channel",
    ...CUSTOMERS.map(
      (c) => `${c.customer_id},${csvEscape(c.name)},${c.channel}`,
    ),
  ].join("\n");
  const ordersCsv = [
    "order_id,customer_id,order_date,period",
    ...orders.map(
      (o) => `${o.order_id},${o.customer_id},${o.order_date},${o.period}`,
    ),
  ].join("\n");
  const orderLinesCsv = [
    "order_id,line_no,sku,qty,unit_price_cad,amount_cad",
    ...orderLines.map(
      (l) =>
        `${l.order_id},${l.line_no},${l.sku},${l.qty},${l.unit_price_cad},${l.amount_cad}`,
    ),
  ].join("\n");

  await writeFile(path.join(ordersDir, "products.csv"), productsCsv + "\n");
  await writeFile(path.join(ordersDir, "customers.csv"), customersCsv + "\n");
  await writeFile(path.join(ordersDir, "orders.csv"), ordersCsv + "\n");
  await writeFile(path.join(ordersDir, "order_lines.csv"), orderLinesCsv + "\n");

  await writeFile(
    path.join(bankDir, "transactions.json"),
    JSON.stringify(bankTxns, null, 2) + "\n",
  );
  await writeFile(
    path.join(evalDir, "ground_truth.json"),
    JSON.stringify(groundTruth, null, 2) + "\n",
  );

  // procure.sql
  const procureSql: string[] = [
    "-- Synthetic procure schema for Northbound Pantry Co.",
    "DROP TABLE IF EXISTS ap_invoice_line CASCADE;",
    "DROP TABLE IF EXISTS ap_invoice CASCADE;",
    "DROP TABLE IF EXISTS contract CASCADE;",
    "DROP TABLE IF EXISTS vendor CASCADE;",
    "",
    "CREATE TABLE vendor (",
    "  vendor_id TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  currency TEXT NOT NULL",
    ");",
    "",
    "CREATE TABLE contract (",
    "  contract_id TEXT PRIMARY KEY,",
    "  vendor_id TEXT NOT NULL REFERENCES vendor(vendor_id),",
    "  sku TEXT NOT NULL,",
    "  unit_price NUMERIC(12,4) NOT NULL,",
    "  currency TEXT NOT NULL,",
    "  valid_from DATE NOT NULL,",
    "  valid_to DATE NOT NULL",
    ");",
    "",
    "CREATE TABLE ap_invoice (",
    "  ap_doc_id TEXT PRIMARY KEY,",
    "  vendor_id TEXT NOT NULL REFERENCES vendor(vendor_id),",
    "  vendor_invoice_no TEXT NOT NULL,",
    "  invoice_date DATE NOT NULL,",
    "  currency TEXT NOT NULL,",
    "  total_amount NUMERIC(14,2) NOT NULL,",
    "  status TEXT NOT NULL",
    ");",
    "",
    "CREATE TABLE ap_invoice_line (",
    "  ap_doc_id TEXT NOT NULL REFERENCES ap_invoice(ap_doc_id),",
    "  line_no INT NOT NULL,",
    "  sku TEXT NOT NULL,",
    "  qty NUMERIC(14,2) NOT NULL,",
    "  unit_price NUMERIC(12,4) NOT NULL,",
    "  amount NUMERIC(14,2) NOT NULL,",
    "  PRIMARY KEY (ap_doc_id, line_no)",
    ");",
    "",
  ];
  for (const v of VENDORS) {
    procureSql.push(
      `INSERT INTO vendor (vendor_id, name, currency) VALUES (${sqlStr(v.vendor_id)}, ${sqlStr(v.name)}, ${sqlStr(v.currency)});`,
    );
  }
  procureSql.push("");
  for (const c of contracts) {
    procureSql.push(
      `INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES (${sqlStr(c.contract_id)}, ${sqlStr(c.vendor_id)}, ${sqlStr(c.sku)}, ${c.unit_price}, ${sqlStr(c.currency)}, ${sqlStr(c.valid_from)}, ${sqlStr(c.valid_to)});`,
    );
  }
  procureSql.push("");
  for (const inv of apInvoices) {
    procureSql.push(
      `INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES (${sqlStr(inv.ap_doc_id)}, ${sqlStr(inv.vendor_id)}, ${sqlStr(inv.vendor_invoice_no)}, ${sqlStr(inv.invoice_date)}, ${sqlStr(inv.currency)}, ${inv.total_amount}, ${sqlStr(inv.status)});`,
    );
  }
  procureSql.push("");
  for (const line of apLines) {
    procureSql.push(
      `INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES (${sqlStr(line.ap_doc_id)}, ${line.line_no}, ${sqlStr(line.sku)}, ${line.qty}, ${line.unit_price}, ${line.amount});`,
    );
  }
  await writeFile(path.join(genDir, "procure.sql"), procureSql.join("\n") + "\n");

  // erp.sql
  const erpSql: string[] = [
    "-- Synthetic ERP GL schema for Northbound Pantry Co.",
    "DROP TABLE IF EXISTS gl_journal_line CASCADE;",
    "DROP TABLE IF EXISTS gl_account CASCADE;",
    "",
    "CREATE TABLE gl_account (",
    "  account_code TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  type TEXT NOT NULL CHECK (type IN ('revenue','cogs','opex'))",
    ");",
    "",
    "CREATE TABLE gl_journal_line (",
    "  line_id TEXT PRIMARY KEY,",
    "  journal_id TEXT NOT NULL,",
    "  posting_date DATE NOT NULL,",
    "  period TEXT NOT NULL,",
    "  account_code TEXT NOT NULL REFERENCES gl_account(account_code),",
    "  amount_cad NUMERIC(14,2) NOT NULL,",
    "  source_system TEXT NOT NULL,",
    "  source_doc_id TEXT NOT NULL,",
    "  memo TEXT",
    ");",
    "",
    `INSERT INTO gl_account (account_code, name, type) VALUES ('4000', 'Product revenue', 'revenue');`,
    `INSERT INTO gl_account (account_code, name, type) VALUES ('5000', 'Cost of goods sold', 'cogs');`,
    `INSERT INTO gl_account (account_code, name, type) VALUES ('5100', 'Packaging and supplies', 'cogs');`,
    `INSERT INTO gl_account (account_code, name, type) VALUES ('6100', 'Marketing expense', 'opex');`,
    "",
  ];
  for (const line of glLines) {
    erpSql.push(
      `INSERT INTO gl_journal_line (line_id, journal_id, posting_date, period, account_code, amount_cad, source_system, source_doc_id, memo) VALUES (${sqlStr(line.line_id)}, ${sqlStr(line.journal_id)}, ${sqlStr(line.posting_date)}, ${sqlStr(line.period)}, ${sqlStr(line.account_code)}, ${line.amount_cad}, ${sqlStr(line.source_system)}, ${sqlStr(line.source_doc_id)}, ${sqlStr(line.memo)});`,
    );
  }
  await writeFile(path.join(genDir, "erp.sql"), erpSql.join("\n") + "\n");

  // Summary
  console.log("=== Northbound Pantry Co. synthetic data (seed %s) ===", SEED);
  console.log(
    "Counts: orders=%d order_lines=%d ap_invoices=%d gl_lines=%d bank_txns=%d",
    orders.length,
    orderLines.length,
    apInvoices.length,
    glLines.length,
    bankTxns.length,
  );
  console.log("\nGM% by month:");
  for (const m of MONTHS) {
    const g = gmByMonth[m]!;
    console.log(
      `  ${m}: revenue=${g.revenue.toFixed(2)} GM=${g.gm.toFixed(2)} GM%=${(g.gmPct * 100).toFixed(2)}%`,
    );
  }
  const deltaGm = bridge.deltaGm;
  const share = (v: number): string =>
    deltaGm === 0
      ? "n/a"
      : `${((v / deltaGm) * 100).toFixed(1)}% of ΔGM`;
  console.log("\nSeptember vs August bridge components (CAD | share of ΔGM):");
  console.log(`  ΔGM:            ${bridge.deltaGm.toFixed(2)}`);
  console.log(`  volume:         ${bridge.volume.toFixed(2)}  (${share(bridge.volume)})`);
  console.log(`  mix:            ${bridge.mix.toFixed(2)}  (${share(bridge.mix)})`);
  console.log(`  price:          ${bridge.price.toFixed(2)}  (${share(bridge.price)})`);
  console.log(`  goodsCost:      ${bridge.goodsCost.toFixed(2)}  (${share(bridge.goodsCost)})`);
  console.log(`    fx:           ${bridge.fx.toFixed(2)}  (${share(bridge.fx)})`);
  console.log(`    supplierPrice:${bridge.supplierPrice.toFixed(2)}  (${share(bridge.supplierPrice)})`);
  console.log(`    overContract: ${bridge.overContract.toFixed(2)} (info)`);
  console.log(`    otherCost:    ${bridge.otherCost.toFixed(2)}  (${share(bridge.otherCost)})`);
  console.log(`  packaging:      ${bridge.packaging.toFixed(2)}  (${share(bridge.packaging)})`);
  console.log(`    bookingError: ${bridge.bookingError.toFixed(2)}  (${share(bridge.bookingError)})`);
  console.log(`    packagingReal:${bridge.packagingReal.toFixed(2)}  (${share(bridge.packagingReal)})`);
  console.log(`  residual:       ${bridge.residual.toFixed(2)}  (${share(bridge.residual)})`);
  console.log(
    `\nW01 qty Apr–Aug avg=${priorAvg.toFixed(0)} Sep=${w01QtyByMonth.get("2026-09")} (target ~${targetSep})`,
  );
  console.log("FX attribution: Bank of Canada Valet API.");
  console.log("Wrote data/generated/*, eval/ground_truth.json");
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
