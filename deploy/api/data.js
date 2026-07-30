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
//            members | points | visits | commission | courses | tuition
//            farmgym | boards | elec | agencyvisit | dayoff
//            (뒤 11개는 out.tables["<레거시 URL>"] = {cols,rows} 형태로 응답 → 화면이 그대로 라이브)
//     month=YYYY-MM   roomstat 기준월(±6개월 창)
//     from,to=YYYY-MM-DD  pickup 주간(목→다음주 수)
//   out.truncated = ["<레거시 URL>", …]  화면당 500행 상한에 걸린 표
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
// studentsFull: 화면이 쓰는 23칸 배열 순서
//  0 AGENCY 1 NAT 2 NAME(EN) 3 KOR 4 AGE 5 SEX 6 APPLY 7 DEPA 8 BEGIN 9 END
//  10 PERI 11 STATUS 12 COURSE 13 ROOM 14 CAMPUS 15 항공/픽업 16 항공(변경전) 17 여권생일
//  18 SID(s_idx) 19 COURSE_TXT(fee_class2) 20 DORM_TXT(fee_dorm2) 21 AGENT_CMT(s_info) 22 STAFF_CMT(comment)
//  18~22 는 레거시 ROOM REPLACEMENT(reserve_move.php) 학생정보 표를 그대로 재현하기 위해 추가.
//  코멘트 2칸은 text 라 페이로드가 커질 수 있어 400자로 자른다(표시 전용).
const STUDENT_COLS = ["AGENCY", "NAT", "NAME_EN", "KOR", "AGE", "SEX", "APPLY", "DEPA", "BEGIN", "END",
  "PERI", "STATUS", "COURSE", "ROOM", "CAMPUS", "FLIGHT", "FLIGHT_PREV", "BIRTH",
  "SID", "COURSE_TXT", "DORM_TXT", "AGENT_CMT", "STAFF_CMT"];

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
            app.jumin_to_birth(s_jumin) a17,
            coalesce(s_idx,0) a18, coalesce(fee_class2,'') a19, coalesce(fee_dorm2,'') a20,
            left(coalesce(s_info,''),400) a21, left(coalesce("comment",''),400) a22
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
      birth(r.a17),
      r.a18 ? String(r.a18) : "", r.a19.trim(), r.a20.trim(), r.a21.trim(), r.a22.trim()]),
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

// ════════════════════════════════════════════════════════════════════════════
// 명세화면 라이브 조회 — out.tables["<레거시 URL>"] = {cols, rows}
// ----------------------------------------------------------------------------
// · 클라이언트 specData(url) 가 REAL.tables[url] 를 2순위로 읽으므로, 여기에 채우면
//   해당 화면이 그대로 라이브가 된다. rows 는 문자열/숫자 배열이고 컬럼 순서는
//   deploy/index.html MENU 의 각 화면 cols 순서와 정확히 일치해야 한다.
// · 화면당 최대 500행(최신순). 상한에 걸리면 out.truncated 에 URL 을 기록한다.
// · 개인정보 최소화: 비밀번호/주민번호/전화/주소/본문 미조회, 이메일·전화는 마스킹.
// · 레거시 datetime → Postgres timestamptz 이관본은 naive 값을 그대로 UTC 로 넣어두었다.
//   따라서 반드시 `at time zone 'UTC'` 로 포맷해야 원래 날짜가 나온다(로컬 tz 로 바꾸면 하루 밀림).
// ════════════════════════════════════════════════════════════════════════════
const MAX_TABLE_ROWS = 500;
// timestamptz 판 날짜정제(varchar 전용 D() 를 쓸 수 없는 컬럼용)
const DT = (col) => `coalesce(to_char(${col} at time zone 'UTC','YYYY-MM-DD'),'')`;
const table = (cols, rows) => ({ cols, rows, truncated: rows.length >= MAX_TABLE_ROWS });

