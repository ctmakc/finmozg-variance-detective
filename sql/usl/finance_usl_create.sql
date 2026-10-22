-- finance_usl: Unified Semantic Layer for Northbound Pantry Co. (synthetic data).
-- One business view over four systems that share no keys: GL (FM_ERP, JDBC), procurement/AP (FM_PROCURE, JDBC),
-- order export (FM_ORDERS, CSV file store), bank feed (FM_BANK, REST) plus live Bank of Canada FX (FM_BOC, REST).
-- Statements are separated by "-- @@" lines; scripts/zetaris-usl.ts sends them one at a time.
-- Lifecycle per docs/reference/zetaris-usl-howto.md: namespace, COMPILE, describe, ACTIVATE, RUN DQ.

CREATE NAMESPACE IF NOT EXISTS lightning.metastore
-- @@
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.finmozg
-- @@
COMPILE USL IF NOT EXISTS finance_usl DEPLOY NAMESPACE lightning.metastore.finmozg DDL
CREATE TABLE vendor (
    vendor_id varchar(20) NOT NULL PRIMARY KEY,
    vendor_name varchar(100),
    currency varchar(3)
);
CREATE TABLE vendor_bill (
    vendor_invoice_no varchar(40) NOT NULL PRIMARY KEY,
    vendor_id varchar(20) NOT NULL FOREIGN KEY REFERENCES vendor(vendor_id),
    ap_doc_id varchar(20),
    invoice_date varchar(10),
    period varchar(7),
    currency varchar(3),
    amount_orig double,
    fx_rate double,
    amount_cad double
);
CREATE TABLE vendor_payment (
    txn_id varchar(20) NOT NULL PRIMARY KEY,
    vendor_invoice_no varchar(40) NOT NULL FOREIGN KEY REFERENCES vendor_bill(vendor_invoice_no),
    booking_date varchar(10),
    period varchar(7),
    counterparty varchar(100),
    currency_orig varchar(3),
    amount_orig double,
    amount_cad double
);
CREATE TABLE product (
    sku varchar(20) NOT NULL PRIMARY KEY,
    product_name varchar(100),
    category varchar(30),
    list_price_cad double,
    wholesale_price_cad double
);
CREATE TABLE customer (
    customer_id varchar(20) NOT NULL PRIMARY KEY,
    customer_name varchar(100),
    channel varchar(20)
);
CREATE TABLE sales_line (
    sales_line_id varchar(40) NOT NULL PRIMARY KEY,
    order_id varchar(30),
    period varchar(7),
    customer_id varchar(20) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    sku varchar(20) NOT NULL FOREIGN KEY REFERENCES product(sku),
    qty double,
    unit_price_cad double,
    revenue_cad double
);
CREATE TABLE purchase_line (
    purchase_line_id varchar(40) NOT NULL PRIMARY KEY,
    ap_doc_id varchar(20),
    vendor_invoice_no varchar(40),
    vendor_id varchar(20) NOT NULL FOREIGN KEY REFERENCES vendor(vendor_id),
    period varchar(7),
    sku varchar(20),
    qty double,
    currency varchar(3),
    unit_price_orig double,
    contract_unit_price double,
    fx_rate double,
    unit_cost_cad double,
    amount_cad double
);
CREATE TABLE gl_balance (
    gl_key varchar(20) NOT NULL PRIMARY KEY,
    period varchar(7),
    account_code varchar(10),
    account_name varchar(100),
    account_type varchar(10),
    amount_cad double
);
CREATE TABLE fx_rate (
    rate_date varchar(10) NOT NULL PRIMARY KEY,
    usdcad double
);
-- @@
UPDATE USL lightning.metastore.finmozg.finance_usl SET DESCRIPTION 'Finance semantic layer for a fictional specialty food distributor. Joins general ledger, purchasing and AP, the order system export, the bank feed and Bank of Canada USD CAD rates into one business view used to explain gross margin changes.'
-- @@
UPDATE USL lightning.metastore.finmozg.finance_usl.vendor_bill SET TABLE DESCRIPTION 'One row per vendor invoice number as booked in AP. The primary key is the vendor invoice number, so an invoice entered twice in AP shows up as a DQ violation.'
-- @@
UPDATE USL lightning.metastore.finmozg.finance_usl.vendor_payment SET TABLE DESCRIPTION 'Vendor payments from the bank feed, keyed to the vendor invoice number in the payment reference.'
-- @@
UPDATE USL lightning.metastore.finmozg.finance_usl.purchase_line SET TABLE DESCRIPTION 'AP invoice lines with the contracted unit price and the Bank of Canada rate on the invoice date, giving the landed unit cost in CAD.'
-- @@
UPDATE USL lightning.metastore.finmozg.finance_usl.gl_balance SET TABLE DESCRIPTION 'Monthly general ledger balance per account. Revenue is stored as a positive number; cogs and opex are positive costs.'
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.fx_rate AS
SELECT COALESCE(o.d, '') AS rate_date, CAST(o.FXUSDCAD.v AS DOUBLE) AS usdcad
FROM fm_boc.fxusdcad_raw LATERAL VIEW explode(observations) t AS o
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.vendor AS
SELECT vendor_id, name AS vendor_name, currency FROM fm_procure.vendor
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.vendor_bill AS
SELECT i.vendor_invoice_no, i.vendor_id, i.ap_doc_id,
       CAST(i.invoice_date AS STRING) AS invoice_date,
       substr(CAST(i.invoice_date AS STRING), 1, 7) AS period,
       i.currency,
       CAST(i.total_amount AS DOUBLE) AS amount_orig,
       CASE WHEN i.currency = 'USD' THEN fx.usdcad ELSE 1.0 END AS fx_rate,
       ROUND(CAST(i.total_amount AS DOUBLE) * CASE WHEN i.currency = 'USD' THEN fx.usdcad ELSE 1.0 END, 2) AS amount_cad
