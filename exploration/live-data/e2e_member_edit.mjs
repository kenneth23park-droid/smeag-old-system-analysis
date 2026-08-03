// E2E: 회원정보 수정 저장(app.member_edits 오버레이) — 실 Supabase 쓰기 검증
// 확인: 폼 입력 가능 · 저장 → 오버레이 기록 · 재조회 시 덮인 값 · 멱등키 재요청 · 목록 반영 · 원본 불변
// 저장 대상은 테스트용 계정 1개(TARGET)이며, 끝나고 app.member_edits 행을 지워 원상복구한다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "/Users/kwangseobpark/smeag-old-system-analysis/node_modules/playwright/index.mjs";
import pg from "/Users/kwangseobpark/smeag-old-system-analysis/deploy/node_modules/pg/lib/index.js";

const ROOT = "/Users/kwangseobpark/smeag-old-system-analysis";
for (const line of fs.readFileSync(ROOT + "/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.AUTH_SESSION_SECRET = "local_test_secret";
const { default: dataHandler } = await import(ROOT + "/deploy/api/data.js");
const { default: editHandler } = await import(ROOT + "/deploy/api/edit.js");

const TARGET = "test77";                 // 레거시 테스트 계정
const NEWNICK = "test77_수정확인";

const db = new pg.Client({ host: process.env.PG_HOST, port: +(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres", user: process.env.PG_USER, password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000, statement_timeout: 60000 });
await db.connect();
const before = (await db.query(
  `select coalesce(mb_nick,'') nick, coalesce(mb_memo,'') memo, mb_level from cms.g4_member where mb_id=$1`, [TARGET])).rows[0];
console.log("원본(before):", JSON.stringify(before));
await db.query(`delete from app.member_edits where lower(mb_id)=lower($1)`, [TARGET]);

const sign = (p) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: now, exp: now + 3600 })).toString("base64url");
  const s = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${s}`;
};
const SESSION = sign({ mb_id: "admin1", mb_name: "테스터", mb_level: 9, source: "test" });

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
  if (u.pathname === "/api/data") return dataHandler(req, res);
  if (u.pathname === "/api/edit") return editHandler(req, res);
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
await new Promise((r) => srv.listen(4329, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4329/?pc=1", { waitUntil: "domcontentloaded" });
const waitLive = async (ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (/Live/.test((await page.textContent("#liveTag")) || "")) return; await page.waitForTimeout(200); }
};
await waitLive();
await page.waitForTimeout(1200);
await page.click(`nav#cats .catwrap:has-text("Member's") button.cat`);
await page.click(`nav#cats .dropdown.open a:has-text("Members")`);
await waitLive(60000);
await page.waitForTimeout(900);

// 검색 → ✎ → 폼
await page.fill("#mbQ", TARGET);
await page.click("#mbGo");
await page.waitForTimeout(400);
await page.click("#memBody .mlg-ico[data-edit]");
await page.waitForSelector("#memForm .mfm table", { timeout: 20000 });

console.log("■ 입력 가능:", await page.evaluate(() => {
  const i = document.querySelector('#memForm [data-col="mb_nick"]');
  return { readonly: i.readOnly, disabled: i.disabled, value: i.value };
}));

// 값 변경 → 저장
await page.fill('#memForm [data-col="mb_nick"]', NEWNICK);
await page.fill('#memForm [data-col="mb_memo"]', "E2E 저장 테스트 " + new Date().toISOString().slice(0, 10));
await page.click("#mfSave");
await page.waitForFunction(() => /저장|Saved|실패|failed/.test(document.querySelector("#mfMsg").textContent), { timeout: 30000 });
console.log("■ 저장 메시지:", await page.textContent("#mfMsg"));

// DB 확인 — 오버레이에 기록되고 원본은 그대로여야 한다
const ov = (await db.query(`select patch, updated_by from app.member_edits where lower(mb_id)=lower($1)`, [TARGET])).rows[0];
console.log("■ app.member_edits:", JSON.stringify(ov));
const after = (await db.query(
  `select coalesce(mb_nick,'') nick, coalesce(mb_memo,'') memo, mb_level from cms.g4_member where mb_id=$1`, [TARGET])).rows[0];
console.log("■ 원본(after):", JSON.stringify(after),
  "· 원본 불변:", JSON.stringify(before) === JSON.stringify(after));
const cl = (await db.query(
  `select target_table, target_pk, changed_cols from app.change_log
    where target_table='g4_member' order by id desc limit 1`)).rows[0];
console.log("■ change_log:", JSON.stringify(cl));

// 재조회 시 덮인 값이 나오는지 + 목록 반영
console.log("■ 재조회:", await page.evaluate(async (t) => {
  const j = await (await fetch("/api/data?member=" + t, { cache: "no-store" })).json();
  return { nick: j.member.nick, memo: j.member.memo, edited: j.member.edited, at: j.member.edited_at };
}, TARGET));

// 멱등키 재요청 — 같은 키는 최초 결과 재생(중복 저장 없음)
console.log("■ 멱등 재요청:", await page.evaluate(async (t) => {
  const body = { op: "member", id: t, patch: { mb_nick: "IDEM_TEST" }, idem: "e2e_fixed_key_1" };
  const a = await (await fetch("/api/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const b = await (await fetch("/api/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, patch: { mb_nick: "SHOULD_NOT_APPLY" } }) })).json();
  return { first: a.ok, firstPatch: a.patch, second: b.ok, replayed: JSON.stringify(a.patch) === JSON.stringify(b.patch) };
}, TARGET));