// members — member_list.php (cms.g4_member, 실측 2053행 → 상한 걸림)
// 이메일은 로컬파트 앞 2자만 노출. mb_password/mb_jumin/mb_tel/mb_hp/mb_addr* 는 조회하지 않음.
// 유학원 계정에는 전체 회원명부를 노출하지 않고 자기 계정만 보여준다.
async function loadMembers(q, scope) {
  const cols = ["ID", "이름", "레벨", "이메일", "가입일", "최근접속"];
  const params = [];
  let where = "";
  if (scope.agency) { params.push(scope.agency); where = `where lower(mb_id) = lower($${params.length})`; }
  const { rows } = await q(
    `select mb_id a0,
            coalesce(mb_name,'') a1,
            coalesce(mb_level,0)::text a2,
            case when position('@' in coalesce(mb_email,'')) > 1
                 then left(split_part(mb_email,'@',1),2) || '***@' || split_part(mb_email,'@',2)
                 else '' end a3,
            ${DT("mb_datetime")} a4,
            ${DT("mb_today_login")} a5
       from cms.g4_member
       ${where}
      order by mb_datetime desc nulls last, mb_no desc
      limit ${MAX_TABLE_ROWS}`, params);
  return { "member_list.php": table(cols, rows.map((r) => [S(r.a0), S(r.a1), S(r.a2), S(r.a3), S(r.a4), S(r.a5)])) };
}

// points — point_list.php (cms.g4_point, 실측 146,387행 → 상한 걸림)
// po_id 가 auto_increment 이므로 po_id desc 만으로 사실상 최신순이고 po_datetime 정렬보다 훨씬 빠르다.
async function loadPoints(q, scope) {
  const cols = ["회원ID", "내용", "포인트", "일자"];
  const params = [];
  let where = "";
  if (scope.agency) { params.push(scope.agency); where = `where lower(coalesce(mb_id,'')) = lower($${params.length})`; }
  const { rows } = await q(
    `select coalesce(mb_id,'') a0,
            coalesce(po_content,'') a1,
            coalesce(po_point,0)::text a2,
            ${DT("po_datetime")} a3
       from cms.g4_point
       ${where}
      order by po_id desc
      limit ${MAX_TABLE_ROWS}`, params);
  return { "point_list.php": table(cols, rows.map((r) => [S(r.a0), S(r.a1), S(r.a2), S(r.a3)])) };
}

// visits — visit_list.php
// 화면 cols 가 ['일자','방문수'] 2칸이므로 상세로그 cms.g4_visit(IP·UA·referer = PII/봇트래픽)이 아니라
// 일별 집계 테이블 cms.g4_visit_sum(5431행)을 쓴다. vs_date 는 date 타입이라 to_char 로 충분.
async function loadVisits(q) {
  const cols = ["일자", "방문수"];
  const { rows } = await q(
    `select to_char(vs_date,'YYYY-MM-DD') a0, coalesce(vs_count,0)::text a1
       from cms.g4_visit_sum
      where vs_date is not null
      order by vs_date desc
      limit ${MAX_TABLE_ROWS}`);
  return { "visit_list.php": table(cols, rows.map((r) => [S(r.a0), S(r.a1)])) };
}

// commission — uhak_agency_commission.php (legacy.uhak_agency_com, 실측 4004행 → 상한 걸림)
// · percent 컬럼은 전 행 빈문자 → 사용 금지. 실제 값은 com_amt 에만 있고 com_category('percent'/'amount')로 분기.
// · uhak_idx 도 전 행 빈문자 → 유학원 식별은 mb_id 로만 가능. student/end_date 는 전 행 NULL(추측 채움 금지).
// · confirm_date 는 약 절반이 NULL 이라 '확인일'이 빈칸인 행이 많다(레거시 헤더에 충실).
async function loadCommission(q, scope) {
  const cols = ["NO", "UHAK", "구분", "%", "금액", "담당", "확인일", "상태", "학생"];
  const { rows } = await q(
    `select u.no a0,
            coalesce(nullif(m.mb_name,''), u.mb_id, '') a1,
            coalesce(u.com_category,'') a2,
            case when u.com_category = 'percent' then coalesce(u.com_amt,'') else '' end a3,
            case when u.com_category = 'amount'  then coalesce(u.com_amt,'') else '' end a4,
            coalesce(u.manager,'') a5,
            ${D("u.confirm_date")} a6,
            coalesce(u.state,'') a7,
            coalesce(u.student::text,'') a8
       from legacy.uhak_agency_com u
       left join cms.g4_member m on m.mb_id = u.mb_id
      where ($1::text is null or lower(coalesce(u.mb_id,'')) = lower($1))
      order by u.no desc
      limit ${MAX_TABLE_ROWS}`, [scope.agency]);
  return {
    "uhak_agency_commission.php": table(cols, rows.map((r) =>
      [r.a0, S(r.a1), S(r.a2), S(r.a3), S(r.a4), S(r.a5), S(r.a6), S(r.a7), S(r.a8)])),
  };
}

