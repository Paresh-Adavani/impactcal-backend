'use strict';
const fs = require('fs'), path = require('path');
const { db, setSetting } = require('./db');

/* ---------------------------------------------------------------------------
   HSN defaults.  All of these attract 18% GST.
   These are SENSIBLE DEFAULTS, editable per product in the pricelist grid.
   Classification is a tax matter — have your CA confirm before the first invoice.
   8479 89 99  other machines and mechanical appliances having individual functions
   8431 49 90  parts suitable for use solely or principally with lifting machinery (8425-8430)
   4016 99 90  other articles of vulcanised rubber
   7320 90 90  other springs of iron or steel
--------------------------------------------------------------------------- */
const HSN = {
  AC:'84798999', ACX:'84798999', AD:'84798999', YSRA:'84798999',
  AKHG:'84314990', AKHS:'84314990', ED:'84314990', EI:'84314990', SB:'84314990',
  JHQC:'40169990',
};
const HSN_NOTE = {
  '84798999':'Other machines and mechanical appliances having individual functions',
  '84314990':'Parts for lifting/handling machinery of headings 8425–8430',
  '40169990':'Other articles of vulcanised rubber (polyurethane buffer)',
  '73209090':'Other springs of iron or steel',
  '996511'  :'SAC — road transport of goods',
};

/* side-load angle and cycle caps that the catalogues do publish */
const SIDE_ANGLE = { AKHS:{'AKHS 130-70':3,'AKHS 130-100':3,'AKHS 130-150':2.5,'AKHS 160-80':3,
                           'AKHS 160-150':2,'AKHS 190-100':2.5,'AKHS 190-150':2} };
const CYCLE_CAP  = { ED:30, EI:30 };   // ED without bladder accumulator; 60/h with BA

