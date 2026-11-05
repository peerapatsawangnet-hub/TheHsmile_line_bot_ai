import { messagingApi } from "@line/bot-sdk";
import { CLINIC_PHONE, CLINIC_PHONE_URI, HANDOFF_REPLY } from "./config";

export const BOOKING_CARD_NOTE = "เติม HN หรือแก้เวลาใน Google Calendar ก่อนกดยืนยันได้ ลูกค้าจะได้รับเวลาล่าสุด";

export function bookingRequestCard(
  summary: string,
  when: string,
  eventId: string,
  title = "🗓️ คำขอนัดใหม่",
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
          {
            type: "text",
            text: BOOKING_CARD_NOTE,
            wrap: true,
            size: "xs",
            color: "#666666",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "ยืนยัน", data: `a=ok&e=${eventId}` },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "postback", label: "ปฏิเสธ", data: `a=no&e=${eventId}` },
          },
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
