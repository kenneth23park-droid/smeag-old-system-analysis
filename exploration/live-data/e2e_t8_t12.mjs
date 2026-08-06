// E2E: T8(미처리 학생 경고 패널) + T12(BACK-UP LOG 통합 감사로그 검색·페이징)
// 로컬 정적서버 + 실 /api/data(실 Supabase) + Playwright
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "/Users/kwangseobpark/smeag-old-system-analysis/node_modules/playwright/index.mjs";

const ROOT = "/Users/kwangseobpark/smeag-old-system-analysis";
for (const line of fs.readFileSync(ROOT + "/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
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
const httpErr = [];
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") {
    req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
    const end = res.end.bind(res);
    res.end = (...a) => { if (res.statusCode >= 500) httpErr.push(res.statusCode + " " + u.search); return end(...a); };
    return dataHandler(req, res);
  }
  if (u.pathname === "/api/auth") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 })); }
  if (u.pathname === "/api/blocks") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ blocks: [], actor: "test" })); }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4338, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });

const PASS = [], FAIL = [];
const chk = (n, ok, d) => { (ok ? PASS : FAIL).push(n + (d ? ` — ${d}` : "")); console.log((ok ? "PASS " : "FAIL ") + n + (d ? ` — ${d}` : "")); };
const tag = async () => (await page.textContent("#liveTag").catch(() => "")) || "";
const waitTag = async (re, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(300); } return false; };
const openMenu = async (cat, item) => {
  await page.click(`nav#cats .catwrap:has-text("${cat}") button.cat`);
  await page.click(`nav#cats .dropdown.open a:has-text("${item}")`);
};

await page.goto("http://localhost:4338/", { waitUntil: "networkidle" });
await waitTag(/Live/);

// ══════════ T8 미처리 학생 경고 패널 ══════════
await openMenu("Student's", "Course Registration");
await waitTag(/Live/, 180000);
await page.waitForSelector("#stdBody table.grid tbody tr", { timeout: 60000 });
await page.waitForTimeout(1200);

const t8a = await page.evaluate(() => {
  const sf = REAL && REAL.studentsFull;
  const rows = (sf && sf.rows) || [];
  return { cols: (sf && sf.cols && sf.cols.length) || 0, rows: rows.length,
    hasRoomTrue: rows.filter((r) => r[31] === true).length, hasInvTrue: rows.filter((r) => r[32] === true).length,
    sample: rows[0] ? [rows[0][31], rows[0][32]] : null };
});
chk("T8-1 studentsFull 33칸 + 판정칸 유입", t8a.cols === 33 && t8a.hasRoomTrue > 0 && t8a.hasInvTrue > 0,
  `cols=${t8a.cols} rows=${t8a.rows} HAS_ROOM=${t8a.hasRoomTrue} HAS_INVOICE=${t8a.hasInvTrue}`);

chk("T8-2 경고 패널 존재", await page.locator("#pendPanel").count() === 1, "");

const t8b = await page.evaluate(() => {
  const badges = document.querySelector("#pendBadges");
  return { badges: badges ? badges.textContent.replace(/\s+/g, " ").trim() : null,
    open: document.querySelector("#pendPanel").classList.contains("open") };
});
chk("T8-3 누락유형 건수 배지 렌더", !!t8b.badges && /\d/.test(t8b.badges), t8b.badges);

await page.click("#pendToggle");
await page.waitForTimeout(900);
const t8c = await page.evaluate(() => ({
  open: document.querySelector("#pendPanel").classList.contains("open"),
  rows: document.querySelectorAll("#pendBody table.grid tbody tr").length,
  head: [...document.querySelectorAll("#pendBody table.grid thead th")].map((t) => t.textContent.trim()),
}));
chk("T8-4 패널 펼침 + 행 렌더", t8c.open && t8c.rows > 0, `rows=${t8c.rows} head=${t8c.head.join("|")}`);

