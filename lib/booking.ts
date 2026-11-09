import { messagingApi } from "@line/bot-sdk";
import { BookingHours, getBookingHours, getServices, Service, TimeRange } from "./booking-config";
import {
  CalendarEvent,
  deleteEvent,
  getEvent,
  insertEvent,
  listDoctorDays,
  listEvents,
  patchEvent,
} from "./calendar";
import {
  BOOKING_CAPACITY_PER_SLOT,
  BOOKING_DAYS_AHEAD,
  BOOKING_HOLD_MINUTES,
  BOOKING_MIN_LEAD_MINUTES,
  BOOKING_SLOT_MINUTES,
  CALENDAR_COLOR_CONFIRMED,
  CALENDAR_COLOR_PENDING,
  CALENDAR_COLOR_UNCONFIRMED,
  CLINIC_PHONE,
} from "./config";
import { AdminNotice, hasAdminChannel, sendToAdmin } from "./admin-channel";
import {
  AdminCardAction,
  BOOKING_CARD_NOTE,
  bookingActions,
  bookingRequestCard,
  ChoiceButton,
  choiceCard,
  reminderCard,
  withCardNote,
} from "./flex-cards";
import type { Slots } from "./gemini";
import { notifyAdmin } from "./handoff";
import { getLineClient } from "./line";
import { findDn } from "./patients";
import { MONTH_SHORT, parseDateText, parsePeriod, parseTimeText } from "./thai-datetime";

type Message = messagingApi.Message;

const OFFSET = "+07:00";
const OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_QUICK_REPLIES = 13;
const MAX_NAME_LENGTH = 100;
const SUGGESTED_TIMES = 2;
const PENDING_PREFIX = "[รอแอดมิน] ";

const BOOKING_TRIGGERS = ["จองคิว", "จองนัด", "ขอนัด", "อยากนัด", "นัดหมอ", "นัดหมาย", "book appointment"];
// ok/no: ยืนยันหรือปฏิเสธนัดและคำขอเลื่อนนัด cx/ck: ยืนยันยกเลิกนัดหรือไม่ยกเลิก
const ADMIN_ACTIONS = new Set(["ok", "no", "cx", "ck"]);
const CANCEL_PREFIX = "[ขอยกเลิก] ";
const OTHER_SERVICE_LABEL = "บริการอื่น ๆ / ติดต่อแอดมิน";
// แอดมินเห็นข้อความนี้ในกลุ่ม จึงรู้ว่าลูกค้าอยากนัดบริการที่ไม่มีในปุ่ม
const OTHER_SERVICE_TEXT = "ขอแอดมิน (นัดบริการอื่น)";

const RIGHTS: Record<string, { label: string; summary: string }> = {
  gold: { label: "สปสช (สิทธิบัตรทอง)", summary: "สปสช" },
  sso: { label: "ประกันสังคม", summary: "ประกันสังคม" },
  self: { label: "ชำระเอง", summary: "ชำระเอง" },
};
const VISITS: Record<string, { label: string; summary: string }> = {
  old: { label: "เคยมาแล้ว", summary: "เคยมาแล้ว" },
  new: { label: "มาครั้งแรก", summary: "คนไข้ใหม่" },
};
const PERIODS: Record<string, { label: string; from: number; to: number }> = {
  am: { label: "ช่วงเช้า", from: 0, to: 12 * 60 },
  pm: { label: "ช่วงบ่าย", from: 12 * 60, to: 16 * 60 },
  eve: { label: "ช่วงเย็น", from: 16 * 60, to: 24 * 60 },
};
const COVERAGES: Record<string, string> = { สปสช: "gold", ประกันสังคม: "sso", ชำระเอง: "self" };

// ข้อมูลที่ลูกค้าบอกมาแล้วในข้อความแรก ส่งต่อไปกับปุ่มทุกขั้นจนถึงขั้นที่ใช้
type Prefill = { right?: string; date?: string; period?: string; start?: number };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function isBookingEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY &&
    process.env.GOOGLE_CALENDAR_ID &&
    process.env.SERVICES_CSV_URL &&
    process.env.HOURS_CSV_URL &&
    hasAdminChannel(),
  );
}

export function isBookingRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return BOOKING_TRIGGERS.some((trigger) => lower.includes(trigger));
}

export function isAdminAction(data: string): boolean {
  return ADMIN_ACTIONS.has(new URLSearchParams(data).get("a") ?? "");
}

export function toIso(date: string, minutes: number): string {
  return `${date}T${clock(minutes)}:00${OFFSET}`;
}

// RFC3339 ไม่รับชั่วโมง 24 จึงใช้เที่ยงคืนของวันถัดไปเป็นเวลาจบของวัน
export function endOfDay(date: string): string {
  return new Date(Date.parse(toIso(date, 0)) + DAY_MS).toISOString();
}

