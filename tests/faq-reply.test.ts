import assert from "node:assert/strict";
import { test } from "node:test";
import Papa from "papaparse";
import { exactFaqReply, faqButtons, faqReply } from "../lib/faq-reply";
import type { Classification } from "../lib/gemini";
import { findFaqAnswer } from "../lib/sheet";

// แถวปลอมในรูปแบบเดียวกับ Sheet จริง: คำถามหลายแบบคั่นด้วย / ราคาจริงอยู่ใน Sheet เท่านั้น
const csv = Papa.unparse([
  { category: "จัดฟัน", question: "จัดฟันราคาเท่าไหร่ / จัดฟันกี่บาท / braces", answer: 'เริ่มต้น 1,111 บาทค่ะ\nสนใจรายละเอียด พิมพ์คำว่า “ขอรายละเอียดการจัดฟัน” ได้เลยค่ะ' },
  { category: "จัดฟัน", question: "ขอรายละเอียดการจัดฟัน", answer: "โปร A\n• เดือน 1: 1,111\n• เดือน 2–11: 222" },
  { category: "ติดต่อ", question: "เบอร์โทรอะไร / ติดต่อทางไหน", answer: 'โทร 000 000 0000 สนใจพิมพ์ "จองคิว"' },
  { category: "เวลา", question: "เปิดวันหยุดนักขัตฤกษ์ไหม / สงกรานต์เปิดไหม", answer: "[นโยบายวันหยุดนักขัตฤกษ์]" },
]);

const result = (extra: Partial<Classification> = {}): Classification => ({
  intent: "faq", confidence: "high", foundInFaq: true, reply: "ข้อความที่ Gemini เรียบเรียงค่ะ", multiplePatients: false, slots: {}, ...extra,
});

test("findFaqAnswer matches the whole question cell or any / variant", () => {
  const price = findFaqAnswer(csv, "จัดฟันราคาเท่าไหร่ / จัดฟันกี่บาท / braces");
  assert.match(price ?? "", /^เริ่มต้น 1,111/);
  assert.equal(findFaqAnswer(csv, "จัดฟันกี่บาท"), price);
  assert.equal(findFaqAnswer(csv, " จัดฟัน ราคาเท่าไหร่? "), price);
  assert.equal(findFaqAnswer(csv, "ขอรายละเอียดการจัดฟัน"), "โปร A\n• เดือน 1: 1,111\n• เดือน 2–11: 222");
  assert.equal(findFaqAnswer(csv, "ไม่มีแถวนี้"), null);
  assert.equal(findFaqAnswer(csv, undefined), null);
  assert.equal(findFaqAnswer(csv, " / "), null);
});

test("faqReply: multi-line sheet answers go out verbatim with buttons", () => {
  const reply = faqReply(csv, result({ faqQuestion: "จัดฟันราคาเท่าไหร่ / จัดฟันกี่บาท / braces" }), "จัดฟันเท่าไหร่คะ");
  assert.equal(reply.kind, "reply");
  assert.match(reply.kind === "reply" ? reply.text : "", /^เริ่มต้น 1,111 บาทค่ะ\n/);
  assert.equal(reply.kind === "reply" ? reply.buttons?.items?.[0]?.action?.type : "", "message");
});

test("faqReply: single-line notes use Gemini's polite wording, buttons still come from the sheet", () => {
  const reply = faqReply(csv, result({ faqQuestion: "เบอร์โทรอะไร / ติดต่อทางไหน" }), "ขอเบอร์หน่อย");
  assert.deepEqual(reply.kind === "reply" ? [reply.text, reply.buttons?.items?.[0]?.action] : null, [
    "ข้อความที่ Gemini เรียบเรียงค่ะ",
    { type: "message", label: "จองคิว", text: "จองคิว" },
  ]);
});

test("faqReply: unfilled [placeholder] rows are never sent", () => {
  assert.deepEqual(faqReply(csv, result({ faqQuestion: "เปิดวันหยุดนักขัตฤกษ์ไหม / สงกรานต์เปิดไหม" }), "สงกรานต์เปิดไหม"), { kind: "incomplete" });
  assert.deepEqual(faqReply(csv, result({ faqQuestion: "สงกรานต์เปิดไหม" }), "open on songkran?"), { kind: "incomplete" });
});

test("faqReply: English question -> Gemini's reply; row not found -> Gemini's reply", () => {
  const english = faqReply(csv, result({ faqQuestion: "braces", reply: "Braces start at 1,111 baht." }), "how much are braces");
  assert.equal(english.kind === "reply" ? english.text : "", "Braces start at 1,111 baht.");
  const missing = faqReply(csv, result({ faqQuestion: "แถวที่ไม่มี" }), "จัดฟันเท่าไหร่");
  assert.equal(missing.kind === "reply" ? missing.text : "", "ข้อความที่ Gemini เรียบเรียงค่ะ");
});

test("exactFaqReply: only formatted (multi-line) rows skip Gemini", () => {
  const detail = exactFaqReply(csv, "ขอรายละเอียดการจัดฟัน");
  assert.equal(detail?.kind === "reply" ? detail.text : "", "โปร A\n• เดือน 1: 1,111\n• เดือน 2–11: 222");
  assert.equal(exactFaqReply(csv, "จัดฟันกี่บาท")?.kind, "reply");
  assert.equal(exactFaqReply(csv, "เบอร์โทรอะไร"), null);
  assert.equal(exactFaqReply(csv, "สงกรานต์เปิดไหม"), null);
  assert.equal(exactFaqReply(null, "ขอรายละเอียดการจัดฟัน"), null);
});

test("faqButtons turns พิมพ์ \"...\" into tap buttons", () => {
  const buttons = faqButtons('สนใจรายละเอียด พิมพ์คำว่า “ขอรายละเอียดการจัดฟัน” หรือพิมพ์ "จองคิว" ได้เลยค่ะ');
  // Thai marks count toward LINE's 20-character label limit: the label is shortened, the sent text is not
  assert.deepEqual(buttons?.items?.map((item) => item.action), [
    { type: "message", label: "รายละเอียดการจัดฟัน", text: "ขอรายละเอียดการจัดฟัน" },
    { type: "message", label: "จองคิว", text: "จองคิว" },
  ]);
  assert.equal(faqButtons("เปิด 10:00 น. ค่ะ"), undefined);
  const long = faqButtons('พิมพ์ "ข้อความนี้ยาวเกินกว่ายี่สิบตัวอักษรแน่นอน"')?.items?.[0]?.action as { label: string; text: string } | undefined;
  assert.equal(long?.label.length, 20);
  assert.equal(long?.text, "ข้อความนี้ยาวเกินกว่ายี่สิบตัวอักษรแน่นอน");
  assert.equal(faqButtons('พิมพ์ "จองคิว" หรือ พิมพ์ "จองคิว"')?.items?.length, 1);
});
