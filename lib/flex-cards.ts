import { messagingApi } from "@line/bot-sdk";
import { CLINIC_PHONE, CLINIC_PHONE_URI, HANDOFF_REPLY } from "./config";

export const BOOKING_CARD_NOTE = "เติม HN หรือแก้เวลาใน Google Calendar ก่อนกดยืนยันได้ ลูกค้าจะได้รับเวลาล่าสุด";

export type AdminCardAction = { label: string; data: string };

export function bookingActions(eventId: string): [AdminCardAction, AdminCardAction] {
  return [{ label: "ยืนยัน", data: `a=ok&e=${eventId}` }, { label: "ปฏิเสธ", data: `a=no&e=${eventId}` }];
}

// การ์ดในกลุ่มแอดมิน: ปุ่มแรกคือทำตามคำขอ ปุ่มที่สองคือไม่ทำ
export function bookingRequestCard(
  summary: string,
  when: string,
  [yes, no]: [AdminCardAction, AdminCardAction],
  { title = "🗓️ คำขอนัดใหม่", note = BOOKING_CARD_NOTE }: { title?: string; note?: string } = {},
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: `${title} ${when}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", size: "lg" },
          { type: "text", text: summary, wrap: true },
          { type: "text", text: when, wrap: true },
          ...(note ? [{ type: "text" as const, text: note, wrap: true, size: "xs", color: "#666666" }] : []),
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", ...yes } },
          { type: "button", style: "secondary", action: { type: "postback", ...no } },
        ],
      },
    },
  };
}

export function reminderCard(when: string, eventId: string): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: `แจ้งเตือนนัด ${when} กรุณากดยืนยันค่ะ`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🦷 แจ้งเตือนนัดหมาย", weight: "bold", size: "lg" },
          { type: "text", text: when, wrap: true },
          { type: "text", text: "กรุณากดยืนยันว่าจะมาตามนัดนะคะ", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "ยืนยันมาตามนัด", data: `a=attend&e=${eventId}`, displayText: "ยืนยันมาตามนัด" },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "message", label: "ขอเปลี่ยนนัด", text: "ขอเปลี่ยนนัด" },
          },
        ],
      },
    },
  };
}

export type ChoiceButton = { label: string; data: string; displayText: string };

// ขั้นเลือกบริการ: ปุ่มเล็กด้านล่าง (quick reply) ลูกค้ามักไม่เห็น จึงทำเป็นการ์ดปุ่มใหญ่ด้วย
// ข้อความคำถามเหมือนเดิมทุกตัวอักษร note คือบรรทัดที่เติมด้านบน เช่น เวลาว่างของวันที่ถาม
export function choiceCard(question: string, buttons: ChoiceButton[], note = ""): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: note ? `${note}\n${question}` : question,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          ...(note ? [{ type: "text" as const, text: note, wrap: true, weight: "bold" as const }] : []),
          { type: "text", text: question, wrap: true, size: "sm", color: "#666666" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: buttons.map(({ label, data, displayText }) => ({
          type: "button" as const,
          style: "primary" as const,
          height: "sm" as const,
          action: { type: "postback" as const, label: label.slice(0, 40), data, displayText },
        })),
      },
    },
  };
}

export function handoffCard(): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: HANDOFF_REPLY,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: HANDOFF_REPLY, wrap: true, weight: "bold" },
          { type: "text", text: `หากเร่งด่วน โทรได้ที่ ${CLINIC_PHONE} ค่ะ`, wrap: true, size: "sm", color: "#666666" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [{
          type: "button",
          style: "primary",
          action: { type: "uri", label: "โทรหาคลินิก", uri: CLINIC_PHONE_URI },
        }],
      },
    },
  };
}
