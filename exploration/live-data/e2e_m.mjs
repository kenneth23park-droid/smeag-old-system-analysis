// 모바일(/m) E2E: 탭·메뉴 이동 시 DB 최신화 후 렌더되는지
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "/Users/kwangseobpark/smeag-old-system-analysis/node_modules/playwright/index.mjs";

for (const line of fs.readFileSync("/Users/kwangseobpark/smeag-old-system-analysis/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.AUTH_SESSION_SECRET = "local_test_secret";
const { default: dataHandler } = await import("/Users/kwangseobpark/smeag-old-system-analysis/deploy/api/data.js");
const sign = (p) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const n = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: n, exp: n + 3600 })).toString("base64url");
  return `${h}.${b}.` + crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET).update(`${h}.${b}`).digest("base64url");
};
const SESSION = sign({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 });
const calls = [];
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") { calls.push(u.search); req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION); return dataHandler(req, res); }
  const file = u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname;
  const p = path.join("/Users/kwangseobpark/smeag-old-system-analysis/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4322, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, isMobile: true, hasTouch: true });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4322/m/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log("A) 홈 진입 호출:", JSON.stringify(calls));
console.log("A) ⟳ 버튼 title:", await page.getAttribute("#mvLiveBtn", "title"));
console.log("A) 본문 길이:", (await page.$eval("#mvMain", (e) => e.innerHTML.length)));

const tabs = await page.$$eval(".mv-tab", (n) => n.map((x) => x.dataset.tab));
console.log("B) 탭:", tabs.join(","));
for (const t of tabs.filter((x) => x !== "more")) {
  const b = calls.length;
  await page.click(`.mv-tab[data-tab="${t}"]`);
  await page.waitForTimeout(4000);
  const title = await page.textContent("#mvTitle");
  const len = await page.$eval("#mvMain", (e) => e.innerHTML.length);
  const rows = await page.$$eval("#mvMain tr, #mvMain .mvl-row, #mvMain .mv-card", (n) => n.length);
  console.log(`B) 탭 ${t} → ${title} | 호출 ${JSON.stringify(calls.slice(b))} | html ${len} | 행/카드 ${rows}`);
}
// 실데이터 반영 확인
console.log("C) REAL 상태:", JSON.stringify(await page.evaluate(() => ({
  students: window.REAL && REAL.studentsFull && REAL.studentsFull.rows.length,
  roomstatGroups: window.REAL && REAL.roomstat && REAL.roomstat.groups.length,
  pickup: window.REAL && REAL.pickup && REAL.pickup.rows.length,
  live: JSON.stringify(MVLIVE.at),
}))));
console.log("errors:", errs.length ? errs.slice(0, 5) : "none");
await browser.close();
srv.close();
