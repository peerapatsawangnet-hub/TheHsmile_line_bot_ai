import { isTelegramAdmin, sendToAdmin } from "./admin-channel";
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

// เปลี่ยนหรือเลื่อนนัด ไม่รวมยกเลิก ลูกค้าเลือกเวลาใหม่เองได้ถ้านัดจองผ่าน LINE
export function isRescheduleCommand(message: string): boolean {
  return includesAny(message, ["เปลี่ยนนัด", "เลื่อนนัด"]) && !message.includes("ยกเลิก");
}

export function isCancelCommand(message: string): boolean {
  return message.includes("ยกเลิกนัด");
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

// ข้อความลูกค้าไปอยู่ในกลุ่มแอดมินเท่านั้น ห้ามลง log
export async function notifyAdmin(userId: string | undefined, reason: string, message: string): Promise<void> {
  const name = await getDisplayName(userId);
  await sendToAdmin({
    text: `🔔 มีแชทรอแอดมินตอบ\nลูกค้า: ${name}\nเรื่อง: ${reason}\nข้อความ: ${clip(message)}\nตอบได้ที่: LINE OA Manager → แชท`,
  }, "admin_notify_failed");
}

export async function notifyEmergency(userId: string | undefined, message: string): Promise<void> {
  const name = await getDisplayName(userId);
  const body = `🔴 ด่วน · อาการฉุกเฉิน\nลูกค้า: ${name}\nข้อความ: ${clip(message)}\nกรุณาติดต่อกลับทันที`;
  console.log(JSON.stringify({ tag: "emergency" }));

  // LINE: mention ทุกคนในกลุ่ม ถ้าไม่รับ textV2 ให้ส่งข้อความปกติแทน
  // Telegram: ข้อความในกลุ่มแจ้งเตือนทุกคนอยู่แล้ว
  const sent = await sendToAdmin({
    text: body,
    line: [{
      type: "textV2",
      text: `{everyone}\n${body}`,
      substitution: { everyone: { type: "mention", mentionee: { type: "all" } } },
    }],
  }, "emergency_mention_failed");
  if (!sent && !isTelegramAdmin()) await sendToAdmin({ text: body }, "emergency_notify_failed");
}

export async function notifyShadow(
  userId: string | undefined,
  intent: string,
  wouldReply: string,
  image?: string | null,
): Promise<void> {
  const name = await getDisplayName(userId);
  await sendToAdmin({ text: `🧪 [ทดลอง] ${name} · ${intent} · บอทจะตอบ: ${clip(wouldReply)}`, image }, "shadow_notify_failed");
}
