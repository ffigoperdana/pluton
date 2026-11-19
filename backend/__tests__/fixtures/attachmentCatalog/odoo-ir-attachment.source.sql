-- Synthetic Odoo-like schema for the attachment catalog parser fixture.
CREATE TABLE aa_notes (id serial PRIMARY KEY, name varchar, comment text);
INSERT INTO aa_notes (name, comment) VALUES
  ('Example Partner', E'COPY public.ir_attachment (id, name, store_fname) FROM stdin;\n1\tdecoy.pdf\tde/decoy'),
  ('Second', E'\\.\nnot an end marker');

CREATE TABLE ir_attachment (
  id serial PRIMARY KEY,
  name varchar NOT NULL,
  description text,
  res_model varchar,
  res_field varchar,
  res_id integer,
  company_id integer,
  type varchar NOT NULL DEFAULT 'binary',
  url varchar(1024),
  public boolean,
  access_token varchar,
  db_datas bytea,
  store_fname varchar,
  file_size integer,
  checksum varchar,
  mimetype varchar,
  index_content text,
  original_id integer,
  create_uid integer,
  create_date timestamp without time zone,
  write_uid integer,
  write_date timestamp without time zone
);

INSERT INTO ir_attachment (name, res_model, res_id, type, store_fname, file_size, checksum, mimetype, index_content, create_date) VALUES
  ('Faktur_Januari.pdf', 'account.move', 18342, 'binary', '3f/3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d', 421888, '3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d', 'application/pdf', E'Faktur\tJanuari\nTotal: Rp 1.000.000\\', '2026-01-05 08:15:00'),
  (E'Laporan\tTab\nBaris.xlsx', 'project.task', 905, 'binary', '0d/0d4e7f12aa00112233445566778899aabbccddee', 90112, '0d4e7f12aa00112233445566778899aabbccddee', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', NULL, '2026-02-01 10:00:00'),
  (E'C:\\Users\\example\\Surat "Resmi".docx', 'hr.employee', 211, 'binary', 'a7/a71be09d44aabbccddeeff00112233445566778899', 30720, 'a71be09d44aabbccddeeff00112233445566778899', 'application/msword', NULL, '2026-03-10 09:30:00'),
  ('Ringkasan rapat – Q3 ✓.pdf', 'mail.message', 77, 'binary', 'b1/b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0', 2048, 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0', 'application/pdf', repeat('teks panjang ', 400), '2026-04-01 12:00:00'),
  ('image_1920', 'product.template', 12, 'binary', 'c4/c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3', 51200, 'c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3', 'image/png', NULL, '2026-05-01 07:00:00');

UPDATE ir_attachment SET res_field = 'image_1920' WHERE name = 'image_1920';

INSERT INTO ir_attachment (name, res_model, res_id, type, db_datas, store_fname, file_size, mimetype) VALUES
  ('stored-in-database.txt', 'res.partner', 1, 'binary', decode(repeat('00ff5c0a09', 64), 'hex'), NULL, 320, 'text/plain');
INSERT INTO ir_attachment (name, type, url) VALUES ('Website link', 'url', 'https://example.internal/page');

CREATE TABLE zz_after (id serial PRIMARY KEY, note text);
INSERT INTO zz_after (note) VALUES ('after the attachment table');