// courses — course_list.php (legacy.course_info, 71행)
// ⚠ '#' 은 반드시 i_idx(코스코드) · '상태' 는 대문자 Y/N — index.html _buildCourseCache() 가
//   이 두 칸으로 courseNameOf/courseActiveOf 를 만든다. 순번을 넣으면 코스명 매핑이 전부 깨진다.
// 캠퍼스는 표시용(이름과 s_campus 가 어긋난 행이 있어 필터 기준으로 쓰지 말 것). i_limit 은 전 행 0.
// 마스터 테이블이므로 유학원 스코프를 적용하지 않는다(적용하면 코스명 매핑이 깨짐).
async function loadCourses(q) {
  const cols = ["#", "코스명", "COURSE(EN)", "정원", "학비", "캠퍼스", "상태"];
  const { rows } = await q(
    `select i_idx::text a0,
            coalesce(i_name,'') a1,
            coalesce(nullif(i_name_en,''), coalesce(i_name,'')) a2,
            case when coalesce(i_limit,0)=0 then '' else i_limit::text end a3,
            coalesce(i_pay,0)::text a4,
            case upper(coalesce(s_campus,''))
              when 'S' then 'ENCANTO' when 'C' then 'CAPITAL'
              when 'E' then 'CLASSIC' when 'A' then 'ALL'
              else upper(coalesce(s_campus,'')) end a5,
            upper(coalesce(i_state,'')) a6
       from legacy.course_info
      order by i_idx desc
      limit ${MAX_TABLE_ROWS}`);
  return {
    "course_list.php": table(cols, rows.map((r) =>
      [S(r.a0), S(r.a1), S(r.a2), S(r.a3), S(r.a4), S(r.a5), S(r.a6)])),
  };
}

// tuition — tution_fee.php (legacy.tution_fee 100행 = 25코스 × week 1~4)
// '#' 은 행 PK(idx)이고 코스코드가 아니다. COURSE 는 course_info 영문명으로 표시(고아행 0건).
// agency_jp/student_jp 는 일본 엔(YEN) 정수. 마스터/단가라 유학원 스코프 미적용.
async function loadTuition(q) {
  const cols = ["#", "COURSE", "WEEK", "AGENCY(JP)", "STUDENT(JP)"];
  const { rows } = await q(
    `select tf.idx::text a0,
            coalesce(nullif(ci.i_name_en,''), nullif(ci.i_name,''), tf.course::text) a1,
            coalesce(tf.week,0)::text a2,
            coalesce(tf.agency_jp,0)::text a3,
            coalesce(tf.student_jp,0)::text a4
       from legacy.tution_fee tf
       left join legacy.course_info ci on ci.i_idx = tf.course
      order by tf.idx desc
      limit ${MAX_TABLE_ROWS}`);
  return {
    "tution_fee.php": table(cols, rows.map((r) => [S(r.a0), S(r.a1), S(r.a2), S(r.a3), S(r.a4)])),
  };
}

