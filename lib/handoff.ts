import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import { getLineClient } from "./line";

const MAX_NOTIFY_LENGTH = 500;

// คำสั่งตรงที่ทำงานแบบเดิมเสมอ: ลูกค้าได้การ์ดติดต่อกลับ และกลุ่มแอดมินได้รับแจ้ง
const HANDOFF_COMMANDS = [
  "คุยกับคน",
  "คุยกับแอดมิน",
  "คุยกับเจ้าหน้าที่",
  "ขอแอดมิน",
  "ขอเจ้าหน้าที่",
  "talk to a human",
  "talk to staff",
  "speak to staff",
];
// ทีมคลินิกเป็นคนเปลี่ยนนัดใน Google Calendar
const APPOINTMENT_CHANGE_COMMANDS = ["เปลี่ยนนัด", "เลื่อนนัด", "ยกเลิกนัด"];

const includesAny = (text: string, words: string[]) => {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
};

export function isAppointmentChangeCommand(message: string): boolean {
  return includesAny(message, APPOINTMENT_CHANGE_COMMANDS);
}

export function isHandoffCommand(message: string): boolean {
  return includesAny(message, HANDOFF_COMMANDS) || isAppointmentChangeCommand(message);
}

async function getDisplayName(userId: string | undefined): Promise<string> {
  if (!userId) return "ไม่ทราบชื่อ";
  try {
    const profile = await getLineClient().getProfile(userId);
    return profile.displayName;
  } catch {
    // ลูกค้าอาจยังไม่ได้เพิ่มเพื่อน ให้แอดมินหาจากข้อความแทน
    return "ไม่ทราบชื่อ";
  }
}

function clip(message: string): string {
  return message.length > MAX_NOTIFY_LENGTH ? `${message.slice(0, MAX_NOTIFY_LENGTH)}…` : message;
}

// ไม่ throw: แจ้งแอดมินไม่สำเร็จต้องไม่ทำให้งานอื่นพัง
async function pushToAdmin(messages: messagingApi.Message[], tag: string): Promise<boolean> {
  const groupId = process.env.ADMIN_GROUP_ID;
  if (!groupId) {
    console.error(JSON.stringify({ tag: "admin_group_missing" }));
    return false;
  }
  try {
    await getLineClient().pushMessage({ to: groupId, messages });
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      tag,
      status: err instanceof HTTPFetchError ? err.status : undefined,
      body: err instanceof HTTPFetchError ? err.body : undefined,
    }));
    return false;
  }
}

// ข้อความลูกค้าไปอยู่ในกลุ่มแอดมินเท่านั้น ห้ามลง log
export async function notifyAdmin(userId: string | undefined, reason: string, message: string): Promise<void> {
  const name = await getDisplayName(userId);
  await pushToAdmin([{
    type: "text",
    text: `🔔 มีแชทรอแอดมินตอบ\nลูกค้า: ${name}\nเรื่อง: ${reason}\nข้อความ: ${clip(message)}\nตอบได้ที่: LINE OA Manager → แชท`,
  }], "admin_notify_failed");
}

export async function notifyEmergency(userId: string | undefined, message: string): Promise<void> {
  const name = await getDisplayName(userId);
  const body = `🔴 ด่วน · อาการฉุกเฉิน\nลูกค้า: ${name}\nข้อความ: ${clip(message)}\nกรุณาติดต่อกลับทันที`;
  console.log(JSON.stringify({ tag: "emergency" }));

  // mention ทุกคนในกลุ่ม ถ้า LINE ไม่รับ textV2 ให้ส่งข้อความปกติแทน
  const mentioned = await pushToAdmin([{
    type: "textV2",
    text: `{everyone}\n${body}`,
    substitution: { everyone: { type: "mention", mentionee: { type: "all" } } },
  }], "emergency_mention_failed");
  if (!mentioned) await pushToAdmin([{ type: "text", text: body }], "emergency_notify_failed");
}

export async function notifyShadow(userId: string | undefined, intent: string, wouldReply: string): Promise<void> {
  const name = await getDisplayName(userId);
  await pushToAdmin([{
    type: "text",
    text: `🧪 [ทดลอง] ${name} · ${intent} · บอทจะตอบ: ${clip(wouldReply)}`,
  }], "shadow_notify_failed");
}
