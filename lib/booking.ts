import { messagingApi } from "@line/bot-sdk";
import { BookingHours, getBookingHours, getServices, Service, TimeRange } from "./booking-config";
import { CalendarEvent, deleteEvent, getEvent, insertEvent, listEvents, patchEvent } from "./calendar";
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
  DEFAULT_REPLY,
} from "./config";
import { bookingRequestCard, reminderCard } from "./flex-cards";
import { getLineClient } from "./line";

type Message = messagingApi.Message;

const OFFSET = "+07:00";
const OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_QUICK_REPLIES = 13;
const MAX_NAME_LENGTH = 100;
const PENDING_PREFIX = "[รอแอดมิน] ";

const BOOKING_TRIGGERS = ["จองคิว", "จองนัด", "ขอนัด", "อยากนัด", "นัดหมอ", "นัดหมาย", "book appointment"];
const ADMIN_ACTIONS = new Set(["ok", "no"]);

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

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function isBookingEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY &&
    process.env.GOOGLE_CALENDAR_ID &&
    process.env.SERVICES_CSV_URL &&
    process.env.HOURS_CSV_URL &&
    process.env.ADMIN_GROUP_ID,
  );
}

export function isBookingRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return BOOKING_TRIGGERS.some((trigger) => lower.includes(trigger));
}

export function isAdminAction(data: string): boolean {
  return ADMIN_ACTIONS.has(new URLSearchParams(data).get("a") ?? "");
}

function toIso(date: string, minutes: number): string {
  return `${date}T${clock(minutes)}:00${OFFSET}`;
}

// RFC3339 ไม่รับชั่วโมง 24 จึงใช้เที่ยงคืนของวันถัดไปเป็นเวลาจบของวัน
function endOfDay(date: string): string {
  return new Date(Date.parse(toIso(date, 0)) + DAY_MS).toISOString();
}