export function dateAt(now: number, daysAhead: number): string {
  return new Date(now + OFFSET_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

// ป้ายปุ่ม quick reply ยาวได้ไม่เกิน 20 ตัวอักษร
function shortDate(value: string): string {
  return formatDate(value).replace(/^วัน/, "").replace("ที่ ", " ");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatWhen(startIso: string): string {
  return `${formatDate(startIso)} เวลา ${formatTime(startIso)} น.`;
}

function rangesFor(date: string, hours: BookingHours): TimeRange[] {
  return hours.dates[date] ?? hours.weekly[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? [];
}

function isExpiredHold(event: CalendarEvent, now: number): boolean {
  const until = event.extendedProperties?.private?.holdUntil;
  return Boolean(until) && Number(until) <= now;
}

function countsForCapacity(event: CalendarEvent, now: number): boolean {
  return Boolean(event.start?.dateTime && event.end?.dateTime) &&
    event.status !== "cancelled" &&
    event.transparency !== "transparent" &&
    !isExpiredHold(event, now);
}

// นับเฉพาะเวลา ไม่อ่านชื่อหรือเบอร์ของคนไข้คนอื่น
async function loadEvents(timeMin: string, timeMax: string, now: number): Promise<CalendarEvent[]> {
  const events = await listEvents({ timeMin, timeMax });
  // ลบคิวที่ลูกค้ากันไว้แต่ไม่ได้กรอกข้อมูล ไม่ให้ค้างในปฏิทิน
  await Promise.allSettled(
    events.filter((event) => isExpiredHold(event, now)).map((event) => deleteEvent(event.id)),
  );
  return events.filter((event) => countsForCapacity(event, now));
}

function overlapCount(events: CalendarEvent[], startMs: number, endMs: number): CalendarEvent[] {
  return events.filter((event) =>
    startMs < Date.parse(event.end?.dateTime ?? "") && endMs > Date.parse(event.start?.dateTime ?? ""),
  );
}

function hasCapacity(events: CalendarEvent[], startMs: number, minutes: number): boolean {
  const endMs = startMs + minutes * MINUTE_MS;
  for (let t = startMs; t < endMs; t += BOOKING_SLOT_MINUTES * MINUTE_MS) {
    if (overlapCount(events, t, t + BOOKING_SLOT_MINUTES * MINUTE_MS).length >= BOOKING_CAPACITY_PER_SLOT) {
      return false;
    }
  }
  return true;
}

function freeSlots(date: string, ranges: TimeRange[], minutes: number, events: CalendarEvent[], now: number): number[] {
  const earliest = now + BOOKING_MIN_LEAD_MINUTES * MINUTE_MS;
  const slots: number[] = [];
  for (const { open, close } of ranges) {
    for (let start = open; start + minutes <= close; start += BOOKING_SLOT_MINUTES) {
      const startMs = Date.parse(toIso(date, start));
      if (startMs >= earliest && hasCapacity(events, startMs, minutes)) slots.push(start);
    }
  }
  return slots;
}

// การ์ดปุ่มใหญ่ ไม่มีปุ่มเล็กด้านล่าง (เจ้าของเลือกเอาออกเพราะซ้ำกัน) columns > 1 จัดปุ่มเป็นตาราง (วัน เวลา)
// ยังจำกัด 13 ปุ่มต่อการ์ด ให้การ์ดไม่ยาวเกินไป วันที่เกินแบ่งหน้าด้วย "วันถัดไป ›"
function choices(text: string, items: ChoiceButton[], columns = 1): Message {
  return choiceCard(text, items.slice(0, MAX_QUICK_REPLIES), columns);
}

// ไม่ encode ภาษาไทย เพราะ postback data ยาวได้ไม่เกิน 300 ตัวอักษร
function postbackData(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value.replace(/[&=%+]/g, encodeURIComponent)}`)
    .join("&");
}

function logBookingError(err: unknown): void {
  console.error(JSON.stringify({
    tag: "booking_error",
    status: (err as { status?: number }).status,
    detail: err instanceof Error ? err.message : String(err),
  }));
}

// ค่าที่ทุกปุ่มหลังเลือกสิทธิต้องส่งต่อ x คือนัดเดิมเมื่อกำลังเลื่อนนัด
// จองใหม่ยังไม่รู้สิทธิและประเภทคนไข้ (ถามหลังกันคิว) จึงส่งเฉพาะค่าที่มี
function flowParams(service: Service, right: string, visit: string, replaces: string): Record<string, string> {
  return {
    s: service.name,
    ...(right ? { r: right } : {}),
    ...(visit ? { v: visit } : {}),
    ...(replaces ? { x: replaces } : {}),
  };
}

function withPrefix(prefix: string, message: Message): Message {
  if (message.type === "flex") return withCardNote(prefix, message);
  return { ...message, text: `${prefix}\n${(message as messagingApi.TextMessage).text}` } as Message;
}

function prefillParams(prefill: Prefill): Record<string, string> {
  const params: Record<string, string> = {};
  if (prefill.right) params.pr = prefill.right;
  if (prefill.date) params.pd = prefill.date;
  if (prefill.period) params.pp = prefill.period;
  if (prefill.start !== undefined) params.pt = String(prefill.start);
  return params;
}

function prefillFrom(params: URLSearchParams): Prefill {
  const right = params.get("pr") ?? "";
  const date = params.get("pd") ?? "";
  const period = params.get("pp") ?? "";
  const start = Number(params.get("pt") ?? NaN);
  return {
    right: RIGHTS[right] ? right : undefined,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    period: PERIODS[period] ? period : undefined,
    start: Number.isInteger(start) && start >= 0 && start < 24 * 60 ? start : undefined,
  };
}

function periodOf(start: number): string {
  return Object.entries(PERIODS).find(([, { from, to }]) => start >= from && start < to)?.[0] ?? "am";
}

// slot ที่แปลงไม่ได้ทิ้งไป ให้ flow ถามเอง
// ไม่มี date_text (Gemini ไม่ใส่หรือใช้ไม่ได้) ลองอ่านวันจากข้อความลูกค้า เช่น "วันนี้มีคิวว่างไหม"
function prefillFromSlots(slots: Slots, now: number, text = ""): Prefill {
  const dateText = slots.date_text || text;
  const parsed = dateText ? parseDateText(dateText, now) : null;
  const start = slots.time_text ? parseTimeText(slots.time_text) ?? undefined : undefined;
  const period = start !== undefined ? periodOf(start) : slots.period ? parsePeriod(slots.period) ?? undefined : undefined;
  return {
    right: slots.coverage ? COVERAGES[slots.coverage.replace(/\./g, "")] : undefined,
    // วันกับวันที่ไม่ตรงกัน (เช่น "วันจันทร์20" แต่ 20 เป็นวันศุกร์) ให้ลูกค้าเลือกวันเอง
    date: parsed && !parsed.weekdayMismatch ? parsed.date : undefined,
    period,
    start,
  };
}

const nameKey = (name: string) => name.replace(/\s+/g, "").toLowerCase();

// "นัดปรึกษารากฟันเทียม" หรือ "จองคิวฟอกสีฟัน" (มักมาจากปุ่มในคำตอบ FAQ) ตรงกับชื่อบริการหรือกลุ่มพอดี
// คืนชื่อนั้นเพื่อเข้าการจองทันทีโดยไม่ผ่าน Gemini
export async function namedBookingTarget(text: string): Promise<string | null> {
  const match = text.trim().match(/^(?:นัด|จอง(?:คิว)?)\s*(.+)$/);
  if (!match) return null;
  const services = await getServices().catch(() => []);
  const names = [...services.map(({ name }) => name), ...services.map(({ group }) => group).filter(Boolean)];
  return names.find((name) => nameKey(name) === nameKey(match[1])) ?? null;
}

function matchService(services: Service[], name: string | undefined): Service | undefined {
  const wanted = name ? nameKey(name) : "";
  if (!wanted) return undefined;
  const key = (service: Service) => nameKey(service.name);
  const exact = services.find((service) => key(service) === wanted);
  if (exact) return exact;
  const partial = services.filter((service) => key(service).includes(wanted) || wanted.includes(key(service)));
  return partial.length === 1 ? partial[0] : undefined;
}

// วันที่คุณหมอเข้าในช่วงที่เปิดจอง ถ้ายังไม่มีการลงวันคุณหมอในช่วงนี้เลย ไม่จำกัดวัน
// กันการจองปิดทั้งหมดเพราะยังไม่ได้ลงตาราง
async function doctorDays(service: Service, now: number): Promise<Set<string> | null> {
  if (!service.needsDoctor) return null;
  const days = await listDoctorDays(toIso(dateAt(now, 0), 0), endOfDay(dateAt(now, BOOKING_DAYS_AHEAD)));
  if (days.length === 0) {
    console.warn(JSON.stringify({ tag: "doctor_days_missing" }));
    return null;
  }
  return new Set(days);
}

export async function findUserEvents(key: string, userId: string, now: number): Promise<CalendarEvent[]> {
  const events = await listEvents({
    privateExtendedProperty: `${key}=${userId}`,
    timeMin: new Date(now).toISOString(),
  });
  return events.filter((event) => event.status !== "cancelled" && !isExpiredHold(event, now));
}

function existingBookingMessage(event: CalendarEvent): Message {
  // ส่งเป็นข้อความ จึงเข้าคำสั่งตรงเดียวกับที่ลูกค้าพิมพ์เอง
  return choices(
    `คุณลูกค้ามีนัดอยู่แล้ว${formatWhen(event.start?.dateTime ?? "")} ค่ะ หากต้องการเปลี่ยนแปลง พิมพ์ "เปลี่ยนนัด" หรือโทร ${CLINIC_PHONE} ได้เลยนะคะ`,
    ["เลื่อนนัด", "ยกเลิกนัด"].map((label, i) => ({ label, data: "", displayText: label, message: true, secondary: i > 0 })),
  );
}

class NoServicesError extends Error {}

// note คือบรรทัดที่เติมด้านบนคำถาม
async function askService(prefill: Prefill = {}, only?: Service[], note = ""): Promise<Message> {
  const services = only ?? await getServices();
  if (services.length === 0) {
    console.error(JSON.stringify({ tag: "booking_no_services" }));
    throw new NoServicesError("no active services");
  }
  // บริการที่มี group เดียวกันรวมเป็นปุ่มเดียว อยู่ตำแหน่งของบริการแรกในกลุ่ม
  const entries: ChoiceButton[] = [];
  const groups = new Set<string>();
  for (const { name, group } of services) {
    if (!group) {
      entries.push({ label: name, data: postbackData({ a: "svc", s: name, ...prefillParams(prefill) }), displayText: name });
    } else if (!groups.has(group)) {
      groups.add(group);
      entries.push({ label: group, data: postbackData({ a: "grp", g: group, ...prefillParams(prefill) }), displayText: group });
    }
  }
  const message = choices(
    `ต้องการนัดบริการใดคะ หากไม่พบบริการที่ต้องการ พิมพ์ "ขอแอดมิน" หรือโทร ${CLINIC_PHONE} ได้เลยค่ะ 🦷`,
    [
      ...entries.slice(0, MAX_QUICK_REPLIES - 1),
      // ส่งเป็นข้อความ จึงเข้าคำสั่งตรง: การ์ดติดต่อกลับ + แจ้งแอดมิน ไม่เข้าการจองปกติ
      // ปุ่มแดงอาการเร่งด่วนเอาออกแล้ว (เจ้าของสั่ง) คำสั่งใน handoff.ts ยังรับการ์ดเก่าที่ค้างในแชต
      { label: OTHER_SERVICE_LABEL, data: "", displayText: OTHER_SERVICE_TEXT, message: true },
    ],
  );
  return note ? withPrefix(note, message) : message;
}

const inBookingWindow = (date: string, now: number) => date >= dateAt(now, 0) && date <= dateAt(now, BOOKING_DAYS_AHEAD);

// วันแรกที่จองบริการนี้ได้ ตามคอลัมน์ min_days_ahead (เช่น ฟอกสีฟัน ZOOM ล่วงหน้า 7 วัน)
const earliestDate = (service: Service, now: number) => dateAt(now, service.minDaysAhead);

// บริการที่ยังจองวันนั้นได้: มีเวลาว่างอย่างน้อยหนึ่งเวลา และคุณหมอเข้าถ้าบริการต้องใช้คุณหมอ
async function openOnDate(services: Service[], date: string, now: number): Promise<Service[]> {
  const ranges = rangesFor(date, await getBookingHours());
  if (ranges.length === 0) return [];
  const withDoctor = services.find((service) => service.needsDoctor);
  const [events, allowed] = await Promise.all([
    loadEvents(toIso(date, 0), endOfDay(date), now),
    withDoctor ? doctorDays(withDoctor, now) : null,
  ]);
  const doctorIn = !allowed || allowed.has(date);
  return services.filter((service) =>
    date >= earliestDate(service, now) &&
    (!service.needsDoctor || doctorIn) &&
    freeSlots(date, ranges, service.minutes, events, now).length > 0);
}

// ลูกค้าถามคิวว่างของวันหนึ่ง: ให้เลือกเฉพาะบริการที่ยังจองวันนั้นได้ แล้วไปขั้นเลือกช่วงของวันนั้นเลย
// ไม่บอกช่วงเวลาว่างรวมบนการ์ด (เจ้าของสั่งเอาออก) เวลาที่ถูกต้องขึ้นกับบริการ จึงบอกหลังเลือกบริการ
// วันที่อยู่นอกช่วงเปิดจองถามบริการตามปกติ ขั้นหลังเลือกประเภทลูกค้าจะบอกเองว่าไม่มีคิว
async function askServiceForDate(services: Service[], prefill: Prefill, date: string, now: number): Promise<Message> {
  if (!inBookingWindow(date, now)) return askService(prefill);
  const day = formatDate(`${date}T12:00:00${OFFSET}`);
  const open = await openOnDate(services, date, now);
  if (open.length === 0) {
    return askService({ right: prefill.right }, undefined, `${day} ไม่มีคิวว่างค่ะ`);
  }
  const missing = open.length < services.length
    ? `บริการที่ไม่อยู่ในปุ่มด้านล่าง ${day} คิวเต็ม คุณหมอไม่เข้า หรือต้องจองล่วงหน้ามากกว่านี้ค่ะ`
    : "";
  return askService(prefill, open, missing);
}

// เลือกบริการในกลุ่ม เช่น "ครอบฟัน / ทำฟันปลอม" ถ้าลูกค้าถามวันมา แสดงเฉพาะบริการที่วันนั้นจองได้
async function askGroup(group: string, prefill: Prefill, now: number): Promise<Message> {
  const all = (await getServices()).filter((service) => service.group === group);
  if (all.length === 0) return askService(prefill);
  const open = prefill.date && inBookingWindow(prefill.date, now) ? await openOnDate(all, prefill.date, now) : all;
  const services = open.length > 0 ? open : all;
  return withPrefix(
    group,
    choices("สนใจรับบริการประเภทใดคะ กรุณาเลือกบริการที่ต้องการ หากไม่แน่ใจสามารถให้ทันตแพทย์ตรวจประเมินก่อนได้ค่ะ 🦷", [
      ...services.slice(0, MAX_QUICK_REPLIES - 1).map(({ name }) => ({
        label: name,
        data: postbackData({ a: "svc", s: name, ...prefillParams(prefill) }),
        displayText: name,
      })),
      { label: "‹ บริการอื่น", data: postbackData({ a: "svcs", ...prefillParams(prefill) }), displayText: "ดูบริการอื่น", secondary: true },
    ]),
  );
}

// ลำดับคำถาม (คุณหมอเลือก): บริการ → วัน → ช่วง → เวลา → สิทธิ → ชื่อ+เบอร์ → เคยมาไหม (เฉพาะคนที่ไม่พบ DN)
// ลูกค้าเห็นเวลาว่างก่อน สิทธิไม่มีผลกับคิวจึงถามหลังกันคิวแล้ว
// บริการที่แท็บบริการตั้ง accepts_rights = FALSE ใช้ได้แค่ชำระเอง บอกตั้งแต่ขั้นแรกและไม่ถามสิทธิ
async function continueAfterService(service: Service, prefill: Prefill, userId: string, now: number): Promise<Message> {
  if (!service.acceptsRights) {
    return withPrefix(
      `บริการ${service.name}ชำระเองค่ะ ใช้สิทธิบัตรทองหรือประกันสังคมไม่ได้นะคะ`,
      await continueToTime(service, "self", prefill, userId, now),
    );
  }
  return continueToTime(service, prefill.right ?? "", prefill, userId, now);
}

// ข้ามขั้นวัน ช่วง และเวลาที่ลูกค้าบอกมาแล้ว ถ้าวันหรือเวลานั้นไม่ว่างให้เลือกใหม่ตามปกติ
async function continueToTime(
  service: Service,
  right: string,
  prefill: Prefill,
  userId: string,
  now: number,
): Promise<Message> {
  const { date, period, start } = prefill;
  const inRange = date && date >= dateAt(now, 0) && date <= dateAt(now, BOOKING_DAYS_AHEAD);
  if (!date) return askDate(service, right, "", now);
  const slots = inRange ? await slotsForDate(service, date, now) : [];
  if (slots.length === 0) {
    return withPrefix(
      `${formatDate(`${date}T12:00:00${OFFSET}`)} ไม่มีคิวว่างค่ะ`,
      await askDate(service, right, "", now),
    );
  }
  if (start !== undefined && slots.includes(start)) {
    return holdSlot(service, right, date, periodOf(start), start, userId, now);
  }
  if (period) return askTime(service, right, "", date, period, now);
  return askPeriod(service, right, "", date, now);
}

// ถามหลังกันคิวแล้ว ปุ่มอ้างถึงคิวที่กันไว้ (e) จึงไม่ต้องพกข้อมูลขั้นก่อนหน้า
function rightsCard(eventId: string, when: string): Message {
  return withPrefix(
    `กันคิว${when} ไว้ให้แล้วค่ะ`,
    choices(
      "ใช้สิทธิการรักษาแบบไหนคะ",
      Object.entries(RIGHTS).map(([code, { label }]) => ({
        label,
        data: postbackData({ a: "hr", e: eventId, r: code }),
        displayText: label,
      })),
    ),
  );
}

function visitCard(eventId: string): Message {
  return choices(
    "เคยมาที่คลินิกแล้วหรือมาครั้งแรกคะ",
    Object.entries(VISITS).map(([code, { label }]) => ({
      label,
      data: postbackData({ a: "hv", e: eventId, v: code }),
      displayText: label,
    })),
  );
}

// วันว่างมีมากกว่าปุ่ม quick reply จึงแบ่งหน้า from คือวันแรกของหน้านี้
async function askDate(
  service: Service,
  right: string,
  visit: string,
  now: number,
  from = "",
  replaces = "",
): Promise<Message> {
  const hours = await getBookingHours();
  const lastDate = dateAt(now, BOOKING_DAYS_AHEAD);
  const [events, allowed] = await Promise.all([
    loadEvents(new Date(now).toISOString(), endOfDay(lastDate), now),
    doctorDays(service, now),
  ]);

  const items: ChoiceButton[] = [];
  for (let i = service.minDaysAhead; i <= BOOKING_DAYS_AHEAD; i++) {
    const date = dateAt(now, i);
    if (date < from) continue;
    if (allowed && !allowed.has(date)) continue;
    if (freeSlots(date, rangesFor(date, hours), service.minutes, events, now).length === 0) continue;
    const noon = `${date}T12:00:00${OFFSET}`;
    items.push({
      label: shortDate(noon),
      data: postbackData({ a: "date", ...flowParams(service, right, visit, replaces), d: date }),
      displayText: formatDate(noon),
    });
  }

  if (items.length === 0) {
    return {
      type: "text",
      text: `ขออภัยค่ะ ช่วง ${BOOKING_DAYS_AHEAD} วันนี้คิว${service.name}เต็ม กรุณาโทร ${CLINIC_PHONE} นะคะ 🙏`,
    };
  }
  let page = items;
  if (items.length > MAX_QUICK_REPLIES) {
    page = items.slice(0, MAX_QUICK_REPLIES - 1);
    const next = new URLSearchParams(items[page.length].data).get("d") ?? "";
    page.push({
      label: "วันถัดไป ›",
      data: postbackData({ a: "dates", ...flowParams(service, right, visit, replaces), f: next }),
      displayText: "ดูวันถัดไป",
      secondary: true,
    });
  }
  const card = choices("ต้องการนัดวันไหนคะ", page, 2);
  // บอกเหตุผลที่วันใกล้ ๆ ไม่ขึ้น เฉพาะหน้าแรก
  return service.minDaysAhead > 0 && !from
    ? withPrefix(`บริการ${service.name}ต้องจองล่วงหน้าอย่างน้อย ${service.minDaysAhead} วันค่ะ`, card)
    : card;
}

// ทุกทางที่จะกันคิว (ปุ่ม ข้อความที่บอกวันมา เลื่อนนัด) ผ่านที่นี่ จึงกันวันที่เร็วกว่า min_days_ahead ได้ทั้งหมด
async function slotsForDate(service: Service, date: string, now: number): Promise<number[]> {
  if (date < earliestDate(service, now)) return [];
  const ranges = rangesFor(date, await getBookingHours());
  if (ranges.length === 0) return [];
  const [events, allowed] = await Promise.all([
    loadEvents(toIso(date, 0), endOfDay(date), now),
    doctorDays(service, now),
  ]);
  if (allowed && !allowed.has(date)) return [];
  return freeSlots(date, ranges, service.minutes, events, now);
}

async function askPeriod(
  service: Service,
  right: string,
  visit: string,
  date: string,
  now: number,
  replaces = "",
): Promise<Message> {
  const slots = await slotsForDate(service, date, now);
  if (slots.length === 0) {
    return withPrefix("วันนี้คิวเต็มแล้วค่ะ", await askDate(service, right, visit, now, "", replaces));
  }

  const params = flowParams(service, right, visit, replaces);
  const items: ChoiceButton[] = Object.entries(PERIODS)
    .filter(([, { from, to }]) => slots.some((start) => start >= from && start < to))
    .map(([code, { label }]) => ({
      label,
      data: postbackData({ a: "period", ...params, d: date, p: code }),
      displayText: label,
    }));
  // ลูกค้าที่ถามวันมาเอง (ข้ามการ์ดเลือกวัน) ต้องมีทางเปลี่ยนวันได้
  items.push({ label: "เลือกวันอื่น", data: postbackData({ a: "dates", ...params }), displayText: "เลือกวันอื่น", secondary: true });
  return choices(`${formatDate(`${date}T12:00:00${OFFSET}`)} สะดวกช่วงไหนคะ`, items);
}

async function askTime(
  service: Service,
  right: string,
  visit: string,
  date: string,
  period: string,
  now: number,
  replaces = "",
  all = false,
): Promise<Message> {
  const { from, to, label } = PERIODS[period] ?? PERIODS.am;
  const daySlots = await slotsForDate(service, date, now);
  const slots = daySlots.filter((start) => start >= from && start < to);
  if (slots.length === 0) {
    return withPrefix("ช่วงนี้คิวเต็มแล้วค่ะ", await askPeriod(service, right, visit, date, now, replaces));
  }

  const params = flowParams(service, right, visit, replaces);
  const buttons = (times: number[]): ChoiceButton[] => times.map((start) => ({
    label: clock(start),
    data: postbackData({ a: "slot", ...params, d: date, p: period, t: String(start) }),
    displayText: `${clock(start)} น.`,
  }));
  // ลูกค้าพิมพ์ "แล้วช่วงเย็นล่ะ" บอทไม่รู้ว่ากำลังจองวันไหน (ไม่มีที่เก็บสถานะ) จึงต้องมีปุ่มกลับไปเลือกช่วง
  const otherPeriod = daySlots.some((start) => start < from || start >= to);
  const back: ChoiceButton[] = otherPeriod
    ? [{ label: "เลือกช่วงอื่น", data: postbackData({ a: "date", ...params, d: date }), displayText: "เลือกช่วงอื่น", secondary: true }]
    : [];
  const note = `${label}${formatDate(`${date}T12:00:00${OFFSET}`)} ยังมีคิวว่างค่ะ`;
  if (all || slots.length <= SUGGESTED_TIMES) {
    const list = choices("ต้องการเวลาไหนคะ", [...buttons(slots.slice(0, MAX_QUICK_REPLIES - back.length)), ...back], 3);
    return all ? list : withPrefix(note, list);
  }

  // เสนอเวลาว่างที่เร็วที่สุดก่อน ช่วยเติมคิวต้นช่วงและให้ลูกค้าตัดสินใจเร็ว
  return withPrefix(
    note,
    choices(
      `แนะนำ ${SUGGESTED_TIMES} เวลานี้ค่ะ หากไม่สะดวก กดดูเวลาอื่นได้เลยนะคะ`,
      [
        ...buttons(slots.slice(0, SUGGESTED_TIMES)),
        {
          label: "ดูเวลาอื่น",
          data: postbackData({ a: "times", ...params, d: date, p: period }),
          displayText: "ดูเวลาอื่น",
          secondary: true,
        },
        ...back,
      ],
      2,
    ),
  );
}

// การเช็กคิวกับการสร้างนัดไม่ได้ทำพร้อมกัน จึงเช็กซ้ำหลังสร้าง ถ้าเกินคิวและมาทีหลังให้ถอนของตัวเอง
async function lostRace(event: CalendarEvent, startMs: number, minutes: number, now: number): Promise<boolean> {
  const endMs = startMs + minutes * MINUTE_MS;
  const events = await loadEvents(new Date(startMs).toISOString(), new Date(endMs).toISOString(), now);
  for (let t = startMs; t < endMs; t += BOOKING_SLOT_MINUTES * MINUTE_MS) {
    const ordered = overlapCount(events, t, t + BOOKING_SLOT_MINUTES * MINUTE_MS).sort(
      (a, b) => Date.parse(a.created ?? "") - Date.parse(b.created ?? "") || a.id.localeCompare(b.id),
    );
    const position = ordered.findIndex(({ id }) => id === event.id);
    if (position >= BOOKING_CAPACITY_PER_SLOT) return true;
  }
  return false;
}

async function holdSlot(
  service: Service,
  chosenRight: string,
  date: string,
  period: string,
  start: number,
  userId: string,
  now: number,
): Promise<Message> {
  const [upcoming] = await findUserEvents("lineUserId", userId, now);
  if (upcoming) return existingBookingMessage(upcoming);

  // ปุ่มเก่าหรือปุ่มที่แก้เอง: บริการที่ชำระเองใช้สิทธิอื่นไม่ได้
  const right = !service.acceptsRights ? "self" : RIGHTS[chosenRight] ? chosenRight : "";
  const slots = await slotsForDate(service, date, now);
  if (!slots.includes(start)) {
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, "", date, period, now));
  }

  const startIso = toIso(date, start);
  const startMs = Date.parse(startIso);
  const event = await insertEvent({
    summary: `${PENDING_PREFIX}รอข้อมูลลูกค้า ${service.name} ไลน์ OA`,
    status: "tentative",
    colorId: CALENDAR_COLOR_PENDING,
    start: { dateTime: startIso },
    end: { dateTime: new Date(startMs + service.minutes * MINUTE_MS).toISOString() },
    extendedProperties: {
      private: {
        source: "line",
        lineUserId: userId,
        awaitingDetailsFor: userId,
        holdUntil: String(now + BOOKING_HOLD_MINUTES * MINUTE_MS),
        service: service.name,
        ...(right ? { right } : {}),
      },
    },
  });

  if (await lostRace(event, startMs, service.minutes, now)) {
    await deleteEvent(event.id);
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, "", date, period, now));
  }

  return nextHoldStep(event);
}

type PrivateProps = Record<string, string | null>;

// รวมค่าที่เพิ่ง patch เข้ากับคิวที่ถืออยู่ในมือ ไม่ต้องอ่านปฏิทินซ้ำ (null คือลบค่า)
function withPrivate(event: CalendarEvent, extra: PrivateProps): CalendarEvent {
  const merged = { ...(event.extendedProperties?.private ?? {}) } as Record<string, string | null>;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return { ...event, extendedProperties: { ...event.extendedProperties, private: merged } };
}

async function updateHold(event: CalendarEvent, extra: PrivateProps): Promise<CalendarEvent> {
  await patchEvent(event.id, { extendedProperties: { private: extra } });
  return withPrivate(event, extra);
}

function detailsPrompt(when: string): Message {
  return {
    type: "text",
    text: `เจ้าหน้าที่จะบันทึกการนัดหมาย ${when} นะคะ กรุณาพิมพ์ชื่อ-นามสกุล และเบอร์โทรของผู้เข้ารับการรักษาในข้อความเดียว เช่น สมชาย ใจดี 0812345678\nหากไม่ต้องการจองแล้ว พิมพ์ "ยกเลิก" ได้เลยค่ะ`,
  };
}

// ขั้นที่ยังขาดของคิวที่กันไว้ ตามลำดับ: สิทธิ → ชื่อและเบอร์ → เคยมาไหม ครบแล้วส่งคำขอให้แอดมิน
async function nextHoldStep(event: CalendarEvent): Promise<Message> {
  const props = event.extendedProperties?.private ?? {};
  const when = formatWhen(event.start?.dateTime ?? "");
  if (!RIGHTS[props.right ?? ""]) return rightsCard(event.id, when);
  if (!props.name || !props.phone) return detailsPrompt(when);
  if (!VISITS[props.visit ?? ""]) return visitCard(event.id);
  return completeBooking(event);
}

// เจอ DN ในทะเบียนแปลว่าเคยมาแล้ว ไม่ต้องถาม ไม่เจอ (เบอร์เปลี่ยน ทะเบียนไม่ครบ) ค่อยถามลูกค้า
async function saveDetails(event: CalendarEvent, details: { name: string; phone: string }): Promise<CalendarEvent> {
  const dn = await findDn(details.name, details.phone);
  return updateHold(event, { name: details.name, phone: details.phone, ...(dn ? { dn, visit: "old" } : {}) });
}

function coverageIn(text: string): string | undefined {
  if (/บัตรทอง|สปสช|30\s*บาท/.test(text)) return "gold";
  if (/ประกันสังคม/.test(text)) return "sso";
  if (/ชำระเอง|จ่ายเอง/.test(text)) return "self";
  return undefined;
}

function visitIn(text: string): string | undefined {
  if (/ครั้งแรก|ไม่เคย|คนไข้ใหม่/.test(text)) return "new";
  if (/เคยมา|คนไข้เก่า/.test(text)) return "old";
  return undefined;
}

// ปุ่มบนการ์ดสิทธิและการ์ดเคยมาไหม ใช้ได้เฉพาะเจ้าของคิวที่ยังไม่หมดเวลา
async function answerHold(action: string, params: URLSearchParams, userId: string): Promise<Message> {
  const event = await getEvent(params.get("e") ?? "");
  const props = event?.extendedProperties?.private ?? {};
  if (!event || event.status === "cancelled" || props.awaitingDetailsFor !== userId || isExpiredHold(event, Date.now())) {
    return { type: "text", text: `คิวที่กันไว้หมดเวลาแล้วค่ะ พิมพ์ "จองคิว" เพื่อเลือกเวลาใหม่ได้เลยนะคะ` };
  }
  const right = params.get("r") ?? "";
  const visit = params.get("v") ?? "";
  if (action === "hr" && RIGHTS[right]) return nextHoldStep(await updateHold(event, { right }));
  if (action === "hv" && VISITS[visit]) return nextHoldStep(await updateHold(event, { visit }));
  return nextHoldStep(event);
}

// การ์ดคำขอในกลุ่มแอดมิน หน้าตาเดียวกันทั้ง Telegram และ LINE
function requestNotice(
  title: string,
  summary: string,
  when: string,
  actions: [AdminCardAction, AdminCardAction],
  note = BOOKING_CARD_NOTE,
): AdminNotice {
  return {
    text: `${title}\n${summary}\n${when}${note ? `\n\n${note}` : ""}`,
    buttons: actions,
    line: [bookingRequestCard(summary, when, actions, { title, note })],
  };
}

function parseDetails(text: string): { name: string; phone: string } | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/(?<!\d)0\d(?:[ -]?\d){7,8}(?!\d)/);
  if (!match) return null;
  const phone = match[0].replace(/\D/g, "");
  // ลูกค้าอาจพิมพ์สิทธิมาพร้อมชื่อ เช่น "ประกันสังคม สมใจ ทดสอบ 08…" (coverageIn อ่านสิทธิแยกไว้แล้ว)
  const name = clean
    .replace(match[0], " ")
    .replace(/เบอร์|ชื่อ|สิทธิ(?:บัตรทอง)?|บัตรทอง|สปสช\.?|ประกันสังคม|ชำระเอง|จ่ายเอง/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name ? { name, phone } : null;
}

async function completeBooking(event: CalendarEvent): Promise<Message> {
  const props = event.extendedProperties?.private ?? {};
  const service = props.service ?? "";
  const right = RIGHTS[props.right ?? ""]?.summary ?? "";
  const visit = VISITS[props.visit ?? ""]?.summary ?? "";
  // DN ช่วยให้หาชาร์ตได้เร็ว ขึ้นเฉพาะในปฏิทินและกลุ่มแอดมิน ไม่ส่งให้ลูกค้า
  const dn = props.dn ?? "";
  const summary = `${dn ? `${dn} ` : ""}${props.name} ${props.phone} ${service} ${right} ${visit} ไลน์ OA`;

  // ชื่อและเบอร์อยู่ในชื่อนัดแล้ว ไม่ต้องเก็บซ้ำในค่าส่วนตัว
  await patchEvent(event.id, {
    summary: `${PENDING_PREFIX}${summary}`,
    extendedProperties: { private: { awaitingDetailsFor: null, holdUntil: null, name: null, phone: null, dn: null } },
  });

  const when = formatWhen(event.start?.dateTime ?? "");
  // ส่งไม่สำเร็จก็ไม่เป็นไร นัดอยู่ใน Calendar แล้ว ทีมยังเห็นจากปฏิทินได้
  await sendToAdmin(requestNotice("🗓️ คำขอนัดใหม่", summary, when, bookingActions(event.id)), "booking_notify_failed");

  console.log(JSON.stringify({ tag: "booking_created" }));
  // ข้อความเฉพาะบริการจากคอลัมน์ booking_note อ่านไม่ได้ก็ส่งข้อความปกติ นัดบันทึกไปแล้ว
  const note = (await getServices().catch(() => [])).find(({ name }) => name === service)?.bookingNote;
  return {
    type: "text",
    text: `ส่งคำขอนัด${service} ${when} แล้วค่ะ แอดมินจะยืนยันนัดให้อีกครั้งนะคะ 🙏${note ? `\n${note}` : ""}`,
  };
}

// คืน null ถ้าลูกค้าไม่ได้อยู่ระหว่างกรอกข้อมูล เพื่อให้ตอบจาก FAQ ตามปกติ
export async function handleBookingDetails(userId: string | undefined, text: string): Promise<Message | null> {
  if (!userId) return null;
  try {
    const [event] = await findUserEvents("awaitingDetailsFor", userId, Date.now());
    if (!event) return null;

    if (text.trim() === "ยกเลิก") {
      await deleteEvent(event.id);
      return { type: "text", text: "ยกเลิกการจองคิวแล้วค่ะ 🙏" };
    }

    // ลูกค้าพิมพ์คำตอบแทนการกดปุ่มได้ทุกขั้น เช่น "ประกันสังคม" หรือ "มาครั้งแรก"
    const props = event.extendedProperties?.private ?? {};
    const coverage = coverageIn(text);
    const details = props.name ? null : parseDetails(text);
    const visit = props.name ? visitIn(text) : undefined;
    let current = event;
    if (coverage && !RIGHTS[props.right ?? ""]) current = await updateHold(current, { right: coverage });
    if (details) current = await saveDetails(current, details);
    if (visit) current = await updateHold(current, { visit });
    if (current !== event) return await nextHoldStep(current);

    if (!RIGHTS[props.right ?? ""] || props.name) return await nextHoldStep(event);
    return {
      type: "text",
      text: `รบกวนพิมพ์ชื่อ-นามสกุล และเบอร์โทรในข้อความเดียวนะคะ เช่น สมชาย ใจดี 0812345678 หากไม่ต้องการจองแล้ว พิมพ์ "ยกเลิก" ได้เลยค่ะ`,
    };
  } catch (err) {
    logBookingError(err);
    return null;
  }
}

// ระบบขัดข้อง: ลูกค้าไม่ได้รับข้อความ แอดมินได้รับแจ้งแทน
async function failSilently(err: unknown, userId: string | undefined, message: string): Promise<null> {
  logBookingError(err);
  const reason = err instanceof NoServicesError ? "ระบบขัดข้อง (ไม่มีบริการในแท็บบริการ)" : "ระบบขัดข้อง (จองคิว)";
  await notifyAdmin(userId, reason, message);
  return null;
}

// เริ่ม flow จอง ถ้าลูกค้าบอกบริการ สิทธิ วัน หรือเวลามาแล้ว ข้ามขั้นนั้นไป
// คืน null เมื่อระบบขัดข้อง (แจ้งแอดมินแล้ว)
export async function startBooking(userId: string | undefined, text: string, slots: Slots = {}): Promise<Message | null> {
  if (!userId) return null;
  try {
    const now = Date.now();
    const [upcoming] = await findUserEvents("lineUserId", userId, now);
    if (upcoming) return existingBookingMessage(upcoming);

    const prefill = prefillFromSlots(slots, now, text);
    const services = await getServices();
    // ชื่อกลุ่มตรงพอดีมาก่อน ไม่อย่างนั้น "ครอบฟัน / ทำฟันปลอม" จะไปตรงบางส่วนกับบริการ "ครอบฟัน"
    const groupNames = [...new Set(services.map((s) => s.group).filter(Boolean))];
    const exactGroup = slots.service ? groupNames.find((name) => nameKey(name) === nameKey(slots.service ?? "")) : undefined;
    if (exactGroup) return await askGroup(exactGroup, prefill, now);
    const service = matchService(services, slots.service);
    if (service) return await continueAfterService(service, prefill, userId, now);
    // ลูกค้าพูดถึงทั้งหมวด เช่น "อยากทำฟันปลอม" ให้เลือกบริการในหมวดนั้น
    const group = matchService(groupNames.map((name) => ({ ...services[0], name })), slots.service);
    if (group) return await askGroup(group.name, prefill, now);
    if (prefill.date && services.length > 0) return await askServiceForDate(services, prefill, prefill.date, now);
    return await askService(prefill);
  } catch (err) {
    return failSilently(err, userId, text);
  }
}

function pendingRescheduleMessage(event: CalendarEvent): Message {
  return {
    type: "text",
    text: `คุณลูกค้ามีคำขอเลื่อนนัดเป็น${formatWhen(event.start?.dateTime ?? "")} รอแอดมินยืนยันอยู่ค่ะ หากต้องการเปลี่ยนแปลง โทร ${CLINIC_PHONE} ได้เลยนะคะ`,
  };
}

// นัดที่ลูกค้าจองผ่าน LINE และยังไม่ถึงเวลา ไม่รวมคิวที่กันไว้ระหว่างกรอกชื่อ
async function upcomingBookings(userId: string, now: number): Promise<CalendarEvent[]> {
  return (await findUserEvents("lineUserId", userId, now))
    .filter((event) =>
      !event.extendedProperties?.private?.awaitingDetailsFor && Date.parse(event.start?.dateTime ?? "") > now)
    .sort((a, b) => Date.parse(a.start?.dateTime ?? "") - Date.parse(b.start?.dateTime ?? ""));
}

// ลูกค้าเลือกวันเวลาใหม่เอง ใช้บริการ สิทธิ และชื่อจากนัดเดิม นัดเดิมอยู่จนกว่าแอดมินยืนยันนัดใหม่
// คืน null เมื่อไม่พบนัดที่จองผ่าน LINE หรือระบบขัดข้อง ให้ผู้เรียกส่งต่อแอดมินแบบเดิม
export async function startReschedule(userId: string | undefined): Promise<Message | null> {
  if (!userId) return null;
  try {
    const now = Date.now();
    const bookings = await upcomingBookings(userId, now);
    const pending = bookings.find((event) => event.extendedProperties?.private?.replaces);
    if (pending) return pendingRescheduleMessage(pending);

    const [original] = bookings;
    if (original?.extendedProperties?.private?.cancelRequested) return pendingCancelMessage(original);
    const props = original?.extendedProperties?.private ?? {};
    const service = (await getServices()).find(({ name }) => name === props.service);
    if (!original || !service || !RIGHTS[props.right ?? ""] || !VISITS[props.visit ?? ""]) return null;

    return withPrefix(
      `นัดเดิมของคุณคือ${formatWhen(original.start?.dateTime ?? "")} ค่ะ เลือกวันใหม่ได้เลยนะคะ หากต้องการให้แอดมินช่วย พิมพ์ "ขอแอดมิน" ได้เลยค่ะ`,
      await askDate(service, props.right ?? "", props.visit ?? "", now, "", original.id),
    );
  } catch (err) {
    logBookingError(err);
    return null;
  }
}

const cleanTitle = (summary: string | undefined) => (summary ?? "").replace(CANCEL_PREFIX, "").replace(PENDING_PREFIX, "");

function pendingCancelMessage(event: CalendarEvent): Message {
  return {
    type: "text",
    text: `คุณลูกค้ามีคำขอยกเลิกนัด${formatWhen(event.start?.dateTime ?? "")} รอแอดมินยืนยันอยู่ค่ะ`,
  };
}

// ถามย้ำก่อนส่งคำขอยกเลิก กันลูกค้าพิมพ์หรือกดพลาด
// คืน null เมื่อไม่พบนัดที่จองผ่าน LINE หรือระบบขัดข้อง ให้ผู้เรียกส่งต่อแอดมินแบบเดิม
export async function startCancel(userId: string | undefined): Promise<Message | null> {
  if (!userId) return null;
  try {
    const event = (await upcomingBookings(userId, Date.now()))
      .find((e) => !e.extendedProperties?.private?.replaces);
    if (!event) return null;
    if (event.extendedProperties?.private?.cancelRequested) return pendingCancelMessage(event);
    return choices(`ต้องการยกเลิกนัด${formatWhen(event.start?.dateTime ?? "")} ใช่ไหมคะ`, [
      { label: "ยกเลิกนัด", data: postbackData({ a: "cancel", e: event.id }), displayText: "ยกเลิกนัด" },
      { label: "ไม่ยกเลิก", data: postbackData({ a: "keep", e: event.id }), displayText: "ไม่ยกเลิก", secondary: true },
    ]);
  } catch (err) {
    logBookingError(err);
    return null;
  }
}

// นัดยังอยู่ในปฏิทินจนแอดมินยืนยัน ชื่อนัดขึ้นต้นด้วย [ขอยกเลิก] ให้เห็นจากปฏิทิน
async function requestCancel(id: string, userId: string, keep: boolean): Promise<Message> {
  const event = await getEvent(id);
  const start = event?.start?.dateTime ?? "";
  if (
    !event ||
    event.status === "cancelled" ||
    event.extendedProperties?.private?.lineUserId !== userId ||
    Date.parse(start) <= Date.now()
  ) {
    return { type: "text", text: `ไม่พบนัดนี้ค่ะ กรุณาโทร ${CLINIC_PHONE} นะคะ 🙏` };
  }
  if (event.extendedProperties?.private?.cancelRequested) return pendingCancelMessage(event);
  if (keep) return { type: "text", text: `นัดของคุณ${formatWhen(start)} ยังอยู่ค่ะ 😊` };

  const summary = cleanTitle(event.summary);
  await patchEvent(id, {
    summary: `${CANCEL_PREFIX}${event.summary ?? ""}`,
    extendedProperties: { private: { cancelRequested: "1" } },
  });
  await sendToAdmin(
    requestNotice("🚫 ขอยกเลิกนัด", summary, formatWhen(start), [
      { label: "ยืนยันยกเลิก", data: `a=cx&e=${id}` },
      { label: "ไม่ยกเลิก", data: `a=ck&e=${id}` },
    ], ""),
    "booking_notify_failed",
  );
  console.log(JSON.stringify({ tag: "cancel_requested" }));
  return { type: "text", text: "ส่งคำขอยกเลิกนัดแล้วค่ะ แอดมินจะยืนยันให้อีกครั้งนะคะ 🙏" };
}

// ยืนยัน: ลบนัดแล้วแจ้งลูกค้า ไม่ยกเลิก: คืนชื่อนัดเดิม ไม่แจ้งลูกค้า ให้แอดมินคุยเอง
async function decideCancel(action: string, event: CalendarEvent | null, id: string): Promise<Message> {
  if (!event || event.status === "cancelled") return { type: "text", text: "นัดนี้ถูกลบหรือยกเลิกไปแล้วค่ะ" };
  if (!event.extendedProperties?.private?.cancelRequested) {
    return { type: "text", text: "คำขอยกเลิกนี้ดำเนินการไปแล้วค่ะ" };
  }
  const summary = cleanTitle(event.summary);
  const when = formatWhen(event.start?.dateTime ?? "");

  if (action === "cx") {
    await deleteEvent(id);
    const sent = await notifyCustomer(
      event.extendedProperties?.private?.lineUserId,
      `ยกเลิกนัด${when} เรียบร้อยแล้วค่ะ หากต้องการนัดใหม่ พิมพ์ "จองคิว" ได้เลยนะคะ`,
    );
    const failNote = sent ? "" : "\nแจ้งลูกค้าทาง LINE ไม่สำเร็จ กรุณาติดต่อลูกค้าเอง";
    return { type: "text", text: `🚫 ยกเลิกนัดแล้ว: ${summary}\n${when}${failNote}` };
  }

  await patchEvent(id, {
    summary: (event.summary ?? "").replace(CANCEL_PREFIX, ""),
    extendedProperties: { private: { cancelRequested: null } },
  });
  return { type: "text", text: `↩️ ไม่ยกเลิก: ${summary}\n${when}\nนัดยังอยู่ กรุณาคุยกับลูกค้าใน LINE OA Manager` };
}

async function requestReschedule(
  service: Service,
  right: string,
  visit: string,
  date: string,
  period: string,
  start: number,
  userId: string,
  now: number,
  replaces: string,
): Promise<Message> {
  const original = await getEvent(replaces);
  const originalStart = original?.start?.dateTime ?? "";
  if (
    !original ||
    original.status === "cancelled" ||
    original.extendedProperties?.private?.lineUserId !== userId ||
    Date.parse(originalStart) <= now
  ) {
    return { type: "text", text: `ไม่พบนัดเดิมค่ะ กรุณาโทร ${CLINIC_PHONE} นะคะ 🙏` };
  }
  const pending = (await upcomingBookings(userId, now)).find((event) => event.extendedProperties?.private?.replaces);
  if (pending) return pendingRescheduleMessage(pending);

  const slots = await slotsForDate(service, date, now);
  if (!slots.includes(start)) {
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, visit, date, period, now, replaces));
  }

  const startIso = toIso(date, start);
  const startMs = Date.parse(startIso);
  // ชื่อ เบอร์ และ HN มาจากนัดเดิมของลูกค้าคนนี้เอง
  const summary = (original.summary ?? "").replace(PENDING_PREFIX, "");
  const event = await insertEvent({
    summary: `${PENDING_PREFIX}${summary}`,
    status: "tentative",
    colorId: CALENDAR_COLOR_PENDING,
    start: { dateTime: startIso },
    end: { dateTime: new Date(startMs + service.minutes * MINUTE_MS).toISOString() },
    extendedProperties: {
      private: { source: "line", lineUserId: userId, service: service.name, right, visit, replaces },
    },
  });

  if (await lostRace(event, startMs, service.minutes, now)) {
    await deleteEvent(event.id);
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, visit, date, period, now, replaces));
  }

  const when = formatWhen(startIso);
  const change = `จาก: ${formatWhen(originalStart)}\nเป็น: ${when}`;
  await sendToAdmin(requestNotice("🔁 ขอเลื่อนนัด", summary, change, bookingActions(event.id)), "booking_notify_failed");

  console.log(JSON.stringify({ tag: "reschedule_requested" }));
  return {
    type: "text",
    text: `ส่งคำขอเลื่อนนัดเป็น${when} แล้วค่ะ นัดเดิม${formatWhen(originalStart)} ยังอยู่จนกว่าแอดมินจะยืนยันนะคะ 🙏`,
  };
}

export async function handleBookingPostback(data: string, userId: string | undefined): Promise<Message | null> {
  const params = new URLSearchParams(data);
  const action = params.get("a");
  if (action === "attend") return handleAttendance(params.get("e") ?? "", userId);
  if (action === "cancel" || action === "keep") {
    if (!userId) return null;
    try {
      return await requestCancel(params.get("e") ?? "", userId, action === "keep");
    } catch (err) {
      return failSilently(err, userId, "(กดปุ่มยกเลิกนัด)");
    }
  }
  if (action === "hr" || action === "hv") {
    if (!userId) return null;
    try {
      return await answerHold(action, params, userId);
    } catch (err) {
      return failSilently(err, userId, "(กดปุ่มในขั้นตอนจองคิว)");
    }
  }
  // right/visit: ปุ่มจากการ์ดแบบเดิมที่ยังค้างในแชต พาเข้าลำดับใหม่
  if (!["grp", "svcs", "svc", "right", "visit", "dates", "date", "period", "times", "slot"].includes(action ?? "")) return null;

  try {
    if (!userId) return null;
    const now = Date.now();
    const prefill = prefillFrom(params);
    if (action === "grp") return await askGroup(params.get("g") ?? "", prefill, now);
    const services = await getServices();
    if (action === "svcs") {
      return prefill.date ? await askServiceForDate(services, prefill, prefill.date, now) : await askService(prefill);
    }
    const service = services.find(({ name }) => name === params.get("s"));
    if (!service) return await askService(prefill);
    const right = RIGHTS[params.get("r") ?? ""] ? params.get("r") ?? "" : "";
    if (action === "svc" || action === "right" || action === "visit") {
      return await continueAfterService(service, { ...prefill, right: right || prefill.right }, userId, now);
    }

    // เลื่อนนัดพกสิทธิและประเภทคนไข้ของนัดเดิม (x) จองใหม่ยังไม่มีสองค่านี้
    const replaces = params.get("x") ?? "";
    const visit = replaces && VISITS[params.get("v") ?? ""] ? params.get("v") ?? "" : "";
    if (action === "dates") return await askDate(service, right, visit, now, params.get("f") ?? "", replaces);

    const date = params.get("d") ?? "";
    if (action === "date") return await askPeriod(service, right, visit, date, now, replaces);

    const period = params.get("p") ?? "";
    if (action === "period") return await askTime(service, right, visit, date, period, now, replaces);
    if (action === "times") return await askTime(service, right, visit, date, period, now, replaces, true);
    const start = Number(params.get("t"));
    if (replaces) return await requestReschedule(service, right, visit, date, period, start, userId, now, replaces);
    return await holdSlot(service, right, date, period, start, userId, now);
  } catch (err) {
    return failSilently(err, userId, "(กดปุ่มในขั้นตอนจองคิว)");
  }
}

// นัดที่จองผ่าน LINE ในช่วงเปิดจอง นัดที่แอดมินลงเองไม่มี LINE ID จึงหาไม่เจอ
export async function describeNextAppointment(userId: string, now: number): Promise<string | null> {
  const limit = Date.parse(endOfDay(dateAt(now, BOOKING_DAYS_AHEAD)));
  const [next] = (await findUserEvents("lineUserId", userId, now))
    .filter((event) => {
      const start = Date.parse(event.start?.dateTime ?? "");
      return !event.extendedProperties?.private?.awaitingDetailsFor && start > now && start <= limit;
    })
    .sort((a, b) => Date.parse(a.start?.dateTime ?? "") - Date.parse(b.start?.dateTime ?? ""));
  if (!next) return null;
  return `นัดของคุณคือ${formatWhen(next.start?.dateTime ?? "")} ค่ะ 😊`;
}

// "4, 11 และ 18"
function dayList(days: string[]): string {
  const numbers = days.map((day) => String(Number(day.slice(8))));
  return numbers.length > 1 ? `${numbers.slice(0, -1).join(", ")} และ ${numbers.at(-1)}` : numbers[0];
}

// วันที่คุณหมอเข้าตั้งแต่วันนี้ถึงสิ้นเดือน คืน null เมื่อเดือนนั้นผ่านไปแล้ว
export async function describeDoctorDays(year: number, month: number, now: number): Promise<string | null> {
  const first = `${year}-${pad(month)}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const from = first < dateAt(now, 0) ? dateAt(now, 0) : first;
  if (from > last) return null;
  const monthName = `เดือน${MONTH_SHORT[month - 1]}`;

  const [doctorDays, hours] = await Promise.all([listDoctorDays(toIso(from, 0), endOfDay(last)), getBookingHours()]);
  const inMonth = doctorDays.filter((day) => day >= from && day <= last);
  if (inMonth.length > 0) return `${monthName} คุณหมอเข้าวันที่ ${dayList(inMonth)} ค่ะ 😊`;

  // ไม่ได้ลง event หมอเข้า: คุณหมอเข้าทุกวันที่คลินิกเปิด บอกวันปิดจากแท็บเวลาจองแทน
  const closed: string[] = [];
  for (let day = from; day <= last; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
    if (rangesFor(day, hours).length === 0) closed.push(day);
  }
  return closed.length > 0
    ? `${monthName} คุณหมอเข้าทุกวันที่คลินิกเปิด โดยคลินิกปิดวันที่ ${dayList(closed)} ค่ะ 😊`
    : `${monthName} คุณหมอเข้าทุกวันค่ะ 😊`;
}

async function notifyCustomer(userId: string | null | undefined, text: string): Promise<boolean> {
  if (!userId) return false;
  try {
    await getLineClient().pushMessage({ to: userId, messages: [{ type: "text", text }] });
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      tag: "booking_customer_notify_failed",
      status: (err as { status?: number }).status,
    }));
    return false;
  }
}

