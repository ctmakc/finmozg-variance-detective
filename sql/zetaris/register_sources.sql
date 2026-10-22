-- Registers the five sources in Zetaris. Statements are separated by "-- @@" lines and sent one at a time
-- by scripts/zetaris-register.ts. ${PG_USER} and ${PG_PASSWORD} are filled from the environment.
-- "already exists" is treated as reuse.

CREATE DATASOURCE FM_ERP DESCRIBE BY "General ledger, synthetic" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://erp-db:5432/finmozg", username "${PG_USER}", password "${PG_PASSWORD}", fetchsize "1000")
-- @@
REGISTER DATASOURCE TABLES FROM FM_ERP
-- @@
CREATE DATASOURCE FM_PROCURE DESCRIBE BY "Procurement and AP, synthetic" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://procure-db:5432/finmozg", username "${PG_USER}", password "${PG_PASSWORD}", fetchsize "1000")
-- @@
REGISTER DATASOURCE TABLES FROM FM_PROCURE
-- @@
CREATE LIGHTNING DATABASE FM_ORDERS DESCRIBE BY "Order system export, synthetic"
-- @@
CREATE LIGHTNING FILESTORE TABLE orders FROM FM_ORDERS FORMAT CSV OPTIONS (path "/home/zetaris/customer-data/shared/finmozg/orders.csv", header "true", inferSchema "true")
-- @@
CREATE LIGHTNING FILESTORE TABLE order_lines FROM FM_ORDERS FORMAT CSV OPTIONS (path "/home/zetaris/customer-data/shared/finmozg/order_lines.csv", header "true", inferSchema "true")
-- @@
CREATE LIGHTNING FILESTORE TABLE products FROM FM_ORDERS FORMAT CSV OPTIONS (path "/home/zetaris/customer-data/shared/finmozg/products.csv", header "true", inferSchema "true")
-- @@
CREATE LIGHTNING FILESTORE TABLE customers FROM FM_ORDERS FORMAT CSV OPTIONS (path "/home/zetaris/customer-data/shared/finmozg/customers.csv", header "true", inferSchema "true")
-- @@
CREATE LIGHTNING DATABASE FM_BANK DESCRIBE BY "Bank feed REST service, synthetic"
-- @@
CREATE LIGHTNING REST TABLE transactions FROM FM_BANK REQUEST(endpoint "http://bankfeed:8080/transactions", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()
-- @@
CREATE LIGHTNING DATABASE FM_BOC DESCRIBE BY "Bank of Canada Valet FX, public"
-- @@
CREATE LIGHTNING REST TABLE fxusdcad_raw FROM FM_BOC REQUEST(endpoint "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-03-25&end_date=2026-10-01", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()
