import { HTTPFetchError, messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  handleAdminPostback,
  handleBookingDetails,
  handleBookingPostback,
  handleBookingText,
  isAdminAction,
  isBookingEnabled,
  isBookingRequest,
} from "@/lib/booking";
import { DEFAULT_REPLY } from "@/lib/config";
import { handoffCard } from "@/lib/flex-cards";
import { askGemini } from "@/lib/gemini";
import { notifyAdmin, shouldHandoff } from "@/lib/handoff";
import { getLineClient } from "@/lib/line";
import { getFaqCsv } from "@/lib/sheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ไม่ให้ Next.js cache การเรียก LINE หรือ Google
export const fetchCache = "force-no-store";
export const maxDuration = 30;  // การจองเรียก Calendar หลายครั้ง

async function buildAnswer(text: string): Promise<string> {
  try {
    const faq = await getFaqCsv();
    return (await askGemini(faq, text)) ?? DEFAULT_REPLY;
  } catch {
    // getFaqCsv log สาเหตุไว้แล้ว (sheet_unavailable / sheet_empty)
    return DEFAULT_REPLY;
  }
}

async function sendReply(replyToken: string, message: messagingApi.Message): Promise<void> {
  try {
    await getLineClient().replyMessage({
      replyToken,
      messages: [message],
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

    if (event.type === "postback") {
      const { postback, replyToken, source } = event as webhook.PostbackEvent;
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
      const reply = await handleBookingPostback(postback.data, (source as webhook.UserSource).userId);
      if (reply) await sendReply(replyToken, reply);
      return;
    }

    // ตอบเฉพาะแชตส่วนตัว ไม่อย่างนั้นบอทจะตอบทุกข้อความในกลุ่มแอดมิน
    if (event.type !== "message" || event.source?.type !== "user") return;
    const { message, replyToken, source } = event as webhook.MessageEvent;
    if (!replyToken) return;

    if (message.type !== "text") {
      await sendReply(replyToken, { type: "text", text: DEFAULT_REPLY });
      return;
    }

    const { text } = message as webhook.TextMessageContent;
    console.log(JSON.stringify({ tag: "line_message", length: text.length }));

    if (shouldHandoff(text)) {
      console.log(JSON.stringify({ tag: "handoff" }));
      await Promise.all([
        notifyAdmin((source as webhook.UserSource).userId, text),
        sendReply(replyToken, handoffCard()),
      ]);
      return;
    }

    if (isBookingEnabled()) {
      const { userId } = source as webhook.UserSource;
      const reply =
        (await handleBookingDetails(userId, text)) ??
        (isBookingRequest(text) ? await handleBookingText(userId) : null);
      if (reply) {
        await sendReply(replyToken, reply);
        return;
      }
    }

    await sendReply(replyToken, { type: "text", text: await buildAnswer(text) });
  } catch (err) {
    console.error(JSON.stringify({
      tag: "unhandled",
      stack: err instanceof Error ? err.stack : String(err),
    }));
  }
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
    await Promise.allSettled(events.map(handleEvent));
  } catch (err) {
    console.error(JSON.stringify({
      tag: "unhandled",
      stack: err instanceof Error ? err.stack : String(err),
    }));
  }

  return new NextResponse(null, { status: 200 });
}
