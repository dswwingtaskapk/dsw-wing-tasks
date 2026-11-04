/* =====================================================================
   Wing Tasks - phone push server (Cloudflare Worker, free plan)

   What it does
   - The app writes a message into Firestore "pushQueue" and calls  POST /push {q: id}
   - This server reads that message, finds the person's phones in "fcmTokens"
     and sends a phone notification through Firebase Cloud Messaging.
   - Every minute it also sends anything still waiting in the queue, and
     after the daily-report deadline it reminds people whose sections are missing.
   - GET /diag is the health check used by More > Notifications > checkup.

   Needs ONE secret: SERVICE_ACCOUNT  (the Firebase service-account JSON key)

   WhatsApp daily report (optional) - set with: npm run wa:secret
     Green-API (the DSW Wing WhatsApp linked like WhatsApp Web, no Facebook needed):
       GREEN_URL    apiUrl from the Green-API console, e.g. https://7105.api.greenapi.com
       GREEN_ID     idInstance
       GREEN_TOKEN  apiTokenInstance
     or the official WhatsApp Cloud API (needs a verified Meta business):
       WA_TOKEN, WA_PHONE_ID, WA_WABA_ID
     WA_VERIFY      a secret word the app's setup command uses; also guards the webhook
   ===================================================================== */
import { compileReport, fmtReportDate, REQUIRED_SECTIONS, reportPics, PIC_DEFAULTS } from "../app/src/main/assets/report.js";

const SCOPES = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging";
const DHK = 6 * 3600000;
const HALL = ["hallActivities", "maleWing", "femaleWing", "sickness"];
const DSW = ["dswActivities", "tomorrow", "counselling"];
const LABEL = { dswActivities: "DSW Wing activities", tomorrow: "Tomorrow's activities", hallActivities: "Hall activities",
  maleWing: "Male Wing state", femaleWing: "Female Wing state", hostel: "Hostel state", sickness: "Sickness", counselling: "Counselling" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    rememberOrigin(env, ctx, url.origin);
    try {
      if (url.pathname.startsWith("/wapic/")) return await servePic(env, url.pathname);
      if (url.pathname === "/diag") return json(await diag(env));
      if (url.pathname === "/wa") return await waWebhook(req, env, ctx, url);
      if (url.pathname === "/wa/status") return json(await waStatus(env));
      if (url.pathname === "/wa/kick" && req.method === "POST") { ctx.waitUntil(dailyFlow(env).catch(e => console.log("kick", e))); return json({ ok: true }); }
      if (url.pathname === "/wa/setup") return json(await waSetup(env, url.searchParams.get("key") || "", url.origin));
      if (url.pathname === "/privacy") return new Response(PRIVACY, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/push" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (!body.q || typeof body.q !== "string" || !/^[A-Za-z0-9]{6,40}$/.test(body.q)) return json({ ok: false, error: "missing or bad queue id" }, 400);
        return json(await processQueueItem(env, body.q));
      }
      return json({ ok: true, service: "Wing Tasks push server", try: ["/diag"] });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await sweepQueue(env); } catch (e) { console.log("sweep failed", e); }
      try { await deadlineReminders(env); } catch (e) { console.log("reminders failed", e); }
      try { await dailyFlow(env); } catch (e) { console.log("daily flow failed", e); }
      try { await cmdtFlow(env); } catch (e) { console.log("commandant reminder failed", e); }
      let busy = false;
      try { busy = await picsFlow(env); } catch (e) { console.log("report photos failed", e); }
      if (!busy) try { await picCleanup(env); } catch (e) { console.log("photo clean-up failed", e); }
    })());
  },
};

/* ---------------- Google access ---------------- */
let cachedSA = null, cachedToken = null;
function sa(env) {
  if (cachedSA) return cachedSA;
  if (!env.SERVICE_ACCOUNT) throw new Error("SERVICE_ACCOUNT secret is not set");
  const j = JSON.parse(env.SERVICE_ACCOUNT);
  if (!j.client_email || !j.private_key || !j.project_id) throw new Error("SERVICE_ACCOUNT is not a service-account key file");
  return (cachedSA = j);
}
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = s => b64url(new TextEncoder().encode(s));
async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const k = sa(env);
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({ iss: k.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = k.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claim));
  const jwt = head + "." + claim + "." + b64url(sig);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google sign-in failed: " + (j.error_description || j.error || r.status));
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

/* ---------------- Firestore REST helpers ---------------- */
const base = env => `https://firestore.googleapis.com/v1/projects/${sa(env).project_id}/databases/(default)/documents`;
async function fs(env, path, opts = {}) {
  const tok = await accessToken(env);
  const r = await fetch(path.startsWith("http") ? path : base(env) + path, {
    ...opts, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (r.status === 404) return null;
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) { const err = new Error((j.error && j.error.message) || ("Firestore " + r.status)); err.status = r.status; throw err; }
  return j;
}
function val(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("mapValue" in v) return fields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  return null;
}
function fields(f) { const o = {}; for (const k in f) o[k] = val(f[k]); return o; }
const docData = d => d ? { _name: d.name, _id: d.name.split("/").pop(), _updateTime: d.updateTime, ...fields(d.fields || {}) } : null;
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  const m = {}; for (const k in v) m[k] = enc(v[k]); return { mapValue: { fields: m } };
}
const encFields = o => { const f = {}; for (const k in o) f[k] = enc(o[k]); return f; };
async function getDoc(env, path) { return docData(await fs(env, path)); }
async function listDocs(env, path, pageSize = 100) {
  const j = await fs(env, `${path}?pageSize=${pageSize}`);
  return ((j && j.documents) || []).map(docData);
}
async function queryEq(env, collection, field, value) {
  const j = await fs(env, ":runQuery", { method: "POST", body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: collection }],
    where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: enc(value) } }, limit: 30 } }) });
  return (j || []).filter(x => x.document).map(x => docData(x.document));
}
async function setDocFields(env, path, obj) {
  const mask = Object.keys(obj).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  return fs(env, `${path}?${mask}`, { method: "PATCH", body: JSON.stringify({ fields: encFields(obj) }) });
}
/* write nested fields such as {"wa.okAt": 123} without touching the rest of the document.
   cond: "exists=false" or an updateTime, so two runs can never both send */
