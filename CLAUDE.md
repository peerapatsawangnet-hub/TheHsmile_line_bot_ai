# CLAUDE.md: LINE Bot The H Smile Pattaya

LINE Official Account bot ของคลินิกทันตกรรม The H Smile Pattaya ใช้ Gemini จัดประเภทข้อความลูกค้า ตอบจาก FAQ ใน Google Sheet และส่งเข้า flow จองคิว บอทพูดเฉพาะเมื่อมั่นใจ นอกนั้นเงียบและแจ้งกลุ่มแอดมิน

## Stack (locked)

- Next.js 14 App Router + TypeScript 5 (TypeScript 7 ทำให้ `next build` พัง)
- `@line/bot-sdk`, `@google/genai`, `papaparse`, `google-auth-library`
- Vercel Hobby, npm, `tsx` สำหรับ test

## Files

- `app/api/line-webhook/route.ts`: ลำดับตัดสินใจ signature → กลุ่มแอดมิน → แชตส่วนตัว → `settings` → ข้อความตัวอักษร → คำสั่งตรง → flow จองที่ค้างอยู่ → `ack` → classifier → `shadow`
- `lib/intents.ts`: นิยามและตัวอย่างของ 16 intent เป็นแหล่งเดียวของ `<intent_guide>` และป้าย "เรื่อง" ที่แจ้งแอดมิน
- `lib/gemini.ts`, `lib/prompt.ts`: classifier แบบ JSON schema และ system prompt
- `lib/triage.ts`: regex กรอง `ack`, fallback เมื่อ Gemini ใช้ไม่ได้, แปลงผล classifier เป็นการกระทำ
- `lib/thai-datetime.ts`: แปลงวันเวลาภาษาไทย (พ.ศ., เดือนย่อ, บ่าย3) ห้ามให้ Gemini คำนวณวันที่
- `lib/handoff.ts`: คำสั่งตรง (`ขอแอดมิน`, `เปลี่ยนนัด` ฯลฯ) และการแจ้งกลุ่มแอดมิน รวมแจ้งด่วน 🔴 และโหมดทดลอง
- `lib/admin-channel.ts`: ส่งเข้ากลุ่มแอดมินทาง Telegram หรือกลุ่ม LINE ทุกการแจ้งแอดมินต้องผ่าน `sendToAdmin`
- `app/api/telegram-webhook/route.ts`: รับการกดปุ่มยืนยัน/ปฏิเสธนัดจาก Telegram ตรวจ secret token และ chat id
- `lib/settings.ts`: แท็บ `settings` ใน Sheet
- `lib/daily-summary.ts`: สรุปรายวันและโควต้าข้อความ ส่งหลังเตือนนัดใน cron เดิม
- `lib/config.ts`: ค่าคงที่และข้อความมาตรฐาน
- `lib/sheet.ts`: ดึง กรอง และ cache FAQ
- `lib/flex-cards.ts`, `lib/line.ts`: Flex Message และ LINE client
- `rich-menu.json`, `scripts/install-rich-menu.mjs`: Rich Menu 6 ช่อง
- `tests/*.test.ts` (`npm test`), `tests/intent-holdout.json` + `scripts/test-intents.ts`: ชุดทดสอบ
- `tests/e2e/` (`npm run test:e2e`): build แล้วรันบอทจริงกับ mock ของ LINE, Gemini/Vertex, Calendar, Sheets, Telegram สองรอบ (กลุ่ม LINE + AI Studio และ Telegram + Vertex) ต้องผ่านทั้งหมดก่อน push โค้ดที่แตะ flow จอง แจ้งแอดมิน หรือ webhook
- `docs/test-conversations.md`: บททดสอบบนมือถือก่อนปล่อยใช้งาน

## Env vars

`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`, `SHEET_CSV_URL`, `ADMIN_GROUP_ID` (ต้องมีอย่างน้อยหนึ่งช่องทางแอดมิน: ไม่ตั้งทั้งสองแบบจะ log `admin_group_missing`), `SETTINGS_CSV_URL` (ไม่ตั้งถือว่า `bot_enabled = TRUE`, `bot_mode = live` ถ้าตั้งไว้แต่ยังไม่เคยอ่านได้ ถือว่า `shadow` อ่านได้แล้วครั้งหนึ่งใช้ค่าล่าสุด), `DOCTOR_SCHEDULE_CSV_URL` (optional)