// 누락유형 필터 — 각 유형 건수가 실측 SQL 값과 맞는지
const counts = {};
for (const v of ["", "no_room", "no_invoice", "inv_no_room", "stale", "no_flight"]) {
  await page.selectOption("#fPendType", v).catch(() => {});
  await page.waitForTimeout(500);
  counts[v || "ALL"] = await page.evaluate(() => (typeof pendFiltered === "function" ? pendFiltered().length : -1));
}
console.log("   유형별 건수:", JSON.stringify(counts));
chk("T8-5 객실 미배정(배타) = 실측 717", Math.abs(counts.no_room - 717) <= 5, `${counts.no_room} (기대 717)`);
chk("T8-6 인보이스 미발행 = 실측 2,584", Math.abs(counts.no_invoice - 2584) <= 10, `${counts.no_invoice} (기대 2584)`);
chk("T8-7 인보이스有·객실무 = 실측 218", Math.abs(counts.inv_no_room - 218) <= 5, `${counts.inv_no_room} (기대 218)`);
chk("T8-8 항공 미등록(D0~D+30) = 실측 302", Math.abs(counts.no_flight - 302) <= 10, `${counts.no_flight} (기대 302)`);

await page.selectOption("#fPendType", "").catch(() => {});
await page.waitForTimeout(400);
const t8d = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("#fPendCampus option")].map((o) => o.value);
  return { campusOpts: cs, hasSparta: cs.some((c) => /SPARTA/i.test(c)) };
});
console.log("   캠퍼스 옵션:", JSON.stringify(t8d.campusOpts));

// ══════════ T12 BACK-UP LOG ══════════
await openMenu("Dormitory", "BACK-UP LOG");
await waitTag(/Live/, 180000);
await page.waitForTimeout(1500);

const t12a = await page.evaluate(() => ({
  ids: ["clFrom", "clTo", "clQ", "clSid", "clRoom", "clActor", "clType", "clCampus", "clGo", "clSize"].filter((i) => document.getElementById(i)).length,
  rows: document.querySelectorAll("#main table.grid tbody tr").length,
  actors: document.querySelector("#clActor") ? document.querySelector("#clActor").options.length : 0,
}));
chk("T12-1 검색 필터 10종 실제 존재", t12a.ids === 10, `${t12a.ids}/10, 행=${t12a.rows}`);
chk("T12-2 작업자 목록이 실데이터(하드코딩 5명 아님)", t12a.actors > 10, `옵션 ${t12a.actors}개`);

// 작업자 검색
const actor = await page.evaluate(() => { const s = document.querySelector("#clActor"); return s && s.options[1] ? s.options[1].value : ""; });
await page.selectOption("#clActor", actor).catch(() => {});
await page.click("#clGo"); await waitTag(/Live/, 120000); await page.waitForTimeout(1200);
const t12b = await page.evaluate(() => ({ rows: document.querySelectorAll("#main table.grid tbody tr").length,
  info: (document.body.innerText.match(/[\d,]+\s*건|총\s*[\d,+]+/g) || []).slice(0, 2) }));
chk("T12-3 작업자 검색 동작", t12b.rows > 0, `actor=${actor} rows=${t12b.rows}`);

// 2019년 과거 조회
await page.selectOption("#clActor", "").catch(() => {});
await page.fill("#clFrom", "2019-03-01"); await page.fill("#clTo", "2019-03-31");
await page.click("#clGo");
// 2019 구간은 pkey 역스캔이라 수 초 걸린다 — 고정 대기 대신 표에 2019 가 나타날 때까지 폴링
await page.waitForFunction(() => {
  const tr = document.querySelector("#main table.grid tbody tr");
  return !!tr && /2019/.test(tr.innerText);
}, null, { timeout: 180000 }).catch(() => {});
const t12c = await page.evaluate(() => {
  const tds = [...document.querySelectorAll("#main table.grid tbody tr")].slice(0, 5).map((tr) => tr.innerText.replace(/\s+/g, " ").slice(0, 90));
  return { rows: document.querySelectorAll("#main table.grid tbody tr").length, sample: tds };
});
chk("T12-4 2019년 과거 이력 조회(300건 상한 폐지)", t12c.rows > 0 && t12c.sample.some((s) => /2019/.test(s)), `rows=${t12c.rows} 첫행=${t12c.sample[0] || ""}`);