async function patchPaths(env, path, obj, cond) {
  const root = {};
  for (const k in obj) {
    const parts = k.split("."); let o = root;
    parts.slice(0, -1).forEach(p => { o[p] = o[p] && typeof o[p] === "object" ? o[p] : {}; o = o[p]; });
    o[parts[parts.length - 1]] = obj[k];
  }
  let q = Object.keys(obj).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  if (cond === "exists=false") q += "&currentDocument.exists=false";
  else if (cond === "exists=true") q += "&currentDocument.exists=true";
  else if (cond) q += "&currentDocument.updateTime=" + encodeURIComponent(cond);
  return fs(env, `${path}?${q}`, { method: "PATCH", body: JSON.stringify({ fields: encFields(root) }) });
}
async function addDoc(env, collPath, obj) {
  return fs(env, collPath, { method: "POST", body: JSON.stringify({ fields: encFields(obj) }) });
}

/* ---------------- sending ---------------- */
/* a clear heading for the phone notification, so it is understood at a glance */
function titleFor(tab, text) {
  if (tab === "chat") return /^New task from /.test(text) ? "New task" : / completed: /.test(text) ? "Task completed" : "Task message";
  if (tab === "dm") return "New message";
  if (tab === "daily") return /logged out/i.test(text) ? "WhatsApp disconnected" : "Daily report";
  if (tab === "alarm") return "Daily report is late";
  if (tab === "cmdt") return "Send the report to Commandant Sir";
  if (tab === "callend") return "Missed call";
  return "Wing Tasks";
}
async function sendToEmail(env, email, text, link) {
  const tokens = await queryEq(env, "fcmTokens", "email", email);
  if (!tokens.length) return { sent: 0, errors: [], note: "this person has no phone registered yet" };
  const tok = await accessToken(env);
  let sent = 0; const errors = [];
  const L = link || {};
  const data = { title: titleFor(String(L.tab || ""), String(text || "")), body: String(text || "").slice(0, 300), tab: String(L.tab || ""), id: String(L.id || ""), date: String(L.date || ""), name: String(L.name || "").slice(0, 80), dm: String(L.dm || "").slice(0, 300),
    conv: String(L.conv || "").slice(0, 80), msg: String(L.msg || "").slice(0, 300) };
  const isCall = data.tab === "call" || data.tab === "callend";
  const ttl = isCall ? "40s" : "86400s";   // a call that could not be delivered in time must not ring later
  for (const t of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa(env).project_id}/messages:send`, {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: t._id, data, android: { priority: "HIGH", ttl } } }),
    });
    if (r.ok) { sent++; continue; }
    const j = await r.json().catch(() => ({}));
    const msg = (j.error && j.error.message) || ("FCM " + r.status);
    const code = JSON.stringify(j.error && j.error.details || "");
    if (r.status === 404 || /UNREGISTERED|registration token|not a valid FCM/i.test(msg + code)) {
      await fs(env, `/fcmTokens/${encodeURIComponent(t._id)}`, { method: "DELETE" }).catch(() => {});   // old phone / app removed
    } else errors.push(msg);
  }
  return { sent, errors };
}

/* take one queued message, remove it from the queue, send it (each message is sent once) */
async function processQueueItem(env, id) {
  const d = await getDoc(env, `/pushQueue/${id}`);
  if (!d) return { ok: true, sent: 0, note: "already sent" };
  try {
    await fs(env, `/pushQueue/${id}?currentDocument.updateTime=${encodeURIComponent(d._updateTime)}`, { method: "DELETE" });
  } catch (e) {
    if (e.status === 400 || e.status === 409 || e.status === 412) return { ok: true, sent: 0, note: "already being sent" };
    throw e;
  }
  if (!d.email) return { ok: true, sent: 0, note: "no receiver" };
  try {
    const r = await sendToEmail(env, d.email, d.text, d.link);
    return { ok: true, ...r };
  } catch (e) {
    // put it back so the every-minute check tries again (at most 3 times)
    const tries = (Number(d.tries) || 0) + 1;
    if (tries <= 3) await setDocFields(env, `/pushQueue/${id}`, { email: d.email, text: d.text || "", link: d.link || null, at: d.at || Date.now(), tries }).catch(() => {});
    return { ok: false, error: String(e.message || e) };
  }
}

async function sweepQueue(env) {
  const items = await listDocs(env, "/pushQueue", 100);
  const old = Date.now() - 10000;   // the app sends new ones itself; we pick up anything left behind
  for (const it of items) if (!it.at || it.at < old) await processQueueItem(env, it._id).catch(e => console.log("item", it._id, e.message));
}

/* in-app bell + phone */
async function notifyPerson(env, email, text, link) {
  await addDoc(env, `/notifications/${encodeURIComponent(email)}/items`, { text, link, at: Date.now(), read: false }).catch(() => {});
  await sendToEmail(env, email, text, link).catch(() => {});
}

/* ---------------- daily report reminder ---------------- */
async function deadlineReminders(env) {
  const cfg = (await getDoc(env, "/config/dailyReport")) || {};
  if (cfg.remindersOn === false) return;
  const now = Date.now();
  const today = new Date(now + DHK).toISOString().slice(0, 10);
  const [h, m] = String(cfg.deadline || "22:15").split(":").map(Number);
  const deadline = Date.parse(today + "T00:00:00Z") - DHK + (h || 0) * 3600000 + (m || 0) * 60000;
  if (now < deadline || now > deadline + 3 * 3600000) return;   // only in the 3 hours after the deadline
  const log = (await getDoc(env, "/config/reminderLog")) || {};
  if (log.lastDate === today) return;
  await setDocFields(env, "/config/reminderLog", { lastDate: today, at: now });

  const report = await getDoc(env, `/dailyReports/${today}`);
  if (report && report.finalized) return;
  const done = new Set((await listDocs(env, `/dailyReports/${today}/sections`, 20)).map(s => s._id));
  const missing = [...HALL, ...DSW].filter(k => !done.has(k));

  const members = (await listDocs(env, "/members", 300)).filter(x => x.active !== false);
  const link = { tab: "daily", date: today };
  const [y, mo, d] = today.split("-").map(Number);
  const dateTxt = `${d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo - 1]} ${y}`;
  if (!missing.length) {
    const wa = (await getDoc(env, "/config/whatsapp")) || {};
    if (wa.autoSend !== false && waReady(env) && wa.number) return;   // it will go to WhatsApp by itself
    // everything is in but nobody has finalized it yet: ask the people who can finalize and send it
    for (const mem of members) {
      const role = mem.isAdmin ? "full" : (mem.reportRole || "none");
      if (role !== "full") continue;
      await notifyPerson(env, mem._id, `Daily report ${dateTxt} is ready. Please finalize it and send it on WhatsApp.`, link);
    }
    return;
  }
  for (const mem of members) {
    const email = mem._id;
    const role = mem.isAdmin ? "full" : (mem.reportRole || "none");
    let mine = [];
    if (role === "full") mine = missing;
    else if (role === "hallManager") mine = missing.filter(k => HALL.includes(k));
    else if (role === "contributor") mine = missing.filter(k => (mem.reportSections || []).includes(k));
    if (!mine.length) continue;
    const text = role === "full"
      ? `Daily report ${dateTxt} is not complete. Missing: ${mine.map(k => LABEL[k]).join(", ")}.`
      : `Reminder: please submit ${mine.map(k => LABEL[k]).join(", ")} for the daily report ${dateTxt}.`;
    await notifyPerson(env, email, text, link);
  }
}

/* ---------------- health check ---------------- */
async function diag(env) {
  const out = { ok: false, secret: false, accessToken: false, firestore: false, fcmApi: "not checked", phoneTokensSaved: 0, hint: [] };
  try { sa(env); out.secret = true; out.project = sa(env).project_id; }
  catch (e) { out.hint.push("Add the SERVICE_ACCOUNT secret: " + e.message); return out; }
  try { await accessToken(env); out.accessToken = true; }
  catch (e) { out.hint.push(e.message + ". Download a new service-account key and set the secret again."); return out; }
  try { const t = await listDocs(env, "/fcmTokens", 300); out.firestore = true; out.phoneTokensSaved = t.length; out._first = t[0] && t[0]._id; }
  catch (e) { out.hint.push("Firestore problem: " + e.message); return out; }
  try {
    const tok = await accessToken(env);
    const target = out._first || "test-token-that-does-not-exist";
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa(env).project_id}/messages:send`, {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ validate_only: true, message: { token: target, data: { title: "check" } } }),
    });
    if (r.ok || r.status === 400 || r.status === 404) out.fcmApi = "ok";
    else { const j = await r.json().catch(() => ({})); out.fcmApi = (j.error && j.error.message) || ("HTTP " + r.status);
      out.hint.push("Turn on 'Firebase Cloud Messaging API' in Google Cloud Console for this project."); }
  } catch (e) { out.fcmApi = e.message; }
  delete out._first;
  out.ok = out.secret && out.accessToken && out.firestore && out.fcmApi === "ok";
  return out;
}

