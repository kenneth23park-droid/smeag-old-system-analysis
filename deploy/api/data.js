// ============================================================================
// /api/data — 화면(메뉴) 진입 시 "DB 최신값" 조회 (Supabase Postgres 직접, PHP 없음)
// ----------------------------------------------------------------------------
// · 메뉴를 고를 때 클라이언트가 이 엔드포인트를 먼저 호출해 최신 데이터를 받고,
//   그 데이터로 화면을 그린다(정적 임베드 스냅샷 → 라이브 조회로 전환).
// · 읽기 전용(select 만). 원본 레거시 MySQL 은 물론 Supabase 데이터도 수정하지 않음.
// · 인증: /api/auth 가 발급한 httpOnly 쿠키 세션(sme_session) 필수. 없으면 401.
//   유학원 계정(Lv8 미만 + uhak_id 일치)은 자기 유학원 학생만 조회(PII 최소노출).
//
// 라우팅(단일 함수, GET 전용):
//   GET /api/data?stamp=1                        → 버전 스탬프만(가벼움, 변경감지용)
//   GET /api/data?parts=students,roomstat,...    → 요청한 조각만 조회
//     parts: students | roomstat | groups | pickup | deposits | changelog
//     month=YYYY-MM   roomstat 기준월(±6개월 창)
//     from,to=YYYY-MM-DD  pickup 주간(목→다음주 수)
//   If-None-Match 헤더로 버전이 같으면 304(본문 없음) → 클라이언트 캐시 사용.
//
// 필요 환경변수(Vercel): PG_HOST PG_PORT PG_DB PG_USER PG_PASS · AUTH_SESSION_SECRET
// ============================================================================
import crypto from "node:crypto";
import pg from "pg";

const SECRET = process.env.AUTH_SESSION_SECRET || "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const SLICE_FROM = "2025-01-01";   // 학생 슬라이스 시작(등록/출발/시작/종료 중 하나가 이 날짜 이후)
const MAX_DEPOSITS = 3000;
const MAX_CHANGELOG = 300;

const PG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres",
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 20000,
};

