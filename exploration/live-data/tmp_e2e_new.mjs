// tmp: 신규 라이브 화면 4개 + POPULATION 교차표 검증 (읽기 전용)
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
    req.headers.cookie = "sme_session=" + encodeURIComponent(SESSION);
    return dataHandler(req, res);
  }
  if (u.pathname === "/api/auth") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ mb_id: "admin1", mb_name: "테스터", mb_level: 9 }));
  }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join("/Users/kwangseobpark/smeag-old-system-analysis/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4327, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
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
await waitTag(/Live|DB 최신/);
console.log("BOOT tag:", (await tag()).trim(), "| calls:", JSON.stringify(calls));

// MENU 에서 제목으로 항목을 찾아 curCat/curKey/curMenu 세팅 후 goMenu()
async function openByTitle(title) {
  const found = await page.evaluate(async (t) => {
    for (const cat of Object.keys(MENU)) {
      const i = MENU[cat].findIndex((m) => m.t === t);
      if (i >= 0) {
        curCat = cat; curMenu = MENU[cat][i]; curKey = curMenu.k;
        await goMenu();
        return { cat, u: curMenu.u, k: curMenu.k, cols: (curMenu.cols || []).length };
      }
    }
    return null;
  }, title);
  return found;
}

async function probe(title) {
  const before = calls.length;
  const errBefore = errs.length;
  const meta = await openByTitle(title);
  if (!meta) { console.log(`\n### ${title}: MENU 항목 없음`); return; }
  await waitTag(/Live|DB 최신|error|오류/, 60000);
  await page.waitForTimeout(800);
  const newCalls = calls.slice(before);
  const st = await page.evaluate((u) => {
    const t = (typeof REAL !== "undefined" && REAL && REAL.tables && REAL.tables[u]) || null;
    const tb = document.querySelectorAll("#main table.grid tbody tr");
    const th = [...document.querySelectorAll("#main table.grid thead th")].map((x) => x.textContent.trim());
    const sd = (typeof specData === "function") ? specData(u) : null;
    return {
      realTable: t ? { cols: t.cols, rows: t.rows.length, first: t.rows[0] } : null,
      specRows: sd ? sd.rows.length : 0, specCols: sd ? sd.cols : null,
      domRows: tb.length, domHead: th,
      domFirst: tb[0] ? [...tb[0].querySelectorAll("td")].map((c) => c.textContent.trim()) : null,
      truncated: (typeof LIVE !== "undefined" && LIVE.truncated) || null,
      parts: (typeof livePartsFor === "function") ? livePartsFor(curKey) : null,
      mainHead: (document.querySelector("#main .ph h1") || {}).textContent,
    };
  }, meta.u);
  console.log(`\n### ${title}  (u=${meta.u}, k=${meta.k}, cat=${meta.cat})`);
  console.log("  expected parts :", JSON.stringify(st.parts));
  console.log("  /api/data calls:", JSON.stringify(newCalls));
  console.log("  REAL.tables    :", st.realTable ? `rows=${st.realTable.rows} cols=${JSON.stringify(st.realTable.cols)}` : "NONE");
  console.log("  REAL first row :", JSON.stringify(st.realTable && st.realTable.first));
  console.log("  specData rows  :", st.specRows, "cols:", JSON.stringify(st.specCols));
  console.log("  DOM rows       :", st.domRows, "| head:", JSON.stringify(st.domHead));
  console.log("  DOM first row  :", JSON.stringify(st.domFirst));
  console.log("  truncated      :", JSON.stringify(st.truncated));
  console.log("  page errors    :", errs.length - errBefore, errs.slice(errBefore, errBefore + 3));
}

for (const t of ["회원관리", "COURSE LIST", "GAC BOARD", "VISIT (detail)"]) await probe(t);

// POPULATION / POPULATION2 교차표
for (const t of ["POPULATION", "POPULATION2"]) await probe(t);
const pop = await page.evaluate(() => {
  const a = specData("student_population.php"), b = specData("student_population2.php");
  const tot = (d) => d && d.rows[d.rows.length - 1];
  return { aCols: a && a.cols, aTot: tot(a), bTot: tot(b), aRows: a && a.rows.length, bRows: b && b.rows.length,
           aKOR: a && a.rows[0], bKOR: b && b.rows[0] };
});
console.log("\n### POPULATION 비교:", JSON.stringify(pop, null, 1));

console.log("\nALL page errors:", errs.length, errs.slice(0, 8));
await browser.close();
srv.close();
