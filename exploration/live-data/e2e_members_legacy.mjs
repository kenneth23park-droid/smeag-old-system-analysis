// E2E: 회원관리 레거시 재현(member_list.php 목록 + member_form.php 수정폼) 검증
// 로컬 정적서버 + 실 /api/data 핸들러(실 Supabase) + Playwright.
// 확인: 레거시 칸/순서 · 15행 페이지 · 검색 · ✎ 클릭 시 회원정보 수정 폼 · pageerror 0
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
await new Promise((r) => srv.listen(4327, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4327/?pc=1", { waitUntil: "domcontentloaded" });

const tag = async () => (await page.textContent("#liveTag")) || "";
const waitTag = async (re, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(200); }
  return false;
};
await waitTag(/Live/, 120000);
await page.waitForTimeout(1200);

await page.click(`nav#cats .catwrap:has-text("Member's") button.cat`);
await page.click(`nav#cats .dropdown.open a:has-text("Members")`);
await waitTag(/Live/, 60000);
await page.waitForTimeout(900);

const head = await page.evaluate(() => ({
  top: (document.querySelector(".mlg-top") || {}).innerText || "",
  cols: [...document.querySelectorAll("#memBody table.grid thead th")].map((t) => t.innerText.trim()),
  rows: document.querySelectorAll("#memBody table.grid tbody tr").length,
  firstRow: [...(document.querySelectorAll("#memBody table.grid tbody tr")[0] || { children: [] }).children]
    .map((td) => td.innerText.trim()),
  levelSelEditable: !(document.querySelector("#memBody .mlg-sel") || {}).disabled,
  blockChkEditable: !!(document.querySelector("#memBody td input.mbBlk:not([disabled])")),
  pager: (document.querySelector(".mlg-pager") || {}).innerText || "",
  note: (document.querySelector(".mlg-note") || {}).innerText || "",
}));
console.log("■ 목록 상단:", head.top.replace(/\s+/g, " "));
console.log("■ 칸:", head.cols.join(" | "));
console.log("■ 행수(15 기대):", head.rows, "· 권한select 입력가능:", head.levelSelEditable, "· 차단chk 입력가능:", head.blockChkEditable);
console.log("■ 첫 행:", head.firstRow.join(" | "));
console.log("■ 페이저:", head.pager.replace(/\s+/g, " "));

await page.screenshot({ path: ROOT + "/shots/members_legacy_list.png", fullPage: false });

// 2페이지 이동
await page.click('.mlg-pg[data-pg="1"]');
await page.waitForTimeout(300);
console.log("■ 2페이지 행수:", await page.evaluate(() => document.querySelectorAll("#memBody table.grid tbody tr").length));

// 검색(회원아이디 = kenneth)
await page.fill("#mbQ", "kenneth");
await page.click("#mbGo");
await page.waitForTimeout(400);
console.log("■ 검색 'kenneth' 결과:", await page.evaluate(() =>
  [...document.querySelectorAll("#memBody table.grid tbody tr")].map((tr) => tr.children[1].innerText.trim())));

await page.screenshot({ path: ROOT + "/shots/members_legacy_search.png", fullPage: false });

// ✎ 클릭 → 회원정보 수정 폼
await page.click("#memBody .mlg-ico[data-edit]");
await page.waitForSelector("#memForm .mfm table", { timeout: 20000 });
await page.waitForTimeout(400);
const form = await page.evaluate(() => ({
  title: (document.querySelector("#memForm .modal-h") || {}).innerText || "",
  labels: [...document.querySelectorAll("#memForm .mfm th")].map((t) => t.innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
  values: [...document.querySelectorAll("#memForm .mfm input[type=text]")].map((i) => i.value).slice(0, 6),
  editableAll: [...document.querySelectorAll("#memForm .mfm input[type=text]")].every((i) => !i.readOnly && !i.disabled),
  buttons: [...document.querySelectorAll("#memForm .mfm-foot button")].map((b) => b.innerText.trim() + (b.disabled ? "(disabled)" : "")),
  bad: (document.querySelector("#memForm").innerText.match(/undefined|NaN|\[object Object\]/g) || []).length,
}));
console.log("\n■ 수정폼 제목:", form.title.replace(/\s+/g, " "));
console.log("■ 수정폼 라벨:", form.labels.join(" | "));
console.log("■ 값 샘플:", JSON.stringify(form.values), "· 전부 입력가능:", form.editableAll);
console.log("■ 버튼:", form.buttons.join(" · "), "· 이상문자열:", form.bad);
await page.screenshot({ path: ROOT + "/shots/members_legacy_form.png", fullPage: false });

// CSS 적용 확인(계산 스타일)
console.log("\n■ 계산스타일:", JSON.stringify(await page.evaluate(() => ({
  styleTags: document.querySelectorAll("style").length,
  styleSizes: [...document.querySelectorAll("style")].map((s) => s.textContent.length),
  hasMlgText: [...document.querySelectorAll("style")].map((s) => s.textContent.includes(".mlg-top")),
  cssomRules: [...document.styleSheets].map((s) => { try { return s.cssRules.length; } catch (e) { return "x"; } }),
  hasMlgRule: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => (r.selectorText || "").includes(".mlg-top")); } catch (e) { return false; } }),
  lastRules: [...document.styleSheets[0].cssRules].slice(-6).map((r) => (r.selectorText || r.cssText || "").slice(0, 60)),
  mfmBody: getComputedStyle(document.querySelector("#memForm .modal-body")).display,
  mfmTh: getComputedStyle(document.querySelector("#memForm .mfm table th")).textAlign,
  mfmThBg: getComputedStyle(document.querySelector("#memForm .mfm table th")).backgroundColor,
}))));

console.log("\n요청:", JSON.stringify(calls.slice(-4)));
console.log("errors:", errs.length ? errs.slice(0, 8) : "none");
await browser.close();
srv.close();
process.exit(0);