function appointmentDate(start: string): string {
  return dateAt(Date.parse(start), 0);
}

async function sendReminder(event: CalendarEvent): Promise<boolean> {
  const userId = event.extendedProperties?.private?.lineUserId;
  const start = event.start?.dateTime;
  if (!userId || !start) return false;

  try {
    await getLineClient().pushMessage({
      to: userId,
      messages: [reminderCard(formatWhen(start), event.id)],
    });
  } catch (err) {
    console.error(JSON.stringify({
      tag: "reminder_failed",
      status: (err as { status?: number }).status,
    }));
    return false;
  }
  await patchEvent(event.id, {
    extendedProperties: { private: { reminderFor: appointmentDate(start) } },
  });
  return true;
}

// ส่งได้เฉพาะนัดที่ลูกค้าจองผ่าน LINE เพราะนัดที่ทีมลงเองไม่มี LINE ID ของคนไข้
export async function sendDailyReminders(now: number): Promise<{ sent: number; failed: number }> {
  const tomorrow = dateAt(now, 1);
  const events = await listEvents({
    privateExtendedProperty: "source=line",
    timeMin: toIso(tomorrow, 0),
    timeMax: endOfDay(tomorrow),
  });

  let sent = 0;
  let failed = 0;
  for (const event of events) {
    const start = event.start?.dateTime;
    if (
      !start ||
      appointmentDate(start) !== tomorrow ||
      event.status !== "confirmed" ||
      event.colorId === CALENDAR_COLOR_CONFIRMED ||
      event.extendedProperties?.private?.reminderFor === tomorrow ||
      event.extendedProperties?.private?.cancelRequested
    ) continue;

    if (await sendReminder(event)) sent++;
    else failed++;
  }
  console.log(JSON.stringify({ tag: "reminders", sent, failed }));
  return { sent, failed };
}

