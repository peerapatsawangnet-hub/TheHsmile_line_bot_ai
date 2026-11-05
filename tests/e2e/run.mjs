// End-to-end check of the built bot against local mocks of LINE, Gemini/Vertex, Google Calendar,
// Sheets and Telegram. No real service is called and every key here is fake.
// Run after `next build`:  node tests/e2e/run.mjs [--vertex] [--telegram]   (or `npm run test:e2e`)
// Uses ports 3456 (bot) and 3457 (mocks).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "../..");
const SECRET = "test-secret";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const events = new Map();
let hoursCsv = "";
let lastListQuery = "";
let nextId = 1;
const pushes = [];
const replies = [];
// TG=1: admin notices go to the Telegram mock instead of the LINE group
const TG = process.argv.includes("--telegram");
const VERTEX = process.argv.includes("--vertex");
// the bot under test must only see the fake settings below, never real ones from the shell
for (const key of ["VERTEX_PROJECT_ID", "VERTEX_LOCATION", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
  "PATIENTS_SHEET_TAB", "DOCTOR_SCHEDULE_CSV_URL", "ADMIN_GROUP_ID"]) delete process.env[key];
if (VERTEX) process.env.VERTEX_PROJECT_ID = "test-project";
const tgCalls = [];
let tgDown = false;
let patientReads = 0;
let patientsDown = false;
let lastPatientRanges = [];
let calendarFails = false;
let hideBusyOnce = false;
let insertRival = null;
let createdClock = Date.now();
let servicesCsv = "service,duration_minutes,active,needs_doctor\nขูดหินปูน,15,TRUE,FALSE\nรักษาราก,60,,\nปิดอยู่,15,FALSE,\n";
// settings tab unreachable until the extra suite checks the cold-start fallback
let settingsDown = true;
let settingsCsv = "key,value\nbot_enabled,TRUE\nbot_mode,live\n";
const faqCsv = "category,question,answer,active\nเวลา,เปิดกี่โมง,เปิด 10:00-19:00 น.,TRUE\n";
// Gemini mock: question -> classification, or "500" / "maxtokens" / "badjson"
const plan = new Map();
let geminiCalls = 0;
let lastGeminiBody = null;
let lastGeminiPath = "";
let lastGeminiAuth = "";
let lastGeminiKey = "";
let lastDoctorQuery = "";
const cls = (intent, extra = {}) => ({ intent, confidence: "high", found_in_faq: false, reply: "", multiple_patients: false, ...extra });

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const live = () => [...events.values()].filter((e) => e.status !== "cancelled");
const dt = (e) => e.start?.dateTime ?? `${e.start?.date}T00:00:00+07:00`;
const dtEnd = (e) => e.end?.dateTime ?? `${e.end?.date}T23:59:00+07:00`;

