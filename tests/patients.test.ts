import assert from "node:assert/strict";
import { test } from "node:test";
import { findDn, firstName, matchDn, parsePatients, phonesIn } from "../lib/patients";

const rows = [
  ["No", "DN", "Name", "Phone NO.", "Status", "Last Visit", "Appoint Day", "มาล่าสุด", "หมายเหตุ"],
  ["1", "670001", "สมชาย ใจดี", "081-234-5678", "", "", "", "", ""],
  ["2", "670002", "นางสาวสมหญิง รักดี", "812223333", "", "", "", "", ""],
  ["3", "670003", "แม่ มาดี", "0890000000 / 0891111111", "", "", "", "", ""],
  ["4", "670004", "ลูก มาดี", "0890000000", "", "", "", "", ""],
  ["5", "", "ไม่มี DN", "0899999999", "", "", "", "", ""],
  ["6", "670006", "ไม่มีเบอร์", "", "", "", "", "", ""],
];

test("phonesIn handles dashes, lost leading zero, and several numbers", () => {
  assert.deepEqual(phonesIn("081-234-5678"), ["0812345678"]);
  assert.deepEqual(phonesIn("812223333"), ["0812223333"]);
  assert.deepEqual(phonesIn("0890000000 / 0891111111"), ["0890000000", "0891111111"]);
  assert.deepEqual(phonesIn("ไม่มี"), []);
});

test("firstName drops titles", () => {
  assert.equal(firstName("นางสาวสมหญิง รักดี"), "สมหญิง");
  assert.equal(firstName("คุณ สมชาย ใจดี"), "สมชาย");
  assert.equal(firstName("Mr. John Smith"), "john");
  assert.equal(firstName("​มาร์ค​ สุดหล่อ"), "มาร์ค");
});

test("parsePatients reads by header name and skips rows without DN or phone", () => {
  const patients = parsePatients(rows);
  assert.deepEqual(patients.map((p) => p.dn), ["670001", "670002", "670003", "670004"]);
  assert.throws(() => parsePatients([["No", "Name"]]), /patients_header_missing/);
});

test("parsePatients finds the header under a title row and tolerates spelling", () => {
  const titled = [["คนไข้จัดฟัน 2025"], [], ["No", "DN ", "name", "Phone No"], ["1", "670009", "ทดสอบ หัวตาราง", "0811111111"]];
  assert.deepEqual(parsePatients(titled).map((p) => p.dn), ["670009"]);
  const thai = [["HN", "ชื่อ", "เบอร์โทร"], ["670010", "ทดสอบ ไทย", "0822222222"]];
  assert.deepEqual(parsePatients(thai).map((p) => p.dn), ["670010"]);
});

test("matchDn needs both phone and first name", () => {
  const patients = parsePatients(rows);
  assert.equal(matchDn(patients, "สมชาย ใจดี", "0812345678"), "670001");
  assert.equal(matchDn(patients, "สมหญิง", "0812223333"), "670002");
  // same phone, different family members
  assert.equal(matchDn(patients, "ลูก มาดี", "0890000000"), "670004");
  assert.equal(matchDn(patients, "แม่ มาดี", "0891111111"), "670003");
  // right phone, someone else's name: never guess
  assert.equal(matchDn(patients, "พ่อ มาดี", "0890000000"), null);
  assert.equal(matchDn(patients, "สมชาย ใจดี", "0800000000"), null);
  assert.equal(matchDn(patients, "", "0812345678"), null);
});

test("findDn never throws: not configured or sheet unreachable -> null", async () => {
  delete process.env.PATIENTS_SHEET_ID;
  assert.equal(await findDn("สมชาย ใจดี", "0812345678"), null);
  // no service account key: the read fails, booking must still go on
  process.env.PATIENTS_SHEET_ID = "sheet";
  delete process.env.GOOGLE_PRIVATE_KEY;
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal(await findDn("สมชาย ใจดี", "0812345678"), null);
  } finally {
    console.error = original;
    delete process.env.PATIENTS_SHEET_ID;
  }
  assert.ok(errors.some((line) => line.includes('"tag":"patient_lookup_failed"')));
  assert.ok(errors.every((line) => !line.includes("0812345678") && !line.includes("สมชาย")));
});