// XSS 페이로드 — 속성 탈출 없는지
await page.fill("#clFrom", ""); await page.fill("#clTo", "");
await page.fill("#clQ", '" onfocus=alert(1) autofocus x="');
await page.click("#clGo"); await waitTag(/Live/, 120000); await page.waitForTimeout(1200);
const t12d = await page.evaluate(() => ({
  onfocus: document.querySelectorAll("[onfocus]").length,
  autofocus: document.querySelectorAll("input[autofocus]").length,
  val: (document.querySelector("#clQ") || {}).value || "",
}));
chk("T12-5 속성 XSS 차단(escA)", t12d.onfocus === 0 && t12d.autofocus === 0, `onfocus=${t12d.onfocus} autofocus=${t12d.autofocus}`);

// QA 가 500 냈던 조합 — app 전용 유형 + 학생명/방/캠퍼스
await page.fill("#clQ", "KIM");
await page.selectOption("#clType", "WRITE").catch(() => {});
await page.click("#clGo"); await waitTag(/Live|오류|err/i, 120000); await page.waitForTimeout(1500);
await page.fill("#clQ", ""); await page.fill("#clRoom", "432");
await page.selectOption("#clType", "AUTH").catch(() => {});
await page.click("#clGo"); await waitTag(/Live|오류|err/i, 120000); await page.waitForTimeout(1500);
chk("T12-6 app유형+학생/방 조합에서 500 없음(D1 해소)", httpErr.length === 0, httpErr.slice(0, 2).join(" | ") || "5xx 0건");

// 페이징
// 앞 단계 필터 잔존을 없애고 깨끗한 상태에서 페이징만 본다
await page.click("#clReset").catch(() => {});
await page.waitForFunction(() => document.querySelectorAll("#main table.grid tbody tr").length > 1, null, { timeout: 120000 }).catch(() => {});
await page.selectOption("#clType", "AUTH").catch(() => {});
await page.selectOption("#clSize", "50").catch(() => {});
await page.click("#clGo");
await page.waitForFunction(() => document.querySelectorAll("#main table.grid tbody tr").length >= 50, null, { timeout: 120000 }).catch(() => {});
const p1 = await page.evaluate(() => [...document.querySelectorAll("#main table.grid tbody tr")].map((t) => t.innerText.slice(0, 40)));
const nextDis = await page.evaluate(() => { const b = document.querySelector("#clNext"); return b ? b.disabled : null; });
await page.click("#clNext").catch(() => {});
await page.waitForFunction((first) => {
  const tr = document.querySelector("#main table.grid tbody tr");
  return !!tr && tr.innerText.slice(0, 40) !== first;
}, p1[0], { timeout: 120000 }).catch(() => {});
const p2 = await page.evaluate(() => [...document.querySelectorAll("#main table.grid tbody tr")].map((t) => t.innerText.slice(0, 40)));
chk("T12-7 AUTH size=50 다음쪽 열림(D2 해소)", nextDis === false && p2.length > 0 && p2[0] !== p1[0], `next.disabled=${nextDis} p1=${p1.length} p2=${p2.length}`);

chk("T12-8 JS 에러 0", errs.length === 0, errs.slice(0, 3).join(" | ") || "none");

console.log(`\n=== PASS ${PASS.length} / FAIL ${FAIL.length} ===`);
if (FAIL.length) console.log("실패:\n" + FAIL.map((f) => " - " + f).join("\n"));
await browser.close(); srv.close();
process.exit(FAIL.length ? 1 : 0);