// farmgym — student_farm.php / student_gym.php / student_farm2.php
// (legacy.student_payment 89,477행 ⨝ legacy.student_info)
// ⚠ 데이터 실태: farm/gym 값이 채워진 행은 극소수(2016~2017년으로 끝남, 사실상 운영중단 기능).
//   레거시는 값이 전부 빈 학생까지 전 학생을 나열하지만, 500행 상한에서는 빈칸만 차므로
//   farm/gym 관련 컬럼 중 하나라도 값이 있는 행만 남기는 필터(HAS)를 건다 → 레거시와 총건수가 다르다.
//   실측 대상건수: FARM&GYM 65행 / GYM 47행 / FARM 20행 (모두 상한 미달).
// ⚠ student_farm2.php 의 PAID 는 전용 컬럼이 없어 deposit_pay(Y/N/X/R) 를 Y/N 정규화한 '추정 매핑'.
//   index.html 의 student_farm2.php 파생 폴백은 컬럼이 어긋나므로 여기서 직접 채워 덮는다.
// COMMENTS 는 자유입력 text → 공백 정규화 + 200자 절단(민감정보 혼입 방어).
const FG_HAS = `(coalesce(sp.farm_arrival,'')<>'' or coalesce(sp.gym_start,'')<>'' or coalesce(sp.gym_period,'')<>''
                 or coalesce(sp.farm_flight,'')<>'' or coalesce(sp.pay_farm,'0') not in ('0','') or coalesce(sp.pay_gym,'0') not in ('0',''))`;
// 성능: GYM 셋·FARM 셋은 모두 FG_HAS 셋의 부분집합이므로 쿼리를 3번 돌리지 않고
// FG_HAS 로 한 번만 읽어(왕복 1회) JS 에서 분기·정렬한다(3왕복 641ms → 1왕복 ~330ms).
async function loadFarmgym(q, scope) {
  const params = [];
  let agencyWhere = "";
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` and lower(coalesce(si.uhak_id,'')) = lower($${params.length})`; }
  const clip = (v) => S(v).replace(/\s+/g, " ").slice(0, 200);

  const { rows } = await q(
    `select upper(coalesce(si.s_nation,'')) nat,
            coalesce(si.e_name,'') name,
            ${D("sp.gym_start")} gym_start, coalesce(sp.gym_period,'') gym_period,
            ${D("sp.farm_arrival")} farm_arrival, coalesce(sp.farm_flight,'') farm_flight,
            coalesce(sp.comment,'') comments,
            ${D("sp.commission_day")} commission, ${D("sp.apply_date")} apply,
            coalesce(nullif(sp.pay_gym,''),'0') gym_fee,
            coalesce(nullif(sp.pay_farm,''),'0') farm_fee,
            case when coalesce(sp.deposit_pay,'') in ('Y','y','yes') then 'Y'
                 when coalesce(sp.deposit_pay,'') in ('N','n','no')  then 'N'
                 else coalesce(sp.deposit_pay,'') end paid,
            coalesce(nullif(si.r_campus,''), nullif(si.s_campus,''), '') campus,
            sp.student_payment_ctr ctr,
            (coalesce(sp.gym_start,'')<>'' or coalesce(sp.gym_period,'')<>''
             or coalesce(sp.pay_gym,'0') not in ('0','')) is_gym,
            (coalesce(sp.farm_arrival,'')<>'' or coalesce(sp.farm_flight,'')<>''
             or coalesce(sp.pay_farm,'0') not in ('0','')) is_farm
       from legacy.student_payment sp
       join legacy.student_info si on si.s_idx = sp.student_idx
      where ${FG_HAS}${agencyWhere}
      order by greatest(${D("sp.farm_arrival")}, ${D("sp.gym_start")}, ${D("sp.apply_date")}) desc,
               sp.student_payment_ctr desc
      limit ${MAX_TABLE_ROWS}`, params);

  // 날짜 desc + ctr desc 재정렬(빈 날짜는 뒤로)
  const by = (key) => (a, b) => (S(b[key]) || "0").localeCompare(S(a[key]) || "0") || (Number(b.ctr) || 0) - (Number(a.ctr) || 0);
  const gym = rows.filter((r) => r.is_gym).sort(by("gym_start"));
  const farm = rows.filter((r) => r.is_farm).sort(by("farm_arrival"));
  // 기반 셋이 상한에 걸리면 부분집합(gym/farm)도 불완전 → 세 URL 모두 truncated 로 본다.
  const cut = rows.length >= MAX_TABLE_ROWS;
  const t3 = (cols, rs) => ({ cols, rows: rs, truncated: cut });

  return {
    "student_farm.php": t3(
      ["NAT", "NAME", "GYM START", "GYM PERIOD", "FARM ARRIVAL", "FARM FLIGHT", "COMMENTS", "COMMISSION", "APPLY"],
      rows.map((r) => [S(r.nat), S(r.name), S(r.gym_start), S(r.gym_period), S(r.farm_arrival),
        S(r.farm_flight), clip(r.comments), S(r.commission), S(r.apply)])),
    "student_gym.php": t3(
      ["NAT", "NAME", "GYM START", "GYM PERIOD", "GYM FEE", "COMMISSION", "APPLY", "CAMPUS"],
      gym.map((r) => [S(r.nat), S(r.name), S(r.gym_start), S(r.gym_period), S(r.gym_fee),
        S(r.commission), S(r.apply), S(r.campus)])),
    "student_farm2.php": t3(
      ["NAT", "NAME", "FARM ARRIVAL", "PAID", "FARM FEE", "COMMISSION", "APPLY", "CAMPUS"],
      farm.map((r) => [S(r.nat), S(r.name), S(r.farm_arrival), S(r.paid), S(r.farm_fee),
        S(r.commission), S(r.apply), S(r.campus)])),
  };
}