async function handleAttendance(id: string, userId: string | undefined): Promise<Message> {
  try {
    const event = await getEvent(id);
    if (!event || event.status === "cancelled" || event.extendedProperties?.private?.lineUserId !== userId) {
      return { type: "text", text: `ไม่พบนัดนี้ค่ะ กรุณาโทร ${CLINIC_PHONE} นะคะ 🙏` };
    }
    const start = event.start?.dateTime ?? "";
    if (Date.parse(start) <= Date.now()) {
      return { type: "text", text: "นัดนี้ผ่านไปแล้วค่ะ" };
    }
    if (event.colorId !== CALENDAR_COLOR_CONFIRMED) {
      await patchEvent(id, { colorId: CALENDAR_COLOR_CONFIRMED });
      console.log(JSON.stringify({ tag: "attendance_confirmed" }));
    }
    return { type: "text", text: `ขอบคุณที่ยืนยันค่ะ พบกัน${formatWhen(start)} นะคะ 😊` };
  } catch (err) {
    logBookingError(err);
    return { type: "text", text: `ยืนยันไม่สำเร็จค่ะ กรุณาลองใหม่ หรือโทร ${CLINIC_PHONE} นะคะ 🙏` };
  }
}

// ยืนยัน: นัดใหม่เป็นสีฟ้าแล้วลบนัดเดิม ปฏิเสธ: ลบนัดใหม่ นัดเดิมยังอยู่
async function decideReschedule(
  action: string | null,
  event: CalendarEvent,
  replaces: string,
  summary: string,
  when: string,
  failNote: string,
): Promise<Message> {
  const userId = event.extendedProperties?.private?.lineUserId;
  const start = event.start?.dateTime ?? "";
  const original = await getEvent(replaces);
  const originalLive = original && original.status !== "cancelled";

  if (action === "ok") {
    await patchEvent(event.id, {
      status: "confirmed",
      colorId: CALENDAR_COLOR_UNCONFIRMED,
      summary,
      extendedProperties: { private: { replaces: null } },
    });
    if (originalLive) await deleteEvent(replaces);
    const sent = appointmentDate(start) <= dateAt(Date.now(), 1)
      ? await sendReminder(event)
      : await notifyCustomer(
          userId,
          `แอดมินยืนยันการเลื่อนนัดแล้วค่ะ นัดใหม่คือ${when} ก่อนวันนัดจะมีข้อความให้กดยืนยันอีกครั้งนะคะ 😊`,
        );
    return { type: "text", text: `✅ ยืนยันเลื่อนนัดแล้ว: ${summary}\nนัดใหม่ ${when} (ลบนัดเดิมแล้ว)${sent ? "" : failNote}` };
  }

  await deleteEvent(event.id);
  const keep = originalLive ? ` นัดเดิม${formatWhen(original.start?.dateTime ?? "")} ยังอยู่นะคะ` : "";
  const sent = await notifyCustomer(
    userId,
    `ขออภัยค่ะ เวลา${when} ไม่สะดวก${keep} หากต้องการเลื่อนเป็นเวลาอื่น พิมพ์ "เลื่อนนัด" หรือโทร ${CLINIC_PHONE} ได้เลยนะคะ 🙏`,
  );
  return { type: "text", text: `❌ ปฏิเสธการเลื่อนนัด: ${summary}\n${when} (นัดเดิมยังอยู่)${sent ? "" : failNote}` };
}

