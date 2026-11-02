import { NextRequest, NextResponse } from "next/server";
import { isBookingEnabled, sendDailyReminders } from "@/lib/booking";

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

  try {
    return NextResponse.json(await sendDailyReminders(Date.now()));
  } catch (err) {
    console.error(JSON.stringify({
      tag: "reminder_error",
      status: (err as { status?: number }).status,
      detail: err instanceof Error ? err.message : String(err),
    }));
    return new NextResponse(null, { status: 500 });
  }
}