// boards — bbs/board.php?bo_table=office_GAC / _holding / _share
// (cms."g4_write_office_GAC" 37행 · g4_write_office_holding 13행 · g4_write_office_share 3행)
// gnuboard4 관례: 코멘트(wr_is_comment=1) 제외, order by wr_num, wr_reply(wr_num 음수=최신), NO=total-순번+1.
// wr_datetime 은 timestamptz → at time zone 'UTC' 고정(런타임 tz 무관). PII 미노출: wr_password/wr_email/wr_ip/wr_content 미조회.
// 내부 상담·컴플레인 내용이므로 유학원 스코프 세션에는 rows 를 내려주지 않는다(uhak_id 컬럼도 없어 필터 불가).
const BOARD_COLS = ["NO", "TITLE", "WRITER", "DATE", "VIEW"];
const BOARDS = [
  ['bbs/board.php?bo_table=office_GAC', 'cms."g4_write_office_GAC"'],
  ["bbs/board.php?bo_table=office_holding", "cms.g4_write_office_holding"],
  ["bbs/board.php?bo_table=office_share", "cms.g4_write_office_share"],
];
async function loadBoards(q, scope) {
  const out = {};
  for (const [url, ident] of BOARDS) {
    if (scope.agency) { out[url] = table(BOARD_COLS, []); continue; }
    const { rows } = await q(
      `with p as (
         select wr_id, wr_num, wr_reply, wr_subject, wr_name, mb_id, wr_datetime, wr_hit, wr_option
           from ${ident}
          where coalesce(wr_is_comment,0) = 0
       ), n as (select count(*)::int total from p)
       select (select total from n) - (row_number() over (order by wr_num, wr_reply, wr_id desc))::int + 1 a0,
              case when position('secret' in coalesce(wr_option,'')) > 0 then '[secret] ' else '' end
                || coalesce(nullif(btrim(wr_subject),''),'(제목없음)') a1,
              coalesce(nullif(btrim(wr_name),''), coalesce(mb_id,'')) a2,
              ${DT("wr_datetime")} a3,
              coalesce(wr_hit,0) a4
         from p
        order by wr_num, wr_reply, wr_id desc
        limit ${MAX_TABLE_ROWS}`);
    out[url] = table(BOARD_COLS, rows.map((r) => [Number(r.a0) || 0, S(r.a1), S(r.a2), S(r.a3), Number(r.a4) || 0]));
  }
  return out;
}