export async function handleAdminPostback(data: string): Promise<Message> {
  const params = new URLSearchParams(data);
  const action = params.get("a");
  const id = params.get("e") ?? "";

  try {
    const event = await getEvent(id);
    if (action === "cx" || action === "ck") return await decideCancel(action, event, id);
    if (!event || event.status === "cancelled") {
      return { type: "text", text: "นัดนี้ถูกลบหรือยกเลิกไปแล้วค่ะ" };
    }
    if (event.status === "confirmed") {
      return { type: "text", text: "นัดนี้ยืนยันไปแล้วค่ะ" };
    }

    const userId = event.extendedProperties?.private?.lineUserId;
    const summary = (event.summary ?? "").replace(PENDING_PREFIX, "");
    const start = event.start?.dateTime ?? "";
    const when = formatWhen(start);
    const failNote = "\nแจ้งลูกค้าทาง LINE ไม่สำเร็จ กรุณาติดต่อลูกค้าเอง";

    const replaces = event.extendedProperties?.private?.replaces;
    if (replaces) return await decideReschedule(action, { ...event, id }, replaces, summary, when, failNote);

    if (action === "ok") {
      await patchEvent(id, { status: "confirmed", colorId: CALENDAR_COLOR_UNCONFIRMED, summary });
      // นัดวันนี้หรือพรุ่งนี้อาจพ้นรอบแจ้งเตือนแล้ว จึงส่งปุ่มยืนยันให้ทันที
      const sent = appointmentDate(start) <= dateAt(Date.now(), 1)
        ? await sendReminder({ ...event, id })
        : await notifyCustomer(
            userId,
            `แอดมินรับนัดเรียบร้อยแล้วค่ะ ${when} ก่อนวันนัดจะมีข้อความให้กดยืนยันอีกครั้งนะคะ 😊 หากต้องการเปลี่ยนแปลง พิมพ์ "เปลี่ยนนัด" ได้เลยค่ะ`,
          );
      return { type: "text", text: `✅ ยืนยันแล้ว: ${summary}\n${when}${sent ? "" : failNote}` };
    }

    await deleteEvent(id);
    const sent = await notifyCustomer(
      userId,
      `ขออภัยค่ะ คิว${when} ไม่สะดวก พิมพ์ "จองคิว" เพื่อเลือกเวลาใหม่ หรือโทร ${CLINIC_PHONE} ได้เลยนะคะ 🙏`,
    );
    return { type: "text", text: `❌ ปฏิเสธแล้ว: ${summary}\n${when}${sent ? "" : failNote}` };
  } catch (err) {
    logBookingError(err);
    return { type: "text", text: "ทำรายการไม่สำเร็จ กรุณาลองใหม่ หรือแก้ไขใน Google Calendar ค่ะ" };
  }
}