FROM fm_procure.ap_invoice i
LEFT JOIN (
    SELECT i2.ap_doc_id, MAX(o.d) AS rate_date
    FROM fm_procure.ap_invoice i2
    JOIN (SELECT o.d FROM fm_boc.fxusdcad_raw LATERAL VIEW explode(observations) t AS o) o
      ON o.d <= CAST(i2.invoice_date AS STRING)
    GROUP BY i2.ap_doc_id
) pick ON pick.ap_doc_id = i.ap_doc_id
LEFT JOIN (SELECT o.d AS rate_date, CAST(o.FXUSDCAD.v AS DOUBLE) AS usdcad FROM fm_boc.fxusdcad_raw LATERAL VIEW explode(observations) t AS o) fx
  ON fx.rate_date = pick.rate_date
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.vendor_payment AS
SELECT COALESCE(txn_id, '') AS txn_id, COALESCE(reference, '') AS vendor_invoice_no, booking_date, period, counterparty, currency_orig,
       CAST(amount_orig AS DOUBLE) * -1 AS amount_orig, CAST(amount_cad AS DOUBLE) * -1 AS amount_cad
FROM fm_bank.transactions
WHERE CAST(amount_cad AS DOUBLE) < 0 AND reference IS NOT NULL AND reference <> ''
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.product AS
SELECT COALESCE(sku, '') AS sku, name AS product_name, category, CAST(list_price_cad AS DOUBLE) AS list_price_cad,
       CAST(wholesale_price_cad AS DOUBLE) AS wholesale_price_cad
FROM fm_orders.products
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.customer AS
SELECT COALESCE(customer_id, '') AS customer_id, name AS customer_name, channel FROM fm_orders.customers
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.sales_line AS
SELECT COALESCE(concat(l.order_id, '-', CAST(l.line_no AS STRING)), '') AS sales_line_id, l.order_id,
       date_format(o.period, 'yyyy-MM') AS period, COALESCE(o.customer_id, '') AS customer_id, COALESCE(l.sku, '') AS sku,
       CAST(l.qty AS DOUBLE) AS qty, CAST(l.unit_price_cad AS DOUBLE) AS unit_price_cad,
       CAST(l.amount_cad AS DOUBLE) AS revenue_cad
FROM fm_orders.order_lines l JOIN fm_orders.orders o ON o.order_id = l.order_id
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.purchase_line AS
SELECT concat(l.ap_doc_id, '-', CAST(l.line_no AS STRING)) AS purchase_line_id, l.ap_doc_id, b.vendor_invoice_no,
       b.vendor_id, b.period, l.sku, CAST(l.qty AS DOUBLE) AS qty, b.currency,
       CAST(l.unit_price AS DOUBLE) AS unit_price_orig, CAST(c.unit_price AS DOUBLE) AS contract_unit_price,
       b.fx_rate, ROUND(CAST(l.unit_price AS DOUBLE) * b.fx_rate, 4) AS unit_cost_cad,
       ROUND(CAST(l.amount AS DOUBLE) * b.fx_rate, 2) AS amount_cad
FROM fm_procure.ap_invoice_line l
JOIN lightning.metastore.finmozg.finance_usl.vendor_bill b ON b.ap_doc_id = l.ap_doc_id
LEFT JOIN fm_procure.contract c ON c.vendor_id = b.vendor_id AND c.sku = l.sku
-- @@
ACTIVATE USL TABLE lightning.metastore.finmozg.finance_usl.gl_balance AS
SELECT concat(j.period, '-', j.account_code) AS gl_key, j.period, j.account_code, a.name AS account_name, a.type AS account_type,
       ROUND(SUM(CASE WHEN a.type = 'revenue' THEN -CAST(j.amount_cad AS DOUBLE) ELSE CAST(j.amount_cad AS DOUBLE) END), 2) AS amount_cad
FROM fm_erp.gl_journal_line j JOIN fm_erp.gl_account a ON a.account_code = j.account_code
GROUP BY j.period, j.account_code, a.name, a.type
-- @@
RUN DQ TABLE lightning.metastore.finmozg.finance_usl.vendor_bill
-- @@
RUN DQ TABLE lightning.metastore.finmozg.finance_usl.vendor_payment
-- @@
RUN DQ TABLE lightning.metastore.finmozg.finance_usl.sales_line
-- @@
RUN DQ TABLE lightning.metastore.finmozg.finance_usl.purchase_line