Gemini: ตั้ง `VERTEX_PROJECT_ID` (และ `VERTEX_LOCATION` ค่าเริ่มต้น `global`) เพื่อเรียกผ่าน Vertex AI ด้วย service account เดียวกับ Calendar ซึ่งคิดเงินผ่าน billing account และใช้ credit ของ Google Cloud ได้ ไม่ตั้งจะใช้ `GEMINI_API_KEY` ผ่าน AI Studio ซึ่งต้องเติมเงินล่วงหน้า service account ต้องมี role Vertex AI User ในโปรเจกต์นั้น

กลุ่มแอดมินทาง Telegram: ตั้ง `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (เลขติดลบของกลุ่ม) และ `TELEGRAM_WEBHOOK_SECRET` แล้วการแจ้งแอดมินทุกอย่างจะไปที่ Telegram แทนกลุ่ม LINE ไม่กินโควต้า push ของ LINE ต้อง `setWebhook` ไปที่ `/api/telegram-webhook` พร้อม `secret_token` เดียวกัน ข้อความถึงลูกค้า (เตือนนัด แจ้งผลยืนยัน) ยังเป็น LINE push ที่นับโควต้า ปุ่มในการ์ดกลุ่ม LINE เดิมยังกดได้ถ้ายังตั้ง `ADMIN_GROUP_ID` ไว้

ระบบจองคิวเปิดเมื่อมีครบ: `ADMIN_GROUP_ID` หรือ Telegram, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`, `SERVICES_CSV_URL`, `HOURS_CSV_URL`