/* =====================================================================
   WHATSAPP DAILY REPORT
   - at the send time (Admin sets it, default 10:25 PM) the report goes to the chosen number
   - if a section is missing: alarm on the phones of the people who still owe it + Admin,
     every 5 minutes, at most 6 times; the report goes 2-3 minutes after the last section arrives
   - a free WhatsApp message is used while the person has written to us in the last 24 hours
     (tapping OK opens that window); otherwise a short paid template with a "Show report" button
   ===================================================================== */
const GRAPH = "https://graph.facebook.com/v23.0";
const TEMPLATE = "daily_report_ready";
const GRACE = 150000;            // wait 2.5 minutes after a late section, in case of a quick fix
const ALARM_EVERY = 5 * 60000, ALARM_TIMES = 6;
const provider = env => env.GREEN_ID && env.GREEN_TOKEN ? "green" : (env.WA_TOKEN && env.WA_PHONE_ID ? "meta" : null);
const waReady = env => !!provider(env);

/* ---------- Green-API ---------- */
const greenBase = env => String(env.GREEN_URL || "https://api.green-api.com").trim().replace(/\/+$/, "");
async function green(env, method, body) {
  const r = await fetch(`${greenBase(env)}/waInstance${env.GREEN_ID}/${method}/${env.GREEN_TOKEN}`, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { raw: t }; }
  if (!r.ok) { const e = new Error((j && (j.message || j.error)) || (r.status === 401 || r.status === 403 ? "Green-API: wrong idInstance or token" : "Green-API " + r.status)); e.status = r.status; throw e; }
  return j;
}
async function greenSend(env, to, date, text, kind) {
  const r = await green(env, "sendMessage", { chatId: to + "@c.us", message: text.slice(0, 20000), linkPreview: false, typingTime: 2000 });
  if (!r.idMessage) throw new Error("WhatsApp did not accept the message");
  await remember(env, r.idMessage, date, kind);
  return [r.idMessage];
}
const digits = s => String(s || "").replace(/\D/g, "");
function bdNum(p) {
  let d = digits(p);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("01")) d = "88" + d;
  if (d.length === 10 && d.startsWith("1")) d = "880" + d;
  return d;
}
const dhakaDate = ms => new Date(ms + DHK).toISOString().slice(0, 10);
const atTime = (date, hhmm, dflt) => { const [h, m] = String(hhmm || dflt).split(":").map(Number); return Date.parse(date + "T00:00:00Z") - DHK + (h || 0) * 3600000 + (m || 0) * 60000; };
const prevDate = d => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

