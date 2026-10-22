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

INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-001', 'VEND-SNC', 'NUT-ALM', 8.9, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-002', 'VEND-SNC', 'NUT-PEC', 10.8, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-003', 'VEND-SNC', 'NUT-CAS', 10.17, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-004', 'VEND-LOI', 'OIL-EVO', 6.99, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-005', 'VEND-LOI', 'OIL-ORG', 8.26, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-006', 'VEND-LOI', 'OIL-FLT', 5.72, 'USD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-007', 'VEND-PRV', 'PRS-JAM', 5.15, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-008', 'VEND-PRV', 'PRS-HNY', 6.86, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-009', 'VEND-PRV', 'PRS-OLV', 6.01, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-010', 'VEND-RCK', 'COF-ETH', 10.3, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-011', 'VEND-RCK', 'COF-COL', 9.44, 'CAD', '2026-01-01', '2026-12-31');
INSERT INTO contract (contract_id, vendor_id, sku, unit_price, currency, valid_from, valid_to) VALUES ('CTR-012', 'VEND-RCK', 'COF-SUM', 8.58, 'CAD', '2026-01-01', '2026-12-31');

INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00001', 'VEND-SNC', 'SNC-202604-01', '2026-04-15', 'USD', 23584.49, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00002', 'VEND-LOI', 'LOI-202604-01', '2026-04-15', 'USD', 17414.96, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00003', 'VEND-PRV', 'PRV-202604-01', '2026-04-15', 'CAD', 15746.67, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00004', 'VEND-RCK', 'RCK-202604-01', '2026-04-15', 'CAD', 21803.16, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00005', 'VEND-MRP', 'MRP-202604-PKG', '2026-04-15', 'CAD', 12260.91, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00006', 'VEND-SNC', 'SNC-202605-01', '2026-05-15', 'USD', 26225.81, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00007', 'VEND-LOI', 'LOI-202605-01', '2026-05-15', 'USD', 18370.22, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00008', 'VEND-PRV', 'PRV-202605-01', '2026-05-15', 'CAD', 12600.68, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00009', 'VEND-RCK', 'RCK-202605-01', '2026-05-15', 'CAD', 24796.42, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00010', 'VEND-MRP', 'MRP-202605-PKG', '2026-05-15', 'CAD', 12096.74, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00011', 'VEND-SNC', 'SNC-202606-01', '2026-06-15', 'USD', 25785.01, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00012', 'VEND-LOI', 'LOI-202606-01', '2026-06-15', 'USD', 15792.76, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00013', 'VEND-PRV', 'PRV-202606-01', '2026-06-15', 'CAD', 13883.3, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00014', 'VEND-RCK', 'RCK-202606-01', '2026-06-15', 'CAD', 20439.94, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00015', 'VEND-MRP', 'MRP-202606-PKG', '2026-06-15', 'CAD', 11647.79, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00016', 'VEND-SNC', 'SNC-202607-01', '2026-07-15', 'USD', 25823.36, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00017', 'VEND-LOI', 'LOI-202607-01', '2026-07-15', 'USD', 16053.55, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00018', 'VEND-PRV', 'PRV-202607-01', '2026-07-15', 'CAD', 15473.62, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00019', 'VEND-RCK', 'RCK-202607-01', '2026-07-15', 'CAD', 23438.14, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00020', 'VEND-MRP', 'MRP-202607-PKG', '2026-07-15', 'CAD', 11748.71, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00021', 'VEND-SNC', 'SNC-202608-01', '2026-08-15', 'USD', 27841.34, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00022', 'VEND-LOI', 'LOI-202608-01', '2026-08-15', 'USD', 15609.34, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00023', 'VEND-PRV', 'PRV-202608-01', '2026-08-15', 'CAD', 11326.24, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00024', 'VEND-RCK', 'RCK-202608-01', '2026-08-15', 'CAD', 23719.64, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00025', 'VEND-MRP', 'MRP-202608-PKG', '2026-08-15', 'CAD', 12243.83, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00026', 'VEND-SNC', 'SNC-202609-01', '2026-09-15', 'USD', 34540.94, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00027', 'VEND-LOI', 'LOI-202609-01', '2026-09-15', 'USD', 21548.72, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00028', 'VEND-PRV', 'PRV-202609-01', '2026-09-15', 'CAD', 15727.62, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00029', 'VEND-RCK', 'RCK-202609-01', '2026-09-15', 'CAD', 25995.9, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00030', 'VEND-MRP', 'MRP-202609-PKG', '2026-09-15', 'CAD', 12111.24, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00031', 'VEND-MRP', 'MRP-88213', '2026-09-18', 'CAD', 18450, 'posted');
INSERT INTO ap_invoice (ap_doc_id, vendor_id, vendor_invoice_no, invoice_date, currency, total_amount, status) VALUES ('AP-00032', 'VEND-MRP', 'MRP-88213', '2026-09-18', 'CAD', 18450, 'posted');

INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 1, 'NUT-ALM', 865, 8.9, 7698.5);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 2, 'NUT-PEC', 711, 10.8, 7678.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00001', 3, 'NUT-CAS', 807, 10.17, 8207.19);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 1, 'OIL-EVO', 792, 6.99, 5536.08);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 2, 'OIL-ORG', 988, 8.26, 8160.88);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00002', 3, 'OIL-FLT', 650, 5.72, 3718);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 1, 'PRS-JAM', 821, 5.15, 4228.15);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 2, 'PRS-HNY', 810, 6.86, 5556.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00003', 3, 'PRS-OLV', 992, 6.01, 5961.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 1, 'COF-ETH', 859, 10.3, 8847.7);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 2, 'COF-COL', 688, 9.44, 6494.72);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00004', 3, 'COF-SUM', 753, 8.58, 6460.74);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00005', 1, 'PKG', 1, 12260.91, 12260.91);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 1, 'NUT-ALM', 919, 8.9, 8179.1);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 2, 'NUT-PEC', 896, 10.8, 9676.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00006', 3, 'NUT-CAS', 823, 10.17, 8369.91);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 1, 'OIL-EVO', 780, 6.99, 5452.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 2, 'OIL-ORG', 985, 8.26, 8136.1);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00007', 3, 'OIL-FLT', 836, 5.72, 4781.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 1, 'PRS-JAM', 804, 5.15, 4140.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 2, 'PRS-HNY', 634, 6.86, 4349.24);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00008', 3, 'PRS-OLV', 684, 6.01, 4110.84);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 1, 'COF-ETH', 909, 10.3, 9362.7);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 2, 'COF-COL', 866, 9.44, 8175.04);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00009', 3, 'COF-SUM', 846, 8.58, 7258.68);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00010', 1, 'PKG', 1, 12096.74, 12096.74);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 1, 'NUT-ALM', 926, 8.9, 8241.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 2, 'NUT-PEC', 727, 10.8, 7851.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00011', 3, 'NUT-CAS', 953, 10.17, 9692.01);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 1, 'OIL-EVO', 792, 6.99, 5536.08);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 2, 'OIL-ORG', 820, 8.26, 6773.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00012', 3, 'OIL-FLT', 609, 5.72, 3483.48);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 1, 'PRS-JAM', 1026, 5.15, 5283.9);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 2, 'PRS-HNY', 607, 6.86, 4164.02);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00013', 3, 'PRS-OLV', 738, 6.01, 4435.38);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 1, 'COF-ETH', 740, 10.3, 7622);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 2, 'COF-COL', 568, 9.44, 5361.92);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00014', 3, 'COF-SUM', 869, 8.58, 7456.02);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00015', 1, 'PKG', 1, 11647.79, 11647.79);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 1, 'NUT-ALM', 826, 8.9, 7351.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 2, 'NUT-PEC', 893, 10.8, 9644.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00016', 3, 'NUT-CAS', 868, 10.17, 8827.56);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 1, 'OIL-EVO', 885, 6.99, 6186.15);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 2, 'OIL-ORG', 678, 8.26, 5600.28);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00017', 3, 'OIL-FLT', 746, 5.72, 4267.12);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 1, 'PRS-JAM', 785, 5.15, 4042.75);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 2, 'PRS-HNY', 919, 6.86, 6304.34);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00018', 3, 'PRS-OLV', 853, 6.01, 5126.53);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 1, 'COF-ETH', 842, 10.3, 8672.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 2, 'COF-COL', 967, 9.44, 9128.48);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00019', 3, 'COF-SUM', 657, 8.58, 5637.06);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00020', 1, 'PKG', 1, 11748.71, 11748.71);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 1, 'NUT-ALM', 754, 8.9, 6710.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 2, 'NUT-PEC', 900, 10.8, 9720);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00021', 3, 'NUT-CAS', 1122, 10.17, 11410.74);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 1, 'OIL-EVO', 820, 6.99, 5731.8);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 2, 'OIL-ORG', 691, 8.26, 5707.66);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00022', 3, 'OIL-FLT', 729, 5.72, 4169.88);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 1, 'PRS-JAM', 744, 5.15, 3831.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 2, 'PRS-HNY', 481, 6.86, 3299.66);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00023', 3, 'PRS-OLV', 698, 6.01, 4194.98);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 1, 'COF-ETH', 887, 10.3, 9136.1);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 2, 'COF-COL', 915, 9.44, 8637.6);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00024', 3, 'COF-SUM', 693, 8.58, 5945.94);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00025', 1, 'PKG', 1, 12243.83, 12243.83);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 1, 'NUT-ALM', 781, 9.97, 7786.57);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 2, 'NUT-PEC', 1154, 12.1, 13963.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00026', 3, 'NUT-CAS', 1123, 11.39, 12790.97);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 1, 'OIL-EVO', 790, 6.99, 5522.1);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 2, 'OIL-ORG', 941, 8.26, 7772.66);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00027', 3, 'OIL-FLT', 1443, 5.72, 8253.96);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 1, 'PRS-JAM', 923, 5.15, 4753.45);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 2, 'PRS-HNY', 912, 6.86, 6256.32);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00028', 3, 'PRS-OLV', 785, 6.01, 4717.85);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 1, 'COF-ETH', 684, 10.3, 7045.2);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 2, 'COF-COL', 885, 9.44, 8354.4);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00029', 3, 'COF-SUM', 1235, 8.58, 10596.3);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00030', 1, 'PKG', 1, 12111.24, 12111.24);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00031', 1, 'PKG', 1, 18450, 18450);
INSERT INTO ap_invoice_line (ap_doc_id, line_no, sku, qty, unit_price, amount) VALUES ('AP-00032', 1, 'PKG', 1, 18450, 18450);
