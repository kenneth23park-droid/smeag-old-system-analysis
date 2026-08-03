// E2E: 전용화면 5종(회원관리·COMMISSION·COURSE LIST·TUITION FEE·ELEC&WATER) 검증
// 로컬 정적서버 + 실 /api/data 핸들러(실 Supabase) + Playwright.
// 확인: 조각 요청 매핑 · 표 행수 · 필터/페이지네이션 · 무데이터 폴백 없음 · pageerror 0
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "/Users/kwangseobpark/smeag-old-system-analysis/node_modules/playwright/index.mjs";

const ROOT = "/Users/kwangseobpark/smeag-old-system-analysis";
for (const line of fs.readFileSync(ROOT + "/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.AUTH_SESSION_SECRET = "local_test_secret";
const { default: dataHandler } = await import(ROOT + "/deploy/api/data.js");

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
    req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
    return dataHandler(req, res);
  }
  if (u.pathname === "/api/auth") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 }));
  }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4325, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4325/?pc=1", { waitUntil: "domcontentloaded" });

const tag = async () => (await page.textContent("#liveTag")) || "";
const waitTag = async (re, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(200); }
  return false;
};
await waitTag(/Live/, 120000);
await page.waitForTimeout(1500);
console.log("부팅 배지:", (await tag()).trim());

// 메뉴 이동 — 라벨은 EN 기본(mlabel). 해시 라우팅 대신 실제 클릭으로 연다.
async function openMenu(catLabel, menuText) {
  await page.click(`nav#cats .catwrap:has-text("${catLabel}") button.cat`, { timeout: 15000 });
  await page.click(`nav#cats .dropdown.open a:has-text("${menuText}")`, { timeout: 15000 });
}

const SCREENS = [
  { cat: "Member's", menu: "Members", key: "members", part: "members" },
  { cat: "Agency", menu: "COMMISSION", key: "commission", part: "commission" },
  { cat: "Financial", menu: "COURSE LIST", key: "courses", part: "courses" },
  { cat: "Financial", menu: "TUITION FEE", key: "tuition", part: "tuition" },
  { cat: "Dormitory", menu: "ELEC & WATER", key: "elec", part: "elec" },
];

for (const s of SCREENS) {
  const b = calls.length;
  const t0 = Date.now();
  try {
    await openMenu(s.cat, s.menu);
    await waitTag(/Live/, 60000);
    await page.waitForTimeout(800);
    const diag = await page.evaluate((k) => ({
      curKey,
      rows: document.querySelectorAll("#main table.grid tbody tr").length,
      tables: document.querySelectorAll("#main table.grid").length,
      chips: [...document.querySelectorAll("#main .chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()).slice(0, 6),
      h1: (document.querySelector("#main .ph h1") || {}).textContent || "",
      // 데이터 미로딩 안내카드로 폴백했는지(전용화면이 실데이터를 못 받은 신호)
      fallback: /불러오는 중|로그인|데이터가 없|not loaded|No data/i.test(
        (document.querySelector("#main .card.pad") || {}).textContent || ""),
      bad: (document.getElementById("main").innerText.match(/undefined|NaN|\[object Object\]/g) || []).length,
    }), s.key);
    console.log(`\n■ ${s.menu} (${Date.now() - t0}ms) key=${diag.curKey} 표=${diag.tables} 행=${diag.rows} 폴백=${diag.fallback} 이상문자열=${diag.bad}`);
    console.log("   요청:", JSON.stringify(calls.slice(b)));
    console.log("   칩:", diag.chips.join(" | "));
  } catch (e) {
    console.log(`\n■ ${s.menu}: 실패 ${e.message.slice(0, 140)}`);
  }
}

// 재진입 시 추가 호출 없어야(TTL 캐시)
const b2 = calls.length;
await openMenu("Financial", "COURSE LIST");
await page.waitForTimeout(1200);
console.log("\n재진입 추가호출(0 기대):", calls.length - b2);

// 응답 실측(직접 fetch)
console.log("\n응답 실측:", JSON.stringify(await page.evaluate(async () => {
  const out = {};
  for (const p of ["members", "commission", "courses", "tuition"]) {
    const t = Date.now();
    const r = await fetch("/api/data?parts=" + p, { cache: "no-store" });
    const j = await r.json();
    const v = j[p];
    out[p] = { ms: Date.now() - t, n: Array.isArray(v) ? v.length : (v && v.rows ? v.rows.length : null) };
  }
  const t = Date.now();
  const r = await fetch("/api/data?parts=elec", { cache: "no-store" });
  const j = await r.json();
  out.elec = { ms: Date.now() - t, n: j.elec && j.elec.rows && j.elec.rows.length,
    window: j.elec && j.elec.window, latest: j.elec && j.elec.latest, summary: j.elec && j.elec.summary };
  return out;
}, {}), null, 1));

await page.screenshot({ path: "/Users/kwangseobpark/smeag-old-system-analysis/exploration/shots/new_5screens.png" });
console.log("\nerrors:", errs.length ? errs.slice(0, 8) : "none");
await browser.close();
srv.close();
process.exit(0);   // pg 공유 커넥션이 살아 있어 자동 종료되지 않는다
