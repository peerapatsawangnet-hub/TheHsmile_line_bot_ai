import { NextRequest, NextResponse } from "next/server";
import { isBookingEnabled, sendDailyReminders } from "@/lib/booking";
import { sendDailySummary } from "@/lib/daily-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// force-dynamic อย่างเดียวไม่พอ: Next.js ยัง cache การส่งข้อความ LINE ใน GET handler
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Vercel Cron ส่ง Authorization: Bearer <CRON_SECRET> มาให้เอง
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }
  if (!isBookingEnabled()) return NextResponse.json({ skipped: true });

  const now = Date.now();
  let reminders;
  try {
    reminders = await sendDailyReminders(now);
  } catch (err) {
    logError("reminder_error", err);
  }

  // ส่งสรุปหลังเตือนนัด ใช้ cron เดิมเพราะ Vercel Hobby ตั้ง cron ได้จำกัด
  let summary = false;
  try {
    await sendDailySummary(now);
    summary = true;
  } catch (err) {
    logError("daily_summary_error", err);
  }

  if (!reminders) return new NextResponse(null, { status: 500 });
  return NextResponse.json({ ...reminders, summary });
}

function logError(tag: string, err: unknown): void {
  console.error(JSON.stringify({
    tag,
    status: (err as { status?: number }).status,
    detail: err instanceof Error ? err.message : String(err),
  }));
}
