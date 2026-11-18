import { Lang } from "./i18n";
import { getLineClient } from "./line";

// ภาษาของลูกค้าแต่ละคนดูจาก Rich Menu ที่ LINE ผูกไว้กับคนนั้น (LINE เป็นคนจำ บอทไม่ต้องมีที่เก็บสถานะ)
// เมนูติดตั้งด้วย scripts/install-rich-menu.mjs ชื่อเมนูต้องตรงกับที่นี่
export const RICH_MENU_NAMES: Record<Lang, string> = { th: "The H Smile TH", en: "The H Smile EN" };

const CACHE_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;

let menus: { en?: string; at: number } | null = null;
// แคชในหน่วยความจำของ instance นี้เท่านั้น หายเมื่อ instance ปิด ไม่ใช่ที่เก็บสถานะ
const userLangs = new Map<string, { lang: Lang; at: number }>();

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("rich menu lookup timeout")), LOOKUP_TIMEOUT_MS)),
  ]);
}

async function englishMenuId(): Promise<string | undefined> {
  if (menus && Date.now() - menus.at < CACHE_MS) return menus.en;
  const { richmenus } = await withTimeout(getLineClient().getRichMenuList());
  menus = { en: richmenus.find(({ name }) => name === RICH_MENU_NAMES.en)?.richMenuId, at: Date.now() };
  return menus.en;
}

// อ่านไม่ได้ (ยังไม่ติดตั้งเมนู, LINE ช้า) ถือว่าไทย
export async function userLang(userId: string): Promise<Lang> {
  const cached = userLangs.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.lang;
  let lang: Lang = "th";
  try {
    const en = await englishMenuId();
    if (en) {
      const linked = await withTimeout(getLineClient().getRichMenuIdOfUser(userId)).catch(() => null);
      if (linked?.richMenuId === en) lang = "en";
    }
  } catch (err) {
    console.warn(JSON.stringify({ tag: "rich_menu_lookup_failed", detail: err instanceof Error ? err.message : String(err) }));
  }
  userLangs.set(userId, { lang, at: Date.now() });
  return lang;
}

// ภาษาไทยคือเมนูเริ่มต้นของบัญชี จึงแค่ถอดเมนูอังกฤษออก คืน false ถ้ายังไม่ได้ติดตั้งเมนูอังกฤษ
export async function setUserLang(userId: string, lang: Lang): Promise<boolean> {
  userLangs.set(userId, { lang, at: Date.now() });
  try {
    const client = getLineClient();
    if (lang === "th") {
      await withTimeout(client.unlinkRichMenuIdFromUser(userId)).catch(() => undefined);
      return true;
    }
    const en = await englishMenuId();
    if (!en) return false;
    await withTimeout(client.linkRichMenuIdToUser(userId, en));
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ tag: "rich_menu_link_failed", detail: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}
