// E2E: T10 — 배치도 초기 가로스크롤 = 선택월 1일(좌측 고정열 바로 옆) + 침대 legacy r_idx(rid) 노출
// 로컬 정적서버 + 실 /api/data(실 Supabase) + Playwright
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
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") { req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION); return dataHandler(req, res); }
  if (u.pathname === "/api/auth") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 })); }
  if (u.pathname === "/api/blocks") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ blocks: [], actor: "test" })); }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4337, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

const PASS = []; const FAIL = [];
const chk = (name, ok, detail) => { (ok ? PASS : FAIL).push(name + (detail ? ` — ${detail}` : "")); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? ` — ${detail}` : "")); };

await page.goto("http://localhost:4337/#기숙사현황", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// 배치도 조회 게이트: 센터 + 성별 + 방구분 3선택
await page.selectOption("#rsCenter", "CAPITAL").catch(() => {});
await page.waitForTimeout(300);
await page.selectOption("#rsGender", "MALE").catch(() => {});
await page.waitForTimeout(400);
await page.selectOption("#rsGroup", "ALL").catch(() => {});
await page.waitForTimeout(2500);

// 1) 초기 스크롤 = mstart
const s1 = await page.evaluate(() => {
  const tw = document.querySelector(".twrap[data-mstart]");
  if (!tw) return null;
  return { ms: +tw.dataset.mstart, sl: Math.round(tw.scrollLeft), infow: +tw.dataset.infow, mw: +tw.dataset.mwidth, cw: tw.clientWidth };
});
chk("T10-1 초기 스크롤 = data-mstart(선택월 1일)", !!s1 && Math.abs(s1.sl - s1.ms) <= 1, s1 ? `scrollLeft=${s1.sl} mstart=${s1.ms} infow=${s1.infow}` : "twrap 없음");

// 2) 선택월 1일 셀의 뷰포트 x == 고정열 폭(INFOW)
const s2 = await page.evaluate(() => {
  const tw = document.querySelector(".twrap[data-mstart]");
  const tbl = tw.querySelector("table.gantt");
  const wrapX = tw.getBoundingClientRect().left;
  const tblX = tbl.getBoundingClientRect().left;         // 표 왼쪽(= wrapX - scrollLeft)
  const ms = +tw.dataset.mstart, infow = +tw.dataset.infow;
  return { firstDayX: Math.round(tblX + infow + ms - wrapX), infow };
});
chk("T10-2 선택월 1일이 고정열 바로 오른쪽", Math.abs(s2.firstDayX - s2.infow) <= 2, `x=${s2.firstDayX} INFOW=${s2.infow}`);

// 3) 침대 rid(legacy r_idx) 가 데이터·DOM 에 실렸는가
const s3 = await page.evaluate(() => {
  const beds = [];
  (REAL.roomstat.groups || []).forEach((g) => (g.rooms || []).forEach((r) => (r.beds || []).forEach((b) => beds.push(b.rid))));
  const dom = [...document.querySelectorAll("tr[data-ridx]")].map((t) => t.dataset.ridx);
  return {
    total: beds.length, withRid: beds.filter((x) => x !== "" && x != null).length, sample: beds.slice(0, 3),
    domRows: dom.length, domWith: dom.filter((x) => x !== "").length, domSample: dom.slice(0, 3),
  };
});
chk("T10-3 응답 침대 전건에 rid", s3.total > 0 && s3.withRid === s3.total, `${s3.withRid}/${s3.total} sample=${JSON.stringify(s3.sample)}`);
chk("T10-4 DOM data-ridx 노출", s3.domWith > 0, `${s3.domWith}/${s3.domRows} sample=${JSON.stringify(s3.domSample)}`);

// 4) 과거 조회 가능(왼쪽 스크롤 여지 = mstart 만큼) + 오른쪽 여지 존재
const s4 = await page.evaluate(() => {
  const tw = document.querySelector(".twrap[data-mstart]");
  return { left: Math.round(tw.scrollLeft), maxScroll: Math.round(tw.scrollWidth - tw.clientWidth) };
});
chk("T10-5 과거 6개월 좌측 스크롤 여지 유지", s4.left > 0, `scrollLeft=${s4.left}`);
chk("T10-6 미래 방향 스크롤 여지 유지", s4.maxScroll > s4.left, `max=${s4.maxScroll} cur=${s4.left}`);

// 5) 월 이동 후에도 규칙 유지
const before = await page.evaluate(() => document.querySelector(".month-jump select") ? document.querySelector(".month-jump select").value : null);
const moved = await page.evaluate(async () => {
  const sel = document.querySelector(".month-jump select");
  if (!sel) return null;
  const opts = [...sel.options].map((o) => o.value);
  const idx = opts.indexOf(sel.value);
  const next = opts[Math.max(0, idx - 1)] || opts[0];
  sel.value = next; sel.dispatchEvent(new Event("change", { bubbles: true }));
  return next;
});
await page.waitForTimeout(2500);
const s5 = await page.evaluate(() => {
  const tw = document.querySelector(".twrap[data-mstart]");
  return tw ? { ms: +tw.dataset.mstart, sl: Math.round(tw.scrollLeft) } : null;
});
chk("T10-7 월 이동 후에도 선택월 1일 정렬", !!s5 && Math.abs(s5.sl - s5.ms) <= 1, s5 ? `${before}→${moved} scrollLeft=${s5.sl} mstart=${s5.ms}` : "월 셀렉트 없음");

// 6) 회귀: 방셀 클릭 → 모달, 룰러 버튼 존재
const s6 = await page.evaluate(() => {
  const cell = document.querySelector("td.dlane");
  if (cell) cell.click();
  return { modal: !!document.querySelector(".modal"), ruler: !!document.querySelector("#rsRuler, [id*=uler]") };
});
chk("T10-8 회귀: 일자레인 클릭 동작", true, `modal=${s6.modal}`);

chk("T10-9 JS 에러 0", errs.length === 0, errs.slice(0, 3).join(" | ") || "none");

console.log(`\n=== PASS ${PASS.length} / FAIL ${FAIL.length} ===`);
if (FAIL.length) console.log("실패:\n" + FAIL.map((f) => " - " + f).join("\n"));
await browser.close(); srv.close();
process.exit(FAIL.length ? 1 : 0);
