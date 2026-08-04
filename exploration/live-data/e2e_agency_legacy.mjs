// E2E: AGENCY LIST 레거시 재현(uhak_agency_list.php 목록 + 유학원 관리 수정 폼) 검증
// 로컬 정적서버 + 실 /api/data·/api/edit 핸들러(실 Supabase) + Playwright.
// 확인: 레거시 칸/순서 · 15행 페이지 · 검색 · ✎ → 유학원 관리 수정 폼 · 저장(오버레이) · pageerror 0
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
const { default: editHandler } = await import(ROOT + "/deploy/api/edit.js");

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
  req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
  if (u.pathname === "/api/data") { calls.push(u.search); return dataHandler(req, res); }
  if (u.pathname === "/api/edit") { calls.push("EDIT"); return editHandler(req, res); }
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
await new Promise((r) => srv.listen(4331, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4331/?pc=1", { waitUntil: "domcontentloaded" });

const tag = async () => (await page.textContent("#liveTag")) || "";
const waitTag = async (re, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(200); }
  return false;
};
await waitTag(/Live|DB 최신/, 120000);
await page.waitForTimeout(1000);

await page.click(`nav#cats .catwrap:has-text("Agency") button.cat`);
await page.click(`nav#cats .dropdown.open a:has-text("AGENCY LIST")`);
await waitTag(/Live|DB 최신/, 90000);
await page.waitForTimeout(1200);

const head = await page.evaluate(() => ({
  top: (document.querySelector(".mlg-top") || {}).innerText || "",
  cols: [...document.querySelectorAll("#agBody table.grid thead th")].map((t) => t.innerText.trim()),
  rows: document.querySelectorAll("#agBody table.grid tbody tr").length,
  firstRows: [...document.querySelectorAll("#agBody table.grid tbody tr")].slice(0, 5)
    .map((tr) => [...tr.children].map((td) => td.innerText.replace(/\s+/g, " ").trim()).join(" | ")),
  pager: (document.querySelector(".mlg-pager") || {}).innerText || "",
}));
console.log("■ 목록 상단:", head.top.replace(/\s+/g, " "));
console.log("■ 칸:", head.cols.join(" | "));
console.log("■ 행수(15 기대):", head.rows);
head.firstRows.forEach((r, i) => console.log("  " + (i + 1) + ") " + r));
console.log("■ 페이저:", head.pager.replace(/\s+/g, " "));
await page.screenshot({ path: ROOT + "/shots/agency_legacy_list.png" });

// 2페이지
await page.click('.mlg-pg[data-pg="1"]');
await page.waitForTimeout(300);
console.log("■ 2페이지 행수:", await page.evaluate(() => document.querySelectorAll("#agBody table.grid tbody tr").length));

// 검색(AGENCY NAME = blue ocean)
await page.selectOption("#agBy", "name");
await page.fill("#agQ", "blue ocean");
await page.click("#agGo");
await page.waitForTimeout(400);
console.log("■ 검색 'blue ocean':", await page.evaluate(() =>
  [...document.querySelectorAll("#agBody table.grid tbody tr")].map((tr) => tr.children[2].innerText.trim() + "/" + tr.children[3].innerText.trim())));
await page.screenshot({ path: ROOT + "/shots/agency_legacy_search.png" });

// ✎ → 유학원 관리 수정 폼
await page.click("#agBody .mlg-ico[data-edit]");
await page.waitForSelector("#agForm .mfm table", { timeout: 20000 });
await page.waitForTimeout(400);
const form = await page.evaluate(() => ({
  title: (document.querySelector("#agForm .modal-h") || {}).innerText || "",
  labels: [...document.querySelectorAll("#agForm .mfm th")].map((t) => t.innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
  values: Object.fromEntries([...document.querySelectorAll("#agForm .mfm [data-col]")].map((i) => [i.dataset.col, i.value])),
  editable: [...document.querySelectorAll("#agForm .mfm input[type=text]")].every((i) => !i.readOnly && !i.disabled),
  buttons: [...document.querySelectorAll("#agForm .mfm-foot button")].map((b) => b.innerText.trim() + (b.disabled ? "(disabled)" : "")),
  bad: (document.querySelector("#agForm").innerText.match(/undefined|NaN|\[object Object\]/g) || []).length,
}));
console.log("\n■ 수정폼 제목:", form.title.replace(/\s+/g, " "));
console.log("■ 라벨:", form.labels.join(" | "));
console.log("■ 값:", JSON.stringify(form.values));
console.log("■ 입력가능:", form.editable, "· 버튼:", form.buttons.join(" · "), "· 이상문자열:", form.bad);
await page.screenshot({ path: ROOT + "/shots/agency_legacy_form.png" });

// 저장 검증 — 담당자명(mb_2)에 표식을 넣고 저장 → 목록 반영 확인 → 원복 저장
const before = form.values.mb_2 || "";
const probe = "E2E-" + Date.now().toString().slice(-6);
await page.fill('#agForm [data-col="mb_2"]', probe);
await page.click("#afSave");
await page.waitForTimeout(2500);
console.log("■ 저장 메시지:", await page.textContent("#afMsg"));
await page.click("#afX");
await page.waitForTimeout(600);
console.log("■ 목록 CONSULTANT 반영:", await page.evaluate(() =>
  [...document.querySelectorAll("#agBody table.grid tbody tr")].map((tr) => tr.children[9].innerText.trim())));

// 원복
await page.click("#agBody .mlg-ico[data-edit]");
await page.waitForSelector("#agForm .mfm table", { timeout: 20000 });
await page.waitForTimeout(500);
await page.fill('#agForm [data-col="mb_2"]', before);
await page.click("#afSave");
await page.waitForTimeout(2500);
console.log("■ 원복 메시지:", await page.textContent("#afMsg"), "· 되돌린 값:", JSON.stringify(before));

// 원본 불변 확인(cms.g4_member 는 그대로여야 한다)
const pg = (await import(ROOT + "/deploy/node_modules/pg/lib/index.js")).default;
const c = new pg.Client({ host: process.env.PG_HOST, port: +(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres", user: process.env.PG_USER, password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select mb_id, mb_2 from cms.g4_member where mb_2 like 'E2E-%'`);
console.log("■ 레거시 원본에 E2E 흔적(0이어야 함):", r.rowCount);
const ov = await c.query(`select mb_id, patch->>'mb_2' v, updated_at from app.member_edits order by updated_at desc limit 2`);
console.log("■ 오버레이 최근:", JSON.stringify(ov.rows));
await c.end();

console.log("\n요청:", JSON.stringify(calls.slice(-5)));
console.log("errors:", errs.length ? errs.slice(0, 8) : "none");
await browser.close();
srv.close();
process.exit(0);