// elec — room_elec.php (legacy.room_elec 1,670,841행 → 상한 걸림)
// ⚠ MENU 에 cols 정의가 없어(note 만 존재) loader 가 cols 를 함께 내려준다 → 그대로 헤더가 된다.
// re_state 는 전체 행이 '' 이라 STATE 는 항상 공백. re_date 는 varchar → D() 로 정제.
// order by 는 인덱스 없는 re_date 대신 auto_increment PK 역순(re_idx desc, 시간순과 일치).
const ELEC_COLS = ["DATE", "ROOM", "CATEGORY", "BLDG", "GAGE", "P-COUNT", "CHARGE", "STATE", "UPDATER", "UPDATED"];
async function loadElec(q) {
  const { rows } = await q(
    `select ${D("re.re_date")} a0,
            coalesce(ri.i_name,'') a1,
            coalesce(rc.g_name,'') a2,
            coalesce(ri.bldg_type,'') a3,
            coalesce(re.re_gage,0) a4,
            coalesce(re.p_count,0) a5,
            coalesce(re.charge_gage,0) a6,
            case re.re_state when 'Y' then 'CONFIRMED' when 'C' then 'CANCEL' else coalesce(re.re_state,'') end a7,
            coalesce(re.id_updater,'') a8,
            coalesce(to_char(re.update_timestamp,'YYYY-MM-DD HH24:MI'),'') a9
       from legacy.room_elec re
       left join legacy.room_info     ri on ri.i_idx = re.i_idx
       left join legacy.room_category rc on rc.g_idx = ri.g_idx
      order by re.re_idx desc
      limit ${MAX_TABLE_ROWS}`);
  return {
    "room_elec.php": table(ELEC_COLS, rows.map((r) =>
      [S(r.a0), S(r.a1), S(r.a2), S(r.a3), Number(r.a4) || 0, Number(r.a5) || 0, Number(r.a6) || 0, S(r.a7), S(r.a8), S(r.a9)])),
  };
}

// agencyvisit — uhak_agency_visit.php (legacy.uhak_day_info 158행)
// ⚠ 담당표의 legacy.visitors 는 무관한 웹방문로그이므로 조인하지 않는다(원천은 uhak_day_info 단독).
// mb_id 는 전 행 '' 이라 AGENCY NAME 은 mb_name 사용. d_state W=WAIT/Y=COMPLETE/C=CANCEL.
// PHONE 은 PII → 숫자런마다 앞 1~2자리만 남기고 마스킹. d_text 는 장문 → 공백치환 후 200자 절단.
// ⚠ 데이터가 오래됨: 최신 d_date 가 2013-11-05(사실상 히스토리).
// 부가효과: specDerived('uhak_agency_schedule_list.php') 가 이 테이블을 읽어 VISIT(calendar)도 살아난다.
const VISIT_COLS = ["No", "AGENCY NAME", "VISIT DATE", "VISIT TIME", "VISITER", "PHONE", "REQUIREMENT", "RESULT"];
async function loadAgencyvisit(q, scope) {
  const params = [];
  let where = "";
  if (scope.agency) {
    params.push(scope.agency);
    where = `where lower(coalesce(d.mb_id,'')) = lower($1) or lower(coalesce(d.mb_name,'')) = lower($1)`;
  }
  const { rows } = await q(
    `select d.d_idx a0,
            coalesce(nullif(d.mb_name,''), nullif(d.mb_id,''), '') a1,
            ${D("d.d_date")} a2,
            coalesce(d.d_time,'') a3,
            coalesce(d.writer,'') a4,
            case when coalesce(d.d_phone,'')='' then ''
                 else regexp_replace(d.d_phone, '(\\d{1,2})\\d+', '\\1**', 'g') end a5,
            left(regexp_replace(coalesce(d.d_text,''), '[\\r\\n\\t]+', ' ', 'g'), 200) a6,
            case upper(coalesce(d.d_state,''))
              when 'W' then 'WAIT' when 'Y' then 'COMPLETE' when 'C' then 'CANCEL'
              else coalesce(d.d_state,'') end a7
       from legacy.uhak_day_info d
       ${where}
      order by d.d_date desc nulls last, d.d_idx desc
      limit ${MAX_TABLE_ROWS}`, params);
  return {
    "uhak_agency_visit.php": table(VISIT_COLS, rows.map((r) =>
      [Number(r.a0) || 0, S(r.a1), S(r.a2), S(r.a3), S(r.a4), S(r.a5), S(r.a6), S(r.a7)])),
  };
}

