// 인가 매트릭스 검증 — 주체(비로그인/일반회원/유학원/유학원미확정/관리자) × 조각
// 읽기 전용. 테스트용 세션 쿠키는 로컬 시크릿으로 위조해 핸들러에 직접 주입한다.
import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = "/Users/kwangseobpark/smeag-old-system-analysis";
for (const l of fs.readFileSync(ROOT + "/.env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.AUTH_SESSION_SECRET = "local_test_secret";
const { default: data } = await import(ROOT + "/deploy/api/data.js");
const { default: blocks } = await import(ROOT + "/deploy/api/blocks.js");

const sign = (p) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const n = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: n, exp: n + 3600 })).toString("base64url");
  return `${h}.${b}.` + crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET).update(`${h}.${b}`).digest("base64url");
};
const SUBJECTS = {
  "비로그인": null,
  "Lv1 일반회원": { mb_id: "someuser", mb_level: 1 },
  "Lv3 유학원(확정)": { mb_id: "blued", mb_level: 3 },
  "Lv3 유학원(미확정)": { mb_id: "no_such_agency_zzz", mb_level: 3 },
  "Lv9 관리자": { mb_id: "admin1", mb_level: 9 },
};
function res0() {
  const r = { statusCode: 200, headers: {}, body: "" };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b || ""; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = JSON.stringify(o); return r; };
  return r;
}
async function callData(subj, qs) {
  const req = { method: "GET", url: "/api/data" + qs, headers: {} };
  if (subj) req.headers.cookie = "sme_session=" + encodeURIComponent(sign(subj));
  const res = res0();
  await data(req, res);
  let j = {}; try { j = JSON.parse(res.body || "{}"); } catch { /* 304 */ }
  return { code: res.statusCode, j };
}
async function callBlocks(subj, method) {
  const req = { method, url: "/api/blocks", headers: {}, body: { op: "release", items: [{ room_key: "ZZ|TEST|000", bed_no: 0 }] } };
  if (subj) req.headers.cookie = "sme_session=" + encodeURIComponent(sign(subj));
  const res = res0();
  await blocks(req, res);
  let j = {}; try { j = JSON.parse(res.body || "{}"); } catch { /* noop */ }
  return { code: res.statusCode, err: j.error || "", n: Array.isArray(j.blocks) ? j.blocks.length : (j.released ?? "") };
}

const PARTS = ["members", "boards", "dayoff", "elec", "commission", "students", "farmgym", "agencyvisit", "courses"];
console.log("=== /api/data 인가 매트릭스 (code · 반환행수 · denied)");
console.log("주체".padEnd(20) + PARTS.map((p) => p.slice(0, 9).padStart(11)).join(""));
for (const [name, subj] of Object.entries(SUBJECTS)) {
  const cells = [];
  for (const p of PARTS) {
    const { code, j } = await callData(subj, "?parts=" + p);
    let n = "-";
    if (code === 200) {
      if (j.studentsFull) n = j.studentsFull.rows.length;
      else if (j.tables) n = Object.values(j.tables).reduce((a, t) => a + t.rows.length, 0);
      else n = 0;
      if (j.denied && j.denied.length) n = "denied";
    }
    cells.push(`${code}/${n}`.padStart(11));
  }
  console.log(name.padEnd(20) + cells.join(""));
}
console.log("\n=== /api/blocks");
for (const [name, subj] of Object.entries(SUBJECTS)) {
  const g = await callBlocks(subj, "GET");
  const p = await callBlocks(subj, "POST");
  console.log(`  ${name.padEnd(20)} GET ${g.code}${g.err ? "(" + g.err + ")" : " n=" + g.n}   POST ${p.code}${p.err ? "(" + p.err + ")" : " ok"}`);
}
console.log("\n=== 마스킹 확인(관리자, agencyvisit d_text · dayoff purpose · boards 제목)");
{
  const { j } = await callData(SUBJECTS["Lv9 관리자"], "?parts=agencyvisit,dayoff,boards");
  const t = j.tables || {};
  const av = (t["uhak_agency_visit.php"] || { rows: [] }).rows;
  const do_ = (t["scheduler_index(-all).php"] || { rows: [] }).rows;
  const bd = (t["bbs/board.php?bo_table=office_GAC"] || { rows: [] }).rows;
  const hitPhone = av.filter((r) => /\*\*\*/.test(String(r[6] || ""))).length;
  console.log("  agencyvisit 행", av.length, "· 마스킹 흔적 포함 행", hitPhone, "· 예시:", JSON.stringify(String(av[0] && av[0][6] || "").slice(0, 70)));
  console.log("  dayoff 행", do_.length, "· 사유 예시:", JSON.stringify(String(do_[0] && do_[0][9] || "").slice(0, 60)));
  console.log("  boards secret 제목:", JSON.stringify(bd.filter((r) => String(r[1]).startsWith("[secret]")).slice(0, 2).map((r) => r[1])));
}
console.log("\n=== 스탬프에 신규 테이블 반영");
{
  const a = await callData(SUBJECTS["Lv9 관리자"], "?stamp=1&parts=boards,members,elec");
  console.log("  stamp keys:", Object.keys(a.j.stamp || {}).join(","));
  const t = Date.now();
  await callData(SUBJECTS["Lv9 관리자"], "?stamp=1&parts=boards,members,elec,dayoff,visits,points,commission,courses,tuition,agencyvisit");
  console.log("  전체 조각 stamp 소요:", Date.now() - t, "ms");
}
process.exit(0);