function dateAt(now: number, daysAhead: number): string {
  return new Date(now + OFFSET_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

function formatDate(value: string): string {
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

function formatWhen(startIso: string): string {
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

function quickReply(text: string, items: { label: string; data: string; displayText: string }[]): Message {
  return {
    type: "text",
    text,
    quickReply: {
      items: items.slice(0, MAX_QUICK_REPLIES).map(({ label, data, displayText }) => ({
        type: "action",
        action: { type: "postback", label: label.slice(0, 20), data, displayText },
      })),
    },
  };
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

function withPrefix(prefix: string, message: Message): Message {
  return { ...message, text: `${prefix}\n${(message as messagingApi.TextMessage).text}` } as Message;
}

async function findUserEvents(key: string, userId: string, now: number): Promise<CalendarEvent[]> {
  const events = await listEvents({
    privateExtendedProperty: `${key}=${userId}`,
    timeMin: new Date(now).toISOString(),
  });
  return events.filter((event) => event.status !== "cancelled" && !isExpiredHold(event, now));
}

function existingBookingMessage(event: CalendarEvent): Message {
  return {
    type: "text",
    text: `คุณลูกค้ามีนัดอยู่แล้ว${formatWhen(event.start?.dateTime ?? "")} ค่ะ หากต้องการเปลี่ยนแปลง พิมพ์ "เปลี่ยนนัด" หรือโทร ${CLINIC_PHONE} ได้เลยนะคะ`,
  };
}

async function askService(): Promise<Message> {
  const services = await getServices();
  if (services.length === 0) {
    console.error(JSON.stringify({ tag: "booking_no_services" }));
    return { type: "text", text: DEFAULT_REPLY };
  }
  return quickReply(
    `ต้องการนัดบริการใดคะ หากไม่พบบริการที่ต้องการ พิมพ์ "ขอแอดมิน" หรือโทร ${CLINIC_PHONE} ได้เลยค่ะ 🦷`,
    services.map(({ name }) => ({
      label: name,
      data: postbackData({ a: "svc", s: name }),
      displayText: name,
    })),
  );
}

function askRight(service: Service): Message {
  return quickReply(
    "ใช้สิทธิการรักษาแบบไหนคะ",
    Object.entries(RIGHTS).map(([code, { label }]) => ({
      label,
      data: postbackData({ a: "right", s: service.name, r: code }),
      displayText: label,
    })),
  );
}

function askVisit(service: Service, right: string): Message {
  return quickReply(
    "เคยมาที่คลินิกแล้วหรือมาครั้งแรกคะ",
    Object.entries(VISITS).map(([code, { label }]) => ({
      label,
      data: postbackData({ a: "visit", s: service.name, r: right, v: code }),
      displayText: label,
    })),
  );
}

async function askDate(service: Service, right: string, visit: string, now: number): Promise<Message> {
  const hours = await getBookingHours();
  const lastDate = dateAt(now, BOOKING_DAYS_AHEAD);
  const events = await loadEvents(new Date(now).toISOString(), endOfDay(lastDate), now);

  const items = [];
  for (let i = 0; i <= BOOKING_DAYS_AHEAD; i++) {
    const date = dateAt(now, i);
    if (freeSlots(date, rangesFor(date, hours), service.minutes, events, now).length === 0) continue;
    const noon = `${date}T12:00:00${OFFSET}`;
    items.push({
      label: shortDate(noon),
      data: postbackData({ a: "date", s: service.name, r: right, v: visit, d: date }),
      displayText: formatDate(noon),
    });
  }

  if (items.length === 0) {
    return {
      type: "text",
      text: `ขออภัยค่ะ ช่วง ${BOOKING_DAYS_AHEAD} วันนี้คิว${service.name}เต็ม กรุณาโทร ${CLINIC_PHONE} นะคะ 🙏`,
    };
  }
  return quickReply("ต้องการนัดวันไหนคะ", items);
}

async function slotsForDate(service: Service, date: string, now: number): Promise<number[]> {
  const ranges = rangesFor(date, await getBookingHours());
  if (ranges.length === 0) return [];
  const events = await loadEvents(toIso(date, 0), endOfDay(date), now);
  return freeSlots(date, ranges, service.minutes, events, now);
}

async function askPeriod(service: Service, right: string, visit: string, date: string, now: number): Promise<Message> {
  const slots = await slotsForDate(service, date, now);
  if (slots.length === 0) {
    return withPrefix("วันนี้คิวเต็มแล้วค่ะ", await askDate(service, right, visit, now));
  }

  const items = Object.entries(PERIODS)
    .filter(([, { from, to }]) => slots.some((start) => start >= from && start < to))
    .map(([code, { label }]) => ({
      label,
      data: postbackData({ a: "period", s: service.name, r: right, v: visit, d: date, p: code }),
      displayText: label,
    }));
  return quickReply(`${formatDate(`${date}T12:00:00${OFFSET}`)} สะดวกช่วงไหนคะ`, items);
}

async function askTime(
  service: Service,
  right: string,
  visit: string,
  date: string,
  period: string,
  now: number,
): Promise<Message> {
  const { from, to } = PERIODS[period] ?? PERIODS.am;
  const slots = (await slotsForDate(service, date, now)).filter((start) => start >= from && start < to);
  if (slots.length === 0) {
    return withPrefix("ช่วงนี้คิวเต็มแล้วค่ะ", await askPeriod(service, right, visit, date, now));
  }

  return quickReply(
    "ต้องการเวลาไหนคะ",
    slots.map((start) => ({
      label: clock(start),
      data: postbackData({ a: "slot", s: service.name, r: right, v: visit, d: date, p: period, t: String(start) }),
      displayText: `${clock(start)} น.`,
    })),
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
  right: string,
  visit: string,
  date: string,
  period: string,
  start: number,
  userId: string,
  now: number,
): Promise<Message> {
  const [upcoming] = await findUserEvents("lineUserId", userId, now);
  if (upcoming) return existingBookingMessage(upcoming);

  const slots = await slotsForDate(service, date, now);
  if (!slots.includes(start)) {
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, visit, date, period, now));
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
        right,
        visit,
      },
    },
  });

  if (await lostRace(event, startMs, service.minutes, now)) {
    await deleteEvent(event.id);
    return withPrefix("เวลานี้คิวเต็มแล้วค่ะ", await askTime(service, right, visit, date, period, now));
  }

  return {
    type: "text",
    text: `กันคิว${formatWhen(startIso)} ไว้ให้ ${BOOKING_HOLD_MINUTES} นาทีค่ะ กรุณาพิมพ์ชื่อ-นามสกุล และเบอร์โทรของผู้เข้ารับการรักษาในข้อความเดียว เช่น สมชาย ใจดี 0812345678 หากไม่ต้องการจองแล้ว พิมพ์ "ยกเลิก" ได้เลยค่ะ`,
  };
}

function parseDetails(text: string): { name: string; phone: string } | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/(?<!\d)0\d(?:[ -]?\d){7,8}(?!\d)/);
  if (!match) return null;
  const phone = match[0].replace(/\D/g, "");
  const name = clean.replace(match[0], " ").replace(/เบอร์|ชื่อ/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name ? { name, phone } : null;
}

