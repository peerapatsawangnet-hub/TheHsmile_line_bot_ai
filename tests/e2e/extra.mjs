import { createHmac } from "node:crypto";

const THANKS = "ยินดีค่ะ หากต้องการข้อมูลเพิ่มเติมเร่งด่วน โทร 0620389777 ค่ะ";
const MONTH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(c) {
  const { text, pb, check, q, events, pushes, replies, plan, cls, items, admin, target } = c;
  const adminPushes = () => pushes.filter((p) => p.to === "Cadmin");
  const lastAdmin = () => adminPushes().at(-1)?.messages[0];

  async function sendBody(body, sign = true) {
    const n = replies.length;
    const res = await fetch("http://127.0.0.1:3456/api/line-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(sign ? { "x-line-signature": createHmac("sha256", "test-secret").update(body).digest("base64") } : {}) },
      body,
    });
    return { status: res.status, replies: replies.slice(n) };
  }

  // ---- settings tab never read yet (cold start) -> shadow, not live
  plan.set("cold-start", cls("thanks"));
  let cold = await text("cold-start", "Ucold");
  check("settings unreadable at start -> shadow, no reply", cold.msg === null && lastAdmin()?.text?.startsWith("🧪 [ทดลอง]"), lastAdmin()?.text);
  check("logged settings fallback", c.getLogs().includes('"tag":"settings_unavailable","fallback":"shadow"'));
  c.setSettingsDown(false);
  cold = await text("cold-start", "Ucold");
  check("settings readable -> live reply", cold.msg?.text === THANKS);
  c.setSettingsDown(true);
  cold = await text("cold-start", "Ucold");
  check("settings down after a good read -> last value (live)", cold.msg?.text === THANKS);
  c.setSettingsDown(false);

  // ---- webhook basics
  check("bad signature -> 401", (await sendBody(JSON.stringify({ events: [] }), false)).status === 401);
  check("signed invalid JSON -> 200", (await sendBody("{oops")).status === 200);

  // ---- regression: booking flow 9 steps, exact texts, no admin push during steps 1-7
  const U = "Ureg";
  const a0 = adminPushes().length;
  let r = await text("จองคิว", U);
  check("reg 1 service text", r.msg?.text === `ต้องการนัดบริการใดคะ หากไม่พบบริการที่ต้องการ พิมพ์ "ขอแอดมิน" หรือโทร 062 038 9777 ได้เลยค่ะ 🦷`, r.msg?.text);
  r = await pb(items(r.msg).find((a) => a.label === "ขูดหินปูน").data, c.user(U));
  check("reg 2 right text", r.msg?.text === "ใช้สิทธิการรักษาแบบไหนคะ");
  r = await pb(items(r.msg).find((a) => a.label === "สปสช (สิทธิบัตรทอง)").data, c.user(U));
  check("reg 3 visit text", r.msg?.text === "เคยมาที่คลินิกแล้วหรือมาครั้งแรกคะ");
  r = await pb(items(r.msg).find((a) => a.label === "เคยมาแล้ว").data, c.user(U));
  check("reg 4 date text", r.msg?.text === "ต้องการนัดวันไหนคะ");
  const dateBtn = items(r.msg).find((a) => new URLSearchParams(a.data).get("d") === target);
  r = await pb(dateBtn.data, c.user(U));
  check("reg 5 period text", r.msg?.text?.endsWith(" สะดวกช่วงไหนคะ"), r.msg?.text);
  r = await pb(items(r.msg).find((a) => a.label === "ช่วงเช้า").data, c.user(U));
  check("reg 6 time text", r.msg?.text === "ต้องการเวลาไหนคะ");
  r = await pb(items(r.msg).find((a) => a.label === "10:45").data, c.user(U));
  check("reg 7 hold text", r.msg?.text?.startsWith("เจ้าหน้าที่จะบันทึกการนัดหมาย วัน") && r.msg.text.includes("เวลา 10:45 น. นะคะ กรุณาพิมพ์ชื่อ-นามสกุล และเบอร์โทร") && r.msg.text.includes("0812345678\nหากไม่ต้องการ"), r.msg?.text);
  check("reg no admin push during steps 1-7", adminPushes().length === a0);
  r = await text("ทดสอบ ระบบ 0800000000", U);
  check("reg 8 request text", /^ส่งคำขอนัดขูดหินปูน .+ เวลา 10:45 น\. แล้วค่ะ แอดมินจะยืนยันนัดให้อีกครั้งนะคะ 🙏$/.test(r.msg?.text ?? ""), r.msg?.text);
  const card = lastAdmin();
  check("reg 8 admin card", card?.type === "flex" && JSON.stringify(card).includes("ทดสอบ ระบบ 0800000000"));
  await c.adminPb(card.contents.footer.contents[0].action.data);
  const confirmMsg = pushes.filter((p) => p.to !== "Cadmin").at(-1);
  check("reg 9 confirmed text", confirmMsg.to === U && confirmMsg.messages[0].text.startsWith("แอดมินรับนัดเรียบร้อยแล้วค่ะ") && confirmMsg.messages[0].text.includes(`หากต้องการเปลี่ยนแปลง พิมพ์ "เปลี่ยนนัด" ได้เลยค่ะ`), confirmMsg.messages[0].text);

  // ---- silent cases
  let g = c.geminiCalls();
  let ap = adminPushes().length;
  r = await text("โอเคค่ะ", "Uack");
  check("ack -> silent, no Gemini, no admin", r.msg === null && c.geminiCalls() === g && adminPushes().length === ap);
  r = await c.send({ type: "message", replyToken: "t", source: c.user("Usticker"), message: { type: "sticker", id: "2", packageId: "1", stickerId: "1" } });
  check("sticker -> silent", r.msg === null && c.geminiCalls() === g);
  r = await c.send({ type: "message", replyToken: "t", source: { type: "group", groupId: "Cadmin", userId: "Ux" }, message: { type: "text", id: "3", text: "เปิดกี่โมง" } });
  check("group message ignored", r.msg === null && c.geminiCalls() === g);

  // ---- thanks / faq
  plan.set("ขอบคุณค่ะ", cls("thanks"));
  r = await text("ขอบคุณค่ะ", "Uthx");
  check("thanks -> fixed reply", r.msg?.text === THANKS, r.msg?.text);

  plan.set("เปิดกี่โมงคะ", cls("faq", { found_in_faq: true, reply: "**เปิด** 10:00-19:00 น. ค่ะ" }));
  r = await text("เปิดกี่โมงคะ", "Ufaq");
  check("faq -> answer, markdown stripped", r.msg?.text === "เปิด 10:00-19:00 น. ค่ะ", r.msg?.text);
  const body = c.lastGeminiBody();

  // the sheet's own wording goes out, not Gemini's summary, with a button for พิมพ์ "..."
  plan.set("จัดฟันเท่าไหร่คะ", cls("faq", { found_in_faq: true, faq_question: "จัดฟันราคาเท่าไหร่", reply: "ประมาณหลักพันค่ะ" }));
  r = await text("จัดฟันเท่าไหร่คะ", "Ufaq");
  check("faq -> sheet answer verbatim", r.msg?.text === "จัดฟันเริ่มต้น 1,111 บาทค่ะ\nหากสนใจรายละเอียด พิมพ์คำว่า “ขอรายละเอียดการจัดฟัน” ได้เลยค่ะ", r.msg?.text);
  const detailBtn = r.msg?.quickReply?.items?.[0]?.action;
  check("faq -> button from พิมพ์คำว่า", detailBtn?.type === "message" && detailBtn.text === "ขอรายละเอียดการจัดฟัน" && detailBtn.label.length <= 20, JSON.stringify(detailBtn));
  // seen live: Gemini picked the price row for the button text; an exact question match must win
  plan.set("ขอรายละเอียดการจัดฟัน", cls("faq", { found_in_faq: true, faq_question: "จัดฟันราคาเท่าไหร่", reply: "มีหลายโปรค่ะ" }));
  g = c.geminiCalls();
  r = await text(detailBtn?.text ?? "", "Ufaq");
  check("tap button -> full multi-line details", r.msg?.text === "🦷 โปร A\n* เดือน 1: 1,111\n* เดือน 2–11: 222" && !r.msg.quickReply, r.msg?.text);
  check("exact FAQ question skips Gemini", c.geminiCalls() === g, String(c.geminiCalls() - g));
  // a row the owner has not filled in yet must never reach the customer
  plan.set("สงกรานต์เปิดไหมคะ", cls("faq", { found_in_faq: true, faq_question: "สงกรานต์เปิดไหม / ปีใหม่เปิดไหม", reply: "[นโยบายวันหยุดนักขัตฤกษ์] ค่ะ" }));
  r = await text("สงกรานต์เปิดไหมคะ", "Ufaq");
  check("unfilled [placeholder] FAQ -> silent + admin", r.msg === null && lastAdmin()?.text?.includes("เรื่อง: คำถามที่ FAQ ยังไม่ได้เติมคำตอบ"), lastAdmin()?.text);
  plan.set("how much are braces", cls("faq", { found_in_faq: true, faq_question: "จัดฟันราคาเท่าไหร่", reply: "Braces start at 1,111 baht." }));
  r = await text("how much are braces", "Ufaq");
  check("english question -> Gemini's English reply", r.msg?.text === "Braces start at 1,111 baht.", r.msg?.text);
  const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
  const userTurn = body.contents?.[0]?.parts?.[0]?.text ?? "";
  check("prompt has intent guide + constraints", sys.includes("<intent_guide>") && sys.includes("- emergency:") && sys.includes("<constraints>"));
  check("user turn is faq then question", /^<faq>\ncategory,question,answer\r?\n/.test(userTurn) && userTurn.trim().endsWith("</question>"));
  check("JSON mode + temperature + tokens", body.generationConfig?.responseMimeType === "application/json" && body.generationConfig?.temperature === 1 && body.generationConfig?.maxOutputTokens === 1024 && body.generationConfig?.thinkingConfig?.thinkingLevel === "LOW" && Boolean(body.generationConfig?.responseSchema));
  const vertexProject = process.env.VERTEX_PROJECT_ID;
  if (vertexProject) {
    check("vertex: project/global model path", c.lastGeminiPath() === `/v1beta1/projects/${vertexProject}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`, c.lastGeminiPath());
    check("vertex: service account token, no API key", c.lastGeminiAuth().startsWith("Bearer ") && !c.lastGeminiKey());
    check("vertex: backend logged", c.getLogs().includes('"backend":"vertex"'));
  } else {
    check("studio: API key, backend logged", c.lastGeminiKey() === "k" && c.getLogs().includes('"backend":"studio"'), c.lastGeminiPath());
  }
  check("gemini log has intent + tokens", /"tag":"gemini","finishReason":"STOP","thoughtsTokenCount":5,"candidatesTokenCount":7,"intent":"faq","confidence":"high"/.test(c.getLogs()));

  plan.set("มีที่จอดรถไหม", cls("faq"));
  r = await text("มีที่จอดรถไหม", "Upark");
  let n = lastAdmin();
  check("not in faq -> silent + admin", r.msg === null && n?.text?.startsWith("🔔 มีแชทรอแอดมินตอบ\nลูกค้า: คุณทดสอบ\nเรื่อง: ถามเรื่องที่ไม่มีใน FAQ\nข้อความ: มีที่จอดรถไหม\nตอบได้ที่: LINE OA Manager"), n?.text);
  check("admin notice has no userId", !n.text.includes("Upark"));

  plan.set("ฟันผุไหม", cls("faq", { confidence: "low", found_in_faq: true, reply: "เดาเอา" }));
  r = await text("ฟันผุไหม", "Ulow");
  check("low confidence -> silent + admin", r.msg === null && lastAdmin()?.text?.includes("เรื่อง: ไม่แน่ใจว่าต้องการอะไร"));

  for (const [intent, label] of [["symptom", "เล่าอาการ"], ["late", "แจ้งมาสาย"], ["confused", "งงกับข้อความบอท"], ["request", "ขอให้ช่วย"]]) {
    plan.set(`msg-${intent}`, cls(intent));
    r = await text(`msg-${intent}`, "Uint");
    check(`${intent} -> silent + admin`, r.msg === null && lastAdmin()?.text?.includes(`เรื่อง: ${label}`));
  }
  plan.set("msg-slot_reply", cls("slot_reply"));
  r = await text("msg-slot_reply", "Uint");
  check("slot_reply -> silent + admin", r.msg === null && lastAdmin()?.text?.includes("เรื่อง: ตอบวัน/เวลา"), lastAdmin()?.text);
  for (const intent of ["greeting", "ack"]) {
    plan.set(`msg-${intent}`, cls(intent));
    ap = adminPushes().length;
    r = await text(`msg-${intent}`, "Uint");
    check(`${intent} -> silent, no admin`, r.msg === null && adminPushes().length === ap);
  }

  // ---- emergency
  plan.set("หน้าบวมมาก", cls("emergency", { confidence: "low" }));
  r = await text("หน้าบวมมาก", "Uemg");
  n = lastAdmin();
  check("emergency -> no reply to patient", r.msg === null);
  check("emergency -> @All textV2", c.TG ? c.isAlert(n) && n.text.includes("กรุณาติดต่อกลับทันที") : n?.type === "textV2" && n.text.startsWith("{everyone}\n🔴 ด่วน · อาการฉุกเฉิน") && n.substitution?.everyone?.mentionee?.type === "all", JSON.stringify(n));

  // ---- Gemini failures
  plan.set("มีคิวว่างไหมคะ", "500");
  g = c.geminiCalls();
  r = await text("มีคิวว่างไหมคะ", "Ufb");
  check("Gemini 500 + booking words -> booking flow", r.msg?.text?.startsWith("ต้องการนัดบริการใดคะ"), r.msg?.text);
  check("500 is not retried", c.geminiCalls() === g + 1);

  plan.set("busy-once", { once503: cls("thanks") });
  g = c.geminiCalls();
  r = await text("busy-once", "Uretry");
  check("503 once -> retried and answered", r.msg?.text === THANKS && c.geminiCalls() === g + 2 && c.getLogs().includes('"tag":"gemini_retry","status":503'));
  plan.set("busy-always", "503");
  g = c.geminiCalls();
  r = await text("busy-always", "Uretry");
  check("503 twice -> one retry only, then admin", r.msg === null && c.geminiCalls() === g + 2 && lastAdmin()?.text?.includes("ระบบขัดข้อง (Gemini)"));
  for (const kind of ["maxtokens", "badjson"]) {
    plan.set(`fail-${kind}`, kind);
    r = await text(`fail-${kind}`, "Ufail");
    check(`${kind} -> silent + admin`, r.msg === null && lastAdmin()?.text?.includes("เรื่อง: ระบบขัดข้อง (Gemini)"));
  }
  plan.set("เลือดไหลค่ะ", "500");
  r = await text("เลือดไหลค่ะ", "Ufb2");
  check("Gemini 500 + emergency words -> red alert", r.msg === null && c.isAlert(lastAdmin()));

  // ---- booking intent with slots
  const [y, m, d] = target.split("-").map(Number);
  const be = `${d}/${m}/${(y + 543) % 100}`;
  plan.set("pre1", cls("booking", { slots: { service: "ขูดหินปูน", coverage: "สปสช", date_text: be, time_text: "11.00" } }));
  r = await text("pre1", "Upre");
  check("prefill skips service + right", r.msg?.text === "เคยมาที่คลินิกแล้วหรือมาครั้งแรกคะ", r.msg?.text);
  const visitData = new URLSearchParams(items(r.msg)[1].data);
  check("prefill carried in postback", visitData.get("r") === "gold" && visitData.get("pd") === target && visitData.get("pt") === "660" && items(r.msg).every((a) => a.data.length <= 300));
  r = await pb(items(r.msg)[1].data, c.user("Upre"));
  const preEv = [...events.values()].find((e) => e.extendedProperties?.private?.lineUserId === "Upre" && e.status !== "cancelled");
  check("prefill date + time -> hold directly", r.msg?.text?.startsWith("เจ้าหน้าที่จะบันทึกการนัดหมาย") && preEv?.start.dateTime === `${target}T11:00:00+07:00`, r.msg?.text);
  await text("ยกเลิก", "Upre");

  plan.set("pre2", cls("booking", { slots: { service: "ขูด หินปูน", date_text: be, period: "บ่าย" } }));
  r = await text("pre2", "Upre2");
  check("prefill without coverage asks right", r.msg?.text === "ใช้สิทธิการรักษาแบบไหนคะ");
  r = await pb(items(r.msg)[2].data, c.user("Upre2"));
  r = await pb(items(r.msg)[0].data, c.user("Upre2"));
  check("prefill period -> afternoon times", r.msg?.text === "ต้องการเวลาไหนคะ" && items(r.msg).every((a) => a.label >= "12:00" && a.label < "16:00"), items(r.msg).map((a) => a.label).join());

  plan.set("pre3", cls("booking", { slots: { service: "ไม่มีบริการนี้", date_text: "วันจันทร์20" } }));
  r = await text("pre3", "Upre3");
  check("unknown service -> service list", r.msg?.text?.startsWith("ต้องการนัดบริการใดคะ"));

  plan.set("pre4", cls("booking", { multiple_patients: true }));
  r = await text("pre4", "Upre4");
  check("multiple patients -> silent + admin", r.msg === null && lastAdmin()?.text?.includes("เรื่อง: จองให้หลายคน"));

  plan.set("pre5", cls("reschedule"));
  r = await text("pre5", "Upre5");
  check("reschedule intent -> handoff card + admin", r.msg?.type === "flex" && lastAdmin()?.text?.includes("เรื่อง: ขอเปลี่ยนนัด"));

  // ---- appointment query
  plan.set("นัดกี่โมงคะ", cls("appointment_query"));
  r = await text("นัดกี่โมงคะ", "Usecret1");
  const mine = c.live().filter((e) => e.extendedProperties?.private?.lineUserId === "Usecret1" && Date.parse(e.start.dateTime) > Date.now()).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))[0];
  const hhmm = new Date(Date.parse(mine.start.dateTime) + 7 * 3600e3).toISOString().slice(11, 16);
  check("appointment query -> time from calendar", r.msg?.text?.startsWith("นัดของคุณคือวัน") && r.msg.text.includes(`เวลา ${hhmm} น. ค่ะ`), r.msg?.text);
  r = await text("นัดกี่โมงคะ", "Unone");
  check("appointment not found -> silent + admin", r.msg === null && lastAdmin()?.text?.includes("เรื่อง: ถามเวลานัด (ไม่พบนัดในระบบ)"));

  // ---- doctor days
  events.set("doc1", { id: "doc1", status: "confirmed", summary: "หมอเข้า", start: { date: target }, end: { date: nextDay(target) } });
  r = await pb(q({ a: "visit", s: "รักษาราก", r: "sso", v: "old" }), c.user("Udoc"));
  const docDates = items(r.msg).map((a) => new URLSearchParams(a.data).get("d"));
  check("needs doctor -> only doctor days", docDates.join() === target, docDates.join());
  r = await pb(q({ a: "visit", s: "ขูดหินปูน", r: "sso", v: "old" }), c.user("Udoc"));
  check("needs_doctor FALSE -> other open days too", items(r.msg).length > 1);
  const dq = decodeURIComponent(c.lastDoctorQuery());
  check("doctor days use q filter", dq.includes("q=หมอเข้า") && dq.includes("summary"), dq.slice(0, 120));
  const other = c.dayFromNow(1) === target ? c.dayFromNow(2) : c.dayFromNow(1);
  r = await pb(q({ a: "date", s: "รักษาราก", r: "sso", v: "old", d: other }), c.user("Udoc"));
  check("needs doctor on non-doctor day -> no slots", r.msg?.text?.startsWith("วันนี้คิวเต็มแล้วค่ะ"), r.msg?.text);

  plan.set("หมอเข้าวันไหน", cls("doctor_schedule", { slots: { date_text: MONTH_SHORT[m - 1] } }));
  r = await text("หมอเข้าวันไหน", "Udoc");
  check("doctor schedule reply", r.msg?.text === `เดือน${MONTH_SHORT[m - 1]} คุณหมอเข้าวันที่ ${d} ค่ะ 😊`, r.msg?.text);
  const docQr = items(r.msg).map((a) => `${a.type}:${a.text}`).join();
  check("doctor reply offers จองคิว / คุยกับแอดมิน", docQr === "message:จองคิว,message:คุยกับแอดมิน", docQr);
  plan.set("หมอเข้าเดือนไหน", cls("doctor_schedule", { slots: { date_text: MONTH_SHORT[(m + 2) % 12] } }));
  r = await text("หมอเข้าเดือนไหน", "Udoc");
  check("no doctor events that month -> open days from hours tab", /^เดือน.+ คุณหมอเข้าทุกวันที่คลินิกเปิด โดยคลินิกปิดวันที่ [\d, ]+(และ \d+ )?ค่ะ 😊$/.test(r.msg?.text ?? ""), r.msg?.text);
  plan.set("เดือนหน้าคุณหมอเข้าวันไหนบ้าง", cls("doctor_schedule", { slots: {} }));
  r = await text("เดือนหน้าคุณหมอเข้าวันไหนบ้าง", "Udoc");
  check("เดือนหน้า without date_text -> next month", r.msg?.text?.startsWith(`เดือน${MONTH_SHORT[m % 12]} `), r.msg?.text);
  plan.set("หมอเข้าวันไหน มีคิวไหม", cls("doctor_schedule", { slots: {} }));
  r = await text("หมอเข้าวันไหน มีคิวไหม", "Udoc");
  check("'มีคิว' not read as March", r.msg?.text?.startsWith(`เดือน${MONTH_SHORT[m - 1]} `), r.msg?.text);

  // ---- several messages from one customer in one webhook call
  plan.set("สอบถามค่ะ\nมีที่จอดรถไหม", cls("faq"));
  g = c.geminiCalls();
  ap = adminPushes().length;
  const ev = (id, t) => ({ type: "message", replyToken: `rt${id}`, source: c.user("Umerge"), message: { type: "text", id, text: t } });
  await sendBody(JSON.stringify({ destination: "x", events: [ev("m1", "สอบถามค่ะ"), ev("m2", "มีที่จอดรถไหม")] }));
  check("merged into one Gemini call + one admin notice", c.geminiCalls() === g + 1 && adminPushes().length === ap + 1 && lastAdmin().text.includes("ข้อความ: สอบถามค่ะ\nมีที่จอดรถไหม"));

  // ---- settings tab: shadow mode, then bot off (cache 60s)
  c.setSettings("key,value\nbot_enabled,TRUE\nbot_mode,shadow\n");
  await sleep(61_000);
  r = await text("ขอบคุณค่ะ", "Ushadow");
  check("shadow -> no reply", r.msg === null);
  check("shadow -> admin sees would-be reply", lastAdmin()?.text === `🧪 [ทดลอง] คุณทดสอบ · thanks · บอทจะตอบ: ${THANKS}`, lastAdmin()?.text);
  ap = adminPushes().length;
  r = await text("หน้าบวมมาก", "Ushadow");
  check("shadow emergency still alerts", r.msg === null && adminPushes().slice(ap).some((p) => c.isAlert(p.messages[0])));

  c.setSettings("key,value\nbot_enabled,FALSE\nbot_mode,live\n");
  await sleep(61_000);
  ap = adminPushes().length;
  r = await text("เปิดกี่โมง", "Uoff");
  check("bot off -> silent, no admin", r.msg === null && adminPushes().length === ap);
  r = await text("จองคิว", "Uoff");
  check("bot off -> booking command silent", r.msg === null);
  r = await text("หน้าบวมมาก", "Uoff");
  check("bot off -> emergency still alerts", r.msg === null && c.isAlert(lastAdmin()));
  r = await pb(q({ a: "visit", s: "ขูดหินปูน", r: "sso", v: "old" }), c.user("Uoff"));
  check("bot off -> booking buttons silent", r.msg === null);
  c.setSettings("key,value\nbot_enabled,TRUE\nbot_mode,live\n");
}

function nextDay(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
}
