'use strict';
/** ImpactCal selection engine. MKS throughout. Port of impactcal.py — same results. */
const G = 9.81;

const STANDARDS = {
  IS3177:     { code:'IS3177', name:'IS 3177 : 2020 — EOT & gantry cranes', speed_factor:0.50, decel_limit:5.00,
                note:'Unloaded crane/trolley; loaded for stiff-masted. 0.70 permitted if the customer specifies.' },
  'ISO8686-5':{ code:'ISO8686-5', name:'ISO 8686-5 : 2017 — overhead travelling cranes', speed_factor:0.85, decel_limit:null,
                note:'0.70 where the drive brakes before contact. Freely suspended load excluded.' },
  'ISO8686-1':{ code:'ISO8686-1', name:'ISO 8686-1 : 2012 — general crane design', speed_factor:0.70, decel_limit:null,
                note:'0.70–1.00 of nominal. phi7 = 1.25 linear, 1.6 progressive, on the structural reaction.' },
  FEM1001:    { code:'FEM1001', name:'FEM 1.001 — hoisting appliances', speed_factor:0.70, decel_limit:null,
                note:'Buffer load treated as an exceptional load case.' },
  CMAA70:     { code:'CMAA70', name:'CMAA 70 / OSHA', speed_factor:0.40, decel_limit:0.91,
                note:'Power off. Trolley limit 1.43 m/s².' },
  AISE6:      { code:'AISE6', name:'AISE TR-6 — mill duty', speed_factor:0.50, decel_limit:4.90,
                note:'Deceleration at 50% speed, energy capacity at 100%.' },
  NONE:       { code:'NONE', name:'No governing standard — velocity as entered', speed_factor:1.00, decel_limit:null,
                note:'The velocity you enter is used unchanged.' },
};

const keLinear = d => 0.5 * d.m * d.v * d.v;
const kePair   = d => d.m * d.m2 * Math.pow(d.v + d.v2, 2) / (2 * (d.m + d.m2));

const CASES = {
  I1 : { title:'Mass, no propelling force',            group:'industrial', ke:keLinear, ew:()=>0 },
  I2 : { title:'Mass with propelling force',           group:'industrial', ke:keLinear, ew:(d,S)=>d.F*S },
  I3 : { title:'Mass with motor drive',                group:'industrial', ke:keLinear, ew:(d,S)=>d.v>0 ? (d.H_M*d.P/d.v)*S : 0 },
  I4 : { title:'Mass on driven rollers',               group:'industrial', ke:keLinear, ew:(d,S)=>d.mu*d.m*G*S },
  I5 : { title:'Free-falling mass',                    group:'industrial', ke:d=>d.m*G*d.H, ew:(d,S)=>d.m*G*S,
         vel:d=>Math.sqrt(2*G*d.H) },
  I6 : { title:'Mass on an incline',                   group:'industrial', ke:keLinear,
         ew:(d,S)=>d.m*G*S*(Math.sin(d.beta)+d.mu*Math.cos(d.beta)) },
  I7 : { title:'Swinging mass with propelling torque', group:'industrial',
         ke:d=>d.J ? 0.5*d.J*d.omega*d.omega : keLinear(d), ew:(d,S)=>d.r ? d.M_t*S/d.r : 0,
         vel:d=>(d.omega&&d.R)?d.omega*d.R:d.v },
  I8 : { title:'Rotary index table',                   group:'industrial',
         ke:d=>d.J ? 0.5*d.J*d.omega*d.omega : 0.25*d.m*d.v*d.v, ew:(d,S)=>d.r ? d.M_t*S/d.r : 0,
         vel:d=>(d.omega&&d.R)?d.omega*d.R:d.v },
  I9 : { title:'Swinging arm with propelling force',   group:'industrial',
         ke:d=>0.25*d.m*d.v*d.v, ew:(d,S)=>d.R ? d.F*d.r*S/d.R : 0 },
  I10: { title:'Mass lowered under control',           group:'industrial', ke:keLinear, ew:(d,S)=>d.m*G*S + d.F*S },
  C1 : { title:'Crane / wagon into a fixed stop',                group:'crane', ke:keLinear,
         ew:(d,S)=>(d.P&&d.v>0)?(d.H_M*d.P/d.v)*S:d.F*S },
  C2 : { title:'Crane / wagon into a fixed stop, absorbers both ends', group:'crane', ke:d=>0.5*keLinear(d),
         ew:(d,S)=>(d.P&&d.v>0)?(d.H_M*d.P/d.v)*S:d.F*S },
  C3 : { title:'Crane into crane, absorbers one side',           group:'crane', ke:kePair,
         ew:(d,S)=>(d.P&&d.v>0)?(d.H_M*d.P/d.v)*S:d.F*S, ve:d=>d.v+d.v2 },
  C4 : { title:'Crane into crane, absorbers both sides',         group:'crane', ke:d=>0.5*kePair(d),
         ew:(d,S)=>(d.P&&d.v>0)?(d.H_M*d.P/d.v)*S:d.F*S, ve:d=>d.v+d.v2 },
};

const DUTY_DEFAULTS = { m:0, v:0, F:0, P:0, H_M:2.5, C:0, n:1, mu:0, beta:0, H:0,
                        J:0, omega:0, M_t:0, r:0, R:0, m2:0, v2:0, temp_min:-10, temp_max:60, angle_deg:0 };

