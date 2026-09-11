'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, getSetting, setSetting, audit, nextNumber, DIR } = require('./lib/db');
const engine = require('./lib/engine');
const gst = require('./lib/gst');
const quote = require('./lib/quote');

const app = express();

// CORS Configuration for Netlify frontend
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL || 'https://impactcal.netlify.app',
    process.env.FRONTEND_URL_PREVIEW || 'https://impactcal-preview.netlify.app',
    'http://localhost:3000',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));
// No static files - frontend is on Netlify
// app.use(express.static(path.join(__dirname, 'public')));

const CADDIR = path.join(DIR, 'cad'); fs.mkdirSync(CADDIR, { recursive: true });
const upload = multer({ dest: path.join(DIR, 'tmp'), limits: { fileSize: 200 * 1024 * 1024 } });
const ADMIN_KEY = process.env.IMPACTCAL_ADMIN_KEY || 'change-me';
const admin = (req, res, next) =>
  (req.get('x-admin-key') === ADMIN_KEY || req.query.key === ADMIN_KEY)
    ? next() : res.status(401).json({ error: 'admin key required' });
const wrap = fn => (req, res) => { try { fn(req, res); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); } };

/* ------------------------------- reference ------------------------------- */
app.get('/api/health', (_q, r) => r.json({ ok: true, products: db.prepare('SELECT COUNT(*) c FROM product').get().c }));
app.get('/api/meta', wrap((_q, r) => r.json({
  cases: Object.entries(engine.CASES).map(([id, c]) => ({ id, title: c.title, group: c.group })),
  standards: Object.values(engine.STANDARDS),
  series: db.prepare("SELECT series, COUNT(*) n FROM product WHERE status='active' GROUP BY series ORDER BY series").all(),
  accessories: db.prepare("SELECT * FROM accessory WHERE status='active' ORDER BY kind, name").all(),
  states: gst.STATES,
  company: Object.fromEntries(db.prepare("SELECT k,v FROM setting WHERE k LIKE 'company.%'").all()
             .map(x => [x.k.replace('company.', ''), x.v])),
})));

/* ------------------------------- selection ------------------------------- */
app.post('/api/select', wrap((req, res) => {
  const { duty = {}, case_id, standard = 'IS3177', series = null, max_stroke_mm = null,
          temp_derate = 1, limit = 40, include_rejected = false } = req.body || {};
  if (!engine.CASES[case_id]) return res.status(400).json({ error: 'unknown case ' + case_id });
  const products = db.prepare("SELECT * FROM product WHERE status='active'").all();
  const all = engine.select(duty, case_id, products,
    { standard, series, maxStrokeMm: max_stroke_mm, tempDerate: temp_derate, includeRejected: include_rejected });
  const shape = c => ({
    bk: c.product.bk, model: c.product.model, series: c.product.series, technology: c.product.technology,
    stroke_mm: c.product.stroke_mm, nm_per_cycle: c.product.nm_per_cycle, nm_per_hour: c.product.nm_per_hour,
    fs_max_n: c.product.fs_max_n, damping_codes: c.product.damping_codes, list_price: c.product.list_price,
    E_k: c.E_k, E_w: c.E_w, E_t: c.E_t, E_tc: c.E_tc, m_e: c.m_e, F_s: c.F_s, a: c.a, t: c.t,
    u_stroke: c.u_stroke, u_hour: c.u_hour, u: c.u, flags: c.flags, fatal: c.fatal, picks: c.picks,
  });
  const std = engine.STANDARDS[standard];
  const first = all[0];
  // E_t, E_tc and m_e depend on the stroke (a stalled drive contributes F*S), so they are a
  // property of each candidate, not of the duty. Only v and E_k are stroke-independent.
  const ref = all.find(c => c.picks.includes('best-centred utilisation')) || first;
  res.json({
    standard: std, case: { id: case_id, ...engine.CASES[case_id] },
    duty_applied: first ? {
      v: first.v, v_e: first.v_e, E_k: first.E_k,
      stroke_dependent: true,
      reference_model: ref ? ref.product.model : null,
      E_t: ref ? ref.E_t : null, E_tc: ref ? ref.E_tc : null, m_e: ref ? ref.m_e : null,
    } : null,
    count: all.length,
    candidates: (() => {
      const head = all.slice(0, limit);
      for (const c of all) if (c.picks.length && !head.includes(c)) head.push(c);  // never lose a pick
      return head.map(shape);
    })(),
  });
}));

