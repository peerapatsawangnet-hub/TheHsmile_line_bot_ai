// ติดตั้ง Rich Menu ไทยและอังกฤษ ไทยเป็นเมนูเริ่มต้นของทุกคน อังกฤษผูกรายคนเมื่อลูกค้าพิมพ์/กด "English"
// ใช้ (PowerShell): $env:LINE_CHANNEL_ACCESS_TOKEN = "..."; node scripts/install-rich-menu.mjs
// รูป: rich-menu-th.jpg และ rich-menu-en.jpg (JPEG หรือ PNG 2500x1686 px ไม่เกิน 1 MB)
// รันซ้ำได้: ลบเมนูชื่อเดิมที่สร้างจากสคริปต์นี้ก่อน ลูกค้าที่เลือกภาษาอังกฤษไว้ต้องกด "English" ใหม่หลังรันซ้ำ
import { readFile } from "node:fs/promises";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error("ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN ก่อน");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };
const root = new URL("../", import.meta.url);

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...init.headers } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  const body = await res.text();
  return body ? JSON.parse(body) : {};
}

async function image(name) {
  for (const ext of ["jpg", "jpeg", "png"]) {
    try {
      const data = await readFile(new URL(`${name}.${ext}`, root));
      if (data.length > 1024 * 1024) throw new Error(`${name}.${ext} ใหญ่เกิน 1 MB`);
      return { data, type: ext === "png" ? "image/png" : "image/jpeg" };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`ไม่พบรูป ${name}.jpg หรือ ${name}.png`);
}

async function install(definitionFile, imageName) {
  const definition = JSON.parse(await readFile(new URL(definitionFile, root), "utf8"));
  const { richmenus } = await call("https://api.line.me/v2/bot/richmenu/list");
  for (const old of richmenus.filter(({ name }) => name === definition.name)) {
    await call(`https://api.line.me/v2/bot/richmenu/${old.richMenuId}`, { method: "DELETE" });
  }
  const { richMenuId } = await call("https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(definition),
  });
  const { data, type } = await image(imageName);
  await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: data,
  });
  console.log(`${definition.name}: ${richMenuId}`);
  return richMenuId;
}

const th = await install("rich-menu.json", "rich-menu-th");
await install("rich-menu-en.json", "rich-menu-en");
await call(`https://api.line.me/v2/bot/user/all/richmenu/${th}`, { method: "POST" });
console.log("ตั้งเมนูไทยเป็นเมนูเริ่มต้นแล้ว");