const mock = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/services") return res.end(servicesCsv);
  if (p === "/faq") return res.end(faqCsv);
  if (p === "/settings") { if (settingsDown) return json(res, 500, {}); return res.end(settingsCsv); }
  if (p.includes(":generateContent")) {
    geminiCalls++;
    lastGeminiBody = JSON.parse(body);
    lastGeminiPath = p;
    lastGeminiAuth = req.headers.authorization ?? "";
    lastGeminiKey = req.headers["x-goog-api-key"] ?? "";
    const userText = lastGeminiBody.contents?.[0]?.parts?.[0]?.text ?? "";
    const question = userText.split("<question>\n")[1]?.split("\n</question>")[0] ?? "";
    const step = plan.get(question) ?? cls("other");
    if (step === "500") return json(res, 500, { error: { code: 500, message: "boom", status: "INTERNAL" } });
    if (step === "503") return json(res, 503, { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } });
    if (step?.once503 && !step.done) { step.done = true; return json(res, 503, { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }); }
    if (step?.once503) return json(res, 200, { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(step.once503) }] }, finishReason: "STOP" }], usageMetadata: {} });
    const finishReason = step === "maxtokens" ? "MAX_TOKENS" : "STOP";
    const out = step === "badjson" ? "{not json" : step === "maxtokens" ? "" : JSON.stringify(step);
    return json(res, 200, { candidates: [{ content: { role: "model", parts: [{ text: out }] }, finishReason }], usageMetadata: { thoughtsTokenCount: 5, candidatesTokenCount: 7 } });
  }
  if (p === "/v2/bot/message/quota") return json(res, 200, { type: "limited", value: 300 });
  if (p === "/v2/bot/message/quota/consumption") return json(res, 200, { totalUsage: 250 });
  if (p === "/hours") return res.end(hoursCsv);
  if (p === "/token") return json(res, 200, { access_token: "tok", expires_in: 3600, token_type: "Bearer" });

  if (p.startsWith("/calendar/") || p.startsWith("/token")) {
    if (calendarFails) return json(res, 500, { error: { message: "boom" } });
  }
  if (p === "/calendar/v3/freeBusy") {
    const parsed = JSON.parse(body);
    if (hideBusyOnce) { hideBusyOnce = false; return json(res, 200, { calendars: { [parsed.items[0].id]: { busy: [] } } }); }
    const busy = live().filter((e) => e.transparency !== "transparent")
      .map((e) => ({ start: new Date(e.start.dateTime).toISOString(), end: new Date(e.end.dateTime).toISOString() }));
    return json(res, 200, { calendars: { [parsed.items[0].id]: { busy } } });
  }
  const m = p.match(/^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/(.+))?$/);
  if (m) {
    const id = m[1] && decodeURIComponent(m[1]);
    if (req.method === "POST") {
      const ev = { ...JSON.parse(body), id: `ev${nextId++}`, created: new Date(createdClock += 1000).toISOString() };
      events.set(ev.id, ev);
      if (insertRival) {
        const rival = { id: `rival${nextId++}`, status: "confirmed", start: ev.start, end: ev.end, created: new Date(createdClock - 500).toISOString() };
        events.set(rival.id, rival);
        insertRival = null;
      }
      return json(res, 200, ev);
    }
    if (req.method === "GET" && id) return events.get(id) ? json(res, 200, events.get(id)) : json(res, 404, { error: {} });
    if (req.method === "GET") {
      const qtext = url.searchParams.get("q");
      if (qtext) lastDoctorQuery = url.search;
      else lastListQuery = url.search;
      // Google rejects RFC3339 hour 24
      if (/T24:/.test(url.searchParams.get("timeMin") ?? "") || /T24:/.test(url.searchParams.get("timeMax") ?? "")) return json(res, 400, { error: { message: "Bad Request" } });
      const prop = url.searchParams.get("privateExtendedProperty");
      const min = url.searchParams.get("timeMin");
      const max = url.searchParams.get("timeMax");
      const items = live().filter((e) => {
        if (prop) { const [k, v] = prop.split("="); if (e.extendedProperties?.private?.[k] !== v) return false; }
        if (qtext && !(e.summary ?? "").includes(qtext)) return false;
        if (min && Date.parse(dtEnd(e)) <= Date.parse(min)) return false;
        if (max && Date.parse(dt(e)) >= Date.parse(max)) return false;
        return true;
      });
      return json(res, 200, { items });
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(body), cur = events.get(id);
      if (patch.extendedProperties) {
        const merged = { ...cur.extendedProperties.private, ...patch.extendedProperties.private };
        for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
        patch.extendedProperties = { private: merged };
      }
      events.set(id, { ...cur, ...patch });
      return json(res, 200, events.get(id));
    }
    if (req.method === "DELETE") { events.get(id).status = "cancelled"; res.writeHead(204); return res.end(); }
  }
  // patient sheet with one tab per month; the bot must read them all
  if (p === "/v4/spreadsheets/psheet") {
    if (patientsDown) return json(res, 403, { error: { code: 403, message: "The caller does not have permission" } });
    return json(res, 200, { sheets: ["ตุลาคม 2569", "พฤศจิกายน 2569", "สรุป"].map((title) => ({ properties: { title } })) });
  }
  if (p === "/v4/spreadsheets/psheet/values:batchGet") {
    patientReads++;
    lastPatientRanges = url.searchParams.getAll("ranges");
    return json(res, 200, { valueRanges: [
      { values: [["No", "DN", "Name", "Phone NO.", "Status"], ["1", "680001", "คนไข้ ตุลา", "081-000-0001", ""]] },
      { values: [["คนไข้จัดฟัน พ.ย."], ["No", "DN", "Name", "Phone NO.", "Status"], ["1", "680099", "ทดสอบ ดีเอ็น", "087-000-0001", "active"]] },
      { values: [["ยอดรวม", "12"]] },
    ] });
  }
  // Telegram mock: record as admin pushes in the same shape the LINE checks read
  const tg = p.match(/^\/bottgtok\/(\w+)$/);
  if (tg) {
    const b = JSON.parse(body);
    tgCalls.push({ method: tg[1], body: b });
    if (tgDown) return json(res, 429, { ok: false, description: "Too Many Requests" });
    if (tg[1] === "sendMessage") {
      const buttons = b.reply_markup?.inline_keyboard?.[0];
      const msg = buttons
        ? { type: "flex", text: b.text, contents: { footer: { contents: buttons.map((x) => ({ action: { data: x.callback_data } })) } } }
        : { type: "text", text: b.text };
      pushes.push({ to: "Cadmin", tg: b, messages: [msg] });
    }
    if (tg[1] === "sendPhoto") pushes.push({ to: "Cadmin", tg: b, messages: [{ type: "image", originalContentUrl: b.photo }] });
    return json(res, 200, { ok: true, result: { message_id: 1 } });
  }
  if (p.includes("/v2/bot/profile/")) return json(res, 200, { displayName: "คุณทดสอบ", userId: "x" });
  if (p.includes("/v2/bot/message/push")) { pushes.push(JSON.parse(body)); return json(res, 200, {}); }
  if (p.includes("/v2/bot/message/reply")) { replies.push(JSON.parse(body)); return json(res, 200, {}); }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(3457, "127.0.0.1", r));

let logs = "";
const server = spawn(process.execPath, [join(projectDir, "node_modules/next/dist/bin/next"), "start", "-p", "3456"], {
  cwd: projectDir,
  env: {
    ...process.env,
    NODE_OPTIONS: `--require ${JSON.stringify(join(here, "preload.cjs"))}`,
    LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: "t", GEMINI_API_KEY: "k", CRON_SECRET: "cron-test",
    SHEET_CSV_URL: "http://127.0.0.1:3457/faq", ADMIN_GROUP_ID: "Cadmin", SETTINGS_CSV_URL: "http://127.0.0.1:3457/settings",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@test.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    GOOGLE_CALENDAR_ID: "clinic@group.calendar.google.com",
    SERVICES_CSV_URL: "http://127.0.0.1:3457/services",
    HOURS_CSV_URL: "http://127.0.0.1:3457/hours",
    PATIENTS_SHEET_ID: "psheet",
    ...(TG ? { TELEGRAM_BOT_TOKEN: "tgtok", TELEGRAM_CHAT_ID: "-100", TELEGRAM_WEBHOOK_SECRET: "tgsec" } : {}),
  },
});
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && !logs.includes("Ready"); i++) await sleep(500);

