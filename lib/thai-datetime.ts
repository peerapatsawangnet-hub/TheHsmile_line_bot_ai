// แปลงวันเวลาที่ลูกค้าพิมพ์เป็นภาษาไทย ทำในโค้ดเท่านั้น ห้ามให้ Gemini คำนวณ
// ทุกฟังก์ชันรับ now (ms) และคิดตามเวลา Asia/Bangkok

const OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS: [string, string][] = [
  ["มกราคม", "มค"], ["กุมภาพันธ์", "กพ"], ["มีนาคม", "มีค"], ["เมษายน", "เมย"],
  ["พฤษภาคม", "พค"], ["มิถุนายน", "มิย"], ["กรกฎาคม", "กค"], ["สิงหาคม", "สค"],
  ["กันยายน", "กย"], ["ตุลาคม", "ตค"], ["พฤศจิกายน", "พย"], ["ธันวาคม", "ธค"],
];
export const MONTH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// ชื่อยาวก่อนชื่อย่อ ไม่อย่างนั้น "มีค" จะถูกอ่านเป็น "มค"
const MONTH_PATTERN = [...MONTHS.map(([full]) => full), ...MONTHS.map(([, abbr]) => abbr).sort((a, b) => b.length - a.length)].join("|");
const WEEKDAY_NAMES: [string, number][] = [
  ["อาทิตย์", 0], ["จันทร์", 1], ["อังคาร", 2], ["พุธ", 3], ["พฤหัสบดี", 4], ["พฤหัส", 4], ["ศุกร์", 5], ["เสาร์", 6],
];
const WEEKDAY_PATTERN = WEEKDAY_NAMES.map(([name]) => name).join("|");

const pad = (n: number) => String(n).padStart(2, "0");

function monthIndex(name: string): number {
  return MONTHS.findIndex(([full, abbr]) => name === full || name === abbr);
}

function weekdayIndex(name: string): number {
  return WEEKDAY_NAMES.find(([day]) => day === name)?.[1] ?? -1;
}

function today(now: number): { y: number; m: number; d: number; weekday: number; iso: string } {
  const date = new Date(now + OFFSET_MS);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    weekday: date.getUTCDay(),
    iso: date.toISOString().slice(0, 10),
  };
}

function toDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// ปี พ.ศ. 2 หลัก (69) หรือ 4 หลัก (2569) เป็น ค.ศ.
function toGregorianYear(raw: string): number {
  const year = Number(raw);
  if (raw.length <= 2) return 2500 + year - 543;
  return year > 2400 ? year - 543 : year;
}

// วันที่และเดือนที่ไม่ระบุปี: ใช้ครั้งถัดไปที่ยังไม่ผ่าน
function nextMonthDay(m: number, d: number, now: number): string | null {
  const t = today(now);
  for (const y of [t.y, t.y + 1]) {
    const iso = toDate(y, m, d);
    if (iso && iso >= t.iso) return iso;
  }
  return null;
}

// วันที่โดดๆ: เดือนนี้ถ้ายังไม่ผ่าน ไม่อย่างนั้นเดือนถัดไปที่มีวันที่นั้น
function nextDayOfMonth(d: number, now: number): string | null {
  const t = today(now);
  for (let i = 0; i < 3; i++) {
    const m = ((t.m - 1 + i) % 12) + 1;
    const y = t.y + Math.floor((t.m - 1 + i) / 12);
    const iso = toDate(y, m, d);
    if (iso && iso >= t.iso) return iso;
  }
  return null;
}

function nextWeekday(weekday: number, modifier: string | undefined, now: number): string {
  const t = today(now);
  if (modifier === "หน้า") {
    // สัปดาห์หน้าเริ่มวันจันทร์
    const monday = addDays(t.iso, -((t.weekday + 6) % 7));
    return addDays(monday, 7 + ((weekday + 6) % 7));
  }
  return addDays(t.iso, (weekday - t.weekday + 7) % 7);
}

export type ParsedDate = { date: string; weekdayMismatch: boolean };

