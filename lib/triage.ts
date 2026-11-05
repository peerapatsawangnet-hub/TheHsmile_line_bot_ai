import type { Classification } from "./gemini";
import { ADMIN_LABELS } from "./intents";

const MAX_ACK_LENGTH = 12;
const ACK_WORDS = new Set(["ได้", "โอเค", "โอเคร", "ok", "okay", "ตามนั้น", "รับทราบ"]);
// คำลงท้าย เช่น "โอเคค่ะ" "ได้จ้า" หรือพิมพ์คำลงท้ายอย่างเดียว เช่น "ค่ะ"
const PARTICLES = /(?:นะคะ|นะ|ค่ะ|คะ|ครับ|คับ|จ้า|จ้ะ|จ๊ะ|จ้ส|ka|krub)+$/u;

// ต้องพลาดฝั่ง "ไม่จับ": ข้อความที่ไม่แน่ใจให้ Gemini ตัดสิน
export function isAck(text: string): boolean {
  const core = text.toLowerCase().replace(/[\s.!~👍🙏]+/gu, "");
  if (core === "") return /👍|🙏/u.test(text);
  if (core.length > MAX_ACK_LENGTH) return false;
  const base = core.replace(PARTICLES, "");
  return base === "" || ACK_WORDS.has(base);
}

const BOOKING_WORDS = /นัด|จอง|คิว|ว่าง|เลื่อน/;
const EMERGENCY_WORDS = /บวม|เลือด|หายใจ|กลืน|ไข้|อุบัติเหตุ/;

// ใช้เมื่อ Gemini ใช้ไม่ได้
export function fallbackIntent(text: string): "emergency" | "booking" | "unknown" {
  if (EMERGENCY_WORDS.test(text)) return "emergency";
  if (BOOKING_WORDS.test(text)) return "booking";
  return "unknown";
}

export type Decision =
  | { kind: "reply"; text: string }
  | { kind: "booking"; slots: Classification["slots"] }
  | { kind: "handoff"; reason: string }
  | { kind: "reschedule" }
  | { kind: "appointment" }
  | { kind: "doctor"; dateText?: string }
  | { kind: "thanks" }
  | { kind: "silent" }
  | { kind: "notify"; reason: string }
  | { kind: "emergency" };

export function decide(result: Classification, faqAvailable: boolean): Decision {
  const { intent, confidence } = result;
  if (intent === "emergency") return { kind: "emergency" };
  if (confidence === "low") return { kind: "notify", reason: ADMIN_LABELS.other };

  switch (intent) {
    case "faq":
      if (!faqAvailable) return { kind: "notify", reason: "ระบบขัดข้อง (อ่าน FAQ ไม่ได้)" };
      return result.foundInFaq && result.reply
        ? { kind: "reply", text: result.reply }
        : { kind: "notify", reason: ADMIN_LABELS.faq };
    case "booking":
      return result.multiplePatients
        ? { kind: "notify", reason: "จองให้หลายคน" }
        : { kind: "booking", slots: result.slots };
    case "reschedule":
      return { kind: "reschedule" };
    case "cancel":
      return { kind: "handoff", reason: ADMIN_LABELS[intent] };
    case "appointment_query":
      return { kind: "appointment" };
    case "doctor_schedule":
      return { kind: "doctor", dateText: result.slots.date_text };
    case "thanks":
      return { kind: "thanks" };
    case "ack":
    case "greeting":
      return { kind: "silent" };
    // บอทไม่รู้ว่าใครถามวันเวลา อาจเป็นคำตอบต่อคำตอบของบอทเอง จึงต้องแจ้งแอดมิน
    case "slot_reply":
      return { kind: "notify", reason: ADMIN_LABELS.slot_reply };
    default:
      return { kind: "notify", reason: ADMIN_LABELS[intent] };
  }
}