- แท็บบริการ: `service,duration_minutes,active,needs_doctor,accepts_rights,group,booking_note` (`needs_doctor` ว่างถือว่า `TRUE`, `accepts_rights` ว่างถือว่าใช้สิทธิ สปสช/ประกันสังคมได้ `FALSE` คือชำระเองเท่านั้น บอทข้ามขั้นเลือกสิทธิและบอกลูกค้า, `group` บริการที่ใส่ชื่อกลุ่มเดียวกันรวมเป็นปุ่มเดียวบนการ์ดแรก (`a=grp`) กดแล้วเลือกบริการในกลุ่ม, `booking_note` ข้อความที่ต่อท้าย "ส่งคำขอนัด…" ของบริการนั้น) การ์ดบริการมีปุ่มแดง "มีอาการปวด / บวม / ครอบฟันหลุด" (`URGENT_BUTTON_TEXT`) ส่งการ์ดติดต่อกลับ + แจ้งแอดมิน "อาการเร่งด่วน" ไม่ใช่แจ้งด่วน 🔴
- แท็บเวลาจอง: `day,open,close` เช่น `จันทร์,10:00,12:00` หนึ่งวันมีหลายแถวได้ วันที่ไม่มีแถวถือว่าปิด
- วันพิเศษ: ใส่ `day` เป็น `YYYY-MM-DD` ใช้แทนเวลาปกติของวันนั้น ถ้าเว้น `open` และ `close` ถือว่าปิด
- วันคุณหมอเข้า: all-day event ชื่อ `หมอเข้า` ในปฏิทินเดิม บริการ `needs_doctor = TRUE` จองได้เฉพาะวันนั้น ถ้าช่วง 30 วันที่เปิดจองยังไม่มี event นี้เลย ถือว่าไม่จำกัดวัน ถ้าคุณหมอเข้าทุกวันที่คลินิกเปิด ไม่ต้องลง event นี้ ให้ลงวันหยุดในแท็บเวลาจอง บอทจะตอบคำถามวันคุณหมอเข้าด้วยวันที่คลินิกปิดแทน
- แท็บ `doctor_schedule` (ไม่บังคับ): `month,image_url` เช่น `2026-11,https://…` ส่งรูปตารางตามคำตอบวันคุณหมอเข้า
- `lib/booking.ts`, `lib/booking-config.ts`, `lib/calendar.ts`: ขั้นตอนจอง การอ่านข้อมูล และ Calendar API
- ใช้ Google Calendar เดิมของคลินิก นับคิวจากเวลาเท่านั้น ห้ามอ่านชื่อหรือเบอร์ของนัดอื่น การอ่านวันคุณหมอเข้าใช้ `q` ให้ Google กรองก่อน
- สถานะนัด: `tentative` + สีเทา (`colorId` 8) คือรอแอดมิน, `confirmed` + สีฟ้า (`colorId` 7) คือแอดมินยืนยันแล้ว, สีม่วง (`colorId` 3) คือคนไข้กดยืนยันแล้ว
- `app/api/cron/reminders/route.ts`: ทุกวันราว 09:00 น. เตือนนัดวันถัดไป (เฉพาะนัดที่จองผ่าน LINE) แล้วส่งสรุปรายวันเข้ากลุ่มแอดมิน ต้องตั้ง `CRON_SECRET`
- แอดมินเป็นคนเติม HN ในปฏิทิน บอทไม่ถาม HN จากลูกค้า
- DN อัตโนมัติ (ไม่บังคับ): ตั้ง `PATIENTS_SHEET_ID` (อ่านทุกแท็บแล้วรวมกัน ข้ามแท็บที่ไม่มีหัวคอลัมน์ ตั้ง `PATIENTS_SHEET_TAB` เพื่ออ่านแท็บเดียว) ชี้ไป Google Sheet รายชื่อคนไข้ที่**ไม่เผยแพร่** แชร์ให้ service account เป็นผู้อ่าน ต้องเปิด Google Sheets API ในโปรเจกต์ของ service account บอทอ่านคอลัมน์ `DN`, `Name`, `Phone NO.` ตามชื่อหัวคอลัมน์ ใส่ DN หน้าชื่อนัดเมื่อเบอร์และชื่อแรกตรงกันคนเดียว (`lib/patients.ts`) DN ไม่ส่งให้ลูกค้า อ่านไม่ได้ก็จองต่อโดยไม่มี DN ห้ามใช้ "เผยแพร่ไปยังเว็บ" กับรายชื่อคนไข้
- ลำดับจองคิว (คุณหมอเลือก): บริการ → วัน → ช่วง → 2 เวลาว่างที่เร็วที่สุด + "ดูเวลาอื่น" (`a=times`) + "เลือกช่วงอื่น" (การ์ดช่วงมี "เลือกวันอื่น" เพราะบอทจำไม่ได้ว่าลูกค้าพิมพ์ถึงวันไหน) → กันคิว → สิทธิ (`a=hr`, เฉพาะบริการที่ใช้สิทธิได้) → ชื่อ+เบอร์ → เคยมาไหม (`a=hv`, ถามเฉพาะเมื่อไม่พบ DN ถ้าพบถือว่าเคยมาแล้ว) → ส่งคำขอให้แอดมินยืนยัน ระหว่างกันคิวเก็บ `right`, `name`, `phone`, `dn`, `visit` ใน private ของคิวนั้น (`nextHoldStep` ดูว่าขาดอะไร) ลบ `name`/`phone`/`dn` เมื่อส่งคำขอแล้ว ลูกค้าพิมพ์คำตอบแทนการกดได้ทุกขั้น
- ทุกขั้นที่มีปุ่มใน flow จอง เลื่อน และยกเลิกนัด ส่งเป็นการ์ด Flex ปุ่มใหญ่ (`choiceCard`, วันแถวละ 2 เวลาแถวละ 3) ไม่มี quick reply ซ้ำ (เจ้าของสั่งเอาออก) ข้อความคำถามอยู่ในการ์ดและ `altText` ตรงตัวเดิม ปุ่มของคำตอบ FAQ และวันคุณหมอเข้ายังเป็น quick reply
- ถามคิวว่างรายวัน ("วันนี้มีคิวว่างไหม"): ถ้ารู้วันแต่ไม่รู้บริการ บอทแสดงเฉพาะบริการที่วันนั้นยังจองได้ ไม่บอกช่วงเวลาว่างรวม (เจ้าของสั่งเอาออก) ปุ่มพกวันที่ (`pd`) ไปจนถึงขั้นเลือกช่วง ถ้า Gemini ไม่ใส่ `date_text` อ่านวันจากข้อความลูกค้า
- เลื่อนนัด: ลูกค้าที่มีนัดจองผ่าน LINE เลือกวันเวลาใหม่เองได้ (postback มี `x` = id นัดเดิม) บอทสร้างนัดใหม่สีเทาที่มี private `replaces` คัดลอกชื่อจากนัดเดิม แอดมินยืนยันแล้วจึงลบนัดเดิม ปฏิเสธแล้วนัดเดิมยังอยู่ นัดที่ไม่ได้จองผ่าน LINE ยังส่งต่อแอดมิน
- ยกเลิกนัด: บอทถามย้ำก่อน ลูกค้ากดยกเลิกแล้วชื่อนัดขึ้นต้น `[ขอยกเลิก]` และ private `cancelRequested` (ไม่เตือนนัด ไม่ให้เลื่อน) แอดมินกด `a=cx` ลบนัดและแจ้งลูกค้า กด `a=ck` คืนชื่อเดิมโดยไม่แจ้งลูกค้า นัดที่ไม่ได้จองผ่าน LINE ส่งต่อแอดมิน

