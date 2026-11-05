import assert from "node:assert/strict";
import { test } from "node:test";
import Papa from "papaparse";
import { faqButtons, faqReplyText } from "../lib/faq-reply";
import type { Classification } from "../lib/gemini";
import { findFaqAnswer } from "../lib/sheet";

// แถวตัวอย่างปลอม ราคาจริงอยู่ใน Sheet เท่านั้น
const csv = Papa.unparse([
  { category: "ราคา", question: "จัดฟันราคาเท่าไหร่", answer: 'เริ่มต้น 1,111 บาทค่ะ\nสนใจรายละเอียด พิมพ์คำว่า “ขอรายละเอียดการจัดฟัน” ได้เลยค่ะ' },
  { category: "ราคา", question: "ขอรายละเอียดการจัดฟัน", answer: "โปร A\n* เดือน 1: 1,111\n* เดือน 2–11: 222" },
]);

const result = (extra: Partial<Classification> = {}): Classification => ({
  intent: "faq", confidence: "high", foundInFaq: true, reply: "สรุปจาก Gemini ค่ะ", multiplePatients: false, slots: {}, ...extra,
});

test("findFaqAnswer returns the sheet answer verbatim, multi-line included", () => {
  assert.equal(findFaqAnswer(csv, "ขอรายละเอียดการจัดฟัน"), "โปร A\n* เดือน 1: 1,111\n* เดือน 2–11: 222");
  // Gemini may drop spaces, quotes or the question mark
  assert.equal(findFaqAnswer(csv, " จัดฟัน ราคาเท่าไหร่? "), findFaqAnswer(csv, "จัดฟันราคาเท่าไหร่"));
  assert.equal(findFaqAnswer(csv, "ไม่มีแถวนี้"), null);
  assert.equal(findFaqAnswer(csv, undefined), null);
});

test("faqReplyText: Thai question -> sheet text, English -> Gemini's reply, no match -> Gemini's reply", () => {
  assert.match(faqReplyText(csv, result({ faqQuestion: "ขอรายละเอียดการจัดฟัน" }), "ขอรายละเอียดการจัดฟัน"), /^โปร A\n/);
  assert.equal(faqReplyText(csv, result({ faqQuestion: "จัดฟันราคาเท่าไหร่" }), "how much are braces"), "สรุปจาก Gemini ค่ะ");
  assert.equal(faqReplyText(csv, result({ faqQuestion: "แถวที่ไม่มี" }), "จัดฟันเท่าไหร่"), "สรุปจาก Gemini ค่ะ");
  assert.equal(faqReplyText(null, result({ faqQuestion: "จัดฟันราคาเท่าไหร่" }), "จัดฟันเท่าไหร่"), "สรุปจาก Gemini ค่ะ");
});

test("faqButtons turns พิมพ์ \"...\" into tap buttons", () => {
  const buttons = faqButtons('สนใจรายละเอียด พิมพ์คำว่า “ขอรายละเอียดการจัดฟัน” หรือพิมพ์ "จองคิว" ได้เลยค่ะ');
  // Thai marks count toward LINE's 20-character label limit: the label is shortened, the sent text is not
  assert.deepEqual(buttons?.items?.map((item) => item.action), [
    { type: "message", label: "รายละเอียดการจัดฟัน", text: "ขอรายละเอียดการจัดฟัน" },
    { type: "message", label: "จองคิว", text: "จองคิว" },
  ]);
  assert.ok(buttons?.items?.every((item) => (item.action as { label: string }).label.length <= 20));
  assert.equal(faqButtons("เปิด 10:00 น. ค่ะ"), undefined);
  const long = faqButtons('พิมพ์ "ข้อความนี้ยาวเกินกว่ายี่สิบตัวอักษรแน่นอน"')?.items?.[0]?.action as { label: string; text: string } | undefined;
  assert.equal(long?.label.length, 20);
  assert.equal(long?.text, "ข้อความนี้ยาวเกินกว่ายี่สิบตัวอักษรแน่นอน");
  assert.equal(faqButtons('พิมพ์ "จองคิว" หรือ พิมพ์ "จองคิว"')?.items?.length, 1);
});
