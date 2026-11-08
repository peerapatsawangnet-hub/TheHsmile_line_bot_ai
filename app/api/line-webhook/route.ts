import { HTTPFetchError, messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  describeDoctorDays,
  describeNextAppointment,
  handleAdminPostback,
  handleBookingDetails,
  handleBookingPostback,
  isAdminAction,
  isBookingEnabled,
  isBookingRequest,
  namedBookingTarget,
  startBooking,
  startCancel,
  startReschedule,
} from "@/lib/booking";
import { getDoctorScheduleImage } from "@/lib/booking-config";
import { exactFaqReply, faqCard, faqReply } from "@/lib/faq-reply";
import { LOOKUP_TIMEOUT_MS, THANKS_REPLY } from "@/lib/config";
import { handoffCard } from "@/lib/flex-cards";
import { Classification, classifyMessage } from "@/lib/gemini";
import {
  isAppointmentChangeCommand,
  isCancelCommand,
  isHandoffCommand,
  isRescheduleCommand,
  isUrgentButton,
  notifyAdmin,
  notifyEmergency,
  notifyShadow,
  URGENT_REASON,
} from "@/lib/handoff";
import { getLineClient } from "@/lib/line";
import { getSettings } from "@/lib/settings";
import { getFaqCsv } from "@/lib/sheet";
import { parseMonthText } from "@/lib/thai-datetime";
import { decide, Decision, fallbackIntent, isAck } from "@/lib/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ไม่ให้ Next.js cache การเรียก LINE หรือ Google
export const fetchCache = "force-no-store";
export const maxDuration = 30;  // การจองเรียก Calendar หลายครั้ง

type Message = messagingApi.Message;

async function sendReply(replyToken: string, messages: Message | Message[]): Promise<void> {
  try {
    await getLineClient().replyMessage({
      replyToken,
      messages: Array.isArray(messages) ? messages : [messages],
    });
  } catch (err) {
    // reply token ใช้ได้ครั้งเดียว จึงไม่ retry และไม่ throw ต่อ
    console.error(JSON.stringify({
      tag: "line_reply_failed",
      status: err instanceof HTTPFetchError ? err.status : undefined,
      body: err instanceof HTTPFetchError ? err.body : undefined,
      detail: err instanceof Error ? err.message : String(err),
    }));
  }
}

const text = (value: string): Message => ({ type: "text", text: value });

const DOCTOR_NEXT_STEPS: messagingApi.QuickReply = {
  items: ["จองคิว", "คุยกับแอดมิน"].map((label) => ({
    type: "action",
    action: { type: "message", label, text: label },
  })),
};

