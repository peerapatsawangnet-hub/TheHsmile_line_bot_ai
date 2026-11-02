# CLAUDE.md: LINE Bot The H Smile Pattaya

LINE Official Account bot ของคลินิกทันตกรรม The H Smile Pattaya ตอบลูกค้าด้วย Gemini จาก FAQ ใน Google Sheet

## Stack (locked)

- Next.js 14 App Router + TypeScript 5 (TypeScript 7 ทำให้ `next build` พัง)
- `@line/bot-sdk`, `@google/genai`, `papaparse`
- Vercel, npm

## Files

- `app/api/line-webhook/route.ts`: verify signature → handoff หรือตอบจาก FAQ → reply
- `lib/config.ts`: ค่าคงที่และข้อความมาตรฐาน
- `lib/sheet.ts`: ดึง กรอง และ cache FAQ
- `lib/gemini.ts`, `lib/prompt.ts`: เรียก Gemini และ system prompt
- `lib/handoff.ts`: ตรวจคำ trigger และแจ้งกลุ่มแอดมิน
- `lib/flex-cards.ts`: Flex Message
- `lib/line.ts`: LINE client
- `rich-menu.json`, `scripts/install-rich-menu.mjs`: Rich Menu
- `docs/test-conversations.md`: บททดสอบก่อนปล่อยใช้งาน

## Env vars

`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`, `SHEET_CSV_URL`, `ADMIN_GROUP_ID` (optional)

ระบบจองคิวเปิดเมื่อมีครบ: `ADMIN_GROUP_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`, `SERVICES_CSV_URL`, `HOURS_CSV_URL`

- แท็บบริการ: `service,duration_minutes,active`
- แท็บเวลาจอง: `day,open,close` เช่น `จันทร์,10:00,12:00` หนึ่งวันมีหลายแถวได้ วันที่ไม่มีแถวถือว่าปิด
- วันพิเศษ: ใส่ `day` เป็น `YYYY-MM-DD` ใช้แทนเวลาปกติของวันนั้น ถ้าเว้น `open` และ `close` ถือว่าปิด
- `lib/booking.ts`, `lib/booking-config.ts`, `lib/calendar.ts`: ขั้นตอนจอง การอ่านข้อมูล และ Calendar API
- ใช้ Google Calendar เดิมของคลินิก นับคิวจากเวลาเท่านั้น ห้ามอ่านชื่อหรือเบอร์ของนัดอื่น
- สถานะนัด: `tentative` + สีเทา (`colorId` 8) คือรอแอดมิน, `confirmed` + สีฟ้า (`colorId` 7) คือแอดมินยืนยันแล้ว, สีม่วง (`colorId` 3) คือคนไข้กดยืนยันแล้ว
- `app/api/cron/reminders/route.ts`: ส่งข้อความเตือนนัดวันถัดไปทุกวันราว 09:00 น. ต้องตั้ง `CRON_SECRET` และส่งได้เฉพาะนัดที่จองผ่าน LINE
- แอดมินเป็นคนเติม HN ในปฏิทิน บอทไม่ถาม HN จากลูกค้า

## Sheet

แถวแรกต้องเป็น `category,question,answer,active` ตัวพิมพ์เล็กตามนี้ มิฉะนั้นจะขึ้น `sheet_empty`

## Rules

- ห้ามใส่ราคา เวลา ที่อยู่ หรือชื่อทันตแพทย์ในโค้ด ข้อมูลเหล่านี้มาจาก Sheet เท่านั้น
- ห้ามข้าม signature verification และห้าม hardcode token
- ห้าม retry ด้วย reply token เดิม เพราะใช้ได้ครั้งเดียว
- ห้าม log ข้อความลูกค้าหรือ userId ให้ log แค่ความยาวข้อความ
- ห้าม parse CSV เอง ให้ใช้ papaparse
- งบเวลาต่อข้อความคือ Sheet 3 วินาที + Gemini 7 วินาที
- ทุกทางที่พังต้องจบที่ `DEFAULT_REPLY`
- บอทตอบเฉพาะแชตส่วนตัว ไม่ตอบในกลุ่ม
- `line-bot-recipe.md` ห้ามขึ้น repo เพราะ license ห้ามแชร์ต่อ และ repo นี้เป็น public