async function send(event) {
  const body = JSON.stringify({ destination: "x", events: [event] });
  const n = replies.length;
  const res = await fetch("http://127.0.0.1:3456/api/line-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": createHmac("sha256", SECRET).update(body).digest("base64") },
    body,
  });
  return { status: res.status, msg: replies.length > n ? replies.at(-1).messages[0] : null };
}
const user = (u) => ({ type: "user", userId: u });
const text = (t, u = "Usecret1") => send({ type: "message", replyToken: "t", source: user(u), message: { type: "text", id: "1", text: t } });
const pb = (data, source = user("Usecret1")) => send({ type: "postback", replyToken: "t", source, postback: { data } });
const items = (m) => m?.quickReply?.items?.map((i) => i.action) ?? [];

let failed = 0;
const check = (name, pass, extra = "") => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
};
const admin = { type: "group", groupId: "Cadmin", userId: "Uadmin" };
const tgUpdate = (update, secret = "tgsec") => fetch("http://127.0.0.1:3456/api/telegram-webhook", {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
  body: JSON.stringify(update),
});
const tgTap = (data, chatId = -100) => tgUpdate({
  callback_query: { id: "cb1", data, from: { first_name: "หมอ" }, message: { message_id: 7, chat: { id: chatId, type: "supergroup" } } },
});
// admin taps confirm/reject: LINE group postback, or Telegram button
const adminPb = async (data) => {
  if (!TG) return pb(data, admin);
  const n = pushes.length;
  await tgTap(data);
  return { status: 200, msg: pushes.slice(n).filter((p) => p.to === "Cadmin").at(-1)?.messages[0] ?? null };
};
const custPushes = () => pushes.filter((p) => p.to !== "Cadmin");
const lastCust = () => custPushes().at(-1);
// red alert: LINE mentions everyone, Telegram sends plain text
const isAlert = (m) => TG ? m?.type === "text" && m.text.startsWith("🔴 ด่วน") : m?.type === "textV2";

const OFFSET_MS = 7 * 3600e3;
const dayFromNow = (n) => new Date(Date.now() + OFFSET_MS + n * 86400e3).toISOString().slice(0, 10);
const weekdayOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const find = (pred) => { for (let i = 2; i <= 14; i++) { const d = dayFromNow(i); if (pred(d, i)) return d; } };
const wed = find((d) => weekdayOf(d) === 3);
const closedTue = find((d) => weekdayOf(d) === 2);
const target = find((d) => weekdayOf(d) === 5);
const days = ["จันทร์", "อังคาร", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
hoursCsv = "day,open,close\n" + days.flatMap((d) => [`${d},10:00,12:00`, `${d},13:00,19:00`]).join("\n") +
  `\n${wed},10:00,12:00\n${closedTue},,\n`;

const seed = (date, hhmm, min, extra = {}) => {
  const start = `${date}T${hhmm}:00+07:00`;
  const ev = { id: `seed${nextId++}`, status: "confirmed", summary: "SEED-PRIVATE-TITLE", created: new Date(0).toISOString(),
    start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + min * 60000).toISOString() }, ...extra };
  events.set(ev.id, ev); return ev;
};

let r = await text("อยากจองคิวค่ะ");
let acts = items(r.msg);
check("booking text -> services", acts.length === 2 && acts[0].label === "ขูดหินปูน", acts.map((a) => a.label).join(","));
r = await pb(acts[0].data); acts = items(r.msg);
check("service -> 3 rights", acts.map((a) => a.label).join() === "สปสช (สิทธิบัตรทอง),ประกันสังคม,ชำระเอง", acts.map((a) => a.label).join());
check("postback data within LINE limit", acts.every((a) => a.data.length <= 300), acts[0].data);
r = await pb(acts[0].data); acts = items(r.msg);
check("right -> new/returning", acts.map((a) => a.label).join() === "เคยมาแล้ว,มาครั้งแรก");
r = await pb(acts[1].data); acts = items(r.msg);
check("date buttons <= 13, labels <= 20", acts.length > 0 && acts.length <= 13 && acts.every((a) => a.label.length <= 20), acts.map((a) => a.label).join(" | "));
// 30 days do not fit in one quick reply: last button pages forward
const pageOne = acts.slice(0, -1).map((a) => new URLSearchParams(a.data).get("d"));
check("first date page ends with วันถัดไป", acts.length === 13 && acts.at(-1).label === "วันถัดไป ›", acts.at(-1)?.label);
let page = items((await pb(acts.at(-1).data)).msg);
const pageTwo = [];
while (page.length) {
  const more = page.at(-1).label === "วันถัดไป ›";
  pageTwo.push(...(more ? page.slice(0, -1) : page).map((a) => new URLSearchParams(a.data).get("d")));
  if (!more) break;
  page = items((await pb(page.at(-1).data)).msg);
}
check("next page continues after page one", pageTwo.length > 0 && pageTwo[0] > pageOne.at(-1) && !pageTwo.some((d) => pageOne.includes(d)), `${pageOne.at(-1)} -> ${pageTwo[0]}`);
check("dates reach 30 days ahead, not beyond", pageTwo.at(-1) <= dayFromNow(30) && pageTwo.at(-1) >= dayFromNow(28), pageTwo.at(-1));
const dates = [...pageOne, ...pageTwo];
check("special Wednesday offered", dates.includes(wed), wed);
check("normal Wednesday not offered", !dates.some((d) => weekdayOf(d) === 3 && d !== wed));
check("special closed day not offered", !dates.includes(closedTue), closedTue);

const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("&");
const b15 = { s: "ขูดหินปูน", r: "gold", v: "new" };
const b60 = { s: "รักษาราก", r: "sso", v: "old" };