## Sheet

แถวแรกของแท็บ FAQ ต้องเป็น `category,question,answer,active` ตัวพิมพ์เล็กตามนี้ มิฉะนั้นจะขึ้น `sheet_empty` แท็บ `settings` ใช้ `key,value` (`bot_enabled`, `bot_mode`)

FAQ (`lib/faq-reply.ts`): ช่อง question ใส่ได้หลายแบบคั่นด้วย `/` Gemini คืน `faq_question` ของแถวที่ใช้ตอบ คำตอบที่เขียน**หลายบรรทัด**ส่งตรงตัวจาก Sheet (ลูกค้าพิมพ์ไทย) คำตอบบรรทัดเดียวให้ Gemini เรียบเรียง ข้อความ `พิมพ์ "…"` หรือ `พิมพ์คำว่า “…”` ในคำตอบกลายเป็นปุ่ม คำตอบที่มีปุ่มส่งเป็นการ์ดปุ่มใหญ่ (`faqCard`) บรรทัดที่จบด้วย พิมพ์ "…" พอดีย้ายไปเป็นปุ่มโดยใช้ข้อความหน้าคำว่าพิมพ์เป็นป้าย (เช่น `💰 ราคา พิมพ์ "ราคารากฟันเทียม"`) ข้อความ "นัด"/"จองคิว" ตามด้วยชื่อบริการหรือกลุ่มพอดีเข้าการจองบริการนั้นทันที (`namedBookingTarget`) ข้อความลูกค้าที่ตรงกับคำถามแบบใดแบบหนึ่งของแถวหลายบรรทัด ตอบเลยไม่ผ่าน Gemini คำตอบที่ยังมี `[…]` ไม่ส่งให้ลูกค้า เงียบและแจ้งแอดมินแทน

## Rules

- ห้ามใส่ราคา เวลา ที่อยู่ หรือชื่อทันตแพทย์ในโค้ด ข้อมูลเหล่านี้มาจาก Sheet เท่านั้น
- ห้ามข้าม signature verification และห้าม hardcode token
- ห้าม retry ด้วย reply token เดิม เพราะใช้ได้ครั้งเดียว
- ห้าม log ข้อความลูกค้า ชื่อ เบอร์ userId หรือ displayName ให้ log แค่ความยาวข้อความ intent confidence token และ error
- ข้อความลูกค้าส่งเข้ากลุ่มแอดมินได้ (เจ้าของอนุญาต ทั้งกลุ่ม LINE และ Telegram) แต่ห้ามใส่ userId
- ห้าม parse CSV เอง ให้ใช้ papaparse
- งบเวลาต่อข้อความคือ Sheet 3 วินาที + Gemini 7 วินาที อ่านปฏิทินเพื่อตอบคำถามไม่เกิน 3 วินาที
- ทางที่พังต้องจบที่ "เงียบ + แจ้งกลุ่มแอดมิน" ห้ามส่งข้อความขออภัยให้ลูกค้า
- เคสฉุกเฉินแจ้งกลุ่มแอดมินเสมอ แม้ `bot_enabled = FALSE` หรือ `bot_mode = shadow`
- ข้อความและลำดับใน flow จองคิวห้ามเปลี่ยนโดยเจ้าของไม่ได้สั่ง ต้องผ่าน regression 9 ขั้นใน `docs/test-conversations.md` ก่อน deploy
- บอทตอบเฉพาะแชตส่วนตัว ไม่ตอบในกลุ่ม
- `line-bot-recipe.md` และ `hsmile-line-bot-update-spec.md` ห้ามขึ้น repo เพราะ repo นี้เป็น public
- ยังไม่มีที่เก็บสถานะ (Upstash ฯลฯ) ห้ามเพิ่มจนกว่าเจ้าของอนุมัติ
