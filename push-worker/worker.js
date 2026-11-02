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
   ===================================================================== */

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
    try {
      if (url.pathname === "/diag") return json(await diag(env));
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
async function addDoc(env, collPath, obj) {
  return fs(env, collPath, { method: "POST", body: JSON.stringify({ fields: encFields(obj) }) });
}

/* ---------------- sending ---------------- */
async function sendToEmail(env, email, text, link) {
  const tokens = await queryEq(env, "fcmTokens", "email", email);
  if (!tokens.length) return { sent: 0, errors: [], note: "this person has no phone registered yet" };
  const tok = await accessToken(env);
  let sent = 0; const errors = [];
  const data = { title: "Wing Tasks", body: String(text || "").slice(0, 300), tab: String((link && link.tab) || ""), id: String((link && link.id) || ""), date: String((link && link.date) || "") };
  for (const t of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa(env).project_id}/messages:send`, {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: t._id, data, android: { priority: "HIGH", ttl: "86400s" } } }),
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
  const old = Date.now() - 30000;   // the app sends new ones itself; we pick up anything left behind
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
  if (!missing.length) return;

  const members = (await listDocs(env, "/members", 300)).filter(x => x.active !== false);
  const link = { tab: "daily", date: today };
  const [y, mo, d] = today.split("-").map(Number);
  const dateTxt = `${d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo - 1]} ${y}`;
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