r = await pb(q({ a: "date", ...b15, d: wed }));
check("special day has morning only", items(r.msg).map((a) => a.label).join() === "ช่วงเช้า");
r = await pb(q({ a: "date", ...b15, d: target })); acts = items(r.msg);
check("period buttons", acts.map((a) => a.label).join() === "ช่วงเช้า,ช่วงบ่าย,ช่วงเย็น");
r = await pb(acts[0].data); acts = items(r.msg);
check("morning every 15 min, none in lunch", acts.map((a) => a.label).join() === "10:00,10:15,10:30,10:45,11:00,11:15,11:30,11:45", acts.map((a) => a.label).join());
r = await pb(q({ a: "period", ...b60, d: target, p: "am" }));
check("60 min must end before lunch", items(r.msg).map((a) => a.label).join() === "10:00,10:15,10:30,10:45,11:00", items(r.msg).map((a) => a.label).join());
r = await pb(q({ a: "period", ...b15, d: target, p: "eve" }));
check("15 min can start 18:45, within 13 buttons", items(r.msg).at(-1).label === "18:45" && items(r.msg).length <= 13, String(items(r.msg).length));

// capacity from existing appointments
seed(target, "13:00", 15); seed(target, "13:15", 15);
seed(target, "14:00", 15);
seed(target, "15:00", 15, { transparency: "transparent" }); seed(target, "15:00", 15, { transparency: "transparent" });
events.set("allday", { id: "allday", status: "confirmed", start: { date: target }, end: { date: target } });
r = await pb(q({ a: "period", ...b15, d: target, p: "pm" }));
let labels = items(r.msg).map((a) => a.label);
check("occupied times are not offered", !labels.includes("13:00") && !labels.includes("13:15") && !labels.includes("14:00"), labels.join(","));
check("afternoon within 13 buttons", items(r.msg).length <= 13, String(items(r.msg).length));
check("next free quarter offered after an appointment", labels.includes("14:15"));
check("free (transparent) events ignored", labels.includes("15:00"));
r = await pb(q({ a: "period", ...b60, d: target, p: "pm" }));
labels = items(r.msg).map((a) => a.label);
check("60 min blocked if any part overlaps", !labels.includes("13:00") && !labels.includes("13:30") && labels.includes("14:15"), labels.join(","));
check("list asks for enough rows and no titles", lastListQuery.includes("maxResults=2500") && !decodeURIComponent(lastListQuery).includes("summary"), decodeURIComponent(lastListQuery).slice(0, 110));

// hold -> details -> admin
const slot = (o, t) => q({ a: "slot", ...o, d: target, p: "pm", t: String(t) });
r = await pb(slot(b15, 14 * 60 + 15));
check("slot -> asks name + phone", r.msg?.text?.includes("ชื่อ-นามสกุล") && r.msg.text.startsWith("เจ้าหน้าที่จะบันทึกการนัดหมาย"), r.msg?.text);
let ev = [...events.values()].find((e) => e.extendedProperties?.private?.lineUserId === "Usecret1");
check("request is gray + tentative at time", ev.status === "tentative" && ev.colorId === "8" && ev.start.dateTime === `${target}T14:15:00+07:00`);
check("hold has correct end", Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime) === 900000);
const pushBefore = pushes.length;

r = await text("ราคาเท่าไหร่");
check("no phone -> asks again", r.msg?.text?.includes("รบกวนพิมพ์") && pushes.length === pushBefore);
r = await text("เบอร์ 0812345678");
check("no name -> asks again", r.msg?.text?.includes("รบกวนพิมพ์"));
r = await text("สมชาย ใจดี 081-234-5678");
check("details -> request sent", r.msg?.text?.includes("แอดมินจะยืนยัน"), r.msg?.text);
ev = events.get(ev.id);
check("title matches clinic format", ev.summary === "[รอแอดมิน] สมชาย ใจดี 0812345678 ขูดหินปูน สปสช คนไข้ใหม่ ไลน์ OA", ev.summary);
check("hold props cleared", !("awaitingDetailsFor" in ev.extendedProperties.private) && !("holdUntil" in ev.extendedProperties.private));
const card = pushes.at(-1);
check("admin card shows details", card.to === "Cadmin" && JSON.stringify(card.messages[0]).includes("สมชาย ใจดี 0812345678"));
const [okBtn] = card.messages[0].contents.footer.contents.map((c) => c.action.data);

r = await text("จองคิว");
check("second booking blocked", r.msg?.text?.includes("มีนัดอยู่แล้ว"), r.msg?.text);
const qr = (r.msg?.quickReply?.items ?? []).map((i) => `${i.action.type}:${i.action.text}`).join();
check("existing booking offers เลื่อนนัด / ยกเลิกนัด buttons", qr === "message:เลื่อนนัด,message:ยกเลิกนัด", qr);
const pushCount = pushes.length;
r = await text("เลื่อนนัด");
const reDates = items(r.msg);
check("tapping เลื่อนนัด -> pick a new date", r.msg?.text?.startsWith("นัดเดิมของคุณคือวัน") && reDates.length > 0 && reDates.every((a) => new URLSearchParams(a.data).get("x") === ev.id), r.msg?.text);
check("reschedule start sends nothing to admin", pushes.length === pushCount);
check("reschedule postback within LINE limit", reDates.every((a) => a.data.length <= 300));
let pc2 = pushes.length;
r = await text("ยกเลิกนัด");
const cxQr = items(r.msg);
check("ยกเลิกนัด -> asks to confirm first", r.msg?.text?.startsWith("ต้องการยกเลิกนัดวัน") && cxQr.map((a) => a.label).join() === "ยกเลิกนัด,ไม่ยกเลิก" && pushes.length === pc2, r.msg?.text);
r = await pb(cxQr[1].data);
check("customer says ไม่ยกเลิก -> nothing changes", r.msg?.text?.includes("ยังอยู่ค่ะ") && !events.get(ev.id).extendedProperties.private.cancelRequested && pushes.length === pc2, r.msg?.text);

