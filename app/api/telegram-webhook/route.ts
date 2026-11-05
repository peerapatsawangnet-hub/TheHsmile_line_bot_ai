import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { callTelegram, sendTelegramText } from "@/lib/admin-channel";
import { handleAdminPostback, isAdminAction } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Chat = { id: number; type: string };
type Update = {
  message?: { chat: Chat };
  callback_query?: {
    id: string;
    data?: string;
    from?: { first_name?: string };
    message?: { message_id: number; chat: Chat };
  };
};

// Telegram ส่ง secret_token ที่ตั้งตอน setWebhook มาใน header ทุกครั้ง
function validSecret(header: string | null): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!validSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return new NextResponse(null, { status: 401 });
  }

  let update: Update;
  try {
    update = await req.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  try {
    await handleUpdate(update);
  } catch (err) {
    console.error(JSON.stringify({ tag: "telegram_webhook_error", detail: err instanceof Error ? err.message : String(err) }));
  }
  // ตอบ 200 เสมอ ไม่อย่างนั้น Telegram ส่งซ้ำ
  return NextResponse.json({ ok: true });
}

async function handleUpdate(update: Update): Promise<void> {
  // log chat id ของกลุ่มใหม่ไว้ใช้ตั้ง TELEGRAM_CHAT_ID
  const chat = update.message?.chat;
  if (chat && chat.type !== "private" && String(chat.id) !== process.env.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ tag: "telegram_chat", chatId: chat.id }));
    return;
  }

  const query = update.callback_query;
  if (!query) return;

  // ปุ่มยืนยันนัดกดได้เฉพาะในกลุ่มแอดมินเท่านั้น
  const message = query.message;
  const fromAdminChat = message !== undefined && String(message.chat.id) === process.env.TELEGRAM_CHAT_ID;
  // ต้องตอบทุกปุ่ม ไม่อย่างนั้นปุ่มขึ้นวงกลมหมุนค้าง
  await callTelegram("answerCallbackQuery", { callback_query_id: query.id });
  if (!fromAdminChat || !query.data || !isAdminAction(query.data)) return;

  const result = await handleAdminPostback(query.data);
  const text = result.type === "text" ? result.text : "";
  const by = query.from?.first_name ? `\nโดย ${query.from.first_name}` : "";
  await sendTelegramText(`${text}${by}`, { reply_parameters: { message_id: message.message_id } });
}