async function graph(env, path, body, method) {
  const r = await fetch(GRAPH + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + env.WA_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error((j.error && (j.error.error_user_msg || j.error.message)) || ("WhatsApp " + r.status)); e.code = j.error && j.error.code; e.raw = j.error; throw e; }
  return j;
}
const waMsg = (env, to, msg) => graph(env, `/${env.WA_PHONE_ID}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to, ...msg });
const okButton = (date, text) => ({ type: "interactive", interactive: { type: "button", body: { text }, action: { buttons: [{ type: "reply", reply: { id: "ok:" + date, title: "OK ✓" } }] } } });

async function remember(env, wamid, date, kind) { if (wamid) await setDocFields(env, `/waMsgs/${encodeURIComponent(wamid)}`, { date, at: Date.now(), kind: kind || "final" }).catch(() => {}); }

/* the full report in our own format, with an OK button at the end (needs the 24-hour window) */
async function sendReportText(env, to, date, text) {
  const ids = [];
  if (text.length <= 1024) ids.push((await waMsg(env, to, okButton(date, text))).messages[0].id);
  else {
    ids.push((await waMsg(env, to, { type: "text", text: { body: text.slice(0, 4096), preview_url: false } })).messages[0].id);
    ids.push((await waMsg(env, to, okButton(date, `Daily report ${fmtReportDate(date)} — tap OK once you have seen it.`))).messages[0].id);
  }
  for (const id of ids) await remember(env, id, date);
  return ids;
}
const outsideWindow = e => [131047, 131051, 470].includes(Number(e.code)) || /24 ?hour|re-?engagement|customer service window/i.test(e.message || "");

async function reportTextFor(env, date, rep, secs) {
  if (rep && rep.finalized && rep.finalText) return rep.finalText;
  if (rep && rep.manualText) return rep.manualText;
  const cfg = (await getDoc(env, "/config/dailyReport")) || {};
  const map = {}; secs.forEach(x => { map[x._id] = x; });
  return compileReport(date, map, cfg);
}

async function sendDaily(env, date, rep, secs, wa, who) {
  const to = bdNum(wa.number);
  const path = `/dailyReports/${date}`;
  // lock: only one run may send this report
  try { await patchPaths(env, path, { "wa.status": "sending", "wa.at": Date.now() }, rep ? rep._updateTime : "exists=false"); }
  catch (e) { if ([400, 409, 412].includes(e.status)) return { ok: false, note: "already being sent" }; throw e; }
  const text = await reportTextFor(env, date, rep, secs);
  const fin = rep && rep.finalized ? {} : { date, finalized: true, finalText: text, finalizedBy: "Auto (WhatsApp)", finalizedAt: Date.now() };
  try {
    let via = "text", ids;
    if (provider(env) === "green") ids = await greenSend(env, to, date, text);
    else try { ids = await sendReportText(env, to, date, text); }
    catch (e) {
      if (!outsideWindow(e)) throw e;
      via = "template";
      const r = await waMsg(env, to, { type: "template", template: { name: TEMPLATE, language: { code: "en" }, components: [
        { type: "body", parameters: [{ type: "text", text: fmtReportDate(date) }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "show:" + date }] }] } });
      ids = [r.messages[0].id]; await remember(env, ids[0], date);
    }
    // the day's photos follow the text, a few each minute (see picsFlow), in report order
    const secMap = {}; secs.forEach(x => { secMap[x._id] = x; });
    const picList = provider(env) === "green" ? reportPics(secMap).map(p => p.id) : [];
    await patchPaths(env, path, { ...fin, "wa.status": via === "text" ? "sent" : "waiting", "wa.via": via, "wa.sentAt": Date.now(), "wa.to": to, "wa.by": who || "Auto",
      "wa.error": null, "wa.deliveredAt": null, "wa.readAt": null, "wa.okAt": null, "wa.ids": ids, "sendNowAt": null,
      "wa.picList": picList, "wa.picsDone": 0, "wa.picsError": null, "wa.picsBusy": null });
    return { ok: true, via };
  } catch (e) {
    await patchPaths(env, path, { "wa.status": "failed", "wa.error": String(e.message || e).slice(0, 300), "wa.failedAt": Date.now(), "sendNowAt": null }).catch(() => {});
    return { ok: false, error: String(e.message || e) };
  }
}

/* who still owes which section: Hall Manager, Report Contributors, and the Admin always */
function owesAlarm(mem, missing) {
  if (mem.isAdmin) return missing;
  const role = mem.reportRole || "none";
  if (role === "hallManager") return missing.filter(k => HALL.includes(k));
  if (role === "contributor") return missing.filter(k => (mem.reportSections || []).includes(k));
  return [];   // Full Access people do not get the alarm
}
async function alarms(env, date, rep, missing, sendAt) {
  const now = Date.now(), a = (rep && rep.alarm) || {};
  const count = Number(a.count) || 0;
  if (count >= ALARM_TIMES || now > sendAt + ALARM_EVERY * ALARM_TIMES + 60000) return;
  if (a.lastAt && now - a.lastAt < ALARM_EVERY - 20000) return;
  try { await patchPaths(env, `/dailyReports/${date}`, { "alarm.count": count + 1, "alarm.lastAt": now }, rep ? rep._updateTime : "exists=false"); }
  catch (e) { if ([400, 409, 412].includes(e.status)) return; throw e; }
  const members = (await listDocs(env, "/members", 300)).filter(x => x.active !== false);
  const dt = fmtReportDate(date);
  for (const mem of members) {
    const mine = owesAlarm(mem, missing); if (!mine.length) continue;
    const text = mem.isAdmin
      ? `Daily report ${dt} is late. Still missing: ${mine.map(k => LABEL[k]).join(", ")}.`
      : `Daily report ${dt}: please submit ${mine.map(k => LABEL[k]).join(", ")} now. It goes to WhatsApp as soon as everything is in.`;
    const link = { tab: "alarm", date };
    if (count === 0) await addDoc(env, `/notifications/${encodeURIComponent(mem._id)}/items`, { text, link, at: now, read: false }).catch(() => {});
    await sendToEmail(env, mem._id, text, link).catch(() => {});
  }
}

async function dailyFlow(env) {
  if (!env.SERVICE_ACCOUNT) return;
  const wa = (await getDoc(env, "/config/whatsapp")) || {};
  const legacy = wa.number ? null : await getDoc(env, "/config/dailyReport");
  if (!wa.number && legacy && legacy.waNumber) wa.number = legacy.waNumber;
  const now = Date.now(), today = dhakaDate(now);
  // Auto-send only starts from the moment it is first switched on: old, still-pending days are never sent by themselves.
  if (!wa.autoSince) { wa.autoSince = now; await patchPaths(env, "/config/whatsapp", { autoSince: now }).catch(() => {}); }
  for (const date of [prevDate(today), today]) {
    const sendAt = atTime(date, wa.sendTime, "22:25");
    const rep = await getDoc(env, `/dailyReports/${date}`);
    const w = (rep && rep.wa) || {};
    const manual = rep && rep.sendNowAt && (!w.sentAt || rep.sendNowAt > w.sentAt);
    if (!manual) {
      if (sendAt < Number(wa.autoSince)) continue;
      if (w.sentAt || w.status === "sending") continue;
      if (now < sendAt || now > sendAt + 20 * 3600000) continue;
    }
    const secs = await listDocs(env, `/dailyReports/${date}/sections`, 20);
    const have = new Set(secs.map(x => x._id));
    const missing = REQUIRED_SECTIONS.filter(k => !have.has(k));
    const canSend = waReady(env) && wa.number;
    if (manual) { if (canSend) await sendDaily(env, date, rep, secs, wa, rep.sendNowBy || "Manual"); continue; }
    if (missing.length) { if (wa.alarmOn !== false) await alarms(env, date, rep, missing, sendAt); continue; }
    if (wa.autoSend === false || !canSend) continue;
    const last = Math.max(0, ...secs.map(x => Number(x.updatedAt) || 0), Number(rep && rep.manualAt) || 0, Number(rep && rep.finalEditedAt) || 0);
    if (last >= sendAt && now - last < GRACE) continue;      // a late section just came in: give 2-3 minutes for corrections
    await sendDaily(env, date, rep, secs, wa, "Auto");
  }
  try { await testFlow(env, wa); } catch (e) { console.log("test send failed", e); }
}

/* ---------- TEST sending: to a separate test number, never counts as the real report ----------
   config/whatsapp: testOn, testTime "HH:MM", testNumber, testSince. "Send test now" = dailyReports/<date>.testNowAt.
   The real report, the 10:15 reminder and the late alarm are not affected in any way. */
async function testFlow(env, wa) {
  if (!waReady(env)) return;
  const tn = bdNum(wa.testNumber || ""); if (tn.length < 10) return;
  const now = Date.now(), date = dhakaDate(now);
  const rep = await getDoc(env, `/dailyReports/${date}`);
  const t = (rep && rep.waTest) || {};
  if (t.status === "sending" && now - (Number(t.at) || 0) < 120000) return;
  const manual = !!(rep && rep.testNowAt && (!t.sentAt || rep.testNowAt > t.sentAt));
  const at = atTime(date, wa.testTime, "12:00");
  const auto = !!wa.testOn && now >= at && now < at + 3 * 3600000 && at >= (Number(wa.testSince) || 0) - 60000 && Number(t.autoFor) !== at;
  if (!manual && !auto) return;
  const path = `/dailyReports/${date}`;
  try { await patchPaths(env, path, { "waTest.status": "sending", "waTest.at": now }, rep ? rep._updateTime : "exists=false"); }
  catch (e) { if ([400, 409, 412].includes(e.status)) return; throw e; }
  const who = manual ? (rep.testNowBy || "Manual") : "Test time";
  try {
    const secs = await listDocs(env, `/dailyReports/${date}/sections`, 20);
    const text = await reportTextFor(env, date, rep, secs);
    if (provider(env) === "green") await greenSend(env, tn, date, text, "test");
    else await waMsg(env, tn, { type: "text", text: { body: text.slice(0, 4096), preview_url: false } });
    const secMap = {}; secs.forEach(x => { secMap[x._id] = x; });
    const picList = provider(env) === "green" ? reportPics(secMap).map(p => p.id) : [];
    await patchPaths(env, path, { "waTest.status": "sent", "waTest.sentAt": Date.now(), "waTest.to": tn, "waTest.by": who, "waTest.error": null,
      "waTest.deliveredAt": null, "waTest.readAt": null, "waTest.okAt": null, ...(auto && !manual ? { "waTest.autoFor": at } : {}),
      "waTest.picList": picList, "waTest.picsDone": 0, "waTest.picsError": null, "waTest.picsBusy": null, testNowAt: null });
  } catch (e) {
    await patchPaths(env, path, { "waTest.status": "failed", "waTest.error": String(e.message || e).slice(0, 300), ...(auto && !manual ? { "waTest.autoFor": at } : {}), testNowAt: null }).catch(() => {});
  }
}

/* ---------- report photos: sent after the text, without captions, in report order ----------
   Green-API fetches each photo from a secret link on this server: /wapic/<date>/<file id>/<key>.
   A few go each minute so the free plan's request limit is never reached; a failed one is skipped. */
let selfOrigin = "";
function rememberOrigin(env, ctx, origin) {
  try {                                           // never let this get in the way of the real request
    if (!origin || !/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1/.test(origin) || origin === selfOrigin) return;
    selfOrigin = origin;
    if (!env.SERVICE_ACCOUNT) return;
    const job = setDocFields(env, "/config/waState", { selfUrl: origin }).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  } catch (e) {}
}
async function myOrigin(env) {
  if (env.WORKER_URL) return String(env.WORKER_URL).replace(/\/+$/, "");
  if (selfOrigin) return selfOrigin;
  const st = (await getDoc(env, "/config/waState")) || {};
  if (st.selfUrl) return (selfOrigin = st.selfUrl);
  const pc = (await getDoc(env, "/config/push")) || {};
  return pc.workerUrl ? (selfOrigin = String(pc.workerUrl).replace(/\/+$/, "")) : "";
}
async function picKey(env, date, fid) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("wapic:" + (env.WA_VERIFY || env.GREEN_TOKEN || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(date + "/" + fid)));
  return [...mac].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function servePic(env, pathname) {
  const m = pathname.match(/^\/wapic\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]{2,40})\/([0-9a-f]{32})$/);
  if (!m || !(env.WA_VERIFY || env.GREEN_TOKEN)) return new Response("not found", { status: 404 });
  if (m[3] !== await picKey(env, m[1], m[2])) return new Response("not found", { status: 404 });
  const first = await getDoc(env, `/dailyReports/${m[1]}/files/${m[2]}_0`);
  if (!first || !first.data) return new Response("gone", { status: 410 });
  const parts = [first.data];
  for (let i = 1; i < (Number(first.n) || 1); i++) { const d = await getDoc(env, `/dailyReports/${m[1]}/files/${m[2]}_${i}`); if (!d) return new Response("gone", { status: 410 }); parts.push(d.data); }
  const bin = atob(parts.join("")), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Response(out, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=600" } });
}
const PICS_PER_MINUTE = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function picsFlow(env) {
  if (!env.SERVICE_ACCOUNT || provider(env) !== "green") return false;
  const today = dhakaDate(Date.now());
  for (const date of [prevDate(today), today]) for (const F of ["wa", "waTest"]) {
    const rep = await getDoc(env, `/dailyReports/${date}`);
    const w = (rep && rep[F]) || {}, list = Array.isArray(w.picList) ? w.picList : [];
    const done = Number(w.picsDone) || 0;
    if (w.status !== "sent" || done >= list.length) continue;
    if (w.picsBusy && Date.now() - w.picsBusy < 120000) return true;          // another run is sending them
    try { await patchPaths(env, `/dailyReports/${date}`, { [F + ".picsBusy"]: Date.now() }, rep._updateTime); }
    catch (e) { if ([400, 409, 412].includes(e.status)) return true; throw e; }
    const origin = await myOrigin(env), to = w.to || bdNum(((await getDoc(env, "/config/whatsapp")) || {}).number);
    let i = done, err = null;
    if (!origin) err = "The server does not know its own address yet. Open the app once, then tap Send again.";
    else for (; i < list.length && i < done + PICS_PER_MINUTE; i++) {
      try {
        const r = await green(env, "sendFileByUrl", { chatId: to + "@c.us", urlFile: `${origin}/wapic/${date}/${list[i]}/${await picKey(env, date, list[i])}`, fileName: `photo-${i + 1}.jpg` });
        if (!r.idMessage) throw new Error("WhatsApp did not accept the photo");
      } catch (e) { err = `Photo ${i + 1}: ` + String(e.message || e).slice(0, 200); }
      if (i + 1 < list.length) await sleep(700);
    }
    await patchPaths(env, `/dailyReports/${date}`, { [F + ".picsDone"]: err && !origin ? done : i, [F + ".picsBusy"]: null, ...(err ? { [F + ".picsError"]: err } : {}) }).catch(() => {});
    return true;
  }
  return false;
}
/* photos are removed some days after their report (the text stays forever); a little each minute, 03:00–05:00 Dhaka time */
async function picCleanup(env) {
  if (!env.SERVICE_ACCOUNT) return;
  const now = Date.now(), hour = new Date(now + DHK).getUTCHours();
  if (hour < 3 || hour >= 5) return;
  const cfg = (await getDoc(env, "/config/dailyReport")) || {};
  const keep = Math.max(1, Math.min(365, Number(cfg.picKeepDays) || PIC_DEFAULTS.picKeepDays));
  const today = dhakaDate(now), addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const last = addDays(today, -keep - 1);                       // newest date whose photos may go
  const log = (await getDoc(env, "/config/picCleanLog")) || {};
  let cur = log.done && log.done < last ? addDays(log.done, 1) : (log.done ? null : addDays(last, -45));
  if (!cur || cur > last) return;
  const files = await listDocs(env, `/dailyReports/${cur}/files`, 25);
  for (const f of files) await fs(env, `/dailyReports/${cur}/files/${encodeURIComponent(f._id)}`, { method: "DELETE" }).catch(() => {});
  if (files.length) await patchPaths(env, `/dailyReports/${cur}`, { picsDeleted: true, picsDeletedAt: now }, "exists=true").catch(() => {});
  if (files.length < 25) await setDocFields(env, "/config/picCleanLog", { done: cur, at: now });
}

/* ---------- reminder: the report must also be passed on to the Commandant ----------
   config/commandant = { on, time "HH:MM", to: [emails], afterSent (default true), since }
   Rings the chosen people every 5 minutes (6 times at most) from the set time until someone taps Done. */
const CMDT_EVERY = 5 * 60000, CMDT_TIMES = 6;
async function cmdtFlow(env) {
  if (!env.SERVICE_ACCOUNT) return;
  const c = await getDoc(env, "/config/commandant");
  if (!c || !c.on) return;
  const to = (Array.isArray(c.to) ? c.to : []).map(x => String(x || "").trim().toLowerCase()).filter(Boolean);
  if (!to.length) return;
  const now = Date.now(), date = dhakaDate(now), at = atTime(date, c.time, "22:45");
  if (now < at || now > at + 3 * 3600000) return;
  if (Number(c.since) && at < Number(c.since) - 60000) return;          // switched on after today's time: start tomorrow
  const rep = await getDoc(env, `/dailyReports/${date}`);
  const sent = rep && ((rep.wa && rep.wa.sentAt) || rep.finalized || rep.waOpenedAt);
  if (c.afterSent !== false && !sent) return;                            // nothing to pass on yet
  const k = (rep && rep.cmdt) || {};
  if (k.doneAt) return;
  const count = Number(k.count) || 0;
  if (count >= CMDT_TIMES) return;
  if (k.lastAt && now - k.lastAt < CMDT_EVERY - 20000) return;
  try { await patchPaths(env, `/dailyReports/${date}`, { "cmdt.count": count + 1, "cmdt.lastAt": now }, rep ? rep._updateTime : "exists=false"); }
  catch (e) { if ([400, 409, 412].includes(e.status)) return; throw e; }
  const text = `The daily report of ${fmtReportDate(date)} has not been sent to the Commandant yet. Please send it now and tap Done.`;
  const link = { tab: "cmdt", date };
  for (const email of to) {
    if (count === 0) await addDoc(env, `/notifications/${encodeURIComponent(email)}/items`, { text, link, at: now, read: false }).catch(() => {});
    await sendToEmail(env, email, text, link).catch(() => {});
  }
}

/* ---------- webhook: Meta tells us about button taps, replies and delivered / read ---------- */
async function checkSig(req, env, raw) {
  if (!env.WA_APP_SECRET) return true;
  const sig = (req.headers.get("x-hub-signature-256") || "").replace("sha256=", "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return [...mac].map(b => b.toString(16).padStart(2, "0")).join("") === sig;
}
async function waWebhook(req, env, ctx, url) {
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && env.WA_VERIFY && url.searchParams.get("hub.verify_token") === env.WA_VERIFY)
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  const raw = await req.text();
  let body = {}; try { body = JSON.parse(raw); } catch (e) {}
  if (body && body.typeWebhook) {      // Green-API
    const auth = (req.headers.get("authorization") || "").replace(/^(Bearer|Basic)\s+/i, "");
    if (!env.WA_VERIFY || auth !== env.WA_VERIFY) return new Response("forbidden", { status: 403 });
    ctx.waitUntil(handleGreen(env, body).catch(e => console.log("green hook", e)));
    return new Response("ok");
  }
  if (!(await checkSig(req, env, raw))) return new Response("bad signature", { status: 401 });
  ctx.waitUntil(handleWa(env, body).catch(e => console.log("wa hook", e)));
  return new Response("ok");
}
async function handleWa(env, body) {
  const wa = (await getDoc(env, "/config/whatsapp")) || {};
  const boss = bdNum(wa.number);
  for (const entry of body.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const st of v.statuses || []) {
      const m = await getDoc(env, `/waMsgs/${encodeURIComponent(st.id)}`); if (!m || !m.date) continue;
      const t = (Number(st.timestamp) || Date.now() / 1000) * 1000;
      if (st.status === "delivered") await patchPaths(env, `/dailyReports/${m.date}`, { "wa.deliveredAt": t }).catch(() => {});
      else if (st.status === "read") await patchPaths(env, `/dailyReports/${m.date}`, { "wa.readAt": t }).catch(() => {});
      else if (st.status === "failed") await patchPaths(env, `/dailyReports/${m.date}`, { "wa.status": "failed", "wa.error": String((st.errors && st.errors[0] && (st.errors[0].error_data && st.errors[0].error_data.details || st.errors[0].title)) || "Not delivered").slice(0, 300) }).catch(() => {});
    }
    for (const msg of v.messages || []) {
      const from = digits(msg.from);
      if (boss && from !== boss) continue;          // only the report receiver can use the buttons
      await setDocFields(env, "/config/waState", { lastInboundAt: Date.now(), lastFrom: from }).catch(() => {});
      const payload = (msg.button && msg.button.payload) || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.id) || "";
      const [kind, date] = payload.split(":");
      if (kind === "ok" && /^\d{4}-\d\d-\d\d$/.test(date || "")) await patchPaths(env, `/dailyReports/${date}`, { "wa.okAt": Date.now(), "wa.status": "sent" }).catch(() => {});
      if (kind === "show" && /^\d{4}-\d\d-\d\d$/.test(date || "")) {
        const rep = await getDoc(env, `/dailyReports/${date}`);
        const secs = await listDocs(env, `/dailyReports/${date}/sections`, 20);
        const text = await reportTextFor(env, date, rep, secs);
        const ids = await sendReportText(env, from, date, text);
        await patchPaths(env, `/dailyReports/${date}`, { "wa.status": "sent", "wa.shownAt": Date.now(), "wa.ids": [...((rep && rep.wa && rep.wa.ids) || []), ...ids] }).catch(() => {});
      }
    }
  }
}

async function handleGreen(env, b) {
  const t = b.typeWebhook;
  if (t === "outgoingMessageStatus" || t === "outgoingAPIMessageReceived") {
    if (!b.idMessage || !b.status) return;
    const m = await getDoc(env, `/waMsgs/${encodeURIComponent(b.idMessage)}`); if (!m || !m.date) return;
    const at = (Number(b.timestamp) || Date.now() / 1000) * 1000, path = `/dailyReports/${m.date}`;
    const F = m.kind === "test" ? "waTest" : "wa";
    if (b.status === "delivered") await patchPaths(env, path, { [F + ".deliveredAt"]: at }).catch(() => {});
    else if (b.status === "read") await patchPaths(env, path, { [F + ".readAt"]: at }).catch(() => {});
    else if (["failed", "noAccount", "suspended"].includes(b.status))
      await patchPaths(env, path, { [F + ".status"]: "failed", [F + ".error"]: b.status === "noAccount" ? "That number has no WhatsApp" : String(b.description || "Not delivered").slice(0, 300) }).catch(() => {});
    return;
  }
  if (t === "stateInstanceChanged") {
    const st = String(b.stateInstance || "");
    await setDocFields(env, "/config/waState", { state: st, stateAt: Date.now(), ready: st === "authorized" }).catch(() => {});
    if (st && st !== "authorized" && st !== "starting") {
      const members = (await listDocs(env, "/members", 300).catch(() => [])).filter(x => x.isAdmin);
      for (const a of members) await notifyPerson(env, a._id, "The DSW Wing WhatsApp was logged out, so reports cannot go automatically. Open the Green-API console and scan the QR code again with the WhatsApp of that number.", { tab: "daily" });
    }
    return;
  }
  if (t === "incomingMessageReceived") {
    const wa = (await getDoc(env, "/config/whatsapp")) || {};
    const from = digits((b.senderData && (b.senderData.sender || b.senderData.chatId)) || "");
    if (from && wa.testNumber && from === bdNum(wa.testNumber) && from !== bdNum(wa.number)) {   // a reply to a test
      const today = dhakaDate(Date.now()), rep = await getDoc(env, `/dailyReports/${today}`);
      if (rep && rep.waTest && rep.waTest.sentAt && !rep.waTest.okAt) await patchPaths(env, `/dailyReports/${today}`, { "waTest.okAt": Date.now() }).catch(() => {});
      return;
    }
    if (!from || from !== bdNum(wa.number)) return;     // only the report receiver counts
    await setDocFields(env, "/config/waState", { lastInboundAt: Date.now(), lastFrom: from, ready: true, state: "authorized" }).catch(() => {});
    // any reply (text, 👍, "ok") marks the latest sent report as acknowledged
    const now = Date.now(), today = dhakaDate(now);
    for (const date of [today, prevDate(today)]) {
      const rep = await getDoc(env, `/dailyReports/${date}`);
      if (rep && rep.wa && rep.wa.sentAt && !rep.wa.okAt && now - rep.wa.sentAt < 30 * 3600000) { await patchPaths(env, `/dailyReports/${date}`, { "wa.okAt": now }); break; }
    }
  }
}

/* ---------- status for the app + one-time setup ---------- */
async function waStatus(env) {
  const out = { ready: waReady(env), provider: provider(env), verify: !!env.WA_VERIFY, phone: null, error: null, windowOpenUntil: null, state: null };
  if (out.provider === "green") {
    try {
      const st = await green(env, "getStateInstance"); out.state = st.stateInstance;
      out.ready = st.stateInstance === "authorized";
      if (!out.ready) out.error = st.stateInstance === "notAuthorized" ? "The WhatsApp is not linked. Open the Green-API console and scan the QR code." : "WhatsApp state: " + st.stateInstance;
      else { const w = await green(env, "getWaSettings").catch(() => ({})); out.phone = { number: w.phone ? "+" + w.phone : "", name: "" }; }
      await setDocFields(env, "/config/waState", { ready: out.ready, state: out.state || "", checkedAt: Date.now() }).catch(() => {});
    } catch (e) { out.ready = false; out.error = String(e.message || e); }
    return out;
  }
  try {
    const st = (await getDoc(env, "/config/waState")) || {};
    if (st.lastInboundAt) out.windowOpenUntil = st.lastInboundAt + 24 * 3600000;
    if (out.ready) { const p = await graph(env, `/${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating`); out.phone = { number: p.display_phone_number, name: p.verified_name, quality: p.quality_rating }; }
  } catch (e) { out.error = String(e.message || e); }
  return out;
}
async function waSetup(env, key, origin) {
  if (!env.WA_VERIFY || key !== env.WA_VERIFY) return { ok: false, error: "wrong or missing key (run: npm run wa:setup)" };
  const steps = [];
  const step = async (name, fn) => { try { steps.push({ name, ok: true, detail: await fn() }); } catch (e) { steps.push({ name, ok: false, detail: String(e.message || e) }); } };
  if (provider(env) === "green") {
    await step("Green-API account", async () => { const s = await green(env, "getStateInstance"); if (s.stateInstance !== "authorized") throw new Error(s.stateInstance === "notAuthorized" ? "WhatsApp is not linked yet: scan the QR code in the Green-API console" : "state: " + s.stateInstance); return "WhatsApp linked"; });
    await step("WhatsApp number", async () => { const w = await green(env, "getWaSettings"); return w.phone ? "+" + w.phone : "unknown"; });
    await step("Delivered / read / replies come back to the server", async () => {
      await green(env, "setSettings", { webhookUrl: origin + "/wa", webhookUrlToken: "Bearer " + env.WA_VERIFY, incomingWebhook: "yes", outgoingAPIMessageWebhook: "yes",
        outgoingMessageWebhook: "no", stateWebhook: "yes", markIncomingMessagesReaded: "no" });
      return origin + "/wa";
    });
    const wa = (await getDoc(env, "/config/whatsapp")) || {};
    if (wa.number) await step("Report receiver has WhatsApp", async () => { const c = await green(env, "checkWhatsapp", { phoneNumber: Number(bdNum(wa.number)) }); if (c.existsWhatsapp === false) throw new Error("+" + bdNum(wa.number) + " has no WhatsApp"); return "+" + bdNum(wa.number); });
    await setDocFields(env, "/config/waState", { setupAt: Date.now(), ready: steps.every(s => s.ok), provider: "green" }).catch(() => {});
    return { ok: steps.every(s => s.ok), steps };
  }
  await step("Token and phone number", async () => { const p = await graph(env, `/${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,code_verification_status,quality_rating`); return `${p.verified_name || ""} ${p.display_phone_number || ""} (${p.code_verification_status || "?"})`; });
  if (env.WA_WABA_ID) {
    await step("Connect webhook to the WhatsApp account", async () => { await graph(env, `/${env.WA_WABA_ID}/subscribed_apps`, {}); return "connected"; });
    await step("Report template", async () => {
      const list = await graph(env, `/${env.WA_WABA_ID}/message_templates?name=${TEMPLATE}&fields=name,status,language`);
      const have = (list.data || []).find(t => t.name === TEMPLATE);
      if (have) return "already there: " + have.status;
      const r = await graph(env, `/${env.WA_WABA_ID}/message_templates`, { name: TEMPLATE, language: "en", category: "UTILITY", components: [
        { type: "BODY", text: "DSW Wing daily report for {{1}} is ready. Tap Show report to read it.", example: { body_text: [["2 Nov 2026"]] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Show report" }] }] });
      return "sent to Meta for approval: " + (r.status || "PENDING");
    });
  } else steps.push({ name: "WhatsApp Business Account ID", ok: false, detail: "WA_WABA_ID is not set (npm run wa:secret)" });
  await setDocFields(env, "/config/waState", { setupAt: Date.now(), ready: steps.every(s => s.ok) }).catch(() => {});
  return { ok: steps.every(s => s.ok), steps };
}

const PRIVACY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wing Tasks privacy</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6"><h1>Wing Tasks — privacy</h1>
<p>Wing Tasks is an internal tool of the DSW Wing. It sends the daily report by WhatsApp to one number chosen by the Wing's Admin.</p>
<p>We store only what the Wing's members enter in the app, and the time a WhatsApp message was delivered, read or acknowledged. Nothing is sold or shared.</p>
<p>Contact: dswwingtaskapk@gmail.com</p></body>`;
