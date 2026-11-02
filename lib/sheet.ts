import Papa from "papaparse";
import { SHEET_CACHE_MS, SHEET_TIMEOUT_MS } from "./config";

type FaqRow = {
  category?: string;
  question?: string;
  answer?: string;
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
    }));

  if (rows.length === 0) return null;
  return Papa.unparse(rows, { columns: ["category", "question", "answer"] });
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