// dayoff — scheduler_index(-all).php (legacy.smeag_dayoff 85행 + legacy.smeag_sched_info 30행)
// ⚠ MENU 에 cols 정의가 없어 loader 가 cols 를 함께 내려준다.
// 레거시가 두 페이지(scheduler_index.php↔sched_info, scheduler_index-all.php↔dayoff)를 한 메뉴로 합쳤으므로
// UNION ALL + SOURCE 컬럼으로 구분한다. 개별 URL 키로도 같은 표를 채워 어느 쪽으로 들어와도 뜨게 한다.
// ⚠ 이관 시 컬럼명 정규화: MySQL `position-enum`/`types-enum` → position_enum/types_enum. `user` 는 예약어 → 큰따옴표.
//   smeag_sched_info 에는 *_enum 컬럼이 없어(position/types 가 enum 역할) UNION 에서 같은 컬럼을 복제해 형태를 맞춤.
// start_date/end_date 는 timestamptz(진짜 날짜형) → D() 불필요. applydate/approval 은 'Feb 21, 2018' 등 비ISO·오염값이라 원문 노출.
// ⚠ 데이터가 오래됨: 최신 start_date 2018-12-21. PII 제외: mobile/memo/pending 미조회.
const DAYOFF_COLS = ["SOURCE", "NAME", "USER", "CAMPUS", "POSITION", "TYPE", "START", "END", "DAYS", "PURPOSE", "APPLY DATE", "APPROVAL"];
async function loadDayoff(q) {
  const { rows } = await q(
    `with u as (
       select 'DAYOFF' src, id, start_date, end_date, text, "user", campus, position, position_enum,
              types, types_enum, days, purpose, applydate, approval
         from legacy.smeag_dayoff
       union all
       select 'SCHED' src, id, start_date, end_date, text, "user", campus, position, position position_enum,
              types, types types_enum, days, purpose, applydate, approval
         from legacy.smeag_sched_info)
     select src a0,
            coalesce(text,'') a1,
            coalesce("user",'') a2,
            upper(coalesce(campus,'')) a3,
            coalesce(nullif(position,''), coalesce(position_enum,'')) a4,
            upper(coalesce(nullif(types,''), coalesce(types_enum,''))) a5,
            coalesce(to_char(start_date,'YYYY-MM-DD HH24:MI'),'') a6,
            coalesce(to_char(end_date,'YYYY-MM-DD HH24:MI'),'') a7,
            coalesce(days,'') a8,
            left(regexp_replace(coalesce(purpose,''), '[\\r\\n\\t]+', ' ', 'g'), 120) a9,
            coalesce(applydate,'') a10,
            coalesce(approval,'') a11
       from u
      order by start_date desc nulls last, id desc
      limit ${MAX_TABLE_ROWS}`);
  const t = table(DAYOFF_COLS, rows.map((r) =>
    [S(r.a0), S(r.a1), S(r.a2), S(r.a3), S(r.a4), S(r.a5), S(r.a6), S(r.a7), S(r.a8), S(r.a9), S(r.a10), S(r.a11)]));
  return {
    "scheduler_index(-all).php": t,
    "scheduler_index.php": t,
    "scheduler_index-all.php": t,
  };
}

// part → loader (out.tables 에 병합)
const TABLE_LOADERS = {
  members: loadMembers, points: loadPoints, visits: loadVisits,
  commission: loadCommission, courses: loadCourses, tuition: loadTuition,
  farmgym: loadFarmgym, boards: loadBoards, elec: loadElec,
  agencyvisit: loadAgencyvisit, dayoff: loadDayoff,
};

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
const ALL_PARTS = ["students", "roomstat", "groups", "pickup", "deposits", "changelog",
  // 명세화면 라이브(out.tables["<레거시 URL>"] 로 응답)
  "members", "points", "visits", "commission", "courses", "tuition",
  "farmgym", "boards", "elec", "agencyvisit", "dayoff"];
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
    // 명세화면 조각: out.tables["<레거시 URL>"] = {cols, rows} · 500행 상한 초과 URL 은 out.truncated 에 기록
    // (같은 커넥션이라 pg 는 동시 쿼리 미지원 → 순차 실행)
    for (const p of parts) {
      const loader = TABLE_LOADERS[p];
      if (!loader) continue;
      const got = await loader(q, scope);
      out.tables = out.tables || {};
      for (const [url, t] of Object.entries(got)) {
        if (t.truncated) (out.truncated = out.truncated || []).push(url);
        out.tables[url] = { cols: t.cols, rows: t.rows };
      }
    }
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
