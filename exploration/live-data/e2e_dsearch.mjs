// E2E: DORM SEARCH(room_search2.php) — 레거시 검색폼 재현 + CLASSIC 필터 제외 검증
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
const calls = [];
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") { calls.push(u.search); req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION); return dataHandler(req, res); }
  if (u.pathname === "/api/auth") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 })); }
  if (u.pathname === "/api/blocks") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ blocks: [], actor: "test" })); }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4331, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://127.0.0.1:4331/?pc=1", { waitUntil: "domcontentloaded" });
const tag = async () => (await page.textContent("#liveTag")) || "";
const waitTag = async (re, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await tag())) return true; await page.waitForTimeout(200); } return false; };
await waitTag(/Live/);
await page.waitForTimeout(800);

await page.click(`nav#cats .catwrap:has-text("Dormitory") button.cat`);
await page.click(`nav#cats .dropdown.open a:has-text("DORM SEARCH")`);
await waitTag(/Live/, 90000);
await page.waitForTimeout(1500);

const form = await page.evaluate(() => ({
  key: curKey,
  h1: (document.querySelector("#main .ph h1") || {}).textContent,
  fields: [...document.querySelectorAll("#main .filters .field label")].map((l) => l.textContent.trim()).filter((t) => t !== ""),
  centers: [...document.querySelectorAll("#dsCenter option")].map((o) => o.value),
  per: [...document.querySelectorAll("#dsPer option")].map((o) => o.value),
  sex: [...document.querySelectorAll("#dsSex option")].map((o) => o.value),
  from: document.querySelector("#dsFrom").value, to: document.querySelector("#dsTo").value,
  window: (REAL.roomstat || {}).from + "~" + (REAL.roomstat || {}).to,
}));
console.log("폼:", JSON.stringify(form, null, 1));

// 1) 기본 검색(4주, MALE, 센터 전체)
await page.fill("#dsFrom", "2026-08-06");
await page.fill("#dsWeeks", "4");
await page.dispatchEvent("#dsWeeks", "input");
await page.click("#dsGo");
await page.waitForTimeout(600);
const r1 = await page.evaluate(() => ({
  to: document.querySelector("#dsTo").value,
  head: [...document.querySelectorAll("#dsBody table.grid thead th")].map((t) => t.textContent),
  rows: document.querySelectorAll("#dsBody table.grid tbody tr").length,
  count: document.querySelector("#dsCount").textContent.replace(/\s+/g, " ").trim(),
  first3: [...document.querySelectorAll("#dsBody table.grid tbody tr")].slice(0, 3).map((tr) => [...tr.children].map((td) => td.textContent).join(" | ")),
  centers: [...new Set([...document.querySelectorAll("#dsBody table.grid tbody tr")].map((tr) => tr.children[5].textContent))],
  sexes: [...new Set([...document.querySelectorAll("#dsBody table.grid tbody tr")].map((tr) => tr.children[4].textContent))],
}));
console.log("\n■ 검색1(2026-08-06 +4주 / MALE / 센터전체):", JSON.stringify(r1, null, 1));

// 2) 센터=ENCANTO + 4인실 + FEMALE
await page.selectOption("#dsCenter", "ENCANTO");
await page.selectOption("#dsPer", "4");
await page.selectOption("#dsSex", "F");
await page.waitForTimeout(400);
const r2 = await page.evaluate(() => ({
  rows: document.querySelectorAll("#dsBody table.grid tbody tr").length,
  count: document.querySelector("#dsCount").textContent.replace(/\s+/g, " ").trim(),
  centers: [...new Set([...document.querySelectorAll("#dsBody table.grid tbody tr")].map((tr) => tr.children[5].textContent))],
  pers: [...new Set([...document.querySelectorAll("#dsBody table.grid tbody tr")].map((tr) => tr.children[3].textContent))],
  sexes: [...new Set([...document.querySelectorAll("#dsBody table.grid tbody tr")].map((tr) => tr.children[4].textContent))],
  first3: [...document.querySelectorAll("#dsBody table.grid tbody tr")].slice(0, 3).map((tr) => [...tr.children].map((td) => td.textContent).join(" | ")),
}));
console.log("\n■ 검색2(ENCANTO / 4인실 / FEMALE):", JSON.stringify(r2, null, 1));

// 3) 점유 교차검증 — 결과에 나온 침대가 정말 그 기간에 비어 있는가(roomstat 세그먼트 직접 재계산)
const cross = await page.evaluate(() => {
  const f = dsState.from, t = dsState.to;
  const set = new Set(dsState.rows.map((r) => r[0] + "|" + r[1] + "|" + r[2]));
  let bad = 0, checked = 0, missed = 0;
  (REAL.roomstat.groups || []).forEach((g) => {
    const cat = (g.name || "").split("/")[0].trim();
    (g.rooms || []).forEach((r) => (r.beds || []).forEach((bed, bi) => {
      const key = cat + "|" + r.no + "|" + (bi + 1);
      const busy = (bed.segs || []).some((s) => !(s.e < f || s.s > t));
      if (set.has(key)) { checked++; if (busy) bad++; }
      else if (!busy && dsState.center === "" && dsState.per === "" ) missed++;
    }));
  });
  return { period: f + "~" + t, listed: set.size, checkedFree: checked, wronglyListedBusy: bad };
});
console.log("\n■ 교차검증:", JSON.stringify(cross));

// 4) CLASSIC 이 어디에도 없어야
const classic = await page.evaluate(() => ({
  inFilter: [...document.querySelectorAll("#dsCenter option")].some((o) => /CLASSIC/i.test(o.textContent)),
  inRows: dsState.rows.some((r) => /CLASSIC/i.test(r[5] + " " + r[0])),
}));
console.log("CLASSIC 노출:", JSON.stringify(classic));

// 5) 기간 역전 방어
await page.fill("#dsTo", "2026-07-01");
await page.click("#dsGo");
await page.waitForTimeout(300);
console.log("역전기간 안내:", (await page.textContent("#dsBody")).replace(/\s+/g, " ").trim().slice(0, 80));

await page.screenshot({ path: ROOT + "/exploration/shots/dorm_search.png", fullPage: false });
console.log("\nerrors:", errs.length ? errs.slice(0, 8) : "none");
await browser.close(); srv.close(); process.exit(0);
