import type { messagingApi } from "@line/bot-sdk";
import type { Classification } from "./gemini";
import { findFaqAnswer } from "./sheet";

const MAX_TEXT_LENGTH = 5000;   // ขีดจำกัดข้อความของ LINE
const MAX_BUTTONS = 13;
const MAX_LABEL_LENGTH = 20;
const MAX_BUTTON_TEXT = 60;
const THAI = /[฀-๿]/;
// ช่องที่เจ้าของยังไม่ได้เติม เช่น [นโยบายวันหยุดนักขัตฤกษ์] ห้ามส่งให้ลูกค้า
const PLACEHOLDER = /\[[^\]]+\]/;

export type FaqReply =
  | { kind: "reply"; text: string; buttons?: messagingApi.QuickReply }
  | { kind: "incomplete" };

// คำตอบหลายบรรทัดคือข้อความที่คลินิกจัดรูปแบบไว้ส่งเอง ส่งตรงตัว
// คำตอบบรรทัดเดียวเป็นโน้ตข้อมูล ให้ Gemini เรียบเรียงให้สุภาพ
const isFormatted = (answer: string) => answer.includes("\n");

function fromSheet(answer: string, polished: string | null): FaqReply {
  if (PLACEHOLDER.test(answer)) return { kind: "incomplete" };
  const text = isFormatted(answer) || !polished ? answer : polished;
  return { kind: "reply", text: text.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(answer) };
}

// ข้อความลูกค้าคือคำถามแบบหนึ่งในแถว FAQ พอดี (เช่น กดปุ่มที่สร้างจาก พิมพ์ "...")
// ตอบแถวนั้นเลยโดยไม่ถาม Gemini เฉพาะคำตอบที่จัดรูปแบบไว้แล้ว
export function exactFaqReply(faqCsv: string | null, message: string): FaqReply | null {
  const answer = faqCsv ? findFaqAnswer(faqCsv, message) : null;
  return answer && isFormatted(answer) ? fromSheet(answer, null) : null;
}

// Gemini ตอบว่าเจอใน FAQ: ใช้แถวที่ Gemini เลือก ลูกค้าพิมพ์ภาษาอื่นใช้ reply ที่ Gemini แปลให้
export function faqReply(faqCsv: string | null, result: Classification, message: string): FaqReply {
  const answer = faqCsv ? findFaqAnswer(faqCsv, result.faqQuestion) : null;
  if (!answer) return { kind: "reply", text: result.reply.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(result.reply) };
  if (!THAI.test(message)) {
    return PLACEHOLDER.test(answer)
      ? { kind: "incomplete" }
      : { kind: "reply", text: result.reply.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(answer) };
  }
  return fromSheet(answer, result.reply);
}

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