// abandon + cancel + expiry
r = await pb(slot(b15, 15 * 60), user("Ucancel"));
const held = [...events.values()].find((e) => e.extendedProperties?.private?.lineUserId === "Ucancel");
r = await text("ยกเลิก", "Ucancel");
check("customer cancels hold", events.get(held.id).status === "cancelled" && r.msg?.text?.includes("ยกเลิก"));

r = await pb(slot(b15, 16 * 60), user("Uexpire"));
const exp = [...events.values()].find((e) => e.extendedProperties?.private?.lineUserId === "Uexpire");
r = await pb(q({ a: "period", ...b15, d: target, p: "eve" }), user("Uother"));
check("active hold counts as a queue", !items(r.msg).some((a) => a.label === "16:00"));
exp.extendedProperties.private.holdUntil = String(Date.now() - 1000);
r = await pb(q({ a: "period", ...b15, d: target, p: "eve" }), user("Uother"));
check("expired hold frees the queue", items(r.msg).some((a) => a.label === "16:00"));
check("expired hold removed from calendar", events.get(exp.id).status === "cancelled");

// race at capacity
insertRival = true;
r = await pb(slot(b15, 17 * 60), user("Urace"));
check("race loser withdraws", !live().some((e) => e.extendedProperties?.private?.lineUserId === "Urace") && r.msg?.text?.includes("คิวเต็ม"), r.msg?.text);

// admin
const before = JSON.stringify(events.get(ev.id));
r = await pb(okBtn);
check("confirm from customer chat ignored", r.msg === null && JSON.stringify(events.get(ev.id)) === before);
r = await pb(okBtn, { type: "group", groupId: "Cother", userId: "x" });
check("confirm from other group ignored", r.msg === null);

const cur = events.get(ev.id);
cur.summary = cur.summary.replace("[รอแอดมิน] ", "[รอแอดมิน] 690001 ");
cur.start.dateTime = `${target}T14:30:00+07:00`; cur.end.dateTime = `${target}T14:45:00+07:00`;
r = await adminPb(okBtn);
check("admin confirm -> blue + confirmed", events.get(ev.id).status === "confirmed" && events.get(ev.id).colorId === "7");
check("pending prefix removed", !events.get(ev.id).summary.includes("[รอแอดมิน]"), events.get(ev.id).summary);
check("staff HN kept", events.get(ev.id).summary.startsWith("690001 "));
check("far appointment gets no button yet", lastCust().messages[0].type === "text");
check("customer gets edited time", lastCust().to === "Usecret1" && lastCust().messages[0].text.includes("14:30"), lastCust().messages[0].text);
const n = custPushes().length;
r = await adminPb(okBtn);
check("double confirm safe", r.msg?.text?.includes("ยืนยันไปแล้ว") && custPushes().length === n);

r = await pb(slot(b15, 18 * 60), user("Ureject"));
r = await text("สมหญิง ทดสอบ 0899999999", "Ureject");
const noData = pushes.at(-1).messages[0].contents.footer.contents[1].action.data;
const eid = new URLSearchParams(noData).get("e");
r = await adminPb(noData);
check("reject deletes + tells customer", events.get(eid).status === "cancelled" && lastCust().to === "Ureject" && r.msg?.text?.startsWith("❌"));
r = await adminPb(noData);
check("acting on removed event safe", r.msg?.text?.includes("ยกเลิกไปแล้ว"));

// reminders
const cron = (auth) => fetch("http://127.0.0.1:3456/api/cron/reminders", auth ? { headers: { authorization: auth } } : {});
const runCron = async () => (await cron("Bearer cron-test")).json();
check("cron without secret -> 401", (await cron()).status === 401);
check("cron wrong secret -> 401", (await cron("Bearer nope")).status === 401);
const tmr = dayFromNow(1);
const lineEv = (u, extra = {}) => seed(tmr, "10:00", 15, { summary: "x", colorId: "7", extendedProperties: { private: { source: "line", lineUserId: u } }, ...extra });
const blue = lineEv("Ublue");
lineEv("Upending", { status: "tentative", colorId: "8" });
lineEv("Upurple", { colorId: "3" });
lineEv("Ucxp", { extendedProperties: { private: { source: "line", lineUserId: "Ucxp", cancelRequested: "1" } } });
const staffOnly = seed(tmr, "11:00", 15, { colorId: "7" });
const toCustomers = () => pushes.filter((p) => p.to !== "Cadmin");
let pc = pushes.length;
let cc = toCustomers().length;
let res = await runCron();
check("reminds only admin-confirmed blue LINE bookings", res.sent === 1 && toCustomers().length === cc + 1 && toCustomers().at(-1).to === "Ublue", JSON.stringify(res));
const summaryPush = pushes.slice(pc).find((p) => p.to === "Cadmin");
const summaryText = summaryPush?.messages[0].text ?? "";
check("daily summary sent to admin after reminders", res.summary === true && summaryText.startsWith("📋 สรุปประจำวัน") && pushes.at(-1) === summaryPush, summaryText);
check("summary counts and quota warning", /นัดวันนี้: \d+ · รอแอดมินยืนยัน \(สีเทา\): \d+/.test(summaryText) && summaryText.includes("250/300 (83%)") && summaryText.includes("⚠️ โควต้าใกล้หมด"), summaryText);
check("summary has no patient titles", !summaryText.includes("SEED-PRIVATE-TITLE") && !summaryText.includes("สมชาย"));
const rem = toCustomers().at(-1).messages[0];
check("reminder has confirm + change buttons", rem.type === "flex" && rem.contents.footer.contents.length === 2);
res = await runCron();
check("reminder not sent twice", res.sent === 0 && toCustomers().length === cc + 1);
const attend = rem.contents.footer.contents[0].action.data;
r = await pb(attend, user("Ustranger"));
check("other user cannot confirm", events.get(blue.id).colorId === "7" && r.msg?.text?.includes("ไม่พบนัด"));
r = await pb(attend, user("Ublue"));
check("patient confirm -> purple", events.get(blue.id).colorId === "3" && r.msg?.text?.includes("ขอบคุณ"), r.msg?.text);
r = await pb(attend, user("Ublue"));
check("double patient confirm safe", events.get(blue.id).colorId === "3" && r.msg?.text?.includes("ขอบคุณ"));
check("change button triggers handoff text", rem.contents.footer.contents[1].action.text === "ขอเปลี่ยนนัด");
const soon = seed(tmr, "12:00", 15, { status: "tentative", colorId: "8", summary: "[รอแอดมิน] y", extendedProperties: { private: { source: "line", lineUserId: "Usoon" } } });
cc = custPushes().length;
r = await adminPb(`a=ok&e=${soon.id}`);
check("confirm for tomorrow sends button at once", custPushes().length === cc + 1 && lastCust().messages[0].type === "flex" && lastCust().to === "Usoon");
res = await runCron();
check("then cron does not repeat it", res.sent === 0);

