import { ApiError, GoogleGenAI } from "@google/genai";
import {
  GEMINI_MODEL,
  GEMINI_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  TEMPERATURE,
} from "./config";
import { buildSystemPrompt, buildUserContent } from "./prompt";

let ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
}

export async function askGemini(
  faqCsv: string,
  question: string,
): Promise<string | null> {
  const startedAt = Date.now();
  const abortSignal = AbortSignal.timeout(GEMINI_TIMEOUT_MS);

  try {
    const res = await getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildUserContent(faqCsv, question),
      config: {
        systemInstruction: buildSystemPrompt(),
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal,
      },
    });

    const finishReason = res.candidates?.[0]?.finishReason;
    console.log(JSON.stringify({
      tag: "gemini",
      finishReason,
      thoughtsTokenCount: res.usageMetadata?.thoughtsTokenCount,
      candidatesTokenCount: res.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - startedAt,
    }));

    // MAX_TOKENS, SAFETY ฯลฯ: ไม่ส่งให้ลูกค้าเจอประโยคขาดครึ่ง
    if (finishReason !== "STOP") return null;

    const text = res.text?.replace(/\*\*|#|`/g, "").trim();
    return text || null;
  } catch (err) {
    if (abortSignal.aborted) {
      console.error(JSON.stringify({
        tag: "gemini_timeout",
        latencyMs: Date.now() - startedAt,
      }));
    } else {
      console.error(JSON.stringify({
        tag: "gemini_error",
        status: err instanceof ApiError ? err.status : undefined,
        detail: err instanceof Error ? err.message : String(err),
      }));
    }
    return null;
  }
}
