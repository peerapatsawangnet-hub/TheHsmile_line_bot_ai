import { getRows } from "./booking-config";

// แท็บ settings ใน Sheet: key,value เปลี่ยนได้โดยไม่ต้อง redeploy (cache 60 วินาที)
export type BotSettings = { enabled: boolean; mode: "live" | "shadow" };

const DEFAULTS: BotSettings = { enabled: true, mode: "live" };
// ตั้ง SETTINGS_CSV_URL ไว้แต่ยังไม่เคยอ่านได้ (เช่น Sheet ช้าตอนเครื่องเพิ่งเริ่ม)
// ห้ามเดาว่าเป็น live เพราะทีมอาจปิดบอทหรือเปิดโหมดทดลองไว้
const UNREADABLE: BotSettings = { enabled: true, mode: "shadow" };
let last: BotSettings | null = null;

export async function getSettings(): Promise<BotSettings> {
  if (!process.env.SETTINGS_CSV_URL) return DEFAULTS;
  try {
    const rows = await getRows("SETTINGS_CSV_URL");
    const value = (key: string) =>
      rows.find((row) => row.key?.trim() === key)?.value?.trim().toLowerCase();
    last = {
      enabled: value("bot_enabled") !== "false",
      mode: value("bot_mode") === "shadow" ? "shadow" : "live",
    };
    return last;
  } catch (err) {
    console.warn(JSON.stringify({
      tag: "settings_unavailable",
      fallback: last ? "last" : "shadow",
      detail: err instanceof Error ? err.message : String(err),
    }));
    return last ?? UNREADABLE;
  }
}
