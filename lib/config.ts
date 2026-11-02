export const GEMINI_MODEL = "gemini-3.5-flash";
export const TEMPERATURE = 1.0;          // ห้ามลด: Gemini 3.x จะตอบเพี้ยน
export const MAX_OUTPUT_TOKENS = 1024;   // Gemini 3.x นับ thinking + output รวมกัน
export const SHEET_CACHE_MS = 60_000;
export const SHEET_TIMEOUT_MS = 3_000;
export const GEMINI_TIMEOUT_MS = 7_000;  // รวม sheet แล้วต้องไม่เกินงบ 10 วินาที

export const CALENDAR_TIMEOUT_MS = 5_000;
export const BOOKING_DAYS_AHEAD = 14;
export const BOOKING_MIN_LEAD_MINUTES = 60;
export const BOOKING_SLOT_MINUTES = 15;
export const BOOKING_CAPACITY_PER_SLOT = 1;  // จำนวนนัดสูงสุดต่อช่วงเวลา 1 คือไม่ซ้อนนัดเดิม
export const BOOKING_HOLD_MINUTES = 15;      // เวลากันคิวระหว่างรอลูกค้าพิมพ์ชื่อและเบอร์
export const CALENDAR_COLOR_PENDING = "8";      // Graphite: เทา รอแอดมินยืนยัน
export const CALENDAR_COLOR_UNCONFIRMED = "7";  // Peacock: ฟ้า แอดมินยืนยันแล้ว รอคนไข้คอนเฟิร์ม
export const CALENDAR_COLOR_CONFIRMED = "3";    // Grape: ม่วง คนไข้คอนเฟิร์มแล้ว

export const CLINIC_PHONE = "062 038 9777";
export const CLINIC_PHONE_URI = "tel:0620389777";
export const HANDOFF_REPLY = "ขอแอดมินติดต่อกลับนะคะ 🙏";

export const DEFAULT_REPLY =
  "ขออภัยค่ะ เรื่องนี้แอดมินขอให้เจ้าหน้าที่ติดต่อกลับโดยเร็วที่สุดนะคะ 🙏 หรือโทรสอบถามได้ที่ 062 038 9777 ค่ะ";
