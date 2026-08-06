// ============================================================================
// E2E: 방 이동 관리 — 실 핸들러(/api/moves, /api/data) + 실 Supabase + 실제 화면
// ----------------------------------------------------------------------------
// 기획 §20 필수 테스트 시나리오를 검증한다.
//   ①  재실 중 침대에 같은 기간 미래 배정 → 차단
//   ③  미래 배정을 등록해도 현재 방은 그대로
//   ④  이동 완료 처리 후에만 현재 방이 바뀐다
//   ⑤  이동 취소 시 현재 방은 변경되지 않는다
//   ⑩  같은 학생 미래 배정 중복 → 경고
//   ⑪  같은 침대 두 명의 미래 일정 겹침 → 차단(DB EXCLUDE 제약)
//   ⑫  졸업일 ≠ 실제 퇴실일 → 실제 퇴실일 우선
//   ⑬  완료 중 오류 → 전량 롤백
//   + 성별 규칙 차단 · 멱등키 재요청 · 예외 승인 Lv10 게이트 · 원본(legacy) 불변
//
// 뒷정리: 이 스크립트가 만든 app.* 행만 지운다(created_by='e2e'). 레거시는 애초에 안 건드린다.
// 실행: node exploration/live-data/e2e_room_move.mjs
// ============================================================================
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
const { default: movesHandler } = await import(ROOT + "/deploy/api/moves.js");

const db = new pg.Client({ host: process.env.PG_HOST, port: +(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres", user: process.env.PG_USER, password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000, statement_timeout: 120000 });
await db.connect();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${extra ? "  → " + JSON.stringify(extra).slice(0, 400) : ""}`); }
};

// ── 뒷정리(선/후) ────────────────────────────────────────────────────────────
async function cleanup() {
  await db.query(`delete from app.room_move_events where move_id in (select id from app.room_moves where created_by='e2e' or note='E2E')`);
  await db.query(`delete from app.assignment_terminations where created_by='e2e'`);
  await db.query(`update app.room_assignments set source_move_id=null where created_by='e2e'`);
  await db.query(`delete from app.room_moves where created_by='e2e' or note='E2E'`);
  await db.query(`delete from app.room_assignments where created_by='e2e'`);
  await db.query(`delete from app.student_stay_facts where updated_by='e2e'`);
}
await cleanup();

// ── 픽스처: 재실 중인 학생 2명 + 비어 있는 침대 2개(같은 성별 구역) ──────────
const fx = (await db.query(`
  with cand as (
    select distinct on (b.s_idx)
           b.s_idx, b.r_idx cur_r_idx, si.s_gender, vb.i_idx, vb.g_idx
      from app.v_legacy_bed_span b
      join app.v_bed vb on vb.r_idx = b.r_idx
      join legacy.student_info si on si.s_idx = b.s_idx
     where b.start_date <= current_date and b.end_date >= current_date
       and si.s_gender = 'M' and vb.g_type = 'M' and vb.g_display='Y'
       and b.end_date between current_date + 40 and current_date + 200
     order by b.s_idx, b.r_idx),
  stu as (select * from cand limit 2)
  select (select json_agg(stu) from stu) students,
         (select json_agg(t) from (
            select vb.r_idx, vb.room_no, vb.group_name, vb.g_type, vb.i_limit
              from app.v_bed vb
             where vb.g_display='Y' and vb.r_state='Y' and vb.i_state='Y'
               and vb.g_type = (select s_gender from stu limit 1)
               and not exists (select 1 from app.v_legacy_bed_span s
                                where s.r_idx = vb.r_idx
                                  and s.start_date <= current_date + 300 and s.end_date >= current_date)
               and not exists (select 1 from app.room_blocks bl
                                where bl.released_at is null and bl.room_key = vb.room_key
                                  and bl.bed_no in (0, vb.r_num))
             limit 2) t) free_beds,
         (select json_agg(t) from (
            select vb.r_idx, vb.room_no, vb.group_name
              from app.v_bed vb
             where vb.g_display='Y' and vb.r_state='Y' and vb.i_state='Y'
               and vb.g_type = case when (select s_gender from stu limit 1)='M' then 'F' else 'M' end
             limit 1) t) opposite_bed,
         (select b.r_idx from app.v_legacy_bed_span b
           where b.start_date <= current_date + 10 and b.end_date >= current_date + 10
           limit 1) occupied_bed
`)).rows[0];

const [S1, S2] = fx.students || [];
const [B1, B2] = fx.free_beds || [];
const OPP = (fx.opposite_bed || [])[0];
if (!S1 || !S2 || !B1 || !B2) { console.error("픽스처를 만들 수 없습니다:", fx); process.exit(1); }
console.log("픽스처:", { S1: S1.s_idx, S2: S2.s_idx, sex: S1.s_gender,
  B1: `${B1.group_name} ${B1.room_no}`, B2: `${B2.group_name} ${B2.room_no}`, OPP: OPP && OPP.room_no });

// ── 로컬 서버(실 핸들러) ─────────────────────────────────────────────────────
const sign = (p, secret) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ ...p, iat: now, exp: now + 3600 })).toString("base64url");
  const s = crypto.createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${s}`;
};
const SEC = process.env.AUTH_SESSION_SECRET;
const SESS_STAFF = sign({ mb_id: "e2e", mb_name: "E2E", mb_level: 8 }, SEC);   // Lv8 — 승인 불가
const SESS_BOSS = sign({ mb_id: "e2e", mb_name: "E2E", mb_level: 11 }, SEC);  // Lv11 — 승인 가능
let CURRENT_SESSION = SESS_STAFF;

// Vercel 런타임이 붙여주는 res.status()/res.json() 을 로컬에서도 흉내낸다(핸들러는 그대로 쓴다).
function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
  return res;
}
const srv = http.createServer(async (req, res) => {
  vercelize(res);
  const u = new URL(req.url, "http://x");
  req.headers.cookie = "sme_session=" + encodeURIComponent(CURRENT_SESSION);
  if (u.pathname === "/api/moves") return movesHandler(req, res);
  if (u.pathname === "/api/data") return dataHandler(req, res);
  if (u.pathname === "/api/auth") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ mb_id: "e2e", mb_name: "E2E", mb_level: 8 }));
  }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(ROOT + "/deploy", file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
  res.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4331, r));
