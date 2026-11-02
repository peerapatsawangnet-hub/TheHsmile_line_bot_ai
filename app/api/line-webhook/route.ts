import { HTTPFetchError, messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_REPLY } from "@/lib/config";
import { askGemini } from "@/lib/gemini";
import { getFaqCsv } from "@/lib/sheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

let client: messagingApi.MessagingApiClient | null = null;

function getClient(): messagingApi.MessagingApiClient {
  client ??= new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  });
  return client;
}

async function buildAnswer(text: string): Promise<string> {
  console.log(JSON.stringify({ tag: "line_message", length: text.length }));
  try {
    const faq = await getFaqCsv();
    return (await askGemini(faq, text)) ?? DEFAULT_REPLY;
  } catch {
    // getFaqCsv log สาเหตุไว้แล้ว (sheet_unavailable / sheet_empty)
    return DEFAULT_REPLY;
  }
}

async function sendReply(replyToken: string, text: string): Promise<void> {
  try {
    await getClient().replyMessage({
      replyToken,
      messages: [{ type: "text", text }],
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
    if (event.type !== "message") return;
    const { message, replyToken } = event as webhook.MessageEvent;
    if (!replyToken) return;

    const replyText =
      message.type === "text"
        ? await buildAnswer((message as webhook.TextMessageContent).text)
        : DEFAULT_REPLY;

    await sendReply(replyToken, replyText);
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
