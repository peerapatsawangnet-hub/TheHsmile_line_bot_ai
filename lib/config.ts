import { ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.5-flash";
export const TEMPERATURE = 1.0;          // ห้ามลด: Gemini 3.x จะตอบเพี้ยน
export const MAX_OUTPUT_TOKENS = 1024;   // Gemini 3.x นับ thinking + output รวมกัน
// จัดประเภทข้อความไม่ต้องคิดลึก ค่าเริ่มต้นคิดนานจนเกิน 7 วินาทีและใช้ token เกินครึ่ง
// ไม่ใช้ MINIMAL เพราะเคสฉุกเฉินต้องจัดถูกทุกครั้ง
export const GEMINI_THINKING_LEVEL = ThinkingLevel.LOW;
export const SHEET_CACHE_MS = 60_000;
export const SHEET_TIMEOUT_MS = 3_000;
// Vertex AI วัดได้ 1-5.4 วินาที รวมการลองใหม่เมื่อเจอ 429/503 ต้องไม่เกินงบนี้
export const GEMINI_TIMEOUT_MS = 7_000;

export const CALENDAR_TIMEOUT_MS = 5_000;
export const TELEGRAM_TIMEOUT_MS = 5_000;
// รายชื่อคนไข้สำหรับเติม DN เปลี่ยนไม่บ่อย อ่านไม่ทันก็จองต่อได้โดยไม่มี DN
export const PATIENTS_TIMEOUT_MS = 3_000;
export const PATIENTS_CACHE_MS = 10 * 60_000;
export const BOOKING_DAYS_AHEAD = 30;
export const BOOKING_MIN_LEAD_MINUTES = 60;
export const BOOKING_SLOT_MINUTES = 15;
export const BOOKING_CAPACITY_PER_SLOT = 1;  // จำนวนนัดสูงสุดต่อช่วงเวลา 1 คือไม่ซ้อนนัดเดิม
export const BOOKING_HOLD_MINUTES = 15;      // เวลากันคิวระหว่างรอลูกค้าพิมพ์ชื่อและเบอร์
// สีปุ่มหลักในการ์ดที่ลูกค้าเห็น (จองคิว เตือนนัด ติดต่อกลับ) เจ้าของเลือกสีน้ำเงิน
export const BUTTON_COLOR = "#2563EB";
export const CALENDAR_COLOR_PENDING = "8";      // Graphite: เทา รอแอดมินยืนยัน
export const CALENDAR_COLOR_UNCONFIRMED = "7";  // Peacock: ฟ้า แอดมินยืนยันแล้ว รอคนไข้คอนเฟิร์ม
export const CALENDAR_COLOR_CONFIRMED = "3";    // Grape: ม่วง คนไข้คอนเฟิร์มแล้ว

export const CLINIC_PHONE = "062 038 9777";
export const CLINIC_PHONE_URI = "tel:0620389777";
export const HANDOFF_REPLY = "ขอแอดมินติดต่อกลับนะคะ 🙏";
// ข้อความตายตัว ไม่ผ่าน Gemini
export const THANKS_REPLY = "ยินดีค่ะ หากต้องการข้อมูลเพิ่มเติมเร่งด่วน โทร 0620389777 ค่ะ";

// ถามเวลานัดหรือวันคุณหมอเข้า: อ่าน Calendar ไม่ทันในเวลานี้ ให้เงียบและแจ้งแอดมิน
export const LOOKUP_TIMEOUT_MS = 3_000;
// โควต้าข้อความเดือนนี้ใช้ไปเกินสัดส่วนนี้ ให้เตือนในสรุปรายวัน
export const QUOTA_WARN_RATIO = 0.8;

// ไม่มี DEFAULT_REPLY แล้ว: เรื่องที่บอทตอบไม่ได้ บอทเงียบและแจ้งกลุ่มแอดมินแทน
