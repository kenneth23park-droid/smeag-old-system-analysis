// E2E: 로컬 정적서버(+실 /api/data 핸들러) → Playwright 로 메뉴 선택 시 DB 최신화 검증
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
  const now = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: now, exp: now + 3600 })).toString("base64url");
  const s = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${s}`;
};
const SESSION = sign({ mb_id: "admin1", mb_name: "테스터", mb_level: 9, source: "test" });
const calls = [];

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") {
    calls.push(u.search);
    req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);   // 테스트용 세션 주입
    return dataHandler(req, res);
  }
  if (u.pathname === "/api/auth") {   // 게이트 init() 이 서버세션을 확인 → enter() 로 진입
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 }));
  }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join("/Users/kwangseobpark/smeag-old-system-analysis/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4321, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.addInitScript(() => {
  window.__fetchLog = [];
  const of = window.fetch;
  window.fetch = function (u, o) { try { if (String(u).includes("/api/data")) window.__fetchLog.push(String(u) + " @@ " + (new Error().stack || "").split("\n").slice(1, 8).join(" | ")); } catch (e) {} return of.apply(this, arguments); };
});
await page.goto("http://127.0.0.1:4321/?pc=1", { waitUntil: "domcontentloaded" });

const tag = async () => (await page.textContent("#liveTag")) || "";
const waitTag = async (re, ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(200); }
  return false;
};
console.log("A) 부팅 직후 배지:", await tag());
console.log("A) 최신화 완료 대기:", await waitTag(/Live/), "→", await tag());
console.log("A) 호출:", JSON.stringify(calls));
console.log("A) 호출 스택:", (await page.evaluate(() => window.__fetchLog)).join("\n   "));

// 학생 표(수강등록관리)가 실데이터로 그려지는지
async function openMenu(catLabel, menuText) {
  await page.click(`nav#cats .catwrap:has-text("${catLabel}") button.cat`);
  await page.click(`nav#cats .dropdown.open a:has-text("${menuText}")`);
}
await openMenu("Student's", "Course Registration");
await waitTag(/Live/);
await page.waitForSelector("#stdBody table.grid tbody tr", { timeout: 20000 });
const info = await page.textContent(".pginfo").catch(() => "");
console.log("B) 수강등록관리:", info.replace(/\s+/g, " ").trim());
console.log("B) 첫행:", (await page.textContent("#stdBody tbody tr:first-child")).replace(/\s+/g, " ").slice(0, 120));

// 배치도(roomstat) — roomstat 조각 요청 확인
const before = calls.length;
await openMenu("Dormitory", "Dormitory Status (Batch)");
await waitTag(/Live/, 60000);
await page.waitForTimeout(3000);
console.log("C) 진단:", JSON.stringify(await page.evaluate(() => {
  const rs = (typeof REAL !== "undefined" && REAL && REAL.roomstat) || null;
  const g = (rs && rs.groups) || [];
  let html = "";
  try { html = R.roomstat(curMenu).slice(0, 200); } catch (e) { html = "ERR " + e.message; }
  return { rsKeys: rs ? Object.keys(rs) : null, rsFrom: rs && rs.from, rsMonth: rs && rs.month, live: JSON.stringify(LIVE.at) + "|" + LIVE.month, groups: g.length, rooms0: g[0] && g[0].rooms.length, name0: g[0] && g[0].name,
           per0: g[0] && g[0].rooms[0] && g[0].rooms[0].per, beds0: g[0] && g[0].rooms[0] && g[0].rooms[0].beds.length,
           mainHas: document.querySelectorAll("#main table.gantt").length,
           blocks: document.querySelectorAll("#main tbody.room-block").length,
           mainLen: document.getElementById("main").innerHTML.length, tail: document.getElementById("main").innerHTML.slice(-700) };
})));
console.log("C) 직접 fetch:", JSON.stringify(await page.evaluate(async () => {
  const r = await fetch("/api/data?parts=students,roomstat&month=2026-07", { cache: "no-store" });
  const j = await r.json();
  return { status: r.status, keys: Object.keys(j), groups: j.roomstat && j.roomstat.groups && j.roomstat.groups.length, err: j.detail };
})));
console.log("C) 배치도 신규 호출:", JSON.stringify(calls.slice(before)));
const names = await page.$$eval(".gantt .rs-name", (n) => n.length);
const rows = await page.$$eval(".gantt tbody.room-block", (n) => n.length);
console.log("C) 방 블록:", rows, "이름 있는 셀:", names);

// 같은 메뉴 재진입(TTL 캐시) → 추가 호출 없어야
const b2 = calls.length;
await openMenu("Student's", "Course Registration");
await page.waitForTimeout(1500);
console.log("D) 재진입 추가호출(0 기대):", calls.length - b2);

// 수동 새로고침(force) → 재조회
const b3 = calls.length;
await page.click("#liveBtn");
await waitTag(/Syncing|Live/);
await page.waitForTimeout(3000);
console.log("E) 수동 ⟳ 호출:", JSON.stringify(calls.slice(b3)), "배지:", await tag());

// 나머지 메뉴: 조각 매핑대로 요청하는지 + 표가 그려지는지
for (const [cat, menu] of [["Dormitory", "Weekly Pickup List"], ["Student's", "Group Students"], ["Student's", "DEPOSIT"], ["Dormitory", "BACK-UP LOG"]]) {
  const b = calls.length;
  try {
    await openMenu(cat, menu);
    await waitTag(/Live/, 40000);
    await page.waitForTimeout(600);
    console.log(`F) ${menu}:`, JSON.stringify(calls.slice(b)), "| 표행:", await page.$$eval("#main table.grid tbody tr", (n) => n.length),
      "| 첫행:", ((await page.textContent("#main table.grid tbody tr:first-child").catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 90));
  } catch (e) { console.log(`F) ${menu}: 실패 ${e.message.slice(0, 90)}`); }
}
await page.screenshot({ path: "/private/tmp/claude-501/-Users-kwangseobpark-smeag-old-system-analysis/3a54c4b2-3e6a-4fa1-812c-ad866938d9bb/scratchpad/live.png", fullPage: false });
console.log("errors:", errs.length ? errs.slice(0, 6) : "none");
await browser.close();
srv.close();
