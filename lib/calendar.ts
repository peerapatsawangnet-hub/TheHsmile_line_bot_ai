import { JWT } from "google-auth-library";
import { CALENDAR_TIMEOUT_MS } from "./config";

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  created?: string;
  transparency?: string;
  colorId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  // ค่า null ใน PATCH คือการลบ property นั้น
  extendedProperties?: { private?: Record<string, string | null> };
};

let auth: JWT | null = null;

function getAuth(): JWT {
  auth ??= new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Vercel เก็บ newline ใน env เป็น \n
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return auth;
}

function eventsUrl(path = ""): string {
  const id = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID ?? "");
  return `https://www.googleapis.com/calendar/v3/calendars/${id}/events${path}`;
}

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<T> {
  const res = await getAuth().request<T>({
    url,
    method,
    data,
    timeout: CALENDAR_TIMEOUT_MS,
    retry: false,
  });
  return res.data;
}

export async function listEvents(params: Record<string, string>): Promise<CalendarEvent[]> {
  // คลินิกมีนัดหลายร้อยรายการใน 14 วัน ค่าเริ่มต้น 250 จะนับคิวไม่ครบ
  const query = new URLSearchParams({
    singleEvents: "true",
    maxResults: "2500",
    fields: "items(id,status,created,transparency,colorId,start,end,extendedProperties)",
    ...params,
  });
  const res = await call<{ items?: CalendarEvent[] }>("GET", `${eventsUrl()}?${query}`);
  return res.items ?? [];
}

export const DOCTOR_DAY_TITLE = "หมอเข้า";

// วันคุณหมอเข้าคือ all-day event ชื่อ "หมอเข้า"
// ให้ Google กรองด้วย q ก่อน จึงไม่ได้รับชื่อของนัดคนไข้กลับมา
export async function listDoctorDays(timeMin: string, timeMax: string): Promise<string[]> {
  const events = await listEvents({
    q: DOCTOR_DAY_TITLE,
    timeMin,
    timeMax,
    fields: "items(id,status,summary,start,end)",
  });
  const days = new Set<string>();
  for (const event of events) {
    const { date: start } = event.start ?? {};
    const { date: end } = event.end ?? {};
    if (event.status === "cancelled" || !start || !event.summary?.trim().startsWith(DOCTOR_DAY_TITLE)) continue;
    // end.date ของ all-day event คือวันถัดจากวันสุดท้าย
    let day = start;
    do {
      days.add(day);
      day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    } while (end && day < end);
  }
  return [...days].sort();
}

export function insertEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
  return call<CalendarEvent>("POST", eventsUrl(), event);
}

export async function getEvent(id: string): Promise<CalendarEvent | null> {
  try {
    return await call<CalendarEvent>("GET", eventsUrl(`/${encodeURIComponent(id)}`));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export function patchEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
  return call<CalendarEvent>("PATCH", eventsUrl(`/${encodeURIComponent(id)}`), patch);
}

export async function deleteEvent(id: string): Promise<void> {
  await call<unknown>("DELETE", eventsUrl(`/${encodeURIComponent(id)}`));
}