/* ------------------------------- products -------------------------------- */
const PCOLS = ['series','model','technology','eta','stroke_mm','nm_per_cycle','nm_per_hour','fs_max_n',
  'me_min_kg','me_max_kg','damping_codes','side_angle_deg','temp_min_c','temp_max_c','max_cycles_per_hour',
  'hsn','gst_rate','uom','list_price','currency','lead_time_days','status','note'];

app.get('/api/products', wrap((req, res) => {
  const { series, q } = req.query;
  let sql = 'SELECT * FROM product WHERE 1=1', args = [];
  if (series) { sql += ' AND series=?'; args.push(series); }
  if (q) { sql += ' AND (model LIKE ? OR bk LIKE ?)'; args.push('%' + q + '%', '%' + q + '%'); }
  res.json(db.prepare(sql + ' ORDER BY series, nm_per_cycle').all(...args));
}));

app.patch('/api/products/:bk', admin, wrap((req, res) => {
  const set = [], args = [];
  for (const [k, v] of Object.entries(req.body || {}))
    if (PCOLS.includes(k)) { set.push(`${k}=?`); args.push(v === '' ? null : v); }
  if (!set.length) return res.status(400).json({ error: 'nothing to update' });
  args.push(req.params.bk);
  db.prepare(`UPDATE product SET ${set.join(',')}, updated_at=datetime('now') WHERE bk=?`).run(...args);
  audit('admin', 'product.update', req.params.bk, JSON.stringify(req.body));
  res.json(db.prepare('SELECT * FROM product WHERE bk=?').get(req.params.bk));
}));

/** Bulk edit — the grid posts only changed cells. */
app.post('/api/products/bulk', admin, wrap((req, res) => {
  const rows = req.body.rows || [];
  const run = db.transaction(rs => {
    let n = 0;
    for (const r of rs) {
      const set = [], args = [];
      for (const [k, v] of Object.entries(r)) if (k !== 'bk' && PCOLS.includes(k)) { set.push(`${k}=?`); args.push(v === '' ? null : v); }
      if (!set.length) continue;
      args.push(r.bk);
      n += db.prepare(`UPDATE product SET ${set.join(',')}, updated_at=datetime('now') WHERE bk=?`).run(...args).changes;
    }
    return n;
  });
  const n = run(rows);
  audit('admin', 'product.bulk', '', `${n} rows`);
  res.json({ updated: n });
}));

/* -------------------------- pricelist xlsx I/O --------------------------- */
app.get('/api/pricelist.xlsx', admin, wrap((_req, res) => {
  const rows = db.prepare(`SELECT bk,series,model,stroke_mm,nm_per_cycle,nm_per_hour,hsn,gst_rate,uom,
    list_price,currency,lead_time_days,status,note FROM product ORDER BY series, nm_per_cycle`).all();
  const acc = db.prepare('SELECT code,name,kind,applies_to,hsn,gst_rate,uom,list_price,status FROM accessory ORDER BY kind,name').all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'products');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(acc), 'accessories');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['ADONI TECH pricelist'], [],
    ['Edit list_price, hsn, gst_rate, lead_time_days, status and note, then upload this file back.'],
    ['bk is the key — do not change it. Rows with an unknown bk are reported and skipped.'],
    ['status: active | obsolete | on_request'], [],
    ['HSN classification is a tax matter. Confirm these codes with your CA before the first invoice.'],
  ]), 'readme');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="adonitech_pricelist.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

