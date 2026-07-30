// 조회 인덱스 추가(Supabase 이관본 전용 · 원본 MySQL 무관) + 전후 성능 측정
import fs from "node:fs";
import pg from "pg";
const env = {};
for (const line of fs.readFileSync("/Users/kwangseobpark/smeag-old-system-analysis/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const c = new pg.Client({ host: env.PG_HOST, port: +(env.PG_PORT || 5432), database: env.PG_DB || "postgres", user: env.PG_USER, password: env.PG_PASS, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 120000 });
await c.connect();
const timed = async (label, sql) => { const t = Date.now(); try { const r = await c.query(sql); console.log(`${label}: ${Date.now() - t}ms rows=${r.rowCount}`); } catch (e) { console.log(`${label}: ERR ${e.message}`); } };

const D = (col) => `case when ${col} ~ '^\\d{4}-\\d{2}-\\d{2}' then left(${col},10) else '' end`;
const STUDENTS = `select uhak_id, s_nation, e_name, ${D("s_regdate")}, ${D("s_departure")}, app.jumin_to_birth(s_jumin)
  from legacy.student_info
 where (s_departure >= '2025-01-01' or s_sdate >= '2025-01-01' or s_edate >= '2025-01-01' or s_regdate >= '2025-01-01')`;
const SEGS = `select rr.r_idx, rr.s_idx, min(rr.rr_date), max(rr.rr_date),
   (array_agg(rr.rr_type order by rr.rr_date))[1], (array_agg(rr.rr_type order by rr.rr_date desc))[1]
   from legacy.room_reserve rr where rr.rr_date between '2026-01-01' and '2027-01-31'
   group by rr.r_idx, rr.ri_idx, rr.s_idx`;
const STAMP = `select (select max("timestamp") from legacy.student_info), (select max(rr_idx) from legacy.room_reserve),
   (select max(change_idx) from legacy.room_change_log), (select max(student_payment_ctr) from legacy.student_payment)`;

console.log("── 인덱스 추가 전 ──");
await timed("students", STUDENTS);
await timed("segs", SEGS);
await timed("stamp", STAMP);

console.log("\n── 인덱스 생성 ──");
for (const [n, sql] of [
  ["si_departure", `create index if not exists idx_si_departure on legacy.student_info(s_departure)`],
  ["si_sdate", `create index if not exists idx_si_sdate on legacy.student_info(s_sdate)`],
  ["si_edate", `create index if not exists idx_si_edate on legacy.student_info(s_edate)`],
  ["si_regdate", `create index if not exists idx_si_regdate on legacy.student_info(s_regdate)`],
  ["si_uhak", `create index if not exists idx_si_uhak_id on legacy.student_info(lower(uhak_id))`],
  ["si_ename", `create index if not exists idx_si_e_name on legacy.student_info(e_name)`],
  ["si_ts", `create index if not exists idx_si_timestamp on legacy.student_info("timestamp")`],
  ["sp_day", `create index if not exists idx_sp_deposit_day on legacy.student_payment(deposit_day)`],
  ["rr_date_ridx", `create index if not exists idx_rr_date_ridx on legacy.room_reserve(rr_date, r_idx)`],
]) await timed("  create " + n, sql);
await timed("  analyze student_info", "analyze legacy.student_info");
await timed("  analyze room_reserve", "analyze legacy.room_reserve");
await timed("  analyze student_payment", "analyze legacy.student_payment");

console.log("\n── 인덱스 추가 후 ──");
await timed("students", STUDENTS);
await timed("segs", SEGS);
await timed("stamp", STAMP);
await c.end();
