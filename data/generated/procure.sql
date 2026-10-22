-- Synthetic procure schema for Northbound Pantry Co.
DROP TABLE IF EXISTS ap_invoice_line CASCADE;
DROP TABLE IF EXISTS ap_invoice CASCADE;
DROP TABLE IF EXISTS contract CASCADE;
DROP TABLE IF EXISTS vendor CASCADE;

CREATE TABLE vendor (
  vendor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE TABLE contract (
  contract_id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendor(vendor_id),
  sku TEXT NOT NULL,
  unit_price NUMERIC(12,4) NOT NULL,
  currency TEXT NOT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL
);

CREATE TABLE ap_invoice (
  ap_doc_id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendor(vendor_id),
  vendor_invoice_no TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  currency TEXT NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE ap_invoice_line (
  ap_doc_id TEXT NOT NULL REFERENCES ap_invoice(ap_doc_id),
  line_no INT NOT NULL,
  sku TEXT NOT NULL,
  qty NUMERIC(14,2) NOT NULL,
  unit_price NUMERIC(12,4) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (ap_doc_id, line_no)
);

INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-SNC', 'Sierra Nut Co.', 'USD');
INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-LOI', 'Lakeshore Olive Imports', 'USD');
INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-MRP', 'Maple Ridge Packaging', 'CAD');
INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-PRV', 'Prairie Preserve Co.', 'CAD');
INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-RCK', 'Rockies Coffee Roasters', 'CAD');
INSERT INTO vendor (vendor_id, name, currency) VALUES ('VEND-OTW', 'Ottawa Dry Goods', 'CAD');

INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-001', 'VEND-SNC', 'NUT-ALM', 11.96, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-002', 'VEND-SNC', 'NUT-PEC', 14.52, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-003', 'VEND-SNC', 'NUT-CAS', 13.66, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-004', 'VEND-LOI', 'OIL-EVO', 9.39, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-005', 'VEND-LOI', 'OIL-ORG', 11.1, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-006', 'VEND-LOI', 'OIL-FLT', 7.69, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-007', 'VEND-PRV', 'PRS-JAM', 7.02, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-008', 'VEND-PRV', 'PRS-HNY', 9.36, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-009', 'VEND-PRV', 'PRS-OLV', 8.19, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-010', 'VEND-RCK', 'COF-ETH', 14.04, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-011', 'VEND-RCK', 'COF-COL', 12.87, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-012', 'VEND-RCK', 'COF-SUM', 11.7, 'CAD', '2026-01-01', '2026-12-31');

INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00001', 'VEND-SNC', 'SNC-202604-01', '2026-04-15', 'USD', 45416.22, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00002', 'VEND-LOI', 'LOI-202604-01', '2026-04-15', 'USD', 33461.09, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00003', 'VEND-PRV', 'PRV-202604-01', '2026-04-15', 'CAD', 30965.22, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00004', 'VEND-RCK', 'RCK-202604-01', '2026-04-15', 'CAD', 44403.84, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00005', 'VEND-MRP', 'MRP-202604-PKG', '2026-04-15', 'CAD', 11902.15, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00006', 'VEND-SNC', 'SNC-202605-01', '2026-05-15', 'USD', 48333.22, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00007', 'VEND-LOI', 'LOI-202605-01', '2026-05-15', 'USD', 36624.14, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00008', 'VEND-PRV', 'PRV-202605-01', '2026-05-15', 'CAD', 29602.17, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00009', 'VEND-RCK', 'RCK-202605-01', '2026-05-15', 'CAD', 49099.05, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00010', 'VEND-MRP', 'MRP-202605-PKG', '2026-05-15', 'CAD', 11629.98, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00011', 'VEND-SNC', 'SNC-202606-01', '2026-06-15', 'USD', 49911.3, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00012', 'VEND-LOI', 'LOI-202606-01', '2026-06-15', 'USD', 31206.05, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00013', 'VEND-PRV', 'PRV-202606-01', '2026-06-15', 'CAD', 30412.98, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00014', 'VEND-RCK', 'RCK-202606-01', '2026-06-15', 'CAD', 49366.98, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00015', 'VEND-MRP', 'MRP-202606-PKG', '2026-06-15', 'CAD', 11978.53, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00016', 'VEND-SNC', 'SNC-202607-01', '2026-07-15', 'USD', 47697.12, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00017', 'VEND-LOI', 'LOI-202607-01', '2026-07-15', 'USD', 36962.74, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00018', 'VEND-PRV', 'PRV-202607-01', '2026-07-15', 'CAD', 31415.67, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00019', 'VEND-RCK', 'RCK-202607-01', '2026-07-15', 'CAD', 52390.26, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00020', 'VEND-MRP', 'MRP-202607-PKG', '2026-07-15', 'CAD', 12386.39, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00021', 'VEND-SNC', 'SNC-202608-01', '2026-08-15', 'USD', 50171.88, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00022', 'VEND-LOI', 'LOI-202608-01', '2026-08-15', 'USD', 34399.46, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00023', 'VEND-PRV', 'PRV-202608-01', '2026-08-15', 'CAD', 30214.08, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00024', 'VEND-RCK', 'RCK-202608-01', '2026-08-15', 'CAD', 45125.73, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00025', 'VEND-MRP', 'MRP-202608-PKG', '2026-08-15', 'CAD', 12051.26, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00026', 'VEND-SNC', 'SNC-202609-01', '2026-09-15', 'USD', 61289.02, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00027', 'VEND-LOI', 'LOI-202609-01', '2026-09-15', 'USD', 39995.4, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00028', 'VEND-PRV', 'PRV-202609-01', '2026-09-15', 'CAD', 36248.94, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00029', 'VEND-RCK', 'RCK-202609-01', '2026-09-15', 'CAD', 52550.55, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00030', 'VEND-MRP', 'MRP-88213', '2026-09-15', 'CAD', 12450, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00031', 'VEND-MRP', 'MRP-88213', '2026-09-15', 'CAD', 12450, 'posted');

INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 1, 'NUT-ALM', 1094, 11.96, 13084.24);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 2, 'NUT-PEC', 1031, 14.52, 14970.12);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 3, 'NUT-CAS', 1271, 13.66, 17361.86);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 1, 'OIL-EVO', 947, 9.39, 8892.33);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 2, 'OIL-ORG', 1310, 11.1, 14541);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 3, 'OIL-FLT', 1304, 7.69, 10027.76);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 1, 'PRS-JAM', 1191, 7.02, 8360.82);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 2, 'PRS-HNY', 1393, 9.36, 13038.48);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 3, 'PRS-OLV', 1168, 8.19, 9565.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 1, 'COF-ETH', 1047, 14.04, 14699.88);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 2, 'COF-COL', 1148, 12.87, 14774.76);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 3, 'COF-SUM', 1276, 11.7, 14929.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00005', 1, 'PKG', 1, 11902.15, 11902.15);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 1, 'NUT-ALM', 1284, 11.96, 15356.64);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 2, 'NUT-PEC', 1034, 14.52, 15013.68);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 3, 'NUT-CAS', 1315, 13.66, 17962.9);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 1, 'OIL-EVO', 1252, 9.39, 11756.28);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 2, 'OIL-ORG', 1524, 11.1, 16916.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 3, 'OIL-FLT', 1034, 7.69, 7951.46);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 1, 'PRS-JAM', 1246, 7.02, 8746.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 2, 'PRS-HNY', 1144, 9.36, 10707.84);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 3, 'PRS-OLV', 1239, 8.19, 10147.41);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 1, 'COF-ETH', 1196, 14.04, 16791.84);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 2, 'COF-COL', 1453, 12.87, 18700.11);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 3, 'COF-SUM', 1163, 11.7, 13607.1);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00010', 1, 'PKG', 1, 11629.98, 11629.98);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 1, 'NUT-ALM', 1453, 11.96, 17377.88);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 2, 'NUT-PEC', 1297, 14.52, 18832.44);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 3, 'NUT-CAS', 1003, 13.66, 13700.98);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 1, 'OIL-EVO', 1134, 9.39, 10648.26);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 2, 'OIL-ORG', 1117, 11.1, 12398.7);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 3, 'OIL-FLT', 1061, 7.69, 8159.09);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 1, 'PRS-JAM', 1227, 7.02, 8613.54);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 2, 'PRS-HNY', 1370, 9.36, 12823.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 3, 'PRS-OLV', 1096, 8.19, 8976.24);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 1, 'COF-ETH', 1398, 14.04, 19627.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 2, 'COF-COL', 1148, 12.87, 14774.76);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 3, 'COF-SUM', 1279, 11.7, 14964.3);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00015', 1, 'PKG', 1, 11978.53, 11978.53);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 1, 'NUT-ALM', 1357, 11.96, 16229.72);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 2, 'NUT-PEC', 1074, 14.52, 15594.48);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 3, 'NUT-CAS', 1162, 13.66, 15872.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 1, 'OIL-EVO', 1379, 9.39, 12948.81);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 2, 'OIL-ORG', 1348, 11.1, 14962.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 3, 'OIL-FLT', 1177, 7.69, 9051.13);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 1, 'PRS-JAM', 1216, 7.02, 8536.32);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 2, 'PRS-HNY', 1369, 9.36, 12813.84);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 3, 'PRS-OLV', 1229, 8.19, 10065.51);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 1, 'COF-ETH', 1371, 14.04, 19248.84);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 2, 'COF-COL', 1386, 12.87, 17837.82);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 3, 'COF-SUM', 1308, 11.7, 15303.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00020', 1, 'PKG', 1, 12386.39, 12386.39);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 1, 'NUT-ALM', 1045, 11.96, 12498.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 2, 'NUT-PEC', 1270, 14.52, 18440.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 3, 'NUT-CAS', 1408, 13.66, 19233.28);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 1, 'OIL-EVO', 1159, 9.39, 10883.01);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 2, 'OIL-ORG', 1263, 11.1, 14019.3);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 3, 'OIL-FLT', 1235, 7.69, 9497.15);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 1, 'PRS-JAM', 1039, 7.02, 7293.78);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 2, 'PRS-HNY', 1187, 9.36, 11110.32);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 3, 'PRS-OLV', 1442, 8.19, 11809.98);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 1, 'COF-ETH', 1166, 14.04, 16370.64);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 2, 'COF-COL', 1107, 12.87, 14247.09);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 3, 'COF-SUM', 1240, 11.7, 14508);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00025', 1, 'PKG', 1, 12051.26, 12051.26);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 1, 'NUT-ALM', 1142, 13.4, 15302.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 2, 'NUT-PEC', 1317, 16.26, 21414.42);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 3, 'NUT-CAS', 1606, 15.3, 24571.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 1, 'OIL-EVO', 1477, 9.39, 13869.03);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 2, 'OIL-ORG', 1645, 11.1, 18259.5);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 3, 'OIL-FLT', 1023, 7.69, 7866.87);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 1, 'PRS-JAM', 1610, 7.02, 11302.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 2, 'PRS-HNY', 1323, 9.36, 12383.28);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 3, 'PRS-OLV', 1534, 8.19, 12563.46);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 1, 'COF-ETH', 1555, 14.04, 21832.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 2, 'COF-COL', 1305, 12.87, 16795.35);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 3, 'COF-SUM', 1190, 11.7, 13923);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00030', 1, 'PKG', 1, 12450, 12450);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00031', 1, 'PKG', 1, 12450, 12450);
