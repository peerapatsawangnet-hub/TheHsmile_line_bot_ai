import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDateText, parseMonthText, parsePeriod, parseTimeText } from "../lib/thai-datetime";

// วันอังคารที่ 3 พ.ย. 2569 เวลา 10:00 น.
const NOW = Date.parse("2026-11-03T10:00:00+07:00");

const dateCases: [string, string, boolean?][] = [
  ["12/10/69", "2026-10-12"],
  ["6/11/69", "2026-11-06"],
  ["6/11/2569", "2026-11-06"],
  ["ขอเลื่อนนะคะ วันที่ 6/11/69 มีคิวไหมคะ", "2026-11-06"],
  ["6/11", "2026-11-06"],
  ["1/11", "2027-11-01"],
  ["3 พย.", "2026-11-03"],
  ["6 พ.ย.", "2026-11-06"],
  ["1 ตค", "2027-10-01"],
  ["15 มีนาคม", "2027-03-15"],
  ["10 มี.ค.", "2027-03-10"],
  ["วันที่30", "2026-11-30"],
  ["วันที่ 2", "2026-12-02"],
  ["วันที่31", "2026-12-31"],
  ["วันที่..19.", "2026-11-19"],
  ["วันศุกร์20", "2026-11-20", false],
  ["วันจันทร์20", "2026-11-20", true],
  ["วันนี้", "2026-11-03"],
  ["พรุ่งนี้", "2026-11-04"],
  ["พรุ้งนี้", "2026-11-04"],
  ["มะรืน", "2026-11-05"],
  ["เสาร์นี้", "2026-11-07"],
  ["วันอังคาร", "2026-11-03"],
  ["อาทิตย์หน้า", "2026-11-15"],
  ["จันทร์หน้า", "2026-11-09"],
];

for (const [text, date, mismatch = false] of dateCases) {
  test(`date: ${text}`, () => {
    assert.deepEqual(parseDateText(text, NOW), { date, weekdayMismatch: mismatch });
  });
}

test("date: no date in text", () => {
  assert.equal(parseDateText("อยากขูดหินปูน", NOW), null);
  assert.equal(parseDateText("31/2/69", NOW), null);
});

const timeCases: [string, number | null][] = [
  ["บ่าย1", 13 * 60],
  ["บ่าย3", 15 * 60],
  ["บ่าย 1.30", 13 * 60 + 30],
  ["บ่ายโมง", 13 * 60],
  ["4 โมงเย็น", 16 * 60],
  ["10 โมง", 10 * 60],
  ["11 โมงเช้า", 11 * 60],
  ["11.45", 11 * 60 + 45],
  ["11.45 ค่ะ", 11 * 60 + 45],
  ["10:45 น.", 10 * 60 + 45],
  ["ช่วง15:00", 15 * 60],
  ["1 ทุ่ม", 19 * 60],
  ["เที่ยง", 12 * 60],
  ["20ได้จ้า", null],
  ["ช่วงเช้า", null],
  ["25:00", null],
];

for (const [text, minutes] of timeCases) {
  test(`time: ${text}`, () => {
    assert.equal(parseTimeText(text), minutes);
  });
}

test("period", () => {
  assert.equal(parsePeriod("เช้าจ้า"), "am");
  assert.equal(parsePeriod("ช่วงบ่ายค่ะ"), "pm");
  assert.equal(parsePeriod("ช่วง เย็น ดี กว่า จ๊ะ"), "eve");
  assert.equal(parsePeriod("10:45"), null);
});

test("month", () => {
  assert.deepEqual(parseMonthText(undefined, NOW), { year: 2026, month: 11 });
  assert.deepEqual(parseMonthText("เดือนหน้า", NOW), { year: 2026, month: 12 });
  assert.deepEqual(parseMonthText("ม.ค.", NOW), { year: 2027, month: 1 });
  assert.deepEqual(parseMonthText("ธันวา", NOW), { year: 2026, month: 12 });
});
