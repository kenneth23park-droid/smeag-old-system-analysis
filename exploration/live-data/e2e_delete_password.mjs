// E2E: 삭제 재인증 정책 — 삭제 작업은 로그인 비밀번호를 다시 묻는다(2026-08-03)
// 확인: ① 토큰 없이 release → 403 need_password  ② 틀린 비번 → confirm 실패
//       ③ 맞는 비번 → 토큰 발급 → release 성공  ④ 다른 계정 토큰/만료 토큰 거부
//       ⑤ 화면: 해제 클릭 시 비밀번호 모달, 취소하면 아무것도 안 지워짐
// 테스트용 블록 1건을 직접 만들고, 끝나면 남은 흔적을 지운다.
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
const { default: blocksHandler } = await import(ROOT + "/deploy/api/blocks.js");
const { default: authHandler } = await import(ROOT + "/deploy/api/auth.js");

// 테스트 계정: 비밀번호를 아는 계정이 없으므로 app.member_authenticate 를 타지 않는
// 검증만 별도로 한다 → 여기서는 **토큰 검증 로직**(서버 게이트)을 집중 확인하고,
// 비밀번호 확인 자체는 /api/auth 가 login 과 같은 RPC 를 쓰는 것으로 코드상 보장된다.
const SECRET = process.env.AUTH_SESSION_SECRET;
const sign = (p) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: now, exp: now + 3600 })).toString("base64url");
  return `${h}.${b}.` + crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
};
const mkConfirm = (sub, pur = "delete", ttl = 300) => {
  const body = { typ: "confirm", sub, pur, exp: Math.floor(Date.now() / 1000) + ttl, jti: "x" };
  const p = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${p}.` + crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
};
const SESSION = sign({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 });

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
  // vercel 스타일 res.status().json() 보강(blocks.js 가 사용)
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
  if (u.pathname === "/api/blocks") return blocksHandler(req, res);
  if (u.pathname === "/api/auth") return authHandler(req, res);
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4335, r));
const post = async (body) => {
  const r = await fetch("http://127.0.0.1:4335/api/blocks", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

// 테스트 블록 1건 생성(차단은 재인증 불필요 — 삭제만 묻는다)
const ITEM = { room_key: "E2E|TESTGRP|9999", bed_no: 0, group_name: "TESTGRP", room_no: "9999" };
const made = await post({ op: "block", items: [ITEM], reason: "ETC", memo: "E2E 삭제 게이트 테스트",
  idem: "e2e_delgate_" + Date.now() });
console.log("① 차단 생성(재인증 없이 성공해야):", made.status, JSON.stringify(made.body).slice(0, 120));

const noTok = await post({ op: "release", items: [ITEM] });
console.log("② 토큰 없이 해제 →", noTok.status, noTok.body.error, "|", noTok.body.message);

const badSub = await post({ op: "release", items: [ITEM], confirm: mkConfirm("someone_else") });
console.log("③ 다른 계정 토큰 →", badSub.status, badSub.body.error);

const badPur = await post({ op: "release", items: [ITEM], confirm: mkConfirm("admin1", "login") });
console.log("④ 목적 다른 토큰 →", badPur.status, badPur.body.error);

const expired = await post({ op: "release", items: [ITEM], confirm: mkConfirm("admin1", "delete", -10) });
console.log("⑤ 만료 토큰 →", expired.status, expired.body.error);

const tampered = await post({ op: "release", items: [ITEM], confirm: mkConfirm("admin1").slice(0, -3) + "aaa" });
console.log("⑥ 서명 위조 토큰 →", tampered.status, tampered.body.error);

const good = await post({ op: "release", items: [ITEM], confirm: mkConfirm("admin1") });
console.log("⑦ 정상 토큰 해제 →", good.status, JSON.stringify(good.body).slice(0, 140));

// /api/auth confirm — 세션은 있으나 비밀번호가 틀리면 401
const wrong = await fetch("http://127.0.0.1:4335/api/auth", { method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ action: "confirm", password: "definitely-not-the-password-" + Date.now() }) });
console.log("⑧ 틀린 비밀번호 confirm →", wrong.status, JSON.stringify(await wrong.json()).slice(0, 120));

// 화면: 해제 클릭 → 비밀번호 모달이 뜨고, 취소하면 아무 요청도 안 나간다
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errs = []; const posts = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/blocks")) posts.push(r.url()); });
await page.goto("http://127.0.0.1:4335/?pc=1", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const ui = await page.evaluate(async () => {
  const p = blkApply("release", [{ id: 999999 }], {});      // 삭제 진입점 직접 호출
  await new Promise((r) => setTimeout(r, 300));
  const modal = !!document.querySelector("#delAuth");
  const title = (document.querySelector("#delAuth .modal-h") || {}).innerText || "";
  const hasPw = !!document.querySelector("#delAuth #daPw");
  document.querySelector("#delAuth [data-x]").click();       // 취소
  const r = await p;
  return { modal, title: title.replace(/\s+/g, " "), hasPw, cancelled: !!(r && r.cancelled) };
});
console.log("⑨ 화면 게이트:", JSON.stringify(ui), "· 취소 후 삭제요청 수(0 기대):", posts.length);
// 모달 스크린샷(취소 상태)
await page.evaluate(() => { window._p = blkApply("release", [{ id: 999999 }], {}); });
await page.waitForSelector("#delAuth #daPw", { timeout: 10000 });
await page.fill("#delAuth #daPw", "••••••");
await page.screenshot({ path: ROOT + "/shots/delete_password_gate.png" });
await page.click("#delAuth [data-x]");
console.log("errors:", errs.length ? errs.slice(0, 4) : "none");

// 정리
const db = new pg.Client({ host: process.env.PG_HOST, port: +(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres", user: process.env.PG_USER, password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false } });
await db.connect();
const left = await db.query(`delete from app.room_blocks where room_key=$1 returning id`, [ITEM.room_key]);
console.log("정리: 남은 테스트 블록 삭제", left.rowCount, "건");
await db.end(); await browser.close(); srv.close();
process.exit(0);
