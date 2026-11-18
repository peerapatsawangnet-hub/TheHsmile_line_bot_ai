import type { messagingApi } from "@line/bot-sdk";
import { ChoiceButton, faqCard as renderFaqCard } from "./flex-cards";
import type { Classification } from "./gemini";
import { isEn, tr } from "./i18n";
import { findFaqRow } from "./sheet";

const MAX_TEXT_LENGTH = 5000;   // ขีดจำกัดข้อความของ LINE
const MAX_BUTTONS = 13;
const MAX_LABEL_LENGTH = 20;     // ป้าย quick reply
const MAX_CARD_LABEL = 40;       // ป้ายปุ่มในการ์ด
const MAX_BUTTON_TEXT = 60;
const THAI = /[฀-๿]/;
// ช่องที่เจ้าของยังไม่ได้เติม เช่น [นโยบายวันหยุดนักขัตฤกษ์] ห้ามส่งให้ลูกค้า
const PLACEHOLDER = /\[[^\]]+\]/;
// ปุ่มในคำตอบ: พิมพ์ "…" / พิมพ์คำว่า “…” (ภาษาไทย) หรือ Type "…" (answer_en ภาษาอังกฤษ)
const BUTTON = String.raw`(?:พิมพ์(?:คำว่า)?|[Tt]ype)\s*["“'‘]([^"”'’\n]+)["”'’]`;

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

// ลูกค้าภาษาอังกฤษ: answer_en ที่คลินิกเขียนไว้ส่งตรงตัว ไม่มีก็ใช้ reply ที่ Gemini แปล (ไม่มีปุ่ม เพราะปุ่มเป็นภาษาไทย)
function english(answer: string, answerEn: string, geminiReply: string | null): FaqReply | null {
  if (answerEn) return PLACEHOLDER.test(answerEn) ? { kind: "incomplete" } : { kind: "reply", text: answerEn.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(answerEn) };
  if (PLACEHOLDER.test(answer)) return { kind: "incomplete" };
  return geminiReply ? { kind: "reply", text: geminiReply.slice(0, MAX_TEXT_LENGTH) } : null;
}

// ข้อความลูกค้าคือคำถามแบบหนึ่งในแถว FAQ พอดี (เช่น กดปุ่มที่สร้างจาก พิมพ์ "...")
// ตอบแถวนั้นเลยโดยไม่ถาม Gemini เฉพาะคำตอบที่จัดรูปแบบไว้แล้ว (ภาษาอังกฤษ: เฉพาะแถวที่มี answer_en)
export function exactFaqReply(faqCsv: string | null, message: string): FaqReply | null {
  const row = faqCsv ? findFaqRow(faqCsv, message) : null;
  if (!row) return null;
  if (isEn()) return row.answerEn ? english(row.answer, row.answerEn, null) : null;
  return isFormatted(row.answer) ? fromSheet(row.answer, null) : null;
}

// Gemini ตอบว่าเจอใน FAQ: ใช้แถวที่ Gemini เลือก ลูกค้าพิมพ์ภาษาอื่นใช้ reply ที่ Gemini แปลให้
export function faqReply(faqCsv: string | null, result: Classification, message: string): FaqReply {
  const row = faqCsv ? findFaqRow(faqCsv, result.faqQuestion) : null;
  const geminiOnly: FaqReply = isEn()
    ? { kind: "reply", text: result.reply.slice(0, MAX_TEXT_LENGTH) }
    : { kind: "reply", text: result.reply.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(result.reply) };
  if (!row) return geminiOnly;
  if (isEn()) return english(row.answer, row.answerEn, result.reply) ?? geminiOnly;
  if (!THAI.test(message)) {
    return PLACEHOLDER.test(row.answer)
      ? { kind: "incomplete" }
      : { kind: "reply", text: result.reply.slice(0, MAX_TEXT_LENGTH), buttons: faqButtons(row.answer) };
  }
  return fromSheet(row.answer, result.reply);
}

// ป้ายปุ่มยาวได้ 20 ตัว (สระและวรรณยุกต์นับด้วย) ข้อความที่ส่งยังเป็นคำเต็ม
function buttonLabel(phrase: string): string {
  if (phrase.length <= MAX_LABEL_LENGTH) return phrase;
  const short = phrase.replace(/^(ขอ|ดู)/, "");
  return short.length <= MAX_LABEL_LENGTH ? short : `${phrase.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

// บรรทัดที่จบด้วย พิมพ์ "x" พอดี (เช่น 💰 ราคา พิมพ์ "ราคารากฟันเทียม") คือบรรทัดปุ่ม
// คืนข้อความหน้าคำว่าพิมพ์เพื่อใช้เป็นป้ายปุ่ม ไม่ใช่บรรทัดปุ่มคืน null
function buttonLine(line: string, phrase: string): string | null {
  const match = line.match(new RegExp(String.raw`^(.*?)\s*${BUTTON}\s*$`));
  return match && match[2].trim() === phrase ? match[1].trim() : null;
}

// ปุ่มภาษาอังกฤษส่งเป็น postback: ลูกค้าเห็นป้ายภาษาอังกฤษในแชต บอทได้คำภาษาไทยไปหาแถวคำตอบ
function faqPostback(phrase: string): string {
  return `a=faq&l=en&q=${phrase.replace(/[&=%+]/g, encodeURIComponent)}`;
}

// คำตอบที่มีปุ่มส่งเป็นการ์ดปุ่มใหญ่ บรรทัดปุ่มย้ายไปเป็นปุ่ม ข้อความหน้าคำว่าพิมพ์เป็นป้าย
// พิมพ์ "…" กลางประโยคยังอยู่ในข้อความ และได้ปุ่มที่ใช้คำนั้นเป็นป้าย
export function faqCard(text: string, buttons: messagingApi.QuickReply): messagingApi.FlexMessage {
  const lines = text.split("\n");
  const choices: ChoiceButton[] = (buttons.items ?? []).map((item) => {
    const action = item.action as messagingApi.MessageAction;
    const phrase = action.text ?? "";
    const label = action.label ?? phrase;
    const at = lines.findIndex((line) => buttonLine(line, phrase) !== null);
    const prefix = at >= 0 ? buttonLine(lines[at], phrase) : null;
    if (at >= 0) lines.splice(at, 1);
    const shown = prefix || (phrase.length <= MAX_CARD_LABEL ? phrase : label);
    return isEn()
      ? { label: shown, data: faqPostback(phrase), displayText: shown }
      : { label: shown, data: "", displayText: phrase, message: true };
  });
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() || tr("เลือกหัวข้อที่ต้องการได้เลยค่ะ", "Please choose a topic.");
  return renderFaqCard(body, choices);
}

// คำตอบที่เขียนว่า พิมพ์ "ขอรายละเอียดการจัดฟัน" กลายเป็นปุ่มให้กดแทนการพิมพ์
export function faqButtons(text: string): messagingApi.QuickReply | undefined {
  const phrases = [...text.matchAll(new RegExp(BUTTON, "g"))]
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
