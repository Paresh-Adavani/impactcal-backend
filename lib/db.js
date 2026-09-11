'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DIR = process.env.IMPACTCAL_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });
const db = new Database(path.join(DIR, 'impactcal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ---------- catalogue ----------
CREATE TABLE IF NOT EXISTS product (
  bk                  TEXT PRIMARY KEY,          -- stable body key
  series              TEXT NOT NULL,
  model               TEXT NOT NULL,
  technology          TEXT NOT NULL,             -- hydraulic | spring | pu
  eta                 REAL NOT NULL,
  stroke_mm           REAL NOT NULL,
  nm_per_cycle        REAL NOT NULL,
  nm_per_hour         REAL NOT NULL,
  fs_max_n            REAL NOT NULL,
  me_min_kg           REAL,
  me_max_kg           REAL,
  damping_codes       TEXT DEFAULT '',
  side_angle_deg      REAL,
  temp_min_c          REAL DEFAULT -10,
  temp_max_c          REAL DEFAULT 80,
  max_cycles_per_hour REAL,
  hsn                 TEXT NOT NULL DEFAULT '84798999',
  gst_rate            REAL NOT NULL DEFAULT 18,
  uom                 TEXT NOT NULL DEFAULT 'NOS',
  list_price          REAL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  lead_time_days      INTEGER,
  status              TEXT NOT NULL DEFAULT 'active',   -- active | obsolete | on_request
  confidence          TEXT DEFAULT 'high',
  source_energy       TEXT, source_energy_hour TEXT,
  note                TEXT DEFAULT '',
  updated_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_product_series ON product(series);

CREATE TABLE IF NOT EXISTS accessory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'mounting',   -- mounting | cap | option | service
  applies_to  TEXT DEFAULT '',                    -- comma list of series, blank = all
  hsn         TEXT NOT NULL DEFAULT '84798999',
  gst_rate    REAL NOT NULL DEFAULT 18,
  list_price  REAL,
  uom         TEXT NOT NULL DEFAULT 'NOS',
  status      TEXT NOT NULL DEFAULT 'active',
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- ---------- people & projects ----------
CREATE TABLE IF NOT EXISTS customer (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT, email TEXT, phone TEXT,
  gstin      TEXT, pan TEXT,
  addr_line1 TEXT, addr_line2 TEXT, city TEXT,
  state_code TEXT, state_name TEXT, pincode TEXT, country TEXT DEFAULT 'India',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS device (
  token      TEXT PRIMARY KEY,
  customer_id INTEGER REFERENCES customer(id) ON DELETE CASCADE,
  label      TEXT, last_seen TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customer(id) ON DELETE CASCADE,
  name        TEXT NOT NULL, reference TEXT, equipment TEXT, prepared_by TEXT,
  created_at  TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS selection (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
  line       TEXT,                       -- crane | industrial | wri | av
  case_id    TEXT NOT NULL,
  standard   TEXT NOT NULL DEFAULT 'IS3177',
  inputs     TEXT NOT NULL,              -- json
  results    TEXT NOT NULL,              -- json: computed duty + ranked candidates
  chosen_bk  TEXT REFERENCES product(bk),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- RFQ -> quotation ----------
CREATE TABLE IF NOT EXISTS rfq (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT UNIQUE NOT NULL,
  selection_id INTEGER REFERENCES selection(id) ON DELETE SET NULL,
  customer_id  INTEGER REFERENCES customer(id),
  project_id   INTEGER REFERENCES project(id),
  status       TEXT NOT NULL DEFAULT 'new',   -- new | quoted | cad_pending | closed | lost
  formats      TEXT DEFAULT '',               -- requested CAD formats
  message      TEXT,
  admin_note   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rfq_item (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id   INTEGER REFERENCES rfq(id) ON DELETE CASCADE,
  bk       TEXT REFERENCES product(bk),
  model    TEXT NOT NULL,
  qty      REAL NOT NULL DEFAULT 1,
  mounting TEXT, cap TEXT, damping_code TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS quotation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  rfq_id        INTEGER REFERENCES rfq(id),
  customer_id   INTEGER REFERENCES customer(id),
  project_id    INTEGER REFERENCES project(id),
  date          TEXT NOT NULL DEFAULT (date('now')),
  valid_days    INTEGER NOT NULL DEFAULT 30,
  place_of_supply_code TEXT,
  place_of_supply_name TEXT,
  supply_type   TEXT,                     -- intra | inter | export
  currency      TEXT NOT NULL DEFAULT 'INR',
  fx_rate       REAL NOT NULL DEFAULT 1,
  freight       REAL NOT NULL DEFAULT 0,
  freight_hsn   TEXT DEFAULT '996511',
  freight_gst   REAL NOT NULL DEFAULT 18,
  packing       REAL NOT NULL DEFAULT 0,
  round_off     REAL NOT NULL DEFAULT 0,
  sub_total     REAL, discount_total REAL, taxable REAL,
  cgst REAL, sgst REAL, igst REAL, grand_total REAL,
  terms_payment TEXT, terms_delivery TEXT, terms_warranty TEXT, terms_other TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | accepted | lost
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotation_num_rev ON quotation(number, rev);
CREATE TABLE IF NOT EXISTS quotation_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER REFERENCES quotation(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 1,
  kind         TEXT NOT NULL DEFAULT 'product',   -- product | accessory | service | freight
  bk           TEXT, code TEXT,
  description  TEXT NOT NULL,
  hsn          TEXT NOT NULL,
  uom          TEXT NOT NULL DEFAULT 'NOS',
  qty          REAL NOT NULL DEFAULT 1,
  rate         REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  gst_rate     REAL NOT NULL DEFAULT 18
);

-- ---------- CAD ----------
CREATE TABLE IF NOT EXISTS cad_asset (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bk         TEXT REFERENCES product(bk),
  model      TEXT, mounting TEXT, fmt TEXT NOT NULL,
  filename   TEXT NOT NULL, stored_as TEXT, rev TEXT DEFAULT 'A',
  bytes      INTEGER, uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cad_release (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id       INTEGER REFERENCES rfq(id) ON DELETE CASCADE,
  cad_asset_id INTEGER REFERENCES cad_asset(id),
  token        TEXT UNIQUE NOT NULL,
  released_at  TEXT DEFAULT (datetime('now')),
  expires_at   TEXT,
  downloads    INTEGER NOT NULL DEFAULT 0
);

-- ---------- settings & numbering ----------
CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS counter (name TEXT PRIMARY KEY, fy TEXT, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')),
  who TEXT, what TEXT, ref TEXT, detail TEXT
);
`);

const getSetting = (k, d=null) => { const r=db.prepare('SELECT v FROM setting WHERE k=?').get(k); return r? r.v : d; };
const setSetting = db.prepare('INSERT INTO setting(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
const audit = (who,what,ref,detail='') =>
  db.prepare('INSERT INTO audit(who,what,ref,detail) VALUES(?,?,?,?)').run(who,what,ref,detail);

/** Indian financial year, 1 April to 31 March: 2026-27 -> "2627" */
function fyCode(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return String(start % 100).padStart(2,'0') + String((start + 1) % 100).padStart(2,'0');
}
/** Sequential document number, resets each financial year. */
const nextNumber = db.transaction((name, prefix) => {
  const fy = fyCode();
  const row = db.prepare('SELECT * FROM counter WHERE name=?').get(name);
  let n;
  if (!row) { n = 1; db.prepare('INSERT INTO counter(name,fy,n) VALUES(?,?,1)').run(name, fy); }
  else if (row.fy !== fy) { n = 1; db.prepare('UPDATE counter SET fy=?, n=1 WHERE name=?').run(fy, name); }
  else { n = row.n + 1; db.prepare('UPDATE counter SET n=? WHERE name=?').run(n, name); }
  return `${prefix}/${fy}/${String(n).padStart(4,'0')}`;
});

module.exports = { db, getSetting, setSetting, audit, nextNumber, fyCode, DIR };
