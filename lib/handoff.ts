import { HTTPFetchError } from "@line/bot-sdk";
import { getLineClient } from "./line";

const MAX_NOTIFY_LENGTH = 500;

const HANDOFF_TRIGGERS = [
  // ขอคุยกับคน
  "คุยกับคน",
  "คุยกับแอดมิน",
  "คุยกับเจ้าหน้าที่",
  "ขอแอดมิน",
  "ขอเจ้าหน้าที่",
  "talk to a human",
  "talk to staff",
  "speak to staff",
  // ร้องเรียน
  "ฟ้อง",
  "ร้องเรียน",
  "ไม่พอใจ",
  "complaint",
  // อาการที่ควรให้คนดูแลทันที
  "เลือดไม่หยุด",
  "เลือดไหลไม่หยุด",
  "ปวดมาก",
  "ปวดฟันมาก",
  "หน้าบวม",
  // สื่อ
  "ติดต่อสื่อ",
];

export function shouldHandoff(message: string): boolean {
  const lower = message.toLowerCase();
  return HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger));
}

async function getDisplayName(userId: string): Promise<string> {
  try {
    const profile = await getLineClient().getProfile(userId);
    return profile.displayName;
  } catch {
    // ลูกค้าอาจยังไม่ได้เพิ่มเพื่อน ให้แอดมินหาจากข้อความแทน
    return "ไม่ทราบชื่อ";
  }
}

// ไม่ throw: แจ้งแอดมินไม่สำเร็จต้องไม่ทำให้ลูกค้าไม่ได้รับคำตอบ
export async function notifyAdmin(userId: string | undefined, message: string): Promise<void> {
  const groupId = process.env.ADMIN_GROUP_ID;
  if (!groupId) {
    console.warn(JSON.stringify({ tag: "handoff_no_admin_group" }));
    return;
  }

  try {
    const name = userId ? await getDisplayName(userId) : "ไม่ทราบชื่อ";
    await getLineClient().pushMessage({
      to: groupId,
      messages: [{
        type: "text",
        text: `🔔 ลูกค้าต้องการคุยกับแอดมิน\n\nชื่อ LINE: ${name}\nข้อความ: ${message.slice(0, MAX_NOTIFY_LENGTH)}\n\nตอบได้ที่: https://manager.line.biz`,
      }],
    });
  } catch (err) {
    console.error(JSON.stringify({
      tag: "handoff_notify_failed",
      status: err instanceof HTTPFetchError ? err.status : undefined,
      body: err instanceof HTTPFetchError ? err.body : undefined,
    }));
  }
}
