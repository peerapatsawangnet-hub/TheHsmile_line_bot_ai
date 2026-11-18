import Papa from "papaparse";
import { SHEET_CACHE_MS, SHEET_TIMEOUT_MS } from "./config";

type FaqRow = {
  category?: string;
  question?: string;
  answer?: string;
  // คำตอบภาษาอังกฤษที่คลินิกเขียนเอง (ไม่บังคับ) ว่างคือให้ Gemini แปลจาก answer
  answer_en?: string;
  active?: string;
};

let cache: { csv: string; fetchedAt: number } | null = null;

// คืน null ถ้าไม่มีแถวที่ใช้งานได้เลย
function cleanCsv(raw: string): string | null {
  const { data } = Papa.parse<FaqRow>(raw, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  const rows = data
    .filter(
      (row) =>
        row.active?.trim().toUpperCase() !== "FALSE" &&
        row.question?.trim() &&
        row.answer?.trim(),
    )
    .map((row) => ({
      category: row.category?.trim() ?? "",
      question: row.question?.trim(),
      answer: row.answer?.trim(),
      answer_en: row.answer_en?.trim() ?? "",
    }));

  if (rows.length === 0) return null;
  // คอลัมน์ answer_en ใส่เฉพาะเมื่อมีแถวที่เขียนไว้ FAQ ที่ส่งให้ Gemini จึงเหมือนเดิมถ้ายังไม่ใช้
  const hasEnglish = rows.some((row) => row.answer_en);
  return Papa.unparse(rows, { columns: hasEnglish ? ["category", "question", "answer", "answer_en"] : ["category", "question", "answer"] });
}

async function fetchRawCsv(): Promise<string> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) throw new Error("SHEET_CSV_URL is not set");

  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Sheet responded with status ${res.status}`);
  return res.text();
}

const questionKey = (text: string) => text.toLowerCase().replace(/[\s"'“”‘’?？!.,]/g, "");

// คำตอบจาก Sheet ของแถวที่คำถามตรงกัน ช่อง question มีได้หลายแบบคั่นด้วย /
// เทียบได้ทั้งช่องทั้งหมด (Gemini คัดลอกมาทั้งช่อง) หรือแบบใดแบบหนึ่ง (ลูกค้าพิมพ์หรือกดปุ่ม)
export function findFaqRow(faqCsv: string, question: string | undefined): { answer: string; answerEn: string } | null {
  if (!question) return null;
  const { data } = Papa.parse<FaqRow>(faqCsv, { header: true, skipEmptyLines: true });
  const wanted = questionKey(question);
  if (!wanted) return null;
  const matches = (row: FaqRow) => {
    const cell = row.question ?? "";
    return questionKey(cell) === wanted || cell.split("/").some((variant) => questionKey(variant) === wanted);
  };
  const row = data.find(matches);
  const answer = row?.answer?.trim();
  return answer ? { answer, answerEn: row?.answer_en?.trim() ?? "" } : null;
}

export function findFaqAnswer(faqCsv: string, question: string | undefined): string | null {
  return findFaqRow(faqCsv, question)?.answer ?? null;
}

export async function getFaqCsv(): Promise<string> {
  if (cache && Date.now() - cache.fetchedAt < SHEET_CACHE_MS) {
    return cache.csv;
  }

  let raw: string;
  try {
    raw = await fetchRawCsv();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (cache) {
      console.warn(JSON.stringify({ tag: "sheet_stale", detail }));
      return cache.csv;
    }
    console.error(JSON.stringify({ tag: "sheet_unavailable", detail }));
    throw err;
  }

  const csv = cleanCsv(raw);
  if (!csv) {
    console.error(JSON.stringify({ tag: "sheet_empty" }));
    throw new Error("Sheet has no usable rows");
  }

  cache = { csv, fetchedAt: Date.now() };
  return csv;
}
