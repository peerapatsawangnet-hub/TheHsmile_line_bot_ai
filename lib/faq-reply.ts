import type { messagingApi } from "@line/bot-sdk";
import type { Classification } from "./gemini";
import { findFaqAnswer } from "./sheet";

const MAX_TEXT_LENGTH = 5000;   // ขีดจำกัดข้อความของ LINE
const MAX_BUTTONS = 13;
const MAX_LABEL_LENGTH = 20;
const THAI = /[฀-๿]/;

// ลูกค้าพิมพ์ไทย: ส่งคำตอบจาก Sheet ตรงตัว ลูกค้าพิมพ์ภาษาอื่น: ใช้ reply ที่ Gemini แปลให้
export function faqReplyText(faqCsv: string | null, result: Classification, message: string): string {
  const exact = faqCsv && THAI.test(message) ? findFaqAnswer(faqCsv, result.faqQuestion) : null;
  return (exact ?? result.reply).slice(0, MAX_TEXT_LENGTH);
}

const MAX_BUTTON_TEXT = 60;

// ป้ายปุ่มยาวได้ 20 ตัว (สระและวรรณยุกต์นับด้วย) ข้อความที่ส่งยังเป็นคำเต็ม
function buttonLabel(phrase: string): string {
  if (phrase.length <= MAX_LABEL_LENGTH) return phrase;
  const short = phrase.replace(/^(ขอ|ดู)/, "");
  return short.length <= MAX_LABEL_LENGTH ? short : `${phrase.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

// คำตอบที่เขียนว่า พิมพ์ "ขอรายละเอียดการจัดฟัน" กลายเป็นปุ่มให้กดแทนการพิมพ์
export function faqButtons(text: string): messagingApi.QuickReply | undefined {
  const phrases = [...text.matchAll(/พิมพ์(?:คำว่า)?\s*["“'‘]([^"”'’\n]+)["”'’]/g)]
    .map((match) => match[1].trim())
    .filter((phrase, index, all) => phrase && phrase.length <= MAX_BUTTON_TEXT && all.indexOf(phrase) === index)
    .slice(0, MAX_BUTTONS);
  if (phrases.length === 0) return undefined;
  return {
    items: phrases.map((phrase) => ({
      type: "action",
      action: { type: "message", label: buttonLabel(phrase), text: phrase },
    })),
  };
}
