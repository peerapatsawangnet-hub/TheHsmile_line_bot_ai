import Papa from "papaparse";
import { SHEET_CACHE_MS, SHEET_TIMEOUT_MS } from "./config";

// needsDoctor: นัดได้เฉพาะวันที่คุณหมอเข้า ค่าว่างถือว่าต้องใช้คุณหมอ
export type Service = { name: string; minutes: number; needsDoctor: boolean };
export type TimeRange = { open: number; close: number };
export type BookingHours = {
  // คีย์คือเลขวันแบบ Date.getDay() วันที่ไม่มีแถวถือว่าปิด
  weekly: Record<number, TimeRange[]>;
  // คีย์คือ YYYY-MM-DD ใช้แทนเวลาปกติของวันนั้น ถ้าไม่ใส่เวลาถือว่าปิด
  dates: Record<string, TimeRange[]>;
};

type Row = Record<string, string | undefined>;

const THAI_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

const caches = new Map<string, { rows: Row[]; fetchedAt: number }>();

export async function getRows(envName: string): Promise<Row[]> {
  const url = process.env[envName];
  if (!url) throw new Error(`${envName} is not set`);

  const cached = caches.get(envName);
  if (cached && Date.now() - cached.fetchedAt < SHEET_CACHE_MS) return cached.rows;

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Sheet responded with status ${res.status}`);

    const { data } = Papa.parse<Row>(await res.text(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
    });
    caches.set(envName, { rows: data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    if (cached) {
      console.warn(JSON.stringify({ tag: "booking_sheet_stale", envName }));
      return cached.rows;
    }
    throw err;
  }
}

function parseTime(value: string | undefined): number | null {
  const match = value?.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

export async function getServices(): Promise<Service[]> {
  const rows = await getRows("SERVICES_CSV_URL");
  return rows.flatMap((row) => {
    const name = row.service?.trim();
    const minutes = Number(row.duration_minutes);
    if (!name || !(minutes > 0) || row.active?.trim().toUpperCase() === "FALSE") return [];
    return [{ name, minutes, needsDoctor: row.needs_doctor?.trim().toUpperCase() !== "FALSE" }];
  });
}

// แท็บ doctor_schedule ไม่บังคับ: month (YYYY-MM), image_url
export async function getDoctorScheduleImage(month: string): Promise<string | null> {
  if (!process.env.DOCTOR_SCHEDULE_CSV_URL) return null;
  const rows = await getRows("DOCTOR_SCHEDULE_CSV_URL");
  const url = rows.find((row) => row.month?.trim() === month)?.image_url?.trim();
  return url?.startsWith("https://") ? url : null;
}

export async function getBookingHours(): Promise<BookingHours> {
  const rows = await getRows("HOURS_CSV_URL");
  const hours: BookingHours = { weekly: {}, dates: {} };

  for (const row of rows) {
    const day = row.day?.trim() ?? "";
    const open = parseTime(row.open);
    const close = parseTime(row.close);
    const range = open !== null && close !== null && open < close ? [{ open, close }] : [];

    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      hours.dates[day] = [...(hours.dates[day] ?? []), ...range];
      continue;
    }
    const weekday = THAI_DAYS.indexOf(day.replace(/^วัน/, ""));
    if (weekday >= 0) hours.weekly[weekday] = [...(hours.weekly[weekday] ?? []), ...range];
  }
  return hours;
}
