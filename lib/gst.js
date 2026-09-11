'use strict';
/** Indian GST helpers: GSTIN validation, place of supply, tax split. */

const STATES = {
 '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
 '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
 '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
 '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
 '24':'Gujarat','26':'Dadra and Nagar Haveli and Daman and Diu','27':'Maharashtra','29':'Karnataka',
 '30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman and Nicobar Islands',
 '36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','96':'Other Country','97':'Other Territory'
};

const A36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** GSTIN check digit, per the GSTN base-36 weighted algorithm. */
function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = A36.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return A36[(36 - (sum % 36)) % 36];
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function validateGstin(raw) {
  const g = String(raw || '').toUpperCase().replace(/\s/g, '');
  if (!g) return { ok:false, reason:'empty' };
  if (g.length !== 15) return { ok:false, reason:`length ${g.length}, a GSTIN is 15 characters`, value:g };
  if (!GSTIN_RE.test(g)) return { ok:false, reason:'does not match the GSTIN pattern', value:g };
  const st = g.slice(0,2);
  if (!STATES[st]) return { ok:false, reason:`unknown state code ${st}`, value:g };
  const cd = gstinCheckDigit(g.slice(0,14));
  if (cd !== g[14]) return { ok:false, reason:`check digit is ${g[14]}, expected ${cd}`, value:g };
  return { ok:true, value:g, state_code:st, state_name:STATES[st], pan:g.slice(2,12) };
}

/** Suggest corrections for a near-miss GSTIN (single inserted or dropped character). */
function repairGstin(raw) {
  const g = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const out = [];
  if (validateGstin(g).ok) return [g];
  for (let i = 0; i < g.length; i++) {
    const c = g.slice(0, i) + g.slice(i + 1);
    if (c.length === 15 && validateGstin(c).ok && !out.includes(c)) out.push(c);
  }
  for (let i = 0; i < g.length - 1; i++) {
    const c = g.slice(0, i) + g.slice(i + 2);
    if (c.length === 15 && validateGstin(c).ok && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Which taxes apply. Supplier is always the seller's registered state.
 * Same state -> CGST + SGST.  Different state or unregistered interstate -> IGST.
 * Outside India -> export, zero-rated (LUT) unless the caller says otherwise.
 */
function supplyType(supplierStateCode, placeOfSupplyCode, country = 'India') {
  if (country && country.toLowerCase() !== 'india') return 'export';
  if (!placeOfSupplyCode) return 'inter';
  return String(placeOfSupplyCode) === String(supplierStateCode) ? 'intra' : 'inter';
}

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Compute a full tax breakdown from quotation lines.
 * line = { qty, rate, discount_pct, gst_rate, hsn, description, uom }
 */
function computeTax(lines, type, opts = {}) {
  const rows = lines.map(l => {
    const gross = Number(l.qty) * Number(l.rate);
    const disc  = gross * (Number(l.discount_pct || 0) / 100);
    const taxable = r2(gross - disc);
    const rate = type === 'export' ? 0 : Number(l.gst_rate || 0);
    const tax = r2(taxable * rate / 100);
    return { ...l, gross:r2(gross), discount:r2(disc), taxable, gst_rate:rate,
             cgst: type==='intra' ? r2(tax/2) : 0,
             sgst: type==='intra' ? r2(tax/2) : 0,
             igst: type==='inter' ? tax : 0,
             total: r2(taxable + tax) };
  });
  const sum = k => r2(rows.reduce((a,b) => a + (b[k]||0), 0));
  const sub_total = sum('gross'), discount_total = sum('discount'), taxable = sum('taxable');
  const cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst');
  let grand = r2(taxable + cgst + sgst + igst);
  let round_off = 0;
  if (opts.round !== false) { const g = Math.round(grand); round_off = r2(g - grand); grand = r2(g); }

  // HSN summary, as required on the invoice / GSTR-1
  const hsnMap = new Map();
  for (const r of rows) {
    const k = `${r.hsn}|${r.gst_rate}`;
    const e = hsnMap.get(k) || { hsn:r.hsn, gst_rate:r.gst_rate, uom:r.uom||'NOS', qty:0, taxable:0, cgst:0, sgst:0, igst:0 };
    e.qty += Number(r.qty); e.taxable = r2(e.taxable + r.taxable);
    e.cgst = r2(e.cgst + r.cgst); e.sgst = r2(e.sgst + r.sgst); e.igst = r2(e.igst + r.igst);
    hsnMap.set(k, e);
  }
  return { rows, sub_total, discount_total, taxable, cgst, sgst, igst, round_off,
           grand_total: grand, hsn_summary: [...hsnMap.values()] };
}

/** Amount in words, Indian numbering (lakh / crore). */
function amountInWords(n) {
  const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve',
    'Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  const two = x => x < 20 ? ones[x] : (tens[Math.floor(x/10)] + (x%10 ? ' ' + ones[x%10] : ''));
  const three = x => (x>=100 ? ones[Math.floor(x/100)] + ' Hundred' + (x%100 ? ' ' + two(x%100) : '') : two(x));
  n = Math.round(Number(n) * 100) / 100;
  const rupees = Math.floor(n), paise = Math.round((n - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  const parts = [];
  const cr = Math.floor(rupees/10000000), lk = Math.floor(rupees%10000000/100000),
        th = Math.floor(rupees%100000/1000), rest = rupees%1000;
  if (cr) parts.push(three(cr) + ' Crore');
  if (lk) parts.push(three(lk) + ' Lakh');
  if (th) parts.push(three(th) + ' Thousand');
  if (rest) parts.push(three(rest));
  let s = parts.join(' ') + ' Rupees';
  if (paise) s += ' and ' + two(paise) + ' Paise';
  return s + ' Only';
}

module.exports = { STATES, validateGstin, repairGstin, gstinCheckDigit, supplyType, computeTax, amountInWords, r2 };