app.post('/api/pricelist/import', admin, upload.single('file'), wrap((req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const wb = XLSX.readFile(req.file.path);
  const out = { products: 0, accessories: 0, skipped: [], warnings: [] };
  const EDIT = ['list_price','hsn','gst_rate','uom','lead_time_days','status','note','model'];
  if (wb.SheetNames.includes('products')) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['products']);
    db.transaction(() => {
      for (const r of rows) {
        if (!r.bk) { out.skipped.push('row without bk'); continue; }
        const exists = db.prepare('SELECT 1 FROM product WHERE bk=?').get(r.bk);
        if (!exists) { out.skipped.push(String(r.bk)); continue; }
        if (r.hsn != null && !/^\d{4}(\d{2})?(\d{2})?$/.test(String(r.hsn)))
          out.warnings.push(`${r.bk}: HSN "${r.hsn}" is not 4, 6 or 8 digits`);
        if (r.gst_rate != null && ![0,0.1,0.25,3,5,12,18,28].includes(Number(r.gst_rate)))
          out.warnings.push(`${r.bk}: GST rate ${r.gst_rate}% is not a standard slab`);
        const set = [], args = [];
        for (const k of EDIT) if (r[k] !== undefined) { set.push(`${k}=?`); args.push(r[k] === '' ? null : r[k]); }
        if (!set.length) continue;
        args.push(r.bk);
        out.products += db.prepare(`UPDATE product SET ${set.join(',')}, updated_at=datetime('now') WHERE bk=?`).run(...args).changes;
      }
    })();
  }
  if (wb.SheetNames.includes('accessories')) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['accessories']);
    db.transaction(() => {
      for (const r of rows) {
        if (!r.code) continue;
        out.accessories += db.prepare(`UPDATE accessory SET name=COALESCE(?,name), hsn=COALESCE(?,hsn),
          gst_rate=COALESCE(?,gst_rate), list_price=?, status=COALESCE(?,status), updated_at=datetime('now')
          WHERE code=?`).run(r.name ?? null, r.hsn ?? null, r.gst_rate ?? null,
                             r.list_price ?? null, r.status ?? null, r.code).changes;
      }
    })();
  }
  fs.unlink(req.file.path, () => {});
  audit('admin', 'pricelist.import', '', JSON.stringify({ p: out.products, a: out.accessories }));
  res.json(out);
}));

/* --------------------------------- GSTIN --------------------------------- */
app.get('/api/gstin/:g', wrap((req, res) => {
  const v = gst.validateGstin(req.params.g);
  res.json(v.ok ? v : { ...v, suggestions: gst.repairGstin(req.params.g) });
}));

/* ------------------------- customers, projects --------------------------- */
app.post('/api/customer', wrap((req, res) => {
  const b = req.body || {};
  let st = b.state_code || null, sn = b.state_name || null;
  if (b.gstin) {
    const v = gst.validateGstin(b.gstin);
    if (!v.ok) return res.status(400).json({ error: 'GSTIN: ' + v.reason, suggestions: gst.repairGstin(b.gstin) });
    st = v.state_code; sn = v.state_name;
  }
  const r = db.prepare(`INSERT INTO customer(name,contact,email,phone,gstin,addr_line1,addr_line2,city,
    state_code,state_name,pincode,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name, b.contact, b.email, b.phone, b.gstin ? b.gstin.toUpperCase() : null,
    b.addr_line1, b.addr_line2, b.city, st, sn, b.pincode, b.country || 'India');
  res.json(db.prepare('SELECT * FROM customer WHERE id=?').get(r.lastInsertRowid));
}));
app.get('/api/customers', admin, wrap((_q, r) => r.json(db.prepare('SELECT * FROM customer ORDER BY name').all())));

app.post('/api/project', wrap((req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO project(customer_id,name,reference,equipment,prepared_by) VALUES (?,?,?,?,?)')
    .run(b.customer_id || null, b.name, b.reference, b.equipment, b.prepared_by);
  res.json(db.prepare('SELECT * FROM project WHERE id=?').get(r.lastInsertRowid));
}));

app.post('/api/selection', wrap((req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO selection(project_id,line,case_id,standard,inputs,results,chosen_bk) VALUES (?,?,?,?,?,?,?)')
    .run(b.project_id || null, b.line || null, b.case_id, b.standard || 'IS3177',
         JSON.stringify(b.inputs || {}), JSON.stringify(b.results || {}), b.chosen_bk || null);
  res.json({ id: r.lastInsertRowid });
}));

/* ----------------------------------- RFQ --------------------------------- */
app.post('/api/rfq', wrap((req, res) => {
  const b = req.body || {};
  if (!b.items || !b.items.length) return res.status(400).json({ error: 'no items' });
  let customer_id = b.customer_id || null;
  if (!customer_id && b.customer) {
    const c = b.customer; let st = null, sn = null;
    if (c.gstin) { const v = gst.validateGstin(c.gstin); if (v.ok) { st = v.state_code; sn = v.state_name; } }
    customer_id = db.prepare(`INSERT INTO customer(name,contact,email,phone,gstin,city,state_code,state_name,pincode,country)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c.name || c.company || 'Unknown', c.contact, c.email, c.phone,
      c.gstin ? c.gstin.toUpperCase() : null, c.city, st, sn, c.pincode, c.country || 'India').lastInsertRowid;
  }
  const number = nextNumber('rfq', getSetting('rfq.prefix', 'AT/R'));
  const r = db.prepare('INSERT INTO rfq(number,selection_id,customer_id,project_id,formats,message) VALUES (?,?,?,?,?,?)')
    .run(number, b.selection_id || null, customer_id, b.project_id || null,
         (b.formats || []).join(','), b.message || null);
  const rid = r.lastInsertRowid;
  const ins = db.prepare('INSERT INTO rfq_item(rfq_id,bk,model,qty,mounting,cap,damping_code,remark) VALUES (?,?,?,?,?,?,?,?)');
  for (const it of b.items) ins.run(rid, it.bk || null, it.model, it.qty || 1, it.mounting || null,
                                    it.cap || null, it.damping_code || null, it.remark || null);
  audit('customer', 'rfq.create', number, '');
  res.json({ id: rid, number });
}));