// ── 커넥션 재사용 · 응답 캐시(부하 최소화) ───────────────────────────────────
// · 서버리스 인스턴스가 살아있는 동안(warm) 커넥션을 재사용 → TLS 핸드셰이크 반복 제거.
// · 같은 버전(stamp)·같은 요청키면 메모리 응답을 그대로 회신 → DB 재조회 없음.
//   데이터가 바뀌면 stamp 가 바뀌어 캐시키가 달라지므로 오래된 값이 나갈 수 없다.
let shared = null;
async function getClient() {
  if (shared) {
    try { await shared.query("select 1"); return shared; }
    catch { try { await shared.end(); } catch { /* noop */ } shared = null; }
  }
  const c = new pg.Client(PG);
  c.on("error", () => { shared = null; });
  await c.connect();
  shared = c;
  return c;
}
const CACHE = new Map();          // key → { etag, body, at }
const CACHE_TTL = 90 * 1000;      // 같은 버전이라도 90초 지나면 재조회(안전판)
const CACHE_MAX = 8;
function cacheGet(key, etag) {
  const hit = CACHE.get(key);
  if (!hit || hit.etag !== etag || Date.now() - hit.at > CACHE_TTL) return null;
  return hit.body;
}
function cacheSet(key, etag, body) {
  CACHE.set(key, { etag, body, at: Date.now() });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

// ── 세션(JWT HS256) 검증 — /api/auth 와 동일 규약 ─────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function verifySession(token) {
  try {
    const [p1, p2, p3] = String(token).split(".");
    if (!p1 || !p2 || !p3) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${p1}.${p2}`).digest("base64url");
    const a = Buffer.from(p3), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(p2, "base64url").toString("utf8"));
    if (typeof body.exp === "number" && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const S = (v) => (v == null ? "" : String(v));
const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(S(s));
const isMonth = (s) => /^\d{4}-\d{2}$/.test(S(s));
const monthShift = (month, n) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthStart = (month) => `${month}-01`;
const monthEnd = (month) => {
  const [y, m] = month.split("-").map(Number);
  return ymd(new Date(Date.UTC(y, m, 0)));
};
// 이번주 목요일 → 다음주 수요일(레거시 픽업 주간)
function pickupWeek(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const back = (d.getUTCDay() - 4 + 7) % 7;           // 4=목요일
  const from = new Date(d.getTime() - back * 86400000);
  const to = new Date(from.getTime() + 6 * 86400000);
  return [ymd(from), ymd(to)];
}

// ── 조각별 조회 ──────────────────────────────────────────────────────────────
// studentsFull: 화면이 쓰는 18칸 배열 순서
//  0 AGENCY 1 NAT 2 NAME(EN) 3 KOR 4 AGE 5 SEX 6 APPLY 7 DEPA 8 BEGIN 9 END
//  10 PERI 11 STATUS 12 COURSE 13 ROOM 14 CAMPUS 15 항공/픽업 16 항공(변경전) 17 여권생일
const STUDENT_COLS = ["AGENCY", "NAT", "NAME_EN", "KOR", "AGE", "SEX", "APPLY", "DEPA", "BEGIN", "END",
  "PERI", "STATUS", "COURSE", "ROOM", "CAMPUS", "FLIGHT", "FLIGHT_PREV", "BIRTH"];

// 레거시 날짜칸은 varchar(''·'0000-00-00' 혼재) → 형식 맞는 값만 통과
const D = (col) => `case when ${col} ~ '^\\d{4}-\\d{2}-\\d{2}' then left(${col},10) else '' end`;

async function loadStudents(q, scope) {
  const where = ["(s_departure >= $1 or s_sdate >= $1 or s_edate >= $1 or s_regdate >= $1)"];
  const params = [SLICE_FROM];
  if (scope.agency) { params.push(scope.agency); where.push(`lower(coalesce(uhak_id,'')) = lower($${params.length})`); }
  const { rows } = await q(
    `select coalesce(uhak_id,'') a0, lower(coalesce(s_nation,'')) a1, coalesce(e_name,'') a2, coalesce(k_name,'') a3,
            coalesce(s_age,0) a4, upper(coalesce(s_gender,'')) a5,
            ${D("s_regdate")} a6, ${D("s_departure")} a7, ${D("s_sdate")} a8, ${D("s_edate")} a9,
            coalesce(s_period,0) a10, lower(coalesce(now_status,'')) a11, coalesce(course_info,'') a12,
            coalesce(s_room,'') a13, coalesce(s_campus,'') a14, coalesce(s_flight,'') a15,
            app.jumin_to_birth(s_jumin) a17
       from legacy.student_info
      where ${where.join(" and ")}
      order by a7 desc, a6 desc`, params);
  // 생년월일: s_jumin 추출값이 상식 범위(1930~올해)일 때만 신뢰. 외국인은 주민칸이 여권번호 등
  // 잡값인 경우가 많아(전체의 약 70%) 잘못된 연도가 나오므로 걸러 화면의 만나이 근사 로직에 맡긴다.
  const thisYear = new Date().getUTCFullYear();
  const birth = (v) => {
    if (!v) return "";
    const s = ymd(new Date(v));
    const y = Number(s.slice(0, 4));
    return y >= 1930 && y <= thisYear ? s : "";
  };
  return {
    cols: STUDENT_COLS,
    rows: rows.map((r) => [r.a0, r.a1, r.a2, r.a3, r.a4 ? String(r.a4) : "", r.a5, r.a6, r.a7, r.a8, r.a9,
      r.a10 ? String(r.a10) : "", r.a11, r.a12, r.a13, r.a14,
      /^(0|\.|-)?$/.test(r.a15.trim()) ? "" : r.a15.trim(), "",
      birth(r.a17)]),
  };
}

// roomstat: 배치도(방×일자) — 표시그룹(room_category g_display='Y') 30그룹
//   그룹 > 방(room_info) > 침대(room_list) > 예약구간(room_reserve 일자행을 구간으로 압축)
async function loadRoomstat(q, month) {
  const from = monthStart(monthShift(month, -6));
  const to = monthEnd(monthShift(month, +6));
  // 같은 커넥션이라 순차 실행(pg 클라이언트는 동시 쿼리 미지원)
  const cats = await q(`select g_idx, coalesce(g_name,'') g_name, coalesce(g_type,'C') g_type, coalesce(bldg_type,'') bldg_type
         from legacy.room_category where g_display='Y' order by coalesce(g_order,9999), g_idx`);
  const beds = await q(`select ri.g_idx, ri.i_idx, coalesce(ri.i_name,'') i_name, coalesce(ri.i_limit,0) i_limit,
              rl.r_idx, coalesce(rl.r_num,0) r_num
         from legacy.room_info ri
         join legacy.room_list rl on rl.i_idx = ri.i_idx and rl.r_state = 'Y'
         join legacy.room_category rc on rc.g_idx = ri.g_idx and rc.g_display = 'Y'
        where ri.i_state = 'Y'
        order by coalesce(rc.g_order,9999), ri.i_idx, rl.r_num, rl.r_idx`);
  // 예약: 일자행(room_reserve)을 예약단위(ri_idx)로 압축 → 구간 세그먼트. 이름은 별도 조회로 매핑.
  const segs = await q(`select rr.r_idx, rr.s_idx,
              min(rr.rr_date) s, max(rr.rr_date) e,
              (array_agg(rr.rr_type order by rr.rr_date))[1]       st,
              (array_agg(rr.rr_type order by rr.rr_date desc))[1]  et
         from legacy.room_reserve rr
        where rr.rr_date between $1 and $2
        group by rr.r_idx, rr.ri_idx, rr.s_idx`, [from, to]);
  const sidxs = [...new Set(segs.rows.map((r) => r.s_idx).filter((v) => v != null))];
  const names = sidxs.length
    ? await q(`select s_idx, coalesce(nullif(e_name,''), k_name, '') nm, lower(coalesce(now_status,'')) status
                 from legacy.student_info where s_idx = any($1)`, [sidxs])
    : { rows: [] };
  const nameById = new Map(names.rows.map((r) => [r.s_idx, r]));
  const segByBed = new Map();
  for (const s of segs.rows) {
    const who = nameById.get(s.s_idx);
    if (!who || !who.nm) continue;                          // 이름 없는 예약행은 표시 대상 아님
    const seg = { s: s.s, e: s.e, nm: who.nm, st: s.st === "I" ? "" : s.st, et: s.et === "I" ? "" : s.et };
    if (who.status === "holding" || who.status === "holdinguse") seg.h = 1;
    let arr = segByBed.get(s.r_idx);
    if (!arr) segByBed.set(s.r_idx, (arr = []));
    arr.push(seg);
  }
  const gender = { M: "m", F: "f" };
  const suffix = { M: "MALE", F: "FEMALE" };
  const groups = [];
  const byCat = new Map();
  for (const c of cats.rows) {
    const g = {
      name: c.g_name + " / " + (suffix[c.g_type] || "FAMILY"),
      gender: gender[c.g_type] || "fam",
      bldg: c.bldg_type,          // E=CAPITAL권역 · S=ENCANTO권역
      rooms: [],
    };
    byCat.set(c.g_idx, g);
    groups.push(g);
  }
  const roomByIdx = new Map();
  for (const b of beds.rows) {
    const g = byCat.get(b.g_idx);
    if (!g) continue;
    let room = roomByIdx.get(b.i_idx);
    if (!room) {
      room = { no: b.i_name, gender: g.gender, per: (b.i_limit || 1) + "인실", beds: [] };
      roomByIdx.set(b.i_idx, room);
      g.rooms.push(room);
    }
    const segsForBed = (segByBed.get(b.r_idx) || []).sort((x, y) => x.s.localeCompare(y.s));
    room.beds.push({ name: "", segs: segsForBed });
  }
  return { from, to, month, groups };
}

// pickup: 주간 픽업(항공정보 등록분) — 화면은 날짜·시간순으로 재정렬
async function loadPickup(q, from, to, scope) {
  const params = [from, to];
  let agencyWhere = "";
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` and lower(coalesce(si.uhak_id,'')) = lower($${params.length})`; }
  const { rows } = await q(
    `with win as (        -- 이번 주간 픽업 대상(항공정보 등록분)
       select s_idx from legacy.student_info
        where ${D("s_departure")} between $1 and $2
          and btrim(coalesce(s_flight,'')) not in ('','0','.','-')),
     first_dep as (       -- 신입(In) 판정: 같은 이름의 최초 출발일 = 이번 출발일이면 첫 입국
       select p.e_name, min(${D("p.s_departure")}) m
         from legacy.student_info p
        where p.e_name in (select w.e_name from legacy.student_info w join win on win.s_idx = w.s_idx)
          and ${D("p.s_departure")} <> ''
        group by p.e_name)
     select ${D("si.s_departure")} arrive, coalesce(si.s_flight,'') flight_raw,
            coalesce(si.e_name, si.k_name,'') name, lower(coalesce(si.s_nation,'')) nation,
            coalesce(si.uhak_id,'') agency, coalesce(si.s_campus,'') campus, coalesce(si.s_room,'') room,
            lower(coalesce(si.now_status,'')) status,
            (fd.m is null or fd.m = ${D("si.s_departure")}) is_new
       from legacy.student_info si
       left join first_dep fd on fd.e_name = si.e_name
      where ${D("si.s_departure")} between $1 and $2
        and btrim(coalesce(si.s_flight,'')) not in ('','0','.','-')
        and lower(coalesce(si.now_status,'')) not in ('cancel','paycancel')${agencyWhere}
      order by 1, 2`, params);
  const rowsOut = rows.map((r) => {
    const raw = r.flight_raw.replace(/\s+/g, " ").trim();
    const t = raw.match(/(\d{1,2}):(\d{2})/);
    let time = "";
    if (t) {
      let hh = Number(t[1]);
      if (/pm/i.test(raw.slice(raw.indexOf(t[0]) + t[0].length, raw.indexOf(t[0]) + t[0].length + 3)) && hh < 12) hh += 12;
      time = String(hh).padStart(2, "0") + ":" + t[2];
    }
    const code = (raw.match(/^[A-Za-z]{1,3}\s?\d{2,4}/) || [""])[0].replace(/\s+/g, "");
    return {
      arrive: r.arrive, time, flight: code || raw.slice(0, 24), name: r.name, nation: r.nation,
      agency: r.agency, campus: r.campus, room: r.room, status: r.status, isNew: !!r.is_new, raw,
    };
  });
  return { window: { from, to }, rows: rowsOut };
}

// groups: Group Students(student_group_info + 배정 학생수)
async function loadGroups(q) {
  const { rows } = await q(
    `with cnt as (select coalesce(group_id::text,'') gid, count(*) n
                    from legacy.student_info
                   where coalesce(group_id::text,'') not in ('','0')
                   group by 1)
     select g.g_id id, coalesce(g.group_name,'') name, coalesce(g.group_country,'') country,
            coalesce(g.group_status,'') status, coalesce(g.added_by,'') by,
            coalesce(to_char(g.created,'YYYY-MM-DD'),'') created,
            coalesce(cnt.n,0) count
       from legacy.student_group_info g
       left join cnt on cnt.gid = g.g_id::text
      order by g.g_id`);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

// deposits: Deposit/Pre-paid (student_payment ⨝ student_info)
async function loadDeposits(q, scope) {
  const params = [SLICE_FROM, MAX_DEPOSITS];
  let agencyWhere = "";
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` and lower(coalesce(si.uhak_id,'')) = lower($${params.length})`; }
  const { rows } = await q(
    `select coalesce(sp.deposit_no,'') no, lower(coalesce(si.s_nation,'')) nat,
            coalesce(si.e_name, si.k_name,'') name, ${D("si.s_sdate")} "begin", ${D("si.s_edate")} "end",
            upper(coalesce(sp.deposit_pay,'')) status, coalesce(sp.deposit_amount,'') amount,
            upper(coalesce(sp.deposit_unit,'')) unit, ${D("sp.deposit_day")} "day"
       from legacy.student_payment sp
       join legacy.student_info si on si.s_idx = sp.student_idx
      where (sp.deposit_day >= $1 or si.s_sdate >= $1 or si.s_edate >= $1)${agencyWhere}
      order by 9 desc, sp.student_payment_ctr desc
      limit $2`, params);
  return rows;
}

// changelog: 방변경 이력(room_change_log)
async function loadChangelog(q, scope) {
  const params = [MAX_CHANGELOG];
  let agencyWhere = "";
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` where lower(coalesce(uhak_id,'')) = lower($${params.length})`; }
  const { rows } = await q(
    `select s_idx sidx, coalesce(uhak_id,'') agency, coalesce(k_name,'') name,
            coalesce(apply_date,'') apply, coalesce(origin_period,'') period,
            coalesce(old_room_info,'') oldr, coalesce(old_room_cate::text,'') oldc,
            coalesce(new_room_info,'') newr, coalesce(new_room_cate::text,'') newc,
            coalesce(apply_sme_manager,'') mgr
       from legacy.room_change_log${agencyWhere}
      order by change_idx desc limit $1`, params);
  return rows;
}

// 버전 스탬프: 최신 갱신 흔적(학생 timestamp · 예약 최대키 · 변경이력 최대키)
async function loadStamp(q) {
  const { rows } = await q(
    `select coalesce(to_char((select max("timestamp") from legacy.student_info),'YYYY-MM-DD"T"HH24:MI:SS'),'') si_ts,
            coalesce((select max(s_idx) from legacy.student_info)::text,'')      si_max,
            coalesce((select max(rr_idx) from legacy.room_reserve)::text,'')     rr_max,
            coalesce((select max(change_idx) from legacy.room_change_log)::text,'') cl_max,
            coalesce((select max(student_payment_ctr) from legacy.student_payment)::text,'') sp_max`);
  const r = rows[0] || {};
  return { si_ts: r.si_ts, si_max: r.si_max, rr_max: r.rr_max, cl_max: r.cl_max, sp_max: r.sp_max };
}
const stampVersion = (stamp) =>
  crypto.createHash("sha1").update(Object.values(stamp).join("|")).digest("hex").slice(0, 16);

// ── 엔트리 ───────────────────────────────────────────────────────────────────
const ALL_PARTS = ["students", "roomstat", "groups", "pickup", "deposits", "changelog"];
export const maxDuration = 30;   // 배치도(13개월 창) 조회 여유 — Vercel 함수 제한

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const session = verifySession(readCookie(req, COOKIE));
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: "no_session", message: "로그인 세션이 없습니다. 다시 로그인하세요." }));
  }

  const url = new URL(req.url, "http://x");
  const wantStamp = url.searchParams.has("stamp");
  const parts = (url.searchParams.get("parts") || "students").split(",")
    .map((s) => s.trim()).filter((s) => ALL_PARTS.includes(s));
  const month = isMonth(url.searchParams.get("month")) ? url.searchParams.get("month")
    : new Date().toISOString().slice(0, 7);
  const [wkFrom, wkTo] = pickupWeek(new Date());
  const from = isYmd(url.searchParams.get("from")) ? url.searchParams.get("from") : wkFrom;
  const to = isYmd(url.searchParams.get("to")) ? url.searchParams.get("to") : wkTo;

  const t0 = Date.now();
  try {
    const client = await getClient();     // warm 인스턴스에서 커넥션 재사용
    const q = (sql, params) => client.query(sql, params);

    // 유학원 계정 스코프: Lv8 미만이고 아이디가 실제 uhak_id 로 존재하면 본인 유학원만
    const scope = { agency: null };
    if (Number(session.mb_level || 0) < 8) {
      const { rows } = await q(
        `select 1 from legacy.student_info where lower(coalesce(uhak_id,'')) = lower($1) limit 1`,
        [S(session.mb_id)]);
      if (rows.length) scope.agency = S(session.mb_id);
    }

    const stamp = await loadStamp(q);
    const version = stampVersion(stamp) + ":" + parts.join(".") + (parts.includes("roomstat") ? ":" + month : "")
      + (parts.includes("pickup") ? ":" + from + "_" + to : "") + (scope.agency ? ":" + scope.agency : "");
    const etag = `W/"${version}"`;

    if (wantStamp) {
      return res.end(JSON.stringify({ ok: true, stamp, version: stampVersion(stamp), ts: new Date().toISOString() }));
    }
    if ((req.headers["if-none-match"] || "") === etag) {
      res.statusCode = 304;
      res.setHeader("ETag", etag);
      res.setHeader("X-Data-Source", "not-modified");
      return res.end();
    }
    const cached = cacheGet(version, etag);
    if (cached) {                          // 같은 버전·같은 요청 → DB 재조회 없이 회신
      res.setHeader("ETag", etag);
      res.setHeader("X-Data-Source", "memory");
      return res.end(cached);
    }

    const out = {
      ok: true, source: "supabase", ts: new Date().toISOString(),
      version: stampVersion(stamp), parts, month, window: { from, to },
      scope: scope.agency ? { agency: scope.agency } : { agency: null },
      user: { id: session.mb_id, name: session.mb_name, level: Number(session.mb_level || 0) },
    };
    if (parts.includes("students")) out.studentsFull = await loadStudents(q, scope);
    if (parts.includes("roomstat")) out.roomstat = await loadRoomstat(q, month);
    if (parts.includes("groups")) out.groups = await loadGroups(q);
    if (parts.includes("pickup")) out.pickup = await loadPickup(q, from, to, scope);
    if (parts.includes("deposits")) out.deposits = await loadDeposits(q, scope);
    if (parts.includes("changelog")) out.changelog = await loadChangelog(q, scope);
    out.ms = Date.now() - t0;

    const body = JSON.stringify(out);
    cacheSet(version, etag, body);
    res.setHeader("ETag", etag);
    res.setHeader("X-Data-Source", "db");
    return res.end(body);
  } catch (e) {
    shared = null;                         // 커넥션 문제면 다음 요청에서 새로 연결
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false, error: "db_error",
      message: "DB 조회에 실패했습니다. 잠시 후 다시 시도하세요.",
      detail: String((e && e.message) || e).slice(0, 200),
    }));
  }
}