// ---- customer reschedules a LINE booking themselves
const orig = events.get(ev.id);
check("original is confirmed before reschedule", orig.status === "confirmed" && orig.start.dateTime === `${target}T14:30:00+07:00`);
const pickNew = async (U) => {
  let m = (await text("ขอเปลี่ยนนัดหน่อย", U)).msg;
  const day = items(m).find((a) => new URLSearchParams(a.data).get("d") !== target);
  m = (await pb(day.data, user(U))).msg;
  m = (await pb(items(m)[0].data, user(U))).msg;
  const slotBtn = items(m)[0];
  return { day: new URLSearchParams(day.data).get("d"), slotBtn };
};
let pick = await pickNew("Usecret1");
check("time buttons keep x", new URLSearchParams(pick.slotBtn.data).get("x") === ev.id);
// someone else replaying the postback cannot move this appointment
r = await pb(pick.slotBtn.data, user("Ustranger"));
check("other user cannot reschedule", r.msg?.text?.startsWith("ไม่พบนัดเดิม") && !live().some((e) => e.extendedProperties?.private?.replaces), r.msg?.text);
pc2 = pushes.length;
r = await pb(pick.slotBtn.data);
const req = live().find((e) => e.extendedProperties?.private?.replaces === ev.id);
check("reschedule request is gray, keeps patient title", req?.status === "tentative" && req.colorId === "8" && req.summary === "[รอแอดมิน] 690001 สมชาย ใจดี 0812345678 ขูดหินปูน สปสช คนไข้ใหม่ ไลน์ OA", req?.summary);
check("reschedule request needs no name step", !req?.extendedProperties.private.awaitingDetailsFor);
check("customer told original stays", r.msg?.text?.startsWith("ส่งคำขอเลื่อนนัดเป็นวัน") && r.msg.text.includes("14:30 น. ยังอยู่จนกว่าแอดมินจะยืนยัน"), r.msg?.text);
check("original untouched while pending", events.get(ev.id).status === "confirmed");
const reCard = pushes.slice(pc2).find((p) => p.to === "Cadmin")?.messages[0];
check("admin gets 🔁 card with from/to", JSON.stringify(reCard).includes("🔁 ขอเลื่อนนัด") && JSON.stringify(reCard).includes("จาก: วัน") && JSON.stringify(reCard).includes("14:30"), JSON.stringify(reCard).slice(0, 160));
r = await text("เลื่อนนัด");
check("second reschedule while pending -> told to wait", r.msg?.text?.startsWith("คุณลูกค้ามีคำขอเลื่อนนัดเป็น"), r.msg?.text);
r = await text("จองคิว");
check("new booking still blocked while pending", r.msg?.text?.includes("มีนัดอยู่แล้ว") || r.msg?.text?.includes("คำขอเลื่อนนัด"), r.msg?.text);

cc = custPushes().length;
r = await adminPb(reCard.contents.footer.contents[0].action.data);
const moved = events.get(req.id);
check("admin confirms reschedule -> new blue, old removed", moved.status === "confirmed" && moved.colorId === "7" && !moved.summary.startsWith("[รอแอดมิน]") && events.get(ev.id).status === "cancelled", JSON.stringify({ s: moved.status, c: moved.colorId, old: events.get(ev.id).status }));
check("replaces marker cleared after confirm", !("replaces" in moved.extendedProperties.private));
check("customer told new time", custPushes().length === cc + 1 && lastCust().to === "Usecret1" && (lastCust().messages[0].type === "flex" || lastCust().messages[0].text.startsWith("แอดมินยืนยันการเลื่อนนัดแล้วค่ะ")), JSON.stringify(lastCust().messages[0]).slice(0, 120));
check("admin sees reschedule result", r.msg?.text?.startsWith("✅ ยืนยันเลื่อนนัดแล้ว"), r.msg?.text);

// reject path: original stays
pick = await pickNew("Usecret1");
r = await pb(pick.slotBtn.data);
const req2 = live().find((e) => e.extendedProperties?.private?.replaces === req.id);
const reCard2 = pushes.filter((p) => p.to === "Cadmin").at(-1).messages[0];
cc = custPushes().length;
r = await adminPb(reCard2.contents.footer.contents[1].action.data);
check("admin rejects reschedule -> request removed, original kept", events.get(req2.id).status === "cancelled" && events.get(req.id).status === "confirmed");
check("customer told original stays after reject", lastCust().to === "Usecret1" && lastCust().messages[0].text.includes("ยังอยู่นะคะ"), lastCust().messages[0].text);

