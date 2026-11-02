import { messagingApi } from "@line/bot-sdk";
import { CLINIC_PHONE, CLINIC_PHONE_URI, HANDOFF_REPLY } from "./config";

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