export function parseDateText(text: string, now: number): ParsedDate | null {
  const s = text.replace(/\s+/g, " ").trim();
  // ตัดจุดออก: "6 พ.ย." เป็น "6 พย" และ "วันที่..19." เป็น "วันที่19"
  const compact = s.replace(/\./g, "");
  const ok = (date: string | null): ParsedDate | null => (date ? { date, weekdayMismatch: false } : null);

  const numeric = s.match(/(?<!\d)(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?(?!\d)/);
  if (numeric) {
    const [, d, m, y] = numeric;
    return ok(y ? toDate(toGregorianYear(y), Number(m), Number(d)) : nextMonthDay(Number(m), Number(d), now));
  }

  const named = compact.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:เดือน)?\\s*(${MONTH_PATTERN})(?:\\s*(\\d{2,4}))?`));
  if (named) {
    const [, d, name, y] = named;
    const m = monthIndex(name) + 1;
    return ok(y ? toDate(toGregorianYear(y), m, Number(d)) : nextMonthDay(m, Number(d), now));
  }

  const weekdayAndDay = compact.match(new RegExp(`(${WEEKDAY_PATTERN})\\s*(?:ที่)?\\s*(\\d{1,2})(?!\\d)`));
  if (weekdayAndDay) {
    const date = nextDayOfMonth(Number(weekdayAndDay[2]), now);
    if (!date) return null;
    return { date, weekdayMismatch: weekdayOf(date) !== weekdayIndex(weekdayAndDay[1]) };
  }

  const dayOnly = compact.match(/วันที่\s*(\d{1,2})(?!\d)/);
  if (dayOnly) return ok(nextDayOfMonth(Number(dayOnly[1]), now));

  const t = today(now);
  if (/มะรืน/.test(s)) return ok(addDays(t.iso, 2));
  if (/พรุ[่้]?งนี้|พรุ่งนี่/.test(s)) return ok(addDays(t.iso, 1));
  if (/วันนี้/.test(s)) return ok(t.iso);

  const weekday = s.match(new RegExp(`(${WEEKDAY_PATTERN})\\s*(นี้|หน้า)?`));
  if (weekday) return ok(nextWeekday(weekdayIndex(weekday[1]), weekday[2], now));

  return null;
}

// คืนนาทีนับจากเที่ยงคืน เช่น 13:00 = 780
export function parseTimeText(text: string): number | null {
  const s = text.replace(/\s+/g, " ").trim();
  if (/บ่ายโมง/.test(s) && !/\d/.test(s)) return 13 * 60;
  if (/เที่ยง/.test(s) && !/\d/.test(s)) return 12 * 60;

  const match = s.match(/(?<!\d)(\d{1,2})(?:\s*[:.]\s*(\d{2}))?(?!\d)/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (minute >= 60) return null;

  if (/ทุ่ม/.test(s)) hour += 18;
  else if (/บ่าย|เย็น/.test(s)) hour += hour < 12 ? 12 : 0;
  else if (/โมง/.test(s)) hour += hour <= 6 ? 12 : 0;
  // ตัวเลขโดดๆ ไม่มี น. หรือ โมง อาจเป็นวันที่ จึงไม่อ่าน
  else if (!match[2] && !/น\.?$|นาฬิกา/.test(s)) return null;

  return hour <= 23 ? hour * 60 + minute : null;
}

export function parsePeriod(text: string): "am" | "pm" | "eve" | null {
  if (/เช้า/.test(text)) return "am";
  if (/บ่าย/.test(text)) return "pm";
  if (/เย็น/.test(text)) return "eve";
  return null;
}

// เดือนที่ลูกค้าถาม เช่น "เดือนหน้า" หรือ "ธันวา" ไม่ระบุคือเดือนนี้
export function parseMonthText(text: string | undefined, now: number): { year: number; month: number } {
  const t = today(now);
  const s = (text ?? "").replace(/\./g, "");
  if (/เดือนหน้า/.test(s)) return t.m === 12 ? { year: t.y + 1, month: 1 } : { year: t.y, month: t.m + 1 };

  const name = s.match(new RegExp(MONTH_PATTERN));
  const index = name ? monthIndex(name[0]) : MONTHS.findIndex(([full]) => s.includes(full.slice(0, 4)));
  if (index >= 0) {
    const month = index + 1;
    return { year: month < t.m ? t.y + 1 : t.y, month };
  }
  return { year: t.y, month: t.m };
}
