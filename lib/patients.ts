import { JWT } from "google-auth-library";
import { PATIENTS_CACHE_MS, PATIENTS_TIMEOUT_MS } from "./config";

// รายชื่อคนไข้อยู่ใน Google Sheet ที่ไม่เผยแพร่ แชร์ให้ service account อ่านอย่างเดียว
// ห้าม log ชื่อ เบอร์ หรือ DN
type Patient = { dn: string; name: string; phones: string[] };

let auth: JWT | null = null;
let cache: { at: number; patients: Patient[] } | null = null;

function getAuth(): JWT {
  auth ??= new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth;
}

// ช่องเบอร์อาจมีหลายเบอร์ มีขีด หรือ Sheets ตัด 0 ข้างหน้าออกเพราะเก็บเป็นตัวเลข
export function phonesIn(cell: string): string[] {
  return (cell.match(/\d[\d -]{7,}\d/g) ?? [])
    .map((part) => part.replace(/\D/g, ""))
    .map((digits) => (digits.length === 9 && !digits.startsWith("0") ? `0${digits}` : digits))
    .filter((digits) => /^0\d{8,9}$/.test(digits));
}

// ชื่อแรกโดยตัดคำนำหน้า ใช้เทียบกับชื่อที่ลูกค้าพิมพ์
// ข้อความไทยที่ก๊อปมามักมีอักขระที่มองไม่เห็นปน จึงตัดทิ้งก่อนเทียบ
export function firstName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[​-‍⁠﻿]/g, "")
    .trim()
    .replace(/^(คุณ|นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|mr\.?|mrs\.?|ms\.?|miss)\s*/i, "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase() ?? "";
}

// หัวคอลัมน์ที่รับได้ เทียบหลังตัดช่องว่างและจุด เช่น "Phone NO." "Phone No" "phone"
const HEADERS = {
  dn: ["dn", "hn"],
  name: ["name", "ชื่อ", "ชื่อนามสกุล", "ชื่อสกุล"],
  phone: ["phoneno", "phone", "tel", "เบอร์", "เบอร์โทร", "เบอร์โทรศัพท์"],
};
const MAX_HEADER_ROW = 5;

const headerKey = (cell: string) => cell.toLowerCase().replace(/[\s.\-_:]/g, "");

export function parsePatients(rows: string[][]): Patient[] {
  // บางไฟล์มีชื่อตารางอยู่เหนือหัวคอลัมน์ จึงหาหัวคอลัมน์ในไม่กี่แถวแรก
  for (let index = 0; index < Math.min(rows.length, MAX_HEADER_ROW); index++) {
    const keys = rows[index].map(headerKey);
    const col = (names: string[]) => keys.findIndex((key) => names.includes(key));
    const dn = col(HEADERS.dn);
    const name = col(HEADERS.name);
    const phone = col(HEADERS.phone);
    if (dn >= 0 && name >= 0 && phone >= 0) return toPatients(rows.slice(index + 1), dn, name, phone);
  }
  throw new Error("patients_header_missing");
}

function toPatients(body: string[][], dn: number, name: number, phone: number): Patient[] {
  return body
    .map((row) => ({ dn: (row[dn] ?? "").trim(), name: (row[name] ?? "").trim(), phones: phonesIn(row[phone] ?? "") }))
    .filter((patient) => patient.dn && patient.phones.length > 0);
}

async function get<T>(path: string): Promise<T> {
  const id = encodeURIComponent(process.env.PATIENTS_SHEET_ID ?? "");
  const res = await getAuth().request<T>({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`,
    timeout: PATIENTS_TIMEOUT_MS,
    retry: false,
  });
  return res.data;
}

// ชื่อแท็บในรูปแบบ range ของ Sheets: ครอบด้วย ' และ ' ข้างในเขียนซ้ำ
const tabRange = (title: string) => `'${title.replace(/'/g, "''")}'`;

// คลินิกแยกแท็บตามเดือน จึงอ่านทุกแท็บแล้วรวมกัน แท็บที่ไม่มีหัวคอลัมน์ข้ามไป
// ตั้ง PATIENTS_SHEET_TAB แล้วอ่านแท็บเดียว
async function readTabs(): Promise<string[][][]> {
  const tab = process.env.PATIENTS_SHEET_TAB;
  const titles = tab
    ? [tab]
    : ((await get<{ sheets?: { properties?: { title?: string } }[] }>("?fields=sheets.properties.title")).sheets ?? [])
        .map((sheet) => sheet.properties?.title ?? "")
        .filter(Boolean);
  if (titles.length === 0) return [];
  const ranges = titles.map((title) => `ranges=${encodeURIComponent(tabRange(title))}`).join("&");
  const data = await get<{ valueRanges?: { values?: string[][] }[] }>(
    `/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE`,
  );
  return (data.valueRanges ?? []).map((range) => range.values ?? []);
}

async function loadPatients(): Promise<Patient[]> {
  if (cache && Date.now() - cache.at < PATIENTS_CACHE_MS) return cache.patients;
  const tabs = (await readTabs()).map((rows) => {
    try {
      return parsePatients(rows);
    } catch {
      return null;
    }
  });
  if (tabs.every((tab) => tab === null)) throw new Error("patients_header_missing");
  const patients = tabs.flatMap((tab) => tab ?? []);
  cache = { at: Date.now(), patients };
  return patients;
}

// ต้องตรงทั้งเบอร์และชื่อแรก ใส่ DN ผิดคนแย่กว่าไม่ใส่ เพราะคุณหมอจะเปิดชาร์ตผิด
export function matchDn(patients: Patient[], name: string, phone: string): string | null {
  const wanted = firstName(name);
  if (!wanted) return null;
  const dns = new Set(
    patients
      .filter((patient) => patient.phones.includes(phone) && firstName(patient.name) === wanted)
      .map((patient) => patient.dn),
  );
  return dns.size === 1 ? [...dns][0] : null;
}

// คืน null เมื่อไม่ได้ตั้งค่า ไม่พบ หรืออ่านไม่ได้ การจองต้องไปต่อได้เสมอ
export async function findDn(name: string, phone: string): Promise<string | null> {
  if (!process.env.PATIENTS_SHEET_ID) return null;
  try {
    const patients = await loadPatients();
    const dn = matchDn(patients, name, phone);
    // นับอย่างเดียว ไม่มีข้อมูลคนไข้: rows=0 คืออ่านผิดไฟล์/แท็บ phoneMatches=0 คือเบอร์ไม่อยู่ในไฟล์
    // phoneMatches>0 แต่ไม่พบ คือชื่อแรกไม่ตรง
    const phoneMatches = patients.filter((patient) => patient.phones.includes(phone)).length;
    console.log(JSON.stringify({ tag: "patient_lookup", found: Boolean(dn), rows: patients.length, phoneMatches }));
    return dn;
  } catch (err) {
    console.error(JSON.stringify({
      tag: "patient_lookup_failed",
      status: (err as { response?: { status?: number } }).response?.status,
      detail: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}
