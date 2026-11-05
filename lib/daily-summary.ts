import { isTelegramAdmin, sendToAdmin } from "./admin-channel";
import { dateAt, endOfDay, formatDate, toIso } from "./booking";
import { CalendarEvent, listEvents } from "./calendar";
import { CALENDAR_COLOR_PENDING, QUOTA_WARN_RATIO } from "./config";
import { getLineClient } from "./line";

const isHold = (event: CalendarEvent) => Boolean(event.extendedProperties?.private?.awaitingDetailsFor);

// โควต้า push ของเดือนนี้
async function quotaLine(): Promise<string> {
  const client = getLineClient();
  const [quota, consumption] = await Promise.all([client.getMessageQuota(), client.getMessageQuotaConsumption()]);
  const used = consumption.totalUsage;
  if (quota.type !== "limited" || !quota.value) return `โควต้าข้อความเดือนนี้: ใช้ไป ${used} (ไม่จำกัด)`;

  const ratio = used / quota.value;
  const line = `โควต้าข้อความเดือนนี้: ใช้ไป ${used}/${quota.value} (${Math.round(ratio * 100)}%)`;
  const stops = isTelegramAdmin() ? "การเตือนนัดและแจ้งผลยืนยันนัดให้ลูกค้า" : "การแจ้งแอดมิน/เตือนนัด";
  return ratio >= QUOTA_WARN_RATIO
    ? `${line}\n⚠️ โควต้าใกล้หมด · reply ยังส่งได้ แต่${stops}จะหยุดเมื่อหมด`
    : line;
}

// นับจาก Calendar เท่านั้น ไม่อ่านชื่อหรือเบอร์ของนัด
export async function sendDailySummary(now: number): Promise<void> {
  const today = dateAt(now, 0);
  const yesterday = dateAt(now, -1);
  const yesterdayStart = Date.parse(toIso(yesterday, 0));
  const todayStart = Date.parse(toIso(today, 0));

  const [todayEvents, upcomingLine, recentLine, quota] = await Promise.all([
    listEvents({ timeMin: toIso(today, 0), timeMax: endOfDay(today) }),
    listEvents({ privateExtendedProperty: "source=line", timeMin: new Date(now).toISOString() }),
    listEvents({ privateExtendedProperty: "source=line", updatedMin: new Date(yesterdayStart).toISOString() }),
    quotaLine().catch(() => "โควต้าข้อความเดือนนี้: อ่านไม่ได้"),
  ]);

  const appointments = todayEvents.filter(
    (event) => event.start?.dateTime && event.status !== "cancelled" && !isHold(event),
  ).length;
  const pending = upcomingLine.filter(
    (event) => event.status === "tentative" && event.colorId === CALENDAR_COLOR_PENDING && !isHold(event),
  ).length;
  const created = recentLine.filter((event) => {
    const at = Date.parse(event.created ?? "");
    return event.status !== "cancelled" && !isHold(event) && at >= yesterdayStart && at < todayStart;
  }).length;

  const sent = await sendToAdmin({
    text: [
      `📋 สรุปประจำวัน ${formatDate(`${today}T12:00:00+07:00`)}`,
      `นัดวันนี้: ${appointments} · รอแอดมินยืนยัน (สีเทา): ${pending}`,
      `นัดใหม่จาก LINE เมื่อวาน: ${created}`,
      quota,
    ].join("\n"),
  }, "daily_summary_failed");
  if (!sent) throw new Error("daily_summary_failed");
  console.log(JSON.stringify({ tag: "daily_summary", appointments, pending, created }));
}