app.get('/api/rfqs', admin, wrap((req, res) => {
  const st = req.query.status;
  const rows = db.prepare(`SELECT r.*, c.name customer, c.gstin, c.state_name, p.name project,
      (SELECT COUNT(*) FROM rfq_item WHERE rfq_id=r.id) items,
      (SELECT number FROM quotation WHERE rfq_id=r.id ORDER BY rev DESC LIMIT 1) quote_number
    FROM rfq r LEFT JOIN customer c ON c.id=r.customer_id LEFT JOIN project p ON p.id=r.project_id
    ${st ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC`).all(...(st ? [st] : []));
  res.json(rows);
}));
app.get('/api/rfq/:id', admin, wrap((req, res) => {
  const r = db.prepare('SELECT * FROM rfq WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  r.items = db.prepare('SELECT * FROM rfq_item WHERE rfq_id=? ORDER BY id').all(r.id);
  r.customer = r.customer_id ? db.prepare('SELECT * FROM customer WHERE id=?').get(r.customer_id) : null;
  r.selection = r.selection_id ? db.prepare('SELECT * FROM selection WHERE id=?').get(r.selection_id) : null;
  r.quotations = db.prepare('SELECT id,number,rev,status,grand_total,date FROM quotation WHERE rfq_id=? ORDER BY rev').all(r.id);
  res.json(r);
}));
app.patch('/api/rfq/:id', admin, wrap((req, res) => {
  const b = req.body || {};
  db.prepare("UPDATE rfq SET status=COALESCE(?,status), admin_note=COALESCE(?,admin_note), updated_at=datetime('now') WHERE id=?")
    .run(b.status ?? null, b.admin_note ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM rfq WHERE id=?').get(req.params.id));
}));

/* -------------------------------- quotation ------------------------------ */
app.post('/api/rfq/:id/quote', admin, wrap((req, res) => res.json(quote.fromRfq(Number(req.params.id), req.body || {}))));
app.get('/api/quotations', admin, wrap((_q, r) => r.json(db.prepare(`SELECT q.*, c.name customer
  FROM quotation q LEFT JOIN customer c ON c.id=q.customer_id ORDER BY q.id DESC`).all())));
app.get('/api/quotation/:id', admin, wrap((req, res) => {
  const q = quote.get(Number(req.params.id));
  q ? res.json(q) : res.status(404).json({ error: 'not found' });
}));
app.patch('/api/quotation/:id', admin, wrap((req, res) => {
  const b = req.body || {}, cols = ['date','valid_days','place_of_supply_code','supply_type','freight',
    'freight_hsn','freight_gst','packing','terms_payment','terms_delivery','terms_warranty','terms_other','notes','status'];
  const set = [], args = [];
  for (const k of cols) if (b[k] !== undefined) { set.push(`${k}=?`); args.push(b[k]); }
  if (b.place_of_supply_code !== undefined) {
    set.push('place_of_supply_name=?'); args.push(gst.STATES[b.place_of_supply_code] || '');
    if (b.supply_type === undefined) {
      set.push('supply_type=?'); args.push(gst.supplyType(quote.supplierState(), b.place_of_supply_code));
    }
  }
  if (set.length) { args.push(req.params.id);
    db.prepare(`UPDATE quotation SET ${set.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...args); }
  res.json(quote.get(Number(req.params.id)));
}));
app.put('/api/quotation/:id/items', admin, wrap((req, res) => {
  const qid = Number(req.params.id), items = req.body.items || [];
  db.transaction(() => {
    db.prepare('DELETE FROM quotation_item WHERE quotation_id=?').run(qid);
    const ins = db.prepare(`INSERT INTO quotation_item
      (quotation_id,seq,kind,bk,code,description,hsn,uom,qty,rate,discount_pct,gst_rate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    items.forEach((i, n) => ins.run(qid, n + 1, i.kind || 'product', i.bk || null, i.code || null,
      i.description, i.hsn || '84798999', i.uom || 'NOS', Number(i.qty) || 0, Number(i.rate) || 0,
      Number(i.discount_pct) || 0, Number(i.gst_rate) || 0));
  })();
  res.json(quote.get(qid));
}));
app.post('/api/quotation/:id/revise', admin, wrap((req, res) => res.json(quote.revise(Number(req.params.id)))));

/* ----------------------------------- CAD --------------------------------- */
app.post('/api/cad', admin, upload.array('files', 40), wrap((req, res) => {
  const { bk = null, model = '', mounting = '', rev = 'A' } = req.body;
  const ins = db.prepare('INSERT INTO cad_asset(bk,model,mounting,fmt,filename,stored_as,rev,bytes) VALUES (?,?,?,?,?,?,?,?)');
  const out = [];
  for (const f of req.files || []) {
    const ext = (path.extname(f.originalname).replace('.', '') || 'bin').toUpperCase();
    const stored = crypto.randomBytes(16).toString('hex') + '.' + ext.toLowerCase();
    fs.renameSync(f.path, path.join(CADDIR, stored));
    const r = ins.run(bk, model || f.originalname, mounting, ext, f.originalname, stored, rev, f.size);
    out.push({ id: r.lastInsertRowid, filename: f.originalname, fmt: ext, bytes: f.size });
  }
  audit('admin', 'cad.upload', bk || model, `${out.length} files`);
  res.json({ uploaded: out });
}));
app.get('/api/cad', admin, wrap((req, res) => {
  const { bk } = req.query;
  res.json(db.prepare(`SELECT * FROM cad_asset ${bk ? 'WHERE bk=?' : ''} ORDER BY id DESC LIMIT 500`).all(...(bk ? [bk] : [])));
}));
/** Release CAD against an RFQ — the manual approval gate. */
app.post('/api/rfq/:id/release-cad', admin, wrap((req, res) => {
  const ids = req.body.asset_ids || [];
  const days = Number(req.body.expiry_days || 30);
  const ins = db.prepare(`INSERT INTO cad_release(rfq_id,cad_asset_id,token,expires_at)
    VALUES (?,?,?,datetime('now','+' || ? || ' days'))`);
  const links = [];
  for (const id of ids) {
    const tok = crypto.randomBytes(24).toString('hex');
    ins.run(req.params.id, id, tok, days);
    const a = db.prepare('SELECT * FROM cad_asset WHERE id=?').get(id);
    links.push({ filename: a.filename, url: `/d/${tok}` });
  }
  db.prepare("UPDATE rfq SET status='closed', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('admin', 'cad.release', req.params.id, `${links.length} files, ${days} day expiry`);
  res.json({ links });
}));
app.get('/d/:token', wrap((req, res) => {
  const rel = db.prepare(`SELECT r.*, a.filename, a.stored_as FROM cad_release r
    JOIN cad_asset a ON a.id=r.cad_asset_id WHERE r.token=?`).get(req.params.token);
  if (!rel) return res.status(404).send('Link not found.');
  if (rel.expires_at && new Date(rel.expires_at) < new Date()) return res.status(410).send('This link has expired.');
  db.prepare('UPDATE cad_release SET downloads=downloads+1 WHERE id=?').run(rel.id);
  audit('customer', 'cad.download', String(rel.rfq_id), rel.filename);
  res.download(path.join(CADDIR, rel.stored_as), rel.filename);
}));

/* -------------------------------- settings ------------------------------- */
app.get('/api/settings', admin, wrap((_q, r) => r.json(Object.fromEntries(db.prepare('SELECT k,v FROM setting').all().map(x => [x.k, x.v])))));
app.put('/api/settings', admin, wrap((req, res) => {
  db.transaction(() => { for (const [k, v] of Object.entries(req.body || {})) setSetting.run(k, String(v)); })();
  audit('admin', 'settings.update', '', Object.keys(req.body || {}).join(','));
  res.json({ ok: true });
}));
app.get('/api/audit', admin, wrap((_q, r) => r.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all())));

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✓ ImpactCal Backend API`);
    console.log(`  Environment: ${NODE_ENV}`);
    console.log(`  Running on: ${NODE_ENV === 'production' ? 'Production' : 'http://localhost:' + PORT}`);
    console.log(`  Frontend: ${process.env.FRONTEND_URL || 'https://impactcal.netlify.app'}\n`);
  });
}

module.exports = app;
