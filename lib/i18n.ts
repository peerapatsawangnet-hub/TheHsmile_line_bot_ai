import { AsyncLocalStorage } from "node:async_hooks";

// ภาษาของลูกค้าที่กำลังตอบ ไทยเป็นค่าเริ่มต้น ข้อความไทยเดิมไม่เปลี่ยน ภาษาอังกฤษเพิ่มคู่กันผ่าน tr()
// เก็บใน AsyncLocalStorage ของแต่ละ event จึงไม่ต้องส่ง lang ผ่านทุกฟังก์ชัน และไม่ใช่ที่เก็บสถานะถาวร
export type Lang = "th" | "en";

const store = new AsyncLocalStorage<Lang>();

export function withLang<T>(lang: Lang, fn: () => T): T {
  return store.run(lang, fn);
}

export const currentLang = (): Lang => store.getStore() ?? "th";
export const isEn = (): boolean => currentLang() === "en";

export function tr(th: string, en: string): string {
  return isEn() ? en : th;
}

export const parseLang = (value: string | null | undefined): Lang => (value === "en" ? "en" : "th");

// ข้อความที่ไม่มีอักษรไทยเลยและมีคำภาษาอังกฤษอย่างน้อยสองคำ ถือว่าลูกค้าเขียนภาษาอังกฤษ (ตอบข้อความนั้นเป็นอังกฤษ)
// คำเดียวอย่าง "ok" "hi" "BTS" ไม่นับ คนไทยพิมพ์บ่อย
export function looksEnglish(text: string): boolean {
  return !/[฀-๿]/.test(text) && /[a-z]{2,}[\s,.!?]+[a-z]{2,}/i.test(text);
}