// ---- DN from the private patient sheet: calendar + admin only, never the customer
// fresh day so earlier tests do not hold these times; the sheet was cached by earlier bookings
const dnDay = (() => { for (let i = 15; i <= 28; i++) { const d = dayFromNow(i); if (weekdayOf(d) === 4) return d; } })();
const dnSlot = (t) => q({ a: "slot", ...b15, d: dnDay, p: "am", t: String(t) });
pc2 = pushes.length;
r = await pb(dnSlot(10 * 60), user("Udn"));
r = await text("ทดสอบ ดีเอ็น 0870000001", "Udn");
const dnEv = live().find((e) => e.extendedProperties?.private?.lineUserId === "Udn");
check("matching phone + name -> DN first in title", dnEv?.summary?.startsWith("[รอแอดมิน] 680099 ทดสอบ ดีเอ็น 0870000001"), dnEv?.summary);
check("customer reply has no DN", r.msg?.text?.includes("แอดมินจะยืนยัน") && !JSON.stringify(replies.at(-1)).includes("680099"), r.msg?.text);
check("admin card has DN", JSON.stringify(pushes.slice(pc2).find((p) => p.to === "Cadmin")?.messages ?? "").includes("680099"));
check("DN, name, phone never logged", !logs.includes("680099") && !logs.includes("0870000001") && logs.includes('"tag":"patient_lookup","found":true,"rows":2,"phoneMatches":1'));
r = await pb(dnSlot(10 * 60 + 15), user("Udn2"));
r = await text("คนอื่น ดีเอ็น 0870000001", "Udn2");
check("same phone, other name -> no DN", live().find((e) => e.extendedProperties?.private?.lineUserId === "Udn2")?.summary === "[รอแอดมิน] คนอื่น ดีเอ็น 0870000001 ขูดหินปูน สปสช คนไข้ใหม่ ไลน์ OA");
check("patient sheet read once for all bookings (cached)", patientReads === 1, String(patientReads));
check("all month tabs read, quoted", lastPatientRanges.join("|") === "'ตุลาคม 2569'|'พฤศจิกายน 2569'|'สรุป'", lastPatientRanges.join("|"));

// ---- customer cancels a LINE booking, admin decides
const cxEv = seed(dnDay, "13:00", 15, { summary: "680500 ยกเลิก ทดสอบ 0861111111 ขูดหินปูน", colorId: "7", extendedProperties: { private: { source: "line", lineUserId: "Ucx", service: "ขูดหินปูน", right: "gold", visit: "old" } } });
r = await text("ขอยกเลิกนัดค่ะ", "Ucx");
let cxBtns = items(r.msg);
check("cancel prompt names the appointment", r.msg?.text?.includes("13:00 น.") && cxBtns.length === 2, r.msg?.text);
r = await pb(cxBtns[0].data, user("Ustranger"));
check("other user cannot cancel", r.msg?.text?.startsWith("ไม่พบนัดนี้") && !events.get(cxEv.id).extendedProperties.private.cancelRequested, r.msg?.text);
pc2 = pushes.length;
r = await pb(cxBtns[0].data, user("Ucx"));
check("cancel request -> customer told to wait", r.msg?.text === "ส่งคำขอยกเลิกนัดแล้วค่ะ แอดมินจะยืนยันให้อีกครั้งนะคะ 🙏", r.msg?.text);
check("calendar title shows [ขอยกเลิก], event kept", events.get(cxEv.id).summary === "[ขอยกเลิก] 680500 ยกเลิก ทดสอบ 0861111111 ขูดหินปูน" && events.get(cxEv.id).status === "confirmed");
const cxCard = pushes.slice(pc2).find((p) => p.to === "Cadmin")?.messages[0];
const cxCardText = JSON.stringify(cxCard);
check("admin gets 🚫 card with ยืนยันยกเลิก/ไม่ยกเลิก", cxCardText.includes("🚫 ขอยกเลิกนัด") && cxCardText.includes("680500 ยกเลิก ทดสอบ") && !cxCardText.includes("[ขอยกเลิก]") && cxCard.contents.footer.contents.map((c) => c.action.data).join() === `a=cx&e=${cxEv.id},a=ck&e=${cxEv.id}`, cxCardText.slice(0, 200));
r = await pb(cxBtns[0].data, user("Ucx"));
check("second cancel tap -> already pending", r.msg?.text?.startsWith("คุณลูกค้ามีคำขอยกเลิกนัด"), r.msg?.text);
r = await text("เลื่อนนัด", "Ucx");
check("reschedule blocked while cancel pending", r.msg?.text?.startsWith("คุณลูกค้ามีคำขอยกเลิกนัด"), r.msg?.text);

// admin: ไม่ยกเลิก -> title restored, customer not messaged
cc = custPushes().length;
r = await adminPb(`a=ck&e=${cxEv.id}`);
check("admin keeps -> title restored, flag cleared", events.get(cxEv.id).summary === "680500 ยกเลิก ทดสอบ 0861111111 ขูดหินปูน" && !("cancelRequested" in events.get(cxEv.id).extendedProperties.private));
check("admin keeps -> no message to customer", custPushes().length === cc && r.msg?.text?.startsWith("↩️ ไม่ยกเลิก"), r.msg?.text);
r = await adminPb(`a=ck&e=${cxEv.id}`);
check("stale cancel button safe", r.msg?.text?.startsWith("คำขอยกเลิกนี้ดำเนินการไปแล้วค่ะ"), r.msg?.text);