const fit = u => (u<=0||u>1) ? 0 : Math.exp(-Math.pow((u-0.65)/0.28, 2));

function evaluate(dutyIn, caseId, p, standardCode='IS3177', tempDerate=1) {
  const c = CASES[caseId]; if (!c) throw new Error('unknown case '+caseId);
  const std = STANDARDS[standardCode] || STANDARDS.NONE;
  const d = Object.assign({}, DUTY_DEFAULTS, dutyIn);
  d.v = (c.vel ? c.vel(d) : d.v) * std.speed_factor;
  if (d.v2) d.v2 = d.v2 * std.speed_factor;
  const S = p.stroke_mm / 1000;
  const E_k = c.ke(d) / d.n;
  const E_w = c.ew(d, S) / d.n;
  const E_t = E_k + E_w;
  const E_tc = E_t * d.C;
  const v_e = c.ve ? c.ve(d) : d.v;
  const m_e = d.v > 0 ? 2*E_t/(d.v*d.v) : Infinity;
  const F_s = E_t / (p.eta * S);
  const a   = v_e*v_e / (2 * p.eta * S);
  const t   = v_e > 0 ? 2*S/(p.eta*v_e) : Infinity;
  const capC = p.nm_per_cycle * tempDerate, capH = p.nm_per_hour * tempDerate;
  const u_stroke = capC ? E_t/capC : Infinity;
  const u_hour   = capH ? E_tc/capH : Infinity;
  const u = Math.max(u_stroke, u_hour);
  const flags = [], fatal = [];
  const fail = s => { flags.push(s); fatal.push(s); };
  if (u_stroke > 1) fail(`over energy per stroke (${(u_stroke*100).toFixed(0)}%)`);
  if (u_hour   > 1) fail(`over energy per hour (${(u_hour*100).toFixed(0)}%)`);
  if (F_s > p.fs_max_n * 1.001) fail(`reaction force ${(F_s/1000).toFixed(0)} kN exceeds rated ${(p.fs_max_n/1000).toFixed(0)} kN`);
  if (std.decel_limit && a > std.decel_limit) fail(`deceleration ${a.toFixed(1)} m/s² exceeds the ${std.code} limit of ${std.decel_limit}`);
  if (p.damping_codes) {
    if (p.me_min_kg && m_e < p.me_min_kg) fail(`effective mass ${m_e.toFixed(0)} kg below the band (${p.me_min_kg} kg)`);
    if (p.me_max_kg && m_e > p.me_max_kg) fail(`effective mass ${m_e.toFixed(0)} kg above the band (${p.me_max_kg} kg)`);
  }
  if (p.side_angle_deg && d.angle_deg > p.side_angle_deg) fail(`side load ${d.angle_deg}° exceeds ${p.side_angle_deg}°`);
  if (p.max_cycles_per_hour && d.C > p.max_cycles_per_hour) fail(`${d.C}/h exceeds the ${p.max_cycles_per_hour}/h cycle cap`);
  if (d.temp_min < p.temp_min_c || d.temp_max > p.temp_max_c)
    fail(`temperature ${d.temp_min}…${d.temp_max} °C outside the rated ${p.temp_min_c}…${p.temp_max_c} °C`);
  if (u > 0 && u < 0.20) flags.push(`under-utilised (${(u*100).toFixed(0)}%) — a smaller model would decelerate better`);
  if (d.v && d.v < 0.30) flags.push('impact velocity below 0.3 m/s — verify effective mass, it grows as 1/v²');
  if (p.confidence && p.confidence !== 'high') flags.push('data derived, not catalogue-verified');
  const score = fit(u) * (p.confidence === 'high' ? 1 : 0.75);
  return { product:p, E_k, E_w, E_t, E_tc, m_e, F_s, a, t, v:d.v, v_e,
           u_stroke, u_hour, u, score, flags, fatal, picks:[] };
}

function rankKey(c) {
  return [ c.product.confidence === 'high' ? 0 : 1, c.product.nm_per_cycle, c.F_s, -c.score ];
}
const cmp = (A,B) => { const a=rankKey(A), b=rankKey(B);
  for (let i=0;i<a.length;i++) if (a[i]!==b[i]) return a[i]<b[i] ? -1 : 1; return 0; };

function select(duty, caseId, products, opts = {}) {
  const { standard='IS3177', series=null, maxStrokeMm=null, tempDerate=1, includeRejected=false } = opts;
  let out = [];
  for (const p of products) {
    if (p.status && p.status !== 'active') continue;
    if (series && series.length && !series.includes(p.series)) continue;
    if (maxStrokeMm && p.stroke_mm > maxStrokeMm) continue;
    const c = evaluate(duty, caseId, p, standard, tempDerate);
    if (c.fatal.length && !includeRejected) continue;
    out.push(c);
  }
  out.sort(cmp);
  if (out.length) {
    const tag = (c,l) => { if (!c.picks.includes(l)) c.picks.push(l); };
    tag(out[0], 'smallest');
    tag(out.reduce((a,b)=> b.a < a.a ? b : a), 'gentlest stop');
    tag(out.reduce((a,b)=> b.score > a.score ? b : a), 'best-centred utilisation');
  }
  return out;
}

module.exports = { G, STANDARDS, CASES, DUTY_DEFAULTS, evaluate, select };
