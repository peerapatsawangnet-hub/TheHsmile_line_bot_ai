import { ApiError, GoogleGenAI, Type } from "@google/genai";
import {
  GEMINI_MODEL,
  GEMINI_THINKING_LEVEL,
  GEMINI_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  TEMPERATURE,
} from "./config";
import { Intent, INTENT_NAMES } from "./intents";
import { buildSystemPrompt, buildUserContent } from "./prompt";

export type Slots = {
  service?: string;
  coverage?: string;
  date_text?: string;
  period?: string;
  time_text?: string;
};

export type Classification = {
  intent: Intent;
  confidence: "high" | "low";
  foundInFaq: boolean;
  reply: string;
  multiplePatients: boolean;
  slots: Slots;
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: [...INTENT_NAMES] },
    confidence: { type: Type.STRING, enum: ["high", "low"] },
    found_in_faq: { type: Type.BOOLEAN },
    reply: { type: Type.STRING },
    multiple_patients: { type: Type.BOOLEAN },
    slots: {
      type: Type.OBJECT,
      properties: {
        service: { type: Type.STRING },
        coverage: { type: Type.STRING, enum: ["สปสช", "ประกันสังคม", "ชำระเอง"] },
        date_text: { type: Type.STRING },
        period: { type: Type.STRING, enum: ["เช้า", "บ่าย", "เย็น"] },
        time_text: { type: Type.STRING },
        name: { type: Type.STRING },
        phone: { type: Type.STRING },
      },
    },
  },
  required: ["intent", "confidence", "found_in_faq", "reply", "multiple_patients"],
};

let ai: GoogleGenAI | null = null;

// ตั้ง VERTEX_PROJECT_ID แล้วเรียกผ่าน Vertex AI ด้วย service account เดียวกับ Calendar
// Vertex AI คิดเงินผ่าน billing account ปกติ ใช้ credit ของ Google Cloud ได้โดยไม่ต้องเติมเงินล่วงหน้า
// ไม่ตั้งจะใช้ GEMINI_API_KEY ผ่าน AI Studio แบบเดิม
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID;
const BACKEND = VERTEX_PROJECT_ID ? "vertex" : "studio";

function getClient(): GoogleGenAI {
  ai ??= VERTEX_PROJECT_ID
    ? new GoogleGenAI({
        vertexai: true,
        project: VERTEX_PROJECT_ID,
        location: process.env.VERTEX_LOCATION ?? "global",
        googleAuthOptions: {
          credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            // Vercel เก็บ newline ใน env เป็น \n
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          },
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function parse(raw: string): Classification | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const intent = data.intent as Intent;
  if (!INTENT_NAMES.includes(intent)) return null;

  const slots = (data.slots ?? {}) as Record<string, unknown>;
  return {
    intent,
    confidence: data.confidence === "high" ? "high" : "low",
    foundInFaq: data.found_in_faq === true,
    // ไม่ส่ง markdown ให้ลูกค้า
    reply: (str(data.reply) ?? "").replace(/\*\*|#|`/g, "").trim(),
    multiplePatients: data.multiple_patients === true,
    // ไม่เก็บชื่อและเบอร์จาก Gemini: flow จองถามเองหลังกันคิว
    slots: {
      service: str(slots.service),
      coverage: str(slots.coverage),
      date_text: str(slots.date_text),
      period: str(slots.period),
      time_text: str(slots.time_text),
    },
  };
}

// Google ตอบว่าโมเดลคนใช้เยอะหรือเกินโควต้าชั่วคราว
const RETRYABLE_STATUS = new Set([429, 503]);

function generate(faqCsv: string, question: string, abortSignal: AbortSignal) {
  return getClient().models.generateContent({
    model: GEMINI_MODEL,
    contents: buildUserContent(faqCsv, question),
    config: {
      systemInstruction: buildSystemPrompt(),
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      abortSignal,
    },
  });
}

// คืน null เมื่อใช้ผลไม่ได้ (timeout, error, MAX_TOKENS, JSON เสีย) ให้ผู้เรียกใช้ fallback
export async function classifyMessage(faqCsv: string, question: string): Promise<Classification | null> {
  const startedAt = Date.now();
  // ครั้งที่ลองใหม่ใช้งบ 7 วินาทีเดียวกัน ไม่ต่อเวลาเพิ่ม
  const abortSignal = AbortSignal.timeout(GEMINI_TIMEOUT_MS);

  try {
    let res;
    try {
      res = await generate(faqCsv, question, abortSignal);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      if (abortSignal.aborted || !status || !RETRYABLE_STATUS.has(status)) throw err;
      console.warn(JSON.stringify({ tag: "gemini_retry", status, latencyMs: Date.now() - startedAt }));
      res = await generate(faqCsv, question, abortSignal);
    }

    const finishReason = res.candidates?.[0]?.finishReason;
    const result = finishReason === "STOP" && res.text ? parse(res.text) : null;
    console.log(JSON.stringify({
      tag: "gemini",
      finishReason,
      thoughtsTokenCount: res.usageMetadata?.thoughtsTokenCount ?? 0,
      candidatesTokenCount: res.usageMetadata?.candidatesTokenCount,
      intent: result?.intent,
      confidence: result?.confidence,
      parsed: Boolean(result),
      latencyMs: Date.now() - startedAt,
      backend: BACKEND,
    }));
    return result;
  } catch (err) {
    if (abortSignal.aborted) {
      console.error(JSON.stringify({
        tag: "gemini_timeout",
        latencyMs: Date.now() - startedAt,
        backend: BACKEND,
      }));
    } else {
      console.error(JSON.stringify({
        tag: "gemini_error",
        backend: BACKEND,
        status: err instanceof ApiError ? err.status : undefined,
        detail: err instanceof Error ? err.message : String(err),
      }));
    }
    return null;
  }
}
