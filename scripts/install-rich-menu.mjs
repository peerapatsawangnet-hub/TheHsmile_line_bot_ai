// ใช้: LINE_CHANNEL_ACCESS_TOKEN=... node scripts/install-rich-menu.mjs path/to/rich-menu.jpg
// รูปต้องเป็น JPEG ขนาด 2500x1686 px และไม่เกิน 1 MB
import { readFile } from "node:fs/promises";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const imagePath = process.argv[2];
if (!token || !imagePath) {
  console.error("ต้องมี LINE_CHANNEL_ACCESS_TOKEN และ path ของรูป");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

async function call(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const image = await readFile(imagePath);
const menu = await readFile(new URL("../rich-menu.json", import.meta.url), "utf8");

const { richMenuId } = await call("https://api.line.me/v2/bot/richmenu", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: menu,
});
await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "image/jpeg" },
  body: image,
});
await call(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
  method: "POST",
  headers: auth,
});

console.log(`Rich menu installed: ${richMenuId}`);
