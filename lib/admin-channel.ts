import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import { TELEGRAM_TIMEOUT_MS } from "./config";
import { getLineClient } from "./line";

// แจ้งแอดมินผ่าน Telegram ถ้าตั้งไว้ ไม่กินโควต้า push ของ LINE
// ไม่ตั้งจะส่งเข้ากลุ่ม LINE แบบเดิม
export function isTelegramAdmin(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export function hasAdminChannel(): boolean {
  return isTelegramAdmin() || Boolean(process.env.ADMIN_GROUP_ID);
}

export type AdminButton = { label: string; data: string };

export type AdminNotice = {
  text: string;
  image?: string | null;
  buttons?: AdminButton[];
  // ข้อความแบบ LINE โดยเฉพาะ เช่น Flex หรือ mention ทุกคน ไม่ใส่จะสร้างจาก text และ image
  line?: messagingApi.Message[];
};

class TelegramError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`telegram ${status}`);
  }
}

export async function callTelegram(method: string, body: object): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new TelegramError(res.status, await res.text());
}

export async function sendTelegramText(text: string, extra: object = {}): Promise<void> {
  await callTelegram("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text, ...extra });
}

async function sendTelegram(notice: AdminNotice): Promise<void> {
  const keyboard = notice.buttons?.length
    ? { reply_markup: { inline_keyboard: [notice.buttons.map((b) => ({ text: b.label, callback_data: b.data }))] } }
    : {};
  await sendTelegramText(notice.text, keyboard);
  if (notice.image) await callTelegram("sendPhoto", { chat_id: process.env.TELEGRAM_CHAT_ID, photo: notice.image });
}

async function sendLine(notice: AdminNotice, groupId: string): Promise<void> {
  const messages: messagingApi.Message[] = notice.line ?? [
    { type: "text", text: notice.text },
    ...(notice.image ? [{ type: "image" as const, originalContentUrl: notice.image, previewImageUrl: notice.image }] : []),
  ];
  await getLineClient().pushMessage({ to: groupId, messages });
}

// ไม่ throw: แจ้งแอดมินไม่สำเร็จต้องไม่ทำให้งานอื่นพัง
export async function sendToAdmin(notice: AdminNotice, tag: string): Promise<boolean> {
  try {
    if (isTelegramAdmin()) {
      await sendTelegram(notice);
      return true;
    }
    const groupId = process.env.ADMIN_GROUP_ID;
    if (!groupId) {
      console.error(JSON.stringify({ tag: "admin_group_missing" }));
      return false;
    }
    await sendLine(notice, groupId);
    return true;
  } catch (err) {
    const status = err instanceof HTTPFetchError || err instanceof TelegramError ? err.status : undefined;
    const body = err instanceof HTTPFetchError || err instanceof TelegramError ? err.body : undefined;
    console.error(JSON.stringify({ tag, channel: isTelegramAdmin() ? "telegram" : "line", status, body }));
    return false;
  }
}