function csv(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(l => {
    const cells = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}
const num = v => (v === '' || v == null || v === 'nan') ? null : Number(v);

const upsert = db.prepare(`
INSERT INTO product (bk,series,model,technology,eta,stroke_mm,nm_per_cycle,nm_per_hour,fs_max_n,
  me_min_kg,me_max_kg,damping_codes,side_angle_deg,max_cycles_per_hour,hsn,gst_rate,uom,
  confidence,source_energy,source_energy_hour,note,status)
VALUES (@bk,@series,@model,@technology,@eta,@stroke_mm,@nm_per_cycle,@nm_per_hour,@fs_max_n,
  @me_min_kg,@me_max_kg,@damping_codes,@side_angle_deg,@max_cycles_per_hour,@hsn,18,'NOS',
  @confidence,@source_energy,@source_energy_hour,@note,'active')
ON CONFLICT(bk) DO UPDATE SET
  series=excluded.series, model=excluded.model, technology=excluded.technology, eta=excluded.eta,
  stroke_mm=excluded.stroke_mm, nm_per_cycle=excluded.nm_per_cycle, nm_per_hour=excluded.nm_per_hour,
  fs_max_n=excluded.fs_max_n, me_min_kg=excluded.me_min_kg, me_max_kg=excluded.me_max_kg,
  damping_codes=excluded.damping_codes, side_angle_deg=excluded.side_angle_deg,
  max_cycles_per_hour=excluded.max_cycles_per_hour, confidence=excluded.confidence,
  source_energy=excluded.source_energy, source_energy_hour=excluded.source_energy_hour,
  note=excluded.note, updated_at=datetime('now')`);

const rows = csv(path.join(__dirname, '..', 'data', 'products.csv'));
const load = db.transaction(rs => {
  for (const r of rs) {
    const series = r.series;
    upsert.run({
      bk:r.bk, series, model:r.model, technology:r.technology, eta:Number(r.eta),
      stroke_mm:num(r.stroke_mm), nm_per_cycle:num(r.nm_per_cycle), nm_per_hour:num(r.nm_per_hour),
      fs_max_n:num(r.fs_max_N), me_min_kg:num(r.me_min_kg), me_max_kg:num(r.me_max_kg),
      damping_codes:r.damping_codes || '', side_angle_deg:(SIDE_ANGLE[series]||{})[r.model] ?? null,
      max_cycles_per_hour:CYCLE_CAP[series] ?? null, hsn:HSN[series] || '84798999',
      confidence:r.confidence || 'high', source_energy:r.source_energy || '',
      source_energy_hour:r.source_energy_hour || '', note:r.note || '',
    });
  }
});
load(rows);

/* ---------------- accessories ---------------- */
const ACC = [
  ['FF','Front flange','mounting',''],       ['RF','Rear flange','mounting',''],
  ['FRF','Front and rear flange','mounting',''], ['FM','Foot mount','mounting',''],
  ['RFFF','Rear flange, front foot mount','mounting',''], ['CM','Clevis mount','mounting',''],
  ['SC','Stop collar','option',''],          ['SLA','Side-load adapter','option',''],
  ['BEL','Weather bellows','option',''],     ['LN','Lock nut (extra pair)','option',''],
  ['NC','No cap','cap','AC,ACX,AD,YSRA'],    ['PU','Polyurethane cap','cap','AC,ACX,AD,YSRA'],
  ['MC','Metallic cap','cap','AC,ACX,AD,YSRA'],
  ['MCPU','Metallic cap with PU button','cap','AC,ACX,AD,YSRA'],
  ['SS','Stainless steel construction','option',''],
  ['SENS','Rod position sensor','option','AKHG,AKHS,ED,EI'],
  ['RECON','Reconditioning / reseal service','service',''],
];
const accIns = db.prepare(`INSERT INTO accessory(code,name,kind,applies_to,hsn,gst_rate,uom,status)
  VALUES(?,?,?,?,'84798999',18,'NOS','active') ON CONFLICT(code) DO NOTHING`);
db.transaction(() => ACC.forEach(a => accIns.run(...a)))();

/* ---------------- settings ---------------- */
const S = {
  'company.name'        :'ADONI TECH',
  'company.gstin'       :'27AHAPA3555B1Z1',
  'company.state_code'  :'27',
  'company.state_name'  :'Maharashtra',
  'company.addr1'       :'Sharda, 1st Floor, Jeevan Chaya Hsg. Soc.',
  'company.addr2'       :'Opp. Civil Hospital',
  'company.city'        :'Satara',
  'company.pincode'     :'415004',
  'company.works'       :'SLU/39, Addl. MIDC, Satara - 415004',
  'company.phone'       :'+91 98908 52663',
  'company.tel'         :'(02162) 232169',
  'company.email'       :'sales@adonitech.co.in',
  'company.web'         :'www.adonitech.co.in',
  'invoice.hsn_digits'  :'8',
  'quote.valid_days'    :'30',
  'quote.prefix'        :'AT/Q',
  'rfq.prefix'          :'AT/R',
  'quote.terms_payment' :'100% against proforma invoice before dispatch.',
  'quote.terms_delivery':'Ex-works Satara, 3–4 weeks from technically and commercially clear order.',
  'quote.terms_warranty':'12 months from despatch against manufacturing defects, on single-shift duty within the rated energy per hour.',
  'quote.terms_other'   :'Prices are ex-works and exclusive of freight and insurance unless quoted separately.\nGST is shown line by line above at the rate applicable on the date of this quotation.\nSelection is subject to confirmation of the application data stated above.',
  'engine.eta_hydraulic':'0.80',
  'engine.eta_spring'   :'0.50',
  'engine.eta_pu'       :'0.158',
  'engine.util_min'     :'0.20',
  'engine.util_max'     :'0.80',
  'cad.release_mode'    :'manual',
};
db.transaction(() => Object.entries(S).forEach(([k,v]) => setSetting.run(k,v)))();
db.transaction(() => Object.entries(HSN_NOTE).forEach(([k,v]) => setSetting.run('hsn.note.'+k, v)))();

const n = db.prepare('SELECT COUNT(*) c FROM product').get().c;
const a = db.prepare('SELECT COUNT(*) c FROM accessory').get().c;
console.log(`seeded ${n} products, ${a} accessories`);
console.log(db.prepare('SELECT series, COUNT(*) n, hsn FROM product GROUP BY series ORDER BY series').all()
  .map(r=>`  ${r.series.padEnd(6)} ${String(r.n).padStart(3)}  HSN ${r.hsn}`).join('\n'));
