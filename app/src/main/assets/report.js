/* =====================================================================
   Daily report text - shared by the app (index.html) and the push server
   (push-worker/worker.js), so the WhatsApp message is exactly the same text.
   ===================================================================== */
export const HALL_SECTIONS = ["hallActivities", "maleWing", "femaleWing", "sickness"];
export const DSW_SECTIONS = ["dswActivities", "tomorrow", "counselling"];
export const REQUIRED_SECTIONS = [...HALL_SECTIONS, ...DSW_SECTIONS];
export const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export function fmtReportDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}
export const letterAt = i => i < 26 ? String.fromCharCode(97 + i) : "a" + String.fromCharCode(97 + (i - 26));
export function sumParts(a) { return (a || []).reduce((x, y) => x + (Number(y) || 0), 0); }
export function wingDefault(parts) { return { presentParts: Array(Math.max((parts || []).length, 1)).fill(0), present: 0, yetToJoin: 0, total: sumParts(parts) }; }
export function drPresentParts(d, parts) {
  const n = Math.max((parts || []).length, 1);
  const base = Array.isArray(d.presentParts) ? d.presentParts : [d.present];
  return Array.from({ length: n }, (_, i) => Number(base[i]) || 0);
}
export const DR_TPL = {
  greeting: "Assalamualaikum sir,",
  subject: "Subj: DSW Wg-Daily Report",
  dateLabel: "Dt:",
  daily: "1. Daily Activities :",
  tomorrow: "2. Tomorrow's Activities:",
  state: "3. O/Hall Students State:",
  sickness: "4. Sickness :",
  counselling: "5. Counselling:",
  nstr: "NSTR",
  nil: "Nil",
  maleLabel: "Male Wg", femaleLabel: "Female Wg", hostelLabel: "Student Run Hostel",
  lAlot: "Alot:", gAlot: 1,
  lPresent: "Present:", gPresent: 2,
  lOnLeave: "On Lve:", gOnLeave: 5,
  lYet: "Yet to join from lve:", gYet: 2,
  lTotal: "Total:", gTotal: 7,
  closing: "Regards\nDSW",
};
export function tplOf(cfg, over) {
  const src = over || (cfg && cfg.template) || {};
  const out = { ...DR_TPL };
  Object.keys(DR_TPL).forEach(k => { if (src[k] !== undefined && src[k] !== null) out[k] = src[k]; });
  return out;
}
export const tplGap = n => " ".repeat(Math.max(0, Math.min(20, Number(n) || 0)));
export function wingLine(letter, label, parts, data, _unused, T) {
  T = T || tplOf(null);
  const alot = sumParts(parts);
  const alotTxt = parts.length > 1 ? `${parts.join("+")}= ${alot}` : String(alot);
  const pp = drPresentParts(data, parts), present = pp.reduce((a, b) => a + b, 0);
  const presentTxt = pp.length > 1 ? `${pp.join("+")}= ${present}` : String(present);
  const total = data.total != null && data.total !== "" ? Number(data.total) : alot;
  const onLeave = wingOnLeave(data, parts);
  const yet = String(Number(data.yetToJoin) || 0).padStart(2, "0");
  return [`*(${letter}) ${label}:*`, `${T.lAlot}${tplGap(T.gAlot)}${alotTxt}`, `${T.lPresent}${tplGap(T.gPresent)}${presentTxt}`, `${T.lOnLeave}${tplGap(T.gOnLeave)}${onLeave}`, `${T.lYet}${tplGap(T.gYet)}${yet}`, `${T.lTotal}${tplGap(T.gTotal)}${total}`].join("\n");
}
export function wingOnLeave(d, parts) {
  const alot = sumParts(parts);
  const present = drPresentParts(d, parts).reduce((a, b) => a + b, 0);
  const total = d.total != null && d.total !== "" ? Number(d.total) || 0 : alot;
  return Math.max(0, total - present - (Number(d.yetToJoin) || 0));
}
export function peopleLine(num, title, students, T) {
  T = T || tplOf(null);
  if (!num) return `*${title} ${T.nil}*`;
  const word = num === 1 ? "Student" : "Students";
  const head = `*${title} ${num} x ${word}*`;
  const body = (students || []).slice(0, num).map((s, i) => `(${letterAt(i)}) ${[s.name, s.id, s.dept, s.level, s.details].filter(x => String(x || "").trim()).join(", ") || "—"}`).join("\n\n");
  return body ? `${head}\n\n${body}` : head;
}
export function compileReport(dateStr, sec, cfg, over) {
  cfg = cfg || {};
  const T = tplOf(cfg, over);
  const dsw = (sec.dswActivities && sec.dswActivities.items) || [];
  const hall = (sec.hallActivities && sec.hallActivities.items) || [];
  const all = [...dsw, ...hall].filter(x => x && String(x.text || "").trim());
  const line1 = all.length ? `*${T.daily}*\n\n${all.map((a, i) => `${all.length > 1 ? `(${letterAt(i)}) ` : ""}${a.text.trim()}`).join("\n\n")}` : `*${T.daily} ${T.nstr}*`;
  const tm = sec.tomorrow || {};
  const tmItems = (Array.isArray(tm.items) ? tm.items : (String(tm.text || "").trim() && String(tm.text).trim().toUpperCase() !== "NSTR" ? [{ text: String(tm.text).trim() }] : [])).filter(x => x && String(x.text || "").trim());
  const line2 = tmItems.length ? `*${T.tomorrow}*\n\n${tmItems.map((a, i) => `${tmItems.length > 1 ? `(${letterAt(i)}) ` : ""}${a.text.trim()}`).join("\n\n")}` : `*${T.tomorrow} ${T.nstr}*`;
  const male = sec.maleWing || wingDefault(cfg.maleParts);
  const female = sec.femaleWing || wingDefault(cfg.femaleParts);
  const hostel = sec.hostel || wingDefault(cfg.hostelParts);
  const line3 = `*${T.state}*\n\n${wingLine("a", T.maleLabel, cfg.maleParts || [0], male, true, T)}\n\n${wingLine("b", T.femaleLabel, cfg.femaleParts || [0], female, true, T)}\n\n${wingLine("c", T.hostelLabel, cfg.hostelParts || [0], hostel, true, T)}`;
  const sick = sec.sickness || { mode: 0, students: [] };
  const line4 = peopleLine(Number(sick.mode) || 0, T.sickness, sick.students, T);
  const cns = sec.counselling || { mode: 0, students: [] };
  const line5 = peopleLine(Number(cns.mode) || 0, T.counselling, [], T);
  const closing = String(T.closing || "").replace(/^\s+|\s+$/g, "");
  return [T.greeting, `*${T.subject}*`, `${T.dateLabel} ${fmtReportDate(dateStr)}`, line1, line2, line3, line4, line5, closing].filter(x => String(x).length).join("\n\n");
}
