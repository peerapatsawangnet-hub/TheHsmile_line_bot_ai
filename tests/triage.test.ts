import assert from "node:assert/strict";
import { test } from "node:test";
import type { Classification } from "../lib/gemini";
import { decide, fallbackIntent, isAck } from "../lib/triage";

test("ack: short acknowledgements are silent", () => {
  for (const text of [
    "ค่ะ", "จ้า", "จ้ส", "ได้ค่ะ", "โอเค", "โอเคค่ะ", "โอเคจ้า", "โอเครค่ะ", "OK", "Okay", "Okay ka", "ตามนั้น", "ตามนั้นค่ะ",
    "รับทราบค่ะ", "ได้จ้า", "👍", "🙏", "ค่ะ.", " โอเค ", "ครับ",
  ]) {
    assert.equal(isAck(text), true, text);
  }
});

test("ack: anything else goes to Gemini", () => {
  for (const text of ["โอเคค่ะคอนเฟิร์มค่ะขอบคุณค่ะ", "ขอบคุณค่ะ", "ค่ะ พรุ่งนี้ว่างไหม", "?", "เปิดกี่โมง", "😀", "👍🏻"]) {
    assert.equal(isAck(text), false, text);
  }
});

test("fallback", () => {
  assert.equal(fallbackIntent("หน้าบวมมาก"), "emergency");
  assert.equal(fallbackIntent("เลือดไหลไม่หยุด"), "emergency");
  assert.equal(fallbackIntent("พรุ่งนี้มีคิวไหม"), "booking");
  assert.equal(fallbackIntent("ขอเลื่อนเป็นบ่าย"), "booking");
  assert.equal(fallbackIntent("ราคาเท่าไหร่"), "unknown");
});

const base: Classification = {
  intent: "faq",
  confidence: "high",
  foundInFaq: true,
  reply: "เปิด 10:00 น. ค่ะ",
  multiplePatients: false,
  slots: {},
};
const with_ = (patch: Partial<Classification>) => decide({ ...base, ...patch }, true);

test("decide: faq", () => {
  assert.deepEqual(with_({}), { kind: "reply", text: "เปิด 10:00 น. ค่ะ" });
  assert.equal(with_({ foundInFaq: false, reply: "" }).kind, "notify");
  assert.equal(decide(base, false).kind, "notify");
});

test("decide: low confidence notifies admin, except emergency", () => {
  assert.equal(with_({ confidence: "low" }).kind, "notify");
  assert.equal(with_({ intent: "emergency", confidence: "low" }).kind, "emergency");
});

test("decide: booking", () => {
  assert.deepEqual(with_({ intent: "booking", slots: { date_text: "พรุ่งนี้" } }), {
    kind: "booking",
    slots: { date_text: "พรุ่งนี้" },
  });
  assert.equal(with_({ intent: "booking", multiplePatients: true }).kind, "notify");
});

test("decide: silent and admin intents", () => {
  for (const intent of ["ack", "greeting"] as const) assert.equal(with_({ intent }).kind, "silent");
  for (const intent of ["slot_reply", "symptom", "request", "late", "confused", "other"] as const) assert.equal(with_({ intent }).kind, "notify");
  assert.equal(with_({ intent: "reschedule" }).kind, "reschedule");
  assert.equal(with_({ intent: "cancel" }).kind, "handoff");
  assert.equal(with_({ intent: "thanks" }).kind, "thanks");
  assert.equal(with_({ intent: "appointment_query" }).kind, "appointment");
  assert.equal(with_({ intent: "doctor_schedule" }).kind, "doctor");
});
