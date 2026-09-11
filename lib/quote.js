'use strict';
const { db, nextNumber, getSetting, audit } = require('./db');
const gst = require('./gst');

const supplierState = () => getSetting('company.state_code', '27');

/** Create a draft quotation from an RFQ, priced from the current pricelist. */
function fromRfq(rfqId, opts = {}) {
  const rfq = db.prepare('SELECT * FROM rfq WHERE id=?').get(rfqId);
  if (!rfq) throw new Error('RFQ not found');
  const cust = rfq.customer_id ? db.prepare('SELECT * FROM customer WHERE id=?').get(rfq.customer_id) : null;
  const items = db.prepare('SELECT * FROM rfq_item WHERE rfq_id=? ORDER BY id').all(rfqId);

  const posCode = opts.place_of_supply_code || (cust && cust.state_code) || supplierState();
  const country = (cust && cust.country) || 'India';
  const type = gst.supplyType(supplierState(), posCode, country);

  const number = nextNumber('quotation', getSetting('quote.prefix', 'AT/Q'));
  const q = db.prepare(`INSERT INTO quotation
    (number,rfq_id,customer_id,project_id,valid_days,place_of_supply_code,place_of_supply_name,
     supply_type,terms_payment,terms_delivery,terms_warranty,terms_other)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      number, rfqId, rfq.customer_id, rfq.project_id,
      Number(getSetting('quote.valid_days', 30)), posCode, gst.STATES[posCode] || '', type,
      getSetting('quote.terms_payment',''), getSetting('quote.terms_delivery',''),
      getSetting('quote.terms_warranty',''), getSetting('quote.terms_other',''));
  const qid = q.lastInsertRowid;

  const ins = db.prepare(`INSERT INTO quotation_item
    (quotation_id,seq,kind,bk,code,description,hsn,uom,qty,rate,discount_pct,gst_rate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let seq = 0;
  for (const it of items) {
    const p = it.bk ? db.prepare('SELECT * FROM product WHERE bk=?').get(it.bk) : null;
    const bits = [it.model];
    if (it.damping_code) bits.push('damping code ' + it.damping_code);
    if (it.cap)          bits.push(it.cap);
    if (p) bits.push(`${p.stroke_mm} mm stroke, ${Number(p.nm_per_cycle).toLocaleString('en-IN')} Nm/cycle`);
    ins.run(qid, ++seq, 'product', it.bk, null, bits.join(' · '),
            p ? p.hsn : '84798999', p ? p.uom : 'NOS', it.qty,
            p && p.list_price ? p.list_price : 0, 0, p ? p.gst_rate : 18);
    if (it.mounting) {
      const acc = db.prepare('SELECT * FROM accessory WHERE name=? OR code=?').get(it.mounting, it.mounting);
      ins.run(qid, ++seq, 'accessory', null, acc ? acc.code : null,
              `${it.mounting} for ${it.model}`, acc ? acc.hsn : '84798999',
              'NOS', it.qty, acc && acc.list_price ? acc.list_price : 0, 0, acc ? acc.gst_rate : 18);
    }
  }
  db.prepare("UPDATE rfq SET status='quoted', updated_at=datetime('now') WHERE id=?").run(rfqId);
  audit('admin', 'quotation.create', number, `from RFQ ${rfq.number}`);
  recompute(qid);
  return get(qid);
}

/** Recompute totals from the current line items. */
function recompute(qid) {
  const q = db.prepare('SELECT * FROM quotation WHERE id=?').get(qid);
  const items = db.prepare('SELECT * FROM quotation_item WHERE quotation_id=? ORDER BY seq').all(qid);
  const lines = items.map(i => ({ ...i, gst_rate: q.supply_type === 'export' ? 0 : i.gst_rate }));
  if (Number(q.freight) > 0)
    lines.push({ qty:1, rate:q.freight, discount_pct:0, gst_rate:q.freight_gst,
                 hsn:q.freight_hsn || '996511', uom:'NOS', description:'Freight', kind:'freight' });
  if (Number(q.packing) > 0)
    lines.push({ qty:1, rate:q.packing, discount_pct:0, gst_rate:18,
                 hsn:items[0] ? items[0].hsn : '84798999', uom:'NOS', description:'Packing and forwarding', kind:'freight' });
  const t = gst.computeTax(lines, q.supply_type);
  db.prepare(`UPDATE quotation SET sub_total=?, discount_total=?, taxable=?, cgst=?, sgst=?, igst=?,
    round_off=?, grand_total=?, updated_at=datetime('now') WHERE id=?`)
    .run(t.sub_total, t.discount_total, t.taxable, t.cgst, t.sgst, t.igst, t.round_off, t.grand_total, qid);
  return t;
}

function get(qid) {
  const q = db.prepare('SELECT * FROM quotation WHERE id=?').get(qid);
  if (!q) return null;
  const items = db.prepare('SELECT * FROM quotation_item WHERE quotation_id=? ORDER BY seq').all(qid);
  const t = recompute(qid);
  const cust = q.customer_id ? db.prepare('SELECT * FROM customer WHERE id=?').get(q.customer_id) : null;
  const proj = q.project_id  ? db.prepare('SELECT * FROM project  WHERE id=?').get(q.project_id)  : null;
  const company = Object.fromEntries(db.prepare("SELECT k,v FROM setting WHERE k LIKE 'company.%'").all()
                    .map(r => [r.k.replace('company.', ''), r.v]));
  return { ...db.prepare('SELECT * FROM quotation WHERE id=?').get(qid),
           items, tax:t, customer:cust, project:proj, company,
           amount_in_words: gst.amountInWords(t.grand_total),
           hsn_digits: Number(getSetting('invoice.hsn_digits', 8)) };
}

/** New revision: copies the quotation and its lines, bumps rev, keeps the number. */
function revise(qid) {
  const q = db.prepare('SELECT * FROM quotation WHERE id=?').get(qid);
  if (!q) throw new Error('not found');
  const cols = ['rfq_id','customer_id','project_id','valid_days','place_of_supply_code','place_of_supply_name',
    'supply_type','currency','fx_rate','freight','freight_hsn','freight_gst','packing',
    'terms_payment','terms_delivery','terms_warranty','terms_other','notes'];
  const r = db.prepare(`INSERT INTO quotation (number,rev,${cols.join(',')})
    VALUES (?,?,${cols.map(()=>'?').join(',')})`).run(q.number, q.rev + 1, ...cols.map(c => q[c]));
  const nid = r.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO quotation_item
    (quotation_id,seq,kind,bk,code,description,hsn,uom,qty,rate,discount_pct,gst_rate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const i of db.prepare('SELECT * FROM quotation_item WHERE quotation_id=? ORDER BY seq').all(qid))
    ins.run(nid, i.seq, i.kind, i.bk, i.code, i.description, i.hsn, i.uom, i.qty, i.rate, i.discount_pct, i.gst_rate);
  audit('admin','quotation.revise', q.number, `rev ${q.rev} -> ${q.rev+1}`);
  recompute(nid);
  return get(nid);
}

module.exports = { fromRfq, recompute, get, revise, supplierState };