await page.screenshot({ path: ROOT + "/shots/members_edit_form.png" });

// 목록에서 권한·차단 변경 → [선택수정]
await page.click("#memForm .modal-x");
await page.waitForTimeout(300);
const lvBefore = (await db.query(`select mb_level from cms.g4_member where mb_id=$1`, [TARGET])).rows[0].mb_level;
await page.selectOption("#memBody .mbLv", "6");
await page.check("#memBody .mbBlk");
await page.click("#mbEditSel");
try {
  await page.waitForFunction(() => /저장|Saved|실패|failed|변경된/.test(document.querySelector("#mbSelCnt").textContent), { timeout: 30000 });
} catch (e) {
  console.log("!! 선택수정 대기 실패 · cnt=", await page.textContent("#mbSelCnt"),
    "· 버튼=", await page.textContent("#mbEditSel"), "· errs=", errs.slice(0, 4));
}
console.log("\n■ 선택수정 결과:", await page.textContent("#mbSelCnt"));
console.log("■ level_override:", JSON.stringify((await db.query(
  `select mb_level, active, updated_by from app.member_level_override where lower(mb_id)=lower($1)`, [TARGET])).rows[0]));
console.log("■ 차단 오버레이:", JSON.stringify((await db.query(
  `select patch->>'mb_intercept_date' blocked from app.member_edits where lower(mb_id)=lower($1)`, [TARGET])).rows[0]));
console.log("■ 원본 mb_level 불변:", (await db.query(`select mb_level from cms.g4_member where mb_id=$1`, [TARGET])).rows[0].mb_level === lvBefore);
await page.screenshot({ path: ROOT + "/shots/members_edit_list.png" });
await db.query(`delete from app.member_level_override where lower(mb_id)=lower($1)`, [TARGET]);

// 정리 — 테스트로 남긴 오버레이/감사행 제거(원본은 애초에 안 건드림)
await db.query(`delete from app.member_edits where lower(mb_id)=lower($1)`, [TARGET]);
await db.query(`delete from app.write_audit where idempotency_key='e2e_fixed_key_1'`);
await db.query(`delete from app.change_log where target_table='g4_member' and target_pk->>'mb_id'=$1`, [TARGET]);
console.log("■ 정리 완료 · errors:", errs.length ? errs.slice(0, 6) : "none");
await browser.close(); srv.close(); await db.end();
process.exit(0);