// คืน null ถ้าเกินเวลา เพื่อไม่ให้รวมแล้วเกินงบเวลาของข้อความ
async function withinLookupBudget<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error(JSON.stringify({ tag: "lookup_timeout" }));
      resolve(null);
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.error(JSON.stringify({
      tag: "lookup_error",
      status: (err as { status?: number }).status,
      detail: err instanceof Error ? err.message : String(err),
    }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// getFaqCsv log สาเหตุไว้แล้ว (sheet_unavailable / sheet_empty) คืน null เพื่อจัดประเภทต่อได้โดยไม่มี FAQ
function loadFaq(): Promise<string | null> {
  return getFaqCsv().catch(() => null);
}

async function classify(
  message: string,
  faqPromise: Promise<string | null> = loadFaq(),
): Promise<{ result: Classification | null; faqAvailable: boolean }> {
  const faq = await faqPromise;
  return { result: await classifyMessage(faq ?? "", message), faqAvailable: faq !== null };
}

// Gemini ใช้ไม่ได้: เดาจากคำสำคัญ ไม่อย่างนั้นแจ้งแอดมิน
function fallbackDecision(message: string): Decision {
  const guess = fallbackIntent(message);
  if (guess === "emergency") return { kind: "emergency" };
  if (guess === "booking") return { kind: "booking", slots: {} };
  return { kind: "notify", reason: "ระบบขัดข้อง (Gemini)" };
}

async function doctorAnswer(
  dateText: string | undefined,
  message: string,
  now: number,
): Promise<{ answer: string | null; image: string | null }> {
  if (!isBookingEnabled()) return { answer: null, image: null };
  // Gemini มักไม่ใส่ "เดือนหน้า" ใน date_text จึงดูจากข้อความลูกค้า
  // ไม่อ่านชื่อเดือนย่อจากข้อความ เพราะ "มีคิว" จะถูกอ่านเป็น "มีค"
  const { year, month } = parseMonthText(/เดือนหน้า/.test(message) ? "เดือนหน้า" : dateText, now);
  const [answer, image] = await Promise.all([
    withinLookupBudget(describeDoctorDays(year, month, now)),
    withinLookupBudget(getDoctorScheduleImage(`${year}-${String(month).padStart(2, "0")}`)),
  ]);
  return { answer, image };
}

// ส่งรูปเข้ากลุ่มแอดมินด้วย เพื่อให้เห็นเหมือนที่ลูกค้าจะได้รับ
async function previewForShadow(decision: Decision, message: string): Promise<{ text: string; image?: string | null }> {
  if (decision.kind !== "doctor") return { text: describeForShadow(decision) };
  const { answer, image } = await doctorAnswer(decision.dateText, message, Date.now());
  if (!answer) return { text: "(เงียบ + แจ้งแอดมิน: ถามวันที่คุณหมอเข้า (ไม่พบในปฏิทิน))" };
  return { text: image ? answer : `${answer}\n(ไม่มีรูปตารางเดือนนี้)`, image };
}

function describeForShadow(decision: Decision): string {
  switch (decision.kind) {
    case "reply": return decision.text;
    case "thanks": return THANKS_REPLY;
    case "booking": return "(เข้า flow จองคิว)";
    case "handoff": return `(การ์ดติดต่อกลับ + แจ้งแอดมิน: ${decision.reason})`;
    case "reschedule": return "(ให้เลือกวันเวลาใหม่ ถ้าไม่พบนัดผ่าน LINE ส่งการ์ดติดต่อกลับ + แจ้งแอดมิน)";
    case "cancel": return "(ถามย้ำแล้วส่งคำขอยกเลิกให้แอดมินกดยืนยัน ถ้าไม่พบนัดผ่าน LINE ส่งการ์ดติดต่อกลับ + แจ้งแอดมิน)";
    case "appointment": return "(ตอบเวลานัดจากปฏิทิน)";
    case "doctor": return "(ตอบวันที่คุณหมอเข้า)";
    case "silent": return "(เงียบ)";
    case "notify": return `(เงียบ + แจ้งแอดมิน: ${decision.reason})`;
    case "emergency": return "(เงียบ + แจ้งด่วน)";
  }
}

// นัดที่จองผ่าน LINE ให้ลูกค้าเลือกเวลาใหม่เอง นัดอื่นหรือระบบขัดข้อง ส่งต่อแอดมินแบบเดิม
async function reschedule(userId: string, replyToken: string, message: string): Promise<void> {
  const reply = isBookingEnabled() ? await startReschedule(userId) : null;
  if (reply) return sendReply(replyToken, reply);
  console.log(JSON.stringify({ tag: "handoff" }));
  await Promise.all([notifyAdmin(userId, "ขอเปลี่ยนนัด", message), sendReply(replyToken, handoffCard())]);
}

async function cancel(userId: string, replyToken: string, message: string): Promise<void> {
  const reply = isBookingEnabled() ? await startCancel(userId) : null;
  if (reply) return sendReply(replyToken, reply);
  console.log(JSON.stringify({ tag: "handoff" }));
  await Promise.all([notifyAdmin(userId, "ขอยกเลิกนัด", message), sendReply(replyToken, handoffCard())]);
}

async function act(decision: Decision, userId: string, replyToken: string, message: string): Promise<void> {
  const now = Date.now();
  switch (decision.kind) {
    case "reply":
      // คำตอบที่มีปุ่มเป็นการ์ดปุ่มใหญ่ แบบเดียวกับการ์ดจองคิว
      return sendReply(replyToken, decision.buttons ? faqCard(decision.text, decision.buttons) : text(decision.text));
    case "thanks":
      return sendReply(replyToken, text(THANKS_REPLY));
    case "silent":
      return;
    case "notify":
      return notifyAdmin(userId, decision.reason, message);
    case "emergency":
      return notifyEmergency(userId, message);
    case "handoff":
      await Promise.all([notifyAdmin(userId, decision.reason, message), sendReply(replyToken, handoffCard())]);
      return;
    case "reschedule":
      return reschedule(userId, replyToken, message);
    case "cancel":
      return cancel(userId, replyToken, message);
    case "booking": {
      if (!isBookingEnabled()) return notifyAdmin(userId, "ขอนัด (ระบบจองปิดอยู่)", message);
      const reply = await startBooking(userId, message, decision.slots);
      if (reply) await sendReply(replyToken, reply);
      return;
    }
    case "appointment": {
      const answer = isBookingEnabled() ? await withinLookupBudget(describeNextAppointment(userId, now)) : null;
      if (answer) return sendReply(replyToken, text(answer));
      return notifyAdmin(userId, "ถามเวลานัด (ไม่พบนัดในระบบ)", message);
    }
    case "doctor": {
      const { answer, image } = await doctorAnswer(decision.dateText, message, now);
      if (!answer) return notifyAdmin(userId, "ถามวันที่คุณหมอเข้า (ไม่พบในปฏิทิน)", message);
      const messages: Message[] = [text(answer)];
      if (image) messages.push({ type: "image", originalContentUrl: image, previewImageUrl: image });
      // ลูกค้ามักอยากนัดต่อ ปุ่มส่งเป็นข้อความ จึงเข้าคำสั่งตรงเดียวกับที่พิมพ์เอง
      messages[messages.length - 1] = { ...messages[messages.length - 1], quickReply: DOCTOR_NEXT_STEPS };
      return sendReply(replyToken, messages);
    }
  }
}

async function handleText(userId: string, replyToken: string, message: string): Promise<void> {
  console.log(JSON.stringify({ tag: "line_message", length: message.length }));
  // อ่าน FAQ พร้อมกับ settings เพื่อเหลือเวลาให้ Gemini มากขึ้น (มี cache 60 วินาที)
  const faqPromise = loadFaq();
  const settings = await getSettings();

  // ปิดบอท: เงียบทุกข้อความ แต่อาการฉุกเฉินยังต้องถึงแอดมิน
  if (!settings.enabled) {
    const { result } = await classify(message, faqPromise);
    const emergency = result ? result.intent === "emergency" : fallbackIntent(message) === "emergency";
    if (emergency) await notifyEmergency(userId, message);
    return;
  }

  // คำสั่งตรงทำงานแบบเดิมเสมอ
  if (isRescheduleCommand(message)) return reschedule(userId, replyToken, message);
  if (isCancelCommand(message)) return cancel(userId, replyToken, message);
  if (isUrgentButton(message)) {
    console.log(JSON.stringify({ tag: "handoff" }));
    await Promise.all([notifyAdmin(userId, URGENT_REASON, message), sendReply(replyToken, handoffCard())]);
    return;
  }
  if (isHandoffCommand(message)) {
    const reason = isAppointmentChangeCommand(message) ? "ขอเปลี่ยนหรือยกเลิกนัด" : "ขอคุยกับแอดมิน";
    console.log(JSON.stringify({ tag: "handoff" }));
    await Promise.all([notifyAdmin(userId, reason, message), sendReply(replyToken, handoffCard())]);
    return;
  }

  if (isBookingEnabled()) {
    // ลูกค้าที่กำลังกรอกชื่อและเบอร์ต้องอยู่ใน flow ห้ามผ่าน classifier
    const details = await handleBookingDetails(userId, message);
    if (details) return sendReply(replyToken, details);
    // "นัดปรึกษารากฟันเทียม" (ปุ่มในคำตอบ FAQ) เข้าการจองบริการนั้นเลย
    const named = await namedBookingTarget(message);
    if (named || isBookingRequest(message)) {
      const reply = await startBooking(userId, message, named ? { service: named } : {});
      if (reply) await sendReply(replyToken, reply);
      return;
    }
  }

  if (isAck(message)) return;

  // ข้อความตรงกับคำถามใน FAQ ทุกตัวอักษร (มักมาจากปุ่ม) ตอบแถวนั้นเลย ไม่ให้ Gemini เลือกแถวอื่น
  const exact = exactFaqReply(await faqPromise, message);
  const { result, faqAvailable } = exact
    ? { result: null, faqAvailable: true }
    : await classify(message, faqPromise);
  let decision: Decision = result ? decide(result, faqAvailable) : fallbackDecision(message);
  const faq = exact ?? (result && decision.kind === "reply" ? faqReply(await faqPromise, result, message) : null);
  if (faq) {
    decision = faq.kind === "reply"
      ? { kind: "reply", text: faq.text, buttons: faq.buttons }
      : { kind: "notify", reason: "คำถามที่ FAQ ยังไม่ได้เติมคำตอบ" };
  }
  console.log(JSON.stringify({ tag: "decision", kind: decision.kind, fallback: !result && !exact, exactFaq: Boolean(exact) }));

  // โหมดทดลอง: ไม่ตอบลูกค้า ส่งสิ่งที่บอทจะทำเข้ากลุ่มแอดมิน แต่เคสฉุกเฉินยังแจ้งจริง
  if (settings.mode === "shadow") {
    if (decision.kind === "emergency") await notifyEmergency(userId, message);
    const preview = await previewForShadow(decision, message);
    await notifyShadow(userId, exact ? "faq" : result?.intent ?? "fallback", preview.text, preview.image);
    return;
  }
  await act(decision, userId, replyToken, message);
}

async function handlePostback(event: webhook.PostbackEvent): Promise<void> {
  const { postback, replyToken, source } = event;
  if (!replyToken) return;

  // ปุ่มยืนยันนัดกดได้เฉพาะในกลุ่มแอดมินเท่านั้น
  if (isAdminAction(postback.data)) {
    const fromAdminGroup =
      source?.type === "group" &&
      (source as webhook.GroupSource).groupId === process.env.ADMIN_GROUP_ID;
    if (fromAdminGroup) await sendReply(replyToken, await handleAdminPostback(postback.data));
    return;
  }

  if (source?.type !== "user") return;
  // ปิดบอทแล้วไม่ตอบปุ่มในขั้นจองคิว แต่ปุ่มยืนยันมาตามนัดยังใช้ได้
  const isAttendance = new URLSearchParams(postback.data).get("a") === "attend";
  if (!isAttendance && !(await getSettings()).enabled) return;

  const reply = await handleBookingPostback(postback.data, (source as webhook.UserSource).userId);
  if (reply) await sendReply(replyToken, reply);
}

async function handleEvent(event: webhook.Event): Promise<void> {
  try {
    // log groupId ไว้ใช้ตั้ง ADMIN_GROUP_ID ตอนเชิญบอทเข้ากลุ่มแอดมิน
    if (event.type === "join" && event.source?.type === "group") {
      console.log(JSON.stringify({
        tag: "line_join",
        groupId: (event.source as webhook.GroupSource).groupId,
      }));
      return;
    }

    if (event.type === "postback") return await handlePostback(event as webhook.PostbackEvent);

    // ตอบเฉพาะแชตส่วนตัว ไม่อย่างนั้นบอทจะตอบทุกข้อความในกลุ่มแอดมิน
    if (event.type !== "message" || event.source?.type !== "user") return;
    const { message, replyToken, source } = event as webhook.MessageEvent;
    const { userId } = source as webhook.UserSource;
    if (!replyToken || !userId) return;

    // สติกเกอร์ รูป ไฟล์: เงียบ
    if (message.type !== "text") return;
    await handleText(userId, replyToken, (message as webhook.TextMessageContent).text);
  } catch (err) {
    console.error(JSON.stringify({
      tag: "unhandled",
      stack: err instanceof Error ? err.stack : String(err),
    }));
  }
}

// LINE อาจส่งหลายข้อความของลูกค้าคนเดียวกันมาในครั้งเดียว: รวมเป็นข้อความเดียว
// เพื่อจัดประเภทครั้งเดียวและแจ้งแอดมินครั้งเดียว ตอบด้วย reply token ของข้อความล่าสุด
function mergeTextMessages(events: webhook.Event[]): webhook.Event[] {
  const merged: webhook.Event[] = [];
  const byUser = new Map<string, webhook.MessageEvent>();
  for (const event of events) {
    const userId = event.source?.type === "user" ? (event.source as webhook.UserSource).userId : undefined;
    const isText = event.type === "message" && (event as webhook.MessageEvent).message.type === "text";
    const earlier = userId && isText ? byUser.get(userId) : undefined;
    if (!userId || !isText) {
      merged.push(event);
      continue;
    }
    const current = event as webhook.MessageEvent;
    if (!earlier) {
      const copy = { ...current, message: { ...current.message } } as webhook.MessageEvent;
      byUser.set(userId, copy);
      merged.push(copy);
      continue;
    }
    const content = earlier.message as webhook.TextMessageContent;
    content.text = `${content.text}\n${(current.message as webhook.TextMessageContent).text}`;
    earlier.replyToken = current.replyToken;
  }
  return merged;
}

export async function POST(req: NextRequest) {
  // ต้องอ่าน raw body ก่อน parse เพราะ signature คำนวณจาก body ดิบ
  const body = await req.text();
  const signature = req.headers.get("x-line-signature");
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!signature || !secret || !validateSignature(body, secret, signature)) {
    console.warn(JSON.stringify({
      tag: "signature_invalid",
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    }));
    return new NextResponse(null, { status: 401 });
  }

  // หลังผ่าน signature ต้องตอบ 200 เสมอ ไม่อย่างนั้น LINE จะส่ง event เดิมซ้ำ
  try {
    const { events = [] } = JSON.parse(body) as webhook.CallbackRequest;
    // รอ reply ให้เสร็จก่อน return เพราะ Vercel อาจปิด function กลางทาง
    await Promise.allSettled(mergeTextMessages(events).map(handleEvent));
  } catch (err) {
    console.error(JSON.stringify({
      tag: "unhandled",
      stack: err instanceof Error ? err.stack : String(err),
    }));
  }

  return new NextResponse(null, { status: 200 });
}