// ask again, admin confirms -> deleted + customer told
r = await text("ยกเลิกนัด", "Ucx");
r = await pb(items(r.msg)[0].data, user("Ucx"));
cc = custPushes().length;
r = await adminPb(`a=cx&e=${cxEv.id}`);
check("admin confirms cancel -> event deleted", events.get(cxEv.id).status === "cancelled" && r.msg?.text?.startsWith("🚫 ยกเลิกนัดแล้ว"), r.msg?.text);
check("customer told cancelled", custPushes().length === cc + 1 && lastCust().to === "Ucx" && lastCust().messages[0].text.includes("ยกเลิกนัด") && lastCust().messages[0].text.includes("เรียบร้อยแล้วค่ะ"), lastCust()?.messages[0].text);
r = await adminPb(`a=cx&e=${cxEv.id}`);
check("cancel confirm twice safe", r.msg?.text?.startsWith("นัดนี้ถูกลบหรือยกเลิกไปแล้วค่ะ"), r.msg?.text);

r = await text("ยกเลิกนัด", "Unobooking");
check("cancel without LINE booking -> handoff card + admin", r.msg?.type === "flex" && pushes.at(-1).messages[0].text.includes("เรื่อง: ขอยกเลิกนัด"));

r = await text("ขอเปลี่ยนนัดหน่อย", "Unobooking");
check("no LINE booking -> handoff card + admin", r.msg?.type === "flex" && pushes.at(-1).messages[0].text.includes("เรื่อง: ขอเปลี่ยนนัด"));

calendarFails = true;
pc = pushes.length;
r = await text("จองคิว", "Udown");
check("calendar down -> silent", r.status === 200 && r.msg === null);
check("calendar down -> admin told", pushes.at(-1)?.to === "Cadmin" && pushes.at(-1).messages[0].text.includes("ระบบขัดข้อง (จองคิว)"));
check("logged booking_error", logs.includes("booking_error"));
calendarFails = false;

if (TG) {
  const linePushesToGroup = () => pushes.filter((p) => p.to === "Cadmin" && !p.tg).length;
  check("telegram: no admin push goes to the LINE group", linePushesToGroup() === 0, String(linePushesToGroup()));
  const card = pushes.find((p) => p.tg?.reply_markup);
  check("telegram: booking card has ยืนยัน/ปฏิเสธ buttons", card?.tg.chat_id === "-100" && card.tg.reply_markup.inline_keyboard[0].map((b) => b.text).join() === "ยืนยัน,ปฏิเสธ");
  check("telegram: every button tap answered", tgCalls.filter((c) => c.method === "answerCallbackQuery").length >= 5);
  const reply = tgCalls.filter((c) => c.method === "sendMessage" && c.body.reply_parameters).at(-1);
  check("telegram: result replies to the card and names who tapped", reply?.body.reply_parameters.message_id === 7 && reply.body.text.endsWith("\nโดย หมอ"), reply?.body.text);

  check("telegram: no secret -> 401", (await tgUpdate({}, null)).status === 401);
  check("telegram: wrong secret -> 401", (await tgUpdate({}, "nope")).status === 401);
  const pending = seed(tmr, "13:00", 15, { status: "tentative", colorId: "8", summary: "[รอแอดมิน] z", extendedProperties: { private: { source: "line", lineUserId: "Uz" } } });
  const before = JSON.stringify(events.get(pending.id));
  const res2 = await tgTap(`a=ok&e=${pending.id}`, -999);
  check("telegram: tap from another chat ignored", res2.status === 200 && JSON.stringify(events.get(pending.id)) === before);
  await tgUpdate({ message: { chat: { id: -555, type: "group" } } });
  check("telegram: new group id logged for setup", logs.includes('"tag":"telegram_chat","chatId":-555'));

  tgDown = true;
  r = await pb(slot(b15, 16 * 60), user("Utgdown"));
  r = await text("ทดสอบ ระบบ 0811111111", "Utgdown");
  check("telegram down -> booking still saved + customer told", r.msg?.text?.includes("แอดมินจะยืนยัน") && live().some((e) => e.extendedProperties?.private?.lineUserId === "Utgdown"), r.msg?.text);
  check("telegram down -> logged with channel", logs.includes('"tag":"booking_notify_failed","channel":"telegram","status":429'));
  tgDown = false;
}

const extra = await import("./extra.mjs");
await extra.run({ text, pb, send, items, check, q, events, pushes, replies, plan, cls, seed, user, admin, dayFromNow, weekdayOf, target, wed, closedTue, adminPb, isAlert, TG,
  getLogs: () => logs, geminiCalls: () => geminiCalls, lastGeminiBody: () => lastGeminiBody, lastGeminiPath: () => lastGeminiPath, lastGeminiAuth: () => lastGeminiAuth, lastGeminiKey: () => lastGeminiKey, lastDoctorQuery: () => lastDoctorQuery,
  setServices: (csv) => (servicesCsv = csv), setSettings: (csv) => (settingsCsv = csv), setSettingsDown: (v) => (settingsDown = v), runCron, live });

check("no doubled day word", !JSON.stringify([replies, pushes]).includes("วันวัน"));
check("no calendar titles of others leaked", !JSON.stringify([replies, pushes]).includes("SEED-PRIVATE-TITLE"));

check("no userId in logs", !/Usecret/.test(logs));
check("no customer name or phone in logs", !logs.includes("สมชาย") && !logs.includes("0812345678"));
check("no customer text in logs", !logs.includes("มีที่จอดรถไหม") && !logs.includes("หน้าบวมมาก"));
check("no display name in logs", !logs.includes("คุณทดสอบ"));
check("old default reply never sent", !JSON.stringify(replies).includes("ขออภัยค่ะ เรื่องนี้แอดมิน"));

console.log(`\n${failed === 0 ? "ALL PASSED" : failed + " FAILED"}`);
if (failed) console.log(logs.slice(-1500));
server.kill(); mock.close(); process.exit(failed ? 1 : 0);
