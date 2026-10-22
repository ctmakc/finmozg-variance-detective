-- Verification queries for finance_usl. Separated by "-- @@".
SELECT 'vendor' AS t, COUNT(*) AS n FROM lightning.metastore.finmozg.finance_usl.vendor
UNION ALL SELECT 'vendor_bill', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.vendor_bill
UNION ALL SELECT 'vendor_payment', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.vendor_payment
UNION ALL SELECT 'product', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.product
UNION ALL SELECT 'customer', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.customer
UNION ALL SELECT 'sales_line', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.sales_line
UNION ALL SELECT 'purchase_line', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.purchase_line
UNION ALL SELECT 'gl_balance', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.gl_balance
UNION ALL SELECT 'fx_rate', COUNT(*) FROM lightning.metastore.finmozg.finance_usl.fx_rate
-- @@
SHOW DQ ALL INVALID TABLE lightning.metastore.finmozg.finance_usl.vendor_bill
-- @@
SELECT p.txn_id, p.vendor_invoice_no, p.counterparty, p.amount_cad
FROM lightning.metastore.finmozg.finance_usl.vendor_payment p
LEFT JOIN lightning.metastore.finmozg.finance_usl.vendor_bill b ON b.vendor_invoice_no = p.vendor_invoice_no
WHERE b.vendor_invoice_no IS NULL
-- @@
SELECT b.vendor_invoice_no, COUNT(DISTINCT b.ap_doc_id) AS ap_docs, SUM(b.amount_cad) AS booked_cad, MAX(p.n) AS bank_payments
FROM lightning.metastore.finmozg.finance_usl.vendor_bill b
LEFT JOIN (SELECT vendor_invoice_no, COUNT(*) AS n FROM lightning.metastore.finmozg.finance_usl.vendor_payment GROUP BY vendor_invoice_no) p
  ON p.vendor_invoice_no = b.vendor_invoice_no
WHERE b.period = '2026-09'
GROUP BY b.vendor_invoice_no ORDER BY ap_docs DESC
-- @@
SELECT period, account_type, ROUND(SUM(amount_cad), 2) AS amount_cad
FROM lightning.metastore.finmozg.finance_usl.gl_balance
WHERE period IN ('2026-08', '2026-09') GROUP BY period, account_type ORDER BY period, account_type