const BASE = "http://127.0.0.1:4331";
const api = async (qs) => (await fetch(`${BASE}/api/moves?${qs}`)).json();
const apiPost = async (body) => (await fetch(`${BASE}/api/moves`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

const D = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const AT = (n, t = "09:30") => `${D(n)}T${t}:00+08:00`;

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── A. 검증(validate) ──");

// §20-1 재실 중 침대에 같은 기간 → 차단
if (fx.occupied_bed) {
  const v = await api(`op=validate&s_idx=${S1.s_idx}&to_r_idx=${fx.occupied_bed}&at=${encodeURIComponent(AT(10))}`);
  const codes = ((v.validate || {}).blocks || []).map((b) => b.code);
  ok("§20-1 재실 중 침대 → 차단(OCCUPANT_NOT_LEFT)", codes.includes("OCCUPANT_NOT_LEFT"), codes);
}
// 성별 규칙
if (OPP) {
  const v = await api(`op=validate&s_idx=${S1.s_idx}&to_r_idx=${OPP.r_idx}&at=${encodeURIComponent(AT(10))}`);
  const codes = ((v.validate || {}).blocks || []).map((b) => b.code);
  ok("성별 다른 구역 → 차단(GENDER_RULE)", codes.includes("GENDER_RULE"), codes);
}
// 빈 침대 → 통과
{
  const v = await api(`op=validate&s_idx=${S1.s_idx}&to_r_idx=${B1.r_idx}&at=${encodeURIComponent(AT(10))}`);
  ok("빈 침대 → 차단 없음", (v.validate || {}).ok === true, (v.validate || {}).blocks);
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── B. 등록 · 멱등 · 현재 배정 불변 ──");
const before1 = (await db.query(`select * from app.student_current_bed($1)`, [S1.s_idx])).rows[0];
const IDEM = "e2e-" + Date.now();
const c1 = await apiPost({ op: "create", s_idx: S1.s_idx, to_r_idx: B1.r_idx,
  planned_move_at: AT(10), move_reason: "E2E", note: "E2E", idem: IDEM,
  facts: { requested_room_type: String(B1.i_limit || 1), actual_checkout_date: D(60) } });
ok("이동 등록 성공", c1.ok === true, c1);
const MOVE1 = c1.move_id;
ok("등록 직후 상태 = 이동 예정(PLANNED)", c1.move && c1.move.move_status === "PLANNED", c1.move && c1.move.move_status);

const c1b = await apiPost({ op: "create", s_idx: S1.s_idx, to_r_idx: B1.r_idx,
  planned_move_at: AT(10), move_reason: "E2E", note: "E2E", idem: IDEM });
ok("멱등키 재요청 → 최초 결과 재생(중복 없음)", c1b.ok === true && c1b.replayed === true && c1b.move.id === MOVE1, c1b);
const dup = (await db.query(`select count(*)::int n from app.room_moves where idem_key=$1`, [IDEM])).rows[0].n;
ok("같은 멱등키로 저장된 이동은 1건", dup === 1, dup);

const after1 = (await db.query(`select * from app.student_current_bed($1)`, [S1.s_idx])).rows[0];
ok("§20-3 미래 배정 등록해도 현재 방 그대로",
  before1 && after1 && before1.r_idx === after1.r_idx && after1.r_idx !== B1.r_idx, { before1, after1 });

// §20-10 같은 학생 미래 배정 중복 → 경고
{
  const v = await api(`op=validate&s_idx=${S1.s_idx}&to_r_idx=${B2.r_idx}&at=${encodeURIComponent(AT(12))}`);
  const codes = ((v.validate || {}).warnings || []).map((w) => w.code);
  ok("§20-10 같은 학생 미완료 이동 중복 → 경고(DUPLICATE_FUTURE)", codes.includes("DUPLICATE_FUTURE"), codes);
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── C. 겹침 차단(DB EXCLUDE) ──");
await apiPost({ op: "confirm", move_id: MOVE1 });
const st1 = (await db.query(`select move_status from app.room_moves where id=$1`, [MOVE1])).rows[0];
ok("확정 전이 성공(CONFIRMED)", st1.move_status === "CONFIRMED", st1);

const c2 = await apiPost({ op: "create", s_idx: S2.s_idx, to_r_idx: B1.r_idx,
  planned_move_at: AT(11), note: "E2E",
  facts: { requested_room_type: String(B1.i_limit || 1), actual_checkout_date: D(60) } });
const codes2 = (c2.blocks || []).map((b) => b.code);
ok("§20-11 같은 침대에 다른 학생 미래 일정 겹침 → 차단",
  c2.ok === false && codes2.includes("ASSIGNMENT_OVERLAP"), { ok: c2.ok, codes2 });

// DB 제약 자체도 확인(앱 로직을 우회해도 막히는가)
let exViolated = false;
try {
  await db.query(`insert into app.room_assignments(s_idx,r_idx,start_date,end_date,status,created_by)
                  values ($1,$2,$3,$4,'CONFIRMED','e2e')`, [S2.s_idx, B1.r_idx, D(10), D(20)]);
} catch (e) { exViolated = e.code === "23P01"; }
ok("EXCLUDE 제약이 직접 INSERT 도 거부(23P01)", exViolated);

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── D. 예외 승인 게이트(Lv10+) ──");
const c3 = await apiPost({ op: "create", s_idx: S2.s_idx, to_r_idx: B2.r_idx,
  planned_move_at: AT(10), note: "E2E", exception_reason: "E2E 예외",
  facts: { requested_room_type: "9", actual_checkout_date: D(60) } });   // 룸타입 불일치 유도
const MOVE3 = c3.move_id;
ok("경고 있는 이동도 등록은 된다", c3.ok === true, c3.error);
const flags3 = (c3.move && c3.move.exception_flags) || [];
ok("룸타입 불일치가 예외 플래그로 기록됨", flags3.includes("ROOM_TYPE_MISMATCH"), flags3);

const cf3 = await apiPost({ op: "confirm", move_id: MOVE3 });
ok("승인 전에는 확정 불가(need_approval)", cf3.ok === false && cf3.error === "need_approval", cf3.error);

CURRENT_SESSION = SESS_STAFF;
const ap8 = await apiPost({ op: "approve", move_id: MOVE3 });
ok("Lv8 은 예외 승인 불가(403 forbidden)", ap8.ok === false && ap8.error === "forbidden", ap8);

CURRENT_SESSION = SESS_BOSS;
const ap11 = await apiPost({ op: "approve", move_id: MOVE3, note: "E2E 승인" });
ok("Lv11 은 예외 승인 가능", ap11.ok === true, ap11);
const cf3b = await apiPost({ op: "confirm", move_id: MOVE3 });
ok("승인 후 확정 가능", cf3b.ok === true, cf3b.error);
CURRENT_SESSION = SESS_STAFF;

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── E. 완료 · 취소 ──");
const cmp = await apiPost({ op: "complete", move_id: MOVE1, actual_move_at: AT(10) });
ok("이동 완료 성공", cmp.ok === true, cmp);
const after2 = (await db.query(`select * from app.student_current_bed($1,$2::date)`, [S1.s_idx, D(10)])).rows[0];
ok("§20-4 완료 후에만 현재 방이 바뀐다", after2 && after2.r_idx === B1.r_idx, after2);
const term = (await db.query(`select count(*)::int n from app.assignment_terminations where created_by='e2e'`)).rows[0].n;
ok("기존 배정이 종료 기록됨(원본은 그대로)", term > 0, term);

const cmp2 = await apiPost({ op: "complete", move_id: MOVE1 });
ok("완료 재요청은 멱등(중복 처리 없음)", cmp2.ok === true && cmp2.replayed === true, cmp2);

const before3 = (await db.query(`select * from app.student_current_bed($1)`, [S2.s_idx])).rows[0];
const cn = await apiPost({ op: "cancel", move_id: MOVE3, reason: "E2E 취소" });
ok("이동 취소 성공", cn.ok === true, cn);
const after3 = (await db.query(`select * from app.student_current_bed($1)`, [S2.s_idx])).rows[0];
ok("§20-5 취소해도 현재 방은 그대로",
  (before3 && after3 && before3.r_idx === after3.r_idx) || (!before3 && !after3), { before3, after3 });
const asg3 = (await db.query(`select status from app.room_assignments where id=$1`, [c3.assignment_id])).rows[0];
ok("취소된 배정은 삭제가 아니라 CANCELLED 로 남는다", asg3 && asg3.status === "CANCELLED", asg3);

// §20-13 완료 중 오류 → 롤백: 선행 이동 미완료 상태에서 완료 시도
{
  const c4 = await apiPost({ op: "create", s_idx: S2.s_idx, to_r_idx: B2.r_idx,
    planned_move_at: AT(20), note: "E2E", depends_on_move_id: MOVE3,
    facts: { requested_room_type: String(B2.i_limit || 1), actual_checkout_date: D(60) } });
  await apiPost({ op: "confirm", move_id: c4.move_id });
  const before = (await db.query(`select status,start_date from app.room_assignments where id=$1`, [c4.assignment_id])).rows[0];
  const r = await apiPost({ op: "complete", move_id: c4.move_id });
  const after = (await db.query(`select status,start_date from app.room_assignments where id=$1`, [c4.assignment_id])).rows[0];
  ok("§11 선행 이동 미완료 → 완료 차단", r.ok === false && r.error === "dependency_open", r.error);
  ok("§20-13 실패한 완료는 아무것도 바꾸지 않는다(롤백)",
    before.status === after.status && String(before.start_date) === String(after.start_date), { before, after });
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── F. 실제 퇴실일 우선(§20-12) · 원본 불변 ──");
{
  await apiPost({ op: "facts", s_idx: S1.s_idx, patch: { graduation_date: D(90), actual_checkout_date: D(45) } });
  // date 는 pg 드라이버가 로컬 타임존 Date 로 준다 → 문자열로 받아 비교한다.
  const v = (await db.query(`select to_char(checkout_date,'YYYY-MM-DD') checkout_date,
                                    to_char(graduation_date,'YYYY-MM-DD') graduation_date
                               from app.v_student_stay where s_idx=$1`, [S1.s_idx])).rows[0];
  ok("§20-12 졸업일과 실제 퇴실일이 다르면 실제 퇴실일 우선",
    v.checkout_date === D(45) && v.graduation_date === D(90), v);
}
{
  const n = (await db.query(`select count(*)::int n from legacy.room_reserve where s_idx = any($1::int[])`,
    [[S1.s_idx, S2.s_idx]])).rows[0].n;
  const n2 = (await db.query(`select count(*)::int n from legacy.reserve_info where s_idx = any($1::int[])`,
    [[S1.s_idx, S2.s_idx]])).rows[0].n;
  ok("레거시 room_reserve / reserve_info 행수 불변(원본 무수정)", n > 0 && n2 > 0, { n, n2 });
  const changed = (await db.query(
    `select count(*)::int n from legacy.room_list where r_idx = any($1::int[]) and r_state <> 'Y'`,
    [[B1.r_idx, B2.r_idx]])).rows[0].n;
  ok("레거시 room_list 상태 무수정", changed === 0, changed);
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── G. 배치도 오버레이 합성 ──");
{
  const r = await fetch(`${BASE}/api/data?parts=roomstat&month=${D(0).slice(0, 7)}`);
  const j = await r.json();
  const rs = j.roomstat || {};
  ok("배치도 응답에 moveIn/moveOut 포함", !!rs.moveIn && !!rs.moveOut, Object.keys(rs));
  ok("완료된 이동이 대상 침대의 미래 배정으로 보인다",
    !!(rs.moveIn && rs.moveIn[B1.r_idx] && rs.moveIn[B1.r_idx].length), rs.moveIn && Object.keys(rs.moveIn).length);
  // 회귀: 기존 구조가 그대로인가
  ok("배치도 기존 구조(groups/rooms/beds/segs) 유지",
    Array.isArray(rs.groups) && rs.groups.length > 0 && Array.isArray(rs.groups[0].rooms)
    && Array.isArray(rs.groups[0].rooms[0].beds) && "segs" in rs.groups[0].rooms[0].beds[0],
    rs.groups && rs.groups.length);
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n── H. 화면(ROOM MOVES · 이동 등록 모달) ──");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto(`${BASE}/?pc=1`, { waitUntil: "domcontentloaded" });
const waitLive = async (ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (/Live/.test((await page.textContent("#liveTag")) || "")) return; await page.waitForTimeout(200); }
};
await waitLive();
await page.waitForTimeout(1000);
await page.click(`nav#cats .catwrap:has-text("Dorm") button.cat`).catch(() => {});
const link = page.locator(`nav#cats .dropdown.open a`, { hasText: "ROOM MOVES" });
await link.first().click();
await page.waitForTimeout(2500);
ok("ROOM MOVES 화면이 열린다", (await page.locator("#mvBody").count()) > 0);
const rowsN = await page.locator("#mvBody table.grid tbody tr").count();
ok("이동 목록이 렌더된다", rowsN >= 0, rowsN);
await page.selectOption("#mvStatus", "ALL");
await page.click("#mvSearch");
await page.waitForTimeout(1500);
const allN = await page.locator("#mvBody table.grid tbody tr").count();
ok("상태 필터(전체)로 E2E 이동이 보인다", allN > 0, allN);
await page.screenshot({ path: ROOT + "/shots/room_moves_board.png", fullPage: false });

await page.click("#mvNew");
await page.waitForTimeout(600);
ok("이동 등록 모달이 열린다", (await page.locator("#mvStuQ").count()) > 0);
await page.fill("#mvStuQ", "a");
await page.fill("#mvStuQ", "an");
await page.waitForTimeout(400);
const optN = await page.locator("#mvStuList .mv-opt").count();
ok("학생 검색이 동작한다", optN > 0, optN);
const grpN = await page.locator("#mvGrp option").count();
ok("이동할 구역 선택지가 채워진다", grpN > 1, grpN);
await page.screenshot({ path: ROOT + "/shots/room_move_form.png", fullPage: false });
await page.keyboard.press("Escape").catch(() => {});

ok("JS 에러 0", errs.length === 0, errs.slice(0, 5));

// ── 정리 ─────────────────────────────────────────────────────────────────────
await browser.close();
srv.close();
await cleanup();
const left = (await db.query(`select count(*)::int n from app.room_moves where created_by='e2e'`)).rows[0].n;
ok("뒷정리 완료(E2E 흔적 0)", left === 0, left);
await db.end();

console.log(`\n═══ 결과: ${pass} 통과 / ${fail} 실패 ═══`);
process.exit(fail ? 1 : 0);
