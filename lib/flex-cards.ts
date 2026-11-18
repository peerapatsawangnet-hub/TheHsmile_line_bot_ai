import { messagingApi } from "@line/bot-sdk";
import { BUTTON_COLOR, CLINIC_PHONE, CLINIC_PHONE_URI, HANDOFF_REPLY, HANDOFF_REPLY_EN, URGENT_BUTTON_COLOR } from "./config";
import { isEn, tr } from "./i18n";

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

// ภาษาตามนัด (ผู้เรียกครอบด้วยภาษาของลูกค้า) ปุ่มยืนยันพก l=en ให้คำตอบหลังกดเป็นภาษาเดิม
export function reminderCard(when: string, eventId: string): messagingApi.FlexMessage {
  const confirm = tr("ยืนยันมาตามนัด", "I'll be there");
  const change = tr("ขอเปลี่ยนนัด", "Reschedule");
  return {
    type: "flex",
    altText: tr(`แจ้งเตือนนัด ${when} กรุณากดยืนยันค่ะ`, `Appointment reminder: ${when}. Please confirm.`),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: tr("🦷 แจ้งเตือนนัดหมาย", "🦷 Appointment reminder"), weight: "bold", size: "lg" },
          { type: "text", text: when, wrap: true },
          { type: "text", text: tr("กรุณากดยืนยันว่าจะมาตามนัดนะคะ", "Please confirm that you'll come."), wrap: true },
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
            color: BUTTON_COLOR,
            action: { type: "postback", label: confirm, data: `a=attend&e=${eventId}${isEn() ? "&l=en" : ""}`, displayText: confirm },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "message", label: change, text: change },
          },
        ],
      },
    },
  };
}

// secondary: ปุ่มรอง เช่น "วันถัดไป ›" หรือ "ไม่ยกเลิก" แสดงเป็นสีเทา
// message: ปุ่มที่ส่งเป็นข้อความแทน postback เพื่อเข้าคำสั่งตรงเดียวกับที่ลูกค้าพิมพ์เอง
// urgent: ปุ่มเรื่องเร่งด่วน (ปวด บวม ฟันหลุด) สีแดงให้เห็นต่างจากปุ่มบริการ
export type ChoiceButton = {
  label: string;
  data: string;
  displayText: string;
  secondary?: boolean;
  message?: boolean;
  urgent?: boolean;
};

function choiceButton({ label, data, displayText, secondary, message, urgent }: ChoiceButton): messagingApi.FlexButton {
  return {
    type: "button",
    style: secondary ? "secondary" : "primary",
    ...(secondary ? {} : { color: urgent ? URGENT_BUTTON_COLOR : BUTTON_COLOR }),
    height: "sm",
    flex: 1,
    action: message
      ? { type: "message", label: label.slice(0, 40), text: displayText }
      : { type: "postback", label: label.slice(0, 40), data, displayText },
  };
}

// ปุ่มเยอะ (วัน เวลา) จัดเป็นตาราง แถวสุดท้ายเติมช่องว่างให้ปุ่มกว้างเท่ากัน
function buttonRows(buttons: ChoiceButton[], columns: number): messagingApi.FlexComponent[] {
  if (columns <= 1) return buttons.map(choiceButton);
  const rows: messagingApi.FlexComponent[] = [];
  for (let i = 0; i < buttons.length; i += columns) {
    const row: messagingApi.FlexComponent[] = buttons.slice(i, i + columns).map(choiceButton);
    while (row.length < columns) row.push({ type: "filler", flex: 1 });
    rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: row });
  }
  return rows;
}

// ขั้นต่างๆ ของการจองคิว: ปุ่มเล็กด้านล่าง (quick reply) ลูกค้ามักไม่เห็น จึงทำเป็นการ์ดปุ่มใหญ่ด้วย
// ข้อความคำถามเหมือนเดิมทุกตัวอักษร note คือบรรทัดที่เติมด้านบน เช่น เวลาว่างของวันที่ถาม
export function choiceCard(question: string, buttons: ChoiceButton[], columns = 1, note = ""): messagingApi.FlexMessage {
  const card: messagingApi.FlexMessage = {
    type: "flex",
    altText: question,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [{ type: "text", text: question, wrap: true, weight: "bold" }],
      },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttonRows(buttons, columns) },
    },
  };
  return note ? withCardNote(note, card) : card;
}

// คำตอบ FAQ ที่มีปุ่ม: ข้อความจาก Sheet ตัวปกติ (อาจยาวหลายบรรทัด) และปุ่มใหญ่แบบเดียวกับการ์ดจองคิว
export function faqCard(text: string, buttons: ChoiceButton[]): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: text.slice(0, 1500),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [{ type: "text", text, wrap: true }] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttonRows(buttons, 1) },
    },
  };
}

// เติมบรรทัดเหนือคำถาม เช่น "เวลานี้คิวเต็มแล้วค่ะ"
export function withCardNote(note: string, card: messagingApi.FlexMessage): messagingApi.FlexMessage {
  const bubble = card.contents as messagingApi.FlexBubble;
  const body = bubble.body as messagingApi.FlexBox;
  return {
    ...card,
    altText: `${note}\n${card.altText}`.slice(0, 1500),
    contents: {
      ...bubble,
      body: { ...body, contents: [{ type: "text", text: note, wrap: true, size: "sm", color: "#555555" }, ...body.contents] },
    },
  };
}

export function handoffCard(): messagingApi.FlexMessage {
  const reply = tr(HANDOFF_REPLY, HANDOFF_REPLY_EN);
  return {
    type: "flex",
    altText: reply,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: reply, wrap: true, weight: "bold" },
          {
            type: "text",
            text: tr(`หากเร่งด่วน โทรได้ที่ ${CLINIC_PHONE} ค่ะ`, `If it's urgent, please call ${CLINIC_PHONE}.`),
            wrap: true,
            size: "sm",
            color: "#666666",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [{
          type: "button",
          style: "primary",
          color: BUTTON_COLOR,
          action: { type: "uri", label: tr("โทรหาคลินิก", "Call the clinic"), uri: CLINIC_PHONE_URI },
        }],
      },
    },
  };
}