async function completeBooking(event: CalendarEvent, details: { name: string; phone: string }): Promise<Message> {
  const props = event.extendedProperties?.private ?? {};
  const service = props.service ?? "";
  const right = RIGHTS[props.right ?? ""]?.summary ?? "";
  const visit = VISITS[props.visit ?? ""]?.summary ?? "";
  const summary = `${details.name} ${details.phone} ${service} ${right} ${visit} ไลน์ OA`;

  await patchEvent(event.id, {
    summary: `${PENDING_PREFIX}${summary}`,
    extendedProperties: { private: { awaitingDetailsFor: null, holdUntil: null } },
  });

  const when = formatWhen(event.start?.dateTime ?? "");
  try {
    await getLineClient().pushMessage({
      to: process.env.ADMIN_GROUP_ID ?? "",
      messages: [bookingRequestCard(summary, when, event.id)],
    });
  } catch (err) {
    // นัดอยู่ใน Calendar แล้ว ทีมยังเห็นจากปฏิทินได้
    console.error(JSON.stringify({
      tag: "booking_notify_failed",
      status: (err as { status?: number }).status,
    }));
  }

  console.log(JSON.stringify({ tag: "booking_created" }));
  return {
    type: "text",
    text: `ส่งคำขอนัด${service} ${when} แล้วค่ะ แอดมินจะยืนยันนัดให้อีกครั้งนะคะ 🙏`,
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

    const details = parseDetails(text);
    if (!details) {
      return {
        type: "text",
        text: `รบกวนพิมพ์ชื่อ-นามสกุล และเบอร์โทรในข้อความเดียวนะคะ เช่น สมชาย ใจดี 0812345678 หากไม่ต้องการจองแล้ว พิมพ์ "ยกเลิก" ได้เลยค่ะ`,
      };
    }
    return await completeBooking(event, details);
  } catch (err) {
    logBookingError(err);
    return null;
  }
}

export async function handleBookingText(userId: string | undefined): Promise<Message> {
  try {
    if (!userId) return { type: "text", text: DEFAULT_REPLY };
    const [upcoming] = await findUserEvents("lineUserId", userId, Date.now());
    return upcoming ? existingBookingMessage(upcoming) : await askService();
  } catch (err) {
    logBookingError(err);
    return { type: "text", text: DEFAULT_REPLY };
  }
}

export async function handleBookingPostback(data: string, userId: string | undefined): Promise<Message | null> {
  const params = new URLSearchParams(data);
  const action = params.get("a");
  if (action === "attend") return handleAttendance(params.get("e") ?? "", userId);
  if (!["svc", "right", "visit", "date", "period", "slot"].includes(action ?? "")) return null;

  try {
    if (!userId) return { type: "text", text: DEFAULT_REPLY };
    const now = Date.now();
    const service = (await getServices()).find(({ name }) => name === params.get("s"));
    if (!service) return await askService();
    if (action === "svc") return askRight(service);

    const right = params.get("r") ?? "";
    if (!RIGHTS[right]) return askRight(service);
    if (action === "right") return askVisit(service, right);

    const visit = params.get("v") ?? "";
    if (!VISITS[visit]) return askVisit(service, right);
    if (action === "visit") return await askDate(service, right, visit, now);

    const date = params.get("d") ?? "";
    if (action === "date") return await askPeriod(service, right, visit, date, now);

    const period = params.get("p") ?? "";
    if (action === "period") return await askTime(service, right, visit, date, period, now);
    return await holdSlot(service, right, visit, date, period, Number(params.get("t")), userId, now);
  } catch (err) {
    logBookingError(err);
    return { type: "text", text: DEFAULT_REPLY };
  }
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
      event.extendedProperties?.private?.reminderFor === tomorrow
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

export async function handleAdminPostback(data: string): Promise<Message> {
  const params = new URLSearchParams(data);
  const action = params.get("a");
  const id = params.get("e") ?? "";

  try {
    const event = await getEvent(id);
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
