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
//            | members | agencies | commission | courses | tuition | elec (전용화면)
//     elecFrom,elecTo=YYYY-MM-DD  elecRoom=i_idx   ELEC & WATER 기간·방
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
const MAX_CHGREF = 3000;    // 변경환불 접수(2025-01-01 이후 실측 2,247건) — 상한 여유

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
// studentsFull: 화면이 쓰는 31칸 배열 순서
//  0 AGENCY 1 NAT 2 NAME(EN) 3 KOR 4 AGE 5 SEX 6 APPLY 7 DEPA 8 BEGIN 9 END
//  10 PERI 11 STATUS 12 COURSE 13 ROOM 14 CAMPUS 15 항공/픽업 16 항공(변경전) 17 여권생일
//  18 SID(s_idx) 19 COURSE_TXT(fee_class2) 20 DORM_TXT(fee_dorm2) 21 AGENT_CMT(s_info) 22 STAFF_CMT(comment)
//  18~22 는 레거시 ROOM REPLACEMENT(reserve_move.php) 학생정보 표를 그대로 재현하기 위해 추가.
//  코멘트 2칸은 text 라 페이로드가 커질 수 있어 400자로 자른다(표시 전용).
//  23~30 은 행정팀 요청(A3 센터수납 현장결제 · A5 완납확인)용 납부칸 — 레거시 student_info 원값.
//   23 PAY_STATUS(N 미납/Y 완납/X 분납/R 반환, 빈값 다수) 24 PAY_CHANNEL(account/center)
//   25 EX_DATE(환율적용일) 26 EX_RATE(적용환율) 27 CPAY_AMT(센터납부금액) 28 CPAY_UNIT(기본 peso)
//   29 CPAY_DATE(센터납부일) 30 CPAY_MEMO(센터납부 메모)
const STUDENT_COLS = ["AGENCY", "NAT", "NAME_EN", "KOR", "AGE", "SEX", "APPLY", "DEPA", "BEGIN", "END",
  "PERI", "STATUS", "COURSE", "ROOM", "CAMPUS", "FLIGHT", "FLIGHT_PREV", "BIRTH",
  "SID", "COURSE_TXT", "DORM_TXT", "AGENT_CMT", "STAFF_CMT",
  "PAY_STATUS", "PAY_CHANNEL", "EX_DATE", "EX_RATE", "CPAY_AMT", "CPAY_UNIT", "CPAY_DATE", "CPAY_MEMO"];

// 레거시 날짜칸은 varchar(''·'0000-00-00' 혼재) → 형식 맞는 값만 통과
const D = (col) => `case when ${col} ~ '^\\d{4}-\\d{2}-\\d{2}' then left(${col},10) else '' end`;

// 자유입력 필드(요청사항·사유·코멘트·게시글 제목) 마스킹.
// 담당자가 본문에 연락처를 적어두는 관행이 있어 길이 절단만으로는 PII 가 그대로 나간다.
// 이메일 전체와 전화번호 형태(3-3/4-4 구분자 허용, 또는 9자리 이상 연속 숫자)만 가린다.
// 날짜(2026-07-13)는 패턴이 달라 보존된다.
const MASKFREE = (expr) => `regexp_replace(regexp_replace(regexp_replace(
    ${expr},
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '***@***', 'g'),
    '\\d{3}[- ]?\\d{3,4}[- ]?\\d{4}', '***-****', 'g'),
    '\\d{9,}', '*********', 'g')`;

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
            left(coalesce(s_info,''),400) a21, left(coalesce("comment",''),400) a22,
            upper(trim(coalesce(pay_status,''))) a23, lower(trim(coalesce(pay_channel,''))) a24,
            ${D("exchange_date")} a25, trim(coalesce(exchange_rate,'')) a26,
            trim(coalesce(center_pay_amount,'')) a27, lower(trim(coalesce(center_pay_unit,''))) a28,
            ${D("center_pay_date")} a29, left(coalesce(center_pay_memo,''),250) a30
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
      r.a18 ? String(r.a18) : "", r.a19.trim(), r.a20.trim(), r.a21.trim(), r.a22.trim(),
      r.a23, r.a24, r.a25, r.a26, r.a27, r.a28, r.a29, r.a30.trim()]),
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
    // si: 예약주체 s_idx — 학생정보 모달의 DORMITORY RESERVED INFORMATION(레거시 student_room.php)에서
    //     동명이인·연장(별도 s_idx) 예약을 섞지 않고 정확히 그 학생의 예약행만 뽑는 데 사용
    const seg = { s: s.s, e: s.e, nm: who.nm, si: s.s_idx, st: s.st === "I" ? "" : s.st, et: s.et === "I" ? "" : s.et };
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
    // rid: legacy room_list.r_idx — 침대 고유키(방배정·방변경에서 셀→예약행 역추적용).
    //      SQL 별칭 ri(=room_info) 및 화면의 방 인덱스 ri 와는 무관하다.
    room.beds.push({ rid: b.r_idx, name: "", segs: segsForBed });
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

// chgref: 변경환불홀딩 접수 목록(student_list_change.php) — 행정팀 요청 A4
//   원천 legacy.student_change(26,857행) ⨝ legacy.student_info(영문명·상태)
//   · 유형칸 판정(레거시 화면 컬럼과 동일한 5종):
//     CHANGE=코스 변경(old≠new) · ADD=추가코스 · ETC=기타비용 · REFUND=환불액 · HOLDING=홀딩액
//     ⚠ 기숙사는 old/new 컬럼 의미가 달라(old=room_list.r_idx, new=기숙사인실) 대소비교가 불가하므로
//       CHANGE 판정에 쓰지 않는다. 기숙사 변경내역은 건별 상세(A2 서류폼)에서 다룬다.
//   · info_etc_title 등 tinytext 에 개행이 섞여 있어 한 줄로 정리(표시 전용).
//   · apply_date 는 '2026-07-13(18:18:12)' 형태라 앞 10자만 날짜로 쓴다.
const CHGREF_COLS = ["IDX", "SID", "AGENCY", "NAME_EN", "STUDENT", "APPLY", "CENTER",
  "CHANGE", "ADD_COURSE", "ETC_FEE", "REFUND", "HOLDING",
  "PROCESS", "RESULT", "DUE", "COMPLETE", "MANAGER", "PERIOD", "GAP"];

async function loadChgref(q, scope) {
  const params = [SLICE_FROM];
  let agencyWhere = "";
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` and lower(coalesce(sc.uhak_id,'')) = lower($${params.length})`; }
  // 개행·중복공백 제거용(표시 전용). 원본은 건드리지 않는다.
  const L = (col) => `btrim(regexp_replace(coalesce(${col},''), '\\s+', ' ', 'g'))`;
  const { rows } = await q(
    `select sc.change_idx idx, sc.s_idx sid, coalesce(sc.uhak_id,'') agency,
            coalesce(nullif(${L("si.e_name")},''), ${L("sc.k_name")}) name_en,
            coalesce(nullif(${L("si.k_name")},''), ${L("sc.k_name")}) student,
            left(coalesce(sc.apply_date,''),10) apply, upper(coalesce(sc.apply_sme_campus,'')) center,
            case when ${L("sc.info_course_old_detail")} <> ${L("sc.info_course_new_detail")}
                 then 'COURSE' else '' end chg,
            ${L("sc.info_add_detail")} add_course,
            left(${L("sc.info_etc_title")},60) etc_fee,
            ${L("sc.info_refund_amount")} refund,
            ${L("sc.info_holding_amount")} holding,
            lower(${L("sc.info_process")}) process, lower(${L("sc.info_result")}) result,
            ${D("sc.info_due_date")} due, ${D("sc.info_complete_date")} complete,
            ${L("sc.apply_sme_manager")} manager,
            ${L("sc.origin_period")} period,
            ${L("sc.change_gap_price")} gap
       from legacy.student_change sc
       left join legacy.student_info si on si.s_idx = sc.s_idx
      where left(coalesce(sc.apply_date,''),10) >= $1${agencyWhere}
      order by sc.change_idx desc
      limit ${MAX_CHGREF}`, params);
  return {
    cols: CHGREF_COLS,
    rows: rows.map((r) => [String(r.idx), String(r.sid || ""), r.agency, r.name_en, r.student,
      r.apply, r.center, r.chg, r.add_course, r.etc_fee, r.refund, r.holding,
      r.process, r.result, r.due, r.complete, r.manager, r.period, r.gap]),
  };
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
            ${MASKFREE(`coalesce(sp.comment,'')`)} comments,
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
              case when position('secret' in coalesce(wr_option,'')) > 0 then '[secret]'
                   else ${MASKFREE(`coalesce(nullif(btrim(wr_subject),''),'(제목없음)')`)} end a1,
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
            left(${MASKFREE(`regexp_replace(coalesce(d.d_text,''), '[\\r\\n\\t]+', ' ', 'g')`)}, 200) a6,
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
            left(${MASKFREE(`regexp_replace(coalesce(purpose,''), '[\\r\\n\\t]+', ' ', 'g')`)}, 120) a9,
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
// ════════════════════════════════════════════════════════════════════════════
// 전용화면 조각 — 회원관리 · COMMISSION · COURSE LIST · TUITION FEE · ELEC & WATER
// 응답은 out.<part> (표 폴백 out.tables 와 다른 경로). SMEAG-5SCREENS-2026-07-30
// ════════════════════════════════════════════════════════════════════════════
// ═══ deploy/api/data.js 에 붙일 loader — members (회원관리 / member_list.php) ═══
//  · 소스: cms.g4_member (실측 2,053행) ⨝ legacy.student_info(유학원별 학생수) ⨝ legacy.uhak_agency_com(커미션건수)
//  · 읽기 전용(select 만). 원본 무변경.
//  · 개인정보 비노출(절대): mb_password, mb_jumin, mb_password_q, mb_password_a, mb_lost_certify,
//    mb_birth, mb_zip1/2, mb_addr1/2(상세주소), mb_4/mb_5(은행·계좌번호) → 쿼리에 넣지 않는다.
//  · kind(구분) 계산 근거:
//      ADMIN  = mb_level >= 8  (app.member_authenticate 의 force_th=8 = 관리자 강제 비번변경 기준)
//      AGENCY = mb_10(유학원코드) 있음 ∨ student_info.uhak_id 존재 ∨ uhak_agency_com.mb_id 존재
//      STAFF  = 그 외
//  · 스코프: 유학원 계정(scope.agency)은 자기 계정 1행만 본다(다른 유학원·직원 계정 PII 차단).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MEMBERS = 3000;      // 실측 2,053행 → 전량 반환 가능(상한만 방어적으로 둠)

async function loadMembers(q, scope) {
  const params = [MAX_MEMBERS];
  let own = "";
  const ag = scope && scope.agency;
  if (ag) { params.push(S(ag)); own = ` where lower(m.mb_id) = lower($${params.length})`; }
  const { rows } = await q(
    `with stu as (   -- 유학원 계정별 학생수(연결 근거: student_info.uhak_id = g4_member.mb_id)
        select lower(coalesce(uhak_id,'')) a, count(*) n
          from legacy.student_info where coalesce(uhak_id,'') <> '' group by 1),
      com as (      -- 커미션 규칙/이력 건수(uhak_agency_com.mb_id = g4_member.mb_id)
        select lower(mb_id) a, count(*) n from legacy.uhak_agency_com group by 1),
      grp as (      -- 레거시 회원목록 '그룹' 칸 = 그룹접근권한 건수(g4_group_member)
        select lower(mb_id) a, count(*) n from cms.g4_group_member group by 1),
      med as (      -- 신전산 수정 오버레이(app.member_edits) — 원본 대신 이 값을 덮어 보여준다
        select lower(mb_id) a, patch from app.member_edits),
      ovr as (      -- 권한 오버라이드(유효권한 = max(레거시, 오버라이드))
        select lower(mb_id) a, mb_level from app.member_level_override where active)
     select m.mb_id id,
            coalesce(nullif(med.patch->>'mb_name',''), m.mb_name, '') name,
            coalesce(nullif(med.patch->>'mb_nick',''), m.mb_nick, '') nick,
            greatest(coalesce(m.mb_level,0), coalesce(ovr.mb_level,0)) level,
            case when coalesce(m.mb_level,0) >= 8 then 'ADMIN'
                 when coalesce(m.mb_10,'') <> '' or stu.a is not null or com.a is not null then 'AGENCY'
                 else 'STAFF' end kind,
            coalesce(nullif(med.patch->>'mb_email',''), m.mb_email, '') email,
            coalesce(nullif(btrim(coalesce(med.patch->>'mb_hp', m.mb_hp)),''),
                     nullif(btrim(coalesce(med.patch->>'mb_tel', m.mb_tel)),''),
                     nullif(btrim(coalesce(med.patch->>'mb_6', m.mb_6)),''), '') phone,
            coalesce(m.mb_sns,'') sns,
            coalesce(nullif(btrim(coalesce(med.patch->>'mb_7', m.mb_7)),''), '') agency,  -- mb_7 = 유학원 표기명
            lower(coalesce(nullif(med.patch->>'mb_8',''), m.mb_8, '')) comm,   -- percent | amount
            coalesce(nullif(med.patch->>'mb_9',''), m.mb_9, '') commval,
            case when m.mb_3 ~ '^\\d{4}-\\d{2}-\\d{2}' then left(m.mb_3,10) else '' end contract,
            coalesce(stu.n,0) students, coalesce(com.n,0) comms,
            coalesce(m.mb_recommend,0) recommend,               -- 유학원 등록실적 계산용
            coalesce(m.mb_11,0) weight,                         -- 유학원 비중 수치화
            case when coalesce(med.patch->>'mb_leave_date', m.mb_leave_date, '') <> '' then 'leave'
                 when coalesce(med.patch->>'mb_intercept_date', m.mb_intercept_date, '') <> ''
                   or lower(coalesce(m.mb_memo_call,'')) = 'block' then 'block'
                 else 'normal' end status,
            coalesce(to_char(m.mb_datetime,'YYYY-MM-DD'),'') joined,
            coalesce(to_char(m.mb_today_login,'YYYY-MM-DD HH24:MI'),'') login,
            coalesce(m.mb_login_ip,'') ip,
            left(regexp_replace(coalesce(med.patch->>'mb_memo', m.mb_memo, ''), '\\s+', ' ', 'g'), 160) memo,
            -- ↓ 레거시 member_list.php 표 칸(그누보드4 원본 컬럼 그대로)
            coalesce(m.mb_point,0) point,                       -- 포인트
            case when coalesce(med.patch->>'mb_mailling', m.mb_mailling::text, '0') <> '0' then 1 else 0 end mailling,
            case when coalesce(med.patch->>'mb_open', m.mb_open::text, '0') <> '0' then 1 else 0 end "open",
            case when m.mb_email_certify is not null then 1 else 0 end certify,    -- 인증
            case when coalesce(med.patch->>'mb_intercept_date', m.mb_intercept_date, '') <> '' then 1 else 0 end intercept,
            coalesce(grp.n,0) "groups",                         -- 그룹접근권한 건수
            coalesce(med.patch->>'mb_leave_date', m.mb_leave_date, '') leave_date,
            case when med.a is not null or ovr.a is not null then 1 else 0 end edited  -- 신전산 수정분 존재
       from cms.g4_member m
       left join stu on stu.a = lower(m.mb_id)
       left join com on com.a = lower(m.mb_id)
       left join grp on grp.a = lower(m.mb_id)
       left join med on med.a = lower(m.mb_id)
       left join ovr on ovr.a = lower(m.mb_id)${own}
      order by coalesce(m.mb_today_login, m.mb_datetime) desc nulls last, m.mb_no desc
      limit $1`, params);
  return rows.map((r) => ({ ...r, level: Number(r.level), students: Number(r.students),
    comms: Number(r.comms), recommend: Number(r.recommend), weight: Number(r.weight),
    point: Number(r.point), groups: Number(r.groups),
    mailling: Number(r.mailling), open: Number(r.open),
    certify: Number(r.certify), intercept: Number(r.intercept), edited: Number(r.edited) }));
}

// ═══ AGENCY LIST — 레거시 adm/uhak_agency_list.php (CONTRACTED LIST) ════════
//  · 소스: cms.g4_member (유학원 계정) — 레거시 유학원 정보는 별도 테이블이 아니라
//    회원 테이블의 여분필드에 들어 있다. 실측으로 확인한 칸 대응(레거시 화면·수정폼 대조):
//      CATE       = mb_10 이 자기 아이디(또는 비어있음) → MAIN, 다른 유학원 아이디면 BRANCH(지사)
//      ID         = mb_id            AGENCY NAME = mb_name        MAIN ID   = mb_10(대표유학원)
//      e-MAIL     = mb_email         APPLY       = mb_datetime    BANK      = mb_4(은행명)
//      ACCOUNT    = mb_5(계좌번호)   CONSULTANT  = mb_2(담당자)   CELL/OFFICE = mb_hp / mb_tel
//    수정폼 전용 칸: mb_1 사업자번호 · mb_3 등록일 · mb_6 팩스 · mb_7 지사 ·
//                    mb_8/mb_9 커미션(방식/값) · mb_11 유학원비중 · mb_sns · mb_addr(City)
//  · 유학원 판정은 loadMembers 의 kind='AGENCY' 와 같은 근거를 쓴다(mb_10 ∨ 학생 ∨ 커미션 ∨ Lv5).
//  · 정렬은 레거시 화면과 같이 유학원명(mb_name) 오름차순. 한 페이지 15행은 화면에서 자른다.
//  · 신전산 수정분(app.member_edits)을 레거시 값 위에 덮어 보여준다. 원본(cms.g4_member) 불변.
//  · 유학원 계정 스코프는 자기 1행만(다른 유학원 계좌·연락처 차단).
//  · 읽기 전용(select 만).
const MAX_AGENCIES = 3000;

async function loadAgencies(q, scope) {
  const params = [MAX_AGENCIES];
  let own = "";
  const ag = scope && scope.agency;
  if (ag) { params.push(S(ag)); own = ` and lower(m.mb_id) = lower($${params.length})`; }
  const { rows } = await q(
    `with stu as (
        select lower(coalesce(uhak_id,'')) a, count(*) n
          from legacy.student_info where coalesce(uhak_id,'') <> '' group by 1),
      com as (
        select lower(mb_id) a, count(*) n from legacy.uhak_agency_com group by 1),
      med as (
        select lower(mb_id) a, patch from app.member_edits)
     select m.mb_id id,
            coalesce(nullif(med.patch->>'mb_name',''), m.mb_name, '') name,
            coalesce(nullif(med.patch->>'mb_10',''), m.mb_10, '') main,
            coalesce(nullif(med.patch->>'mb_email',''), m.mb_email, '') email,
            coalesce(to_char(m.mb_datetime,'YYYY-MM-DD HH24:MI:SS'),'') apply,
            coalesce(nullif(med.patch->>'mb_4',''), m.mb_4, '') bank,
            coalesce(nullif(med.patch->>'mb_5',''), m.mb_5, '') account,
            coalesce(nullif(med.patch->>'mb_2',''), m.mb_2, '') consultant,
            coalesce(nullif(med.patch->>'mb_hp',''), m.mb_hp, '') cell,
            coalesce(nullif(med.patch->>'mb_tel',''), m.mb_tel, '') office,
            coalesce(nullif(med.patch->>'mb_6',''), m.mb_6, '') fax,
            coalesce(nullif(med.patch->>'mb_7',''), m.mb_7, '') branch,
            lower(coalesce(nullif(med.patch->>'mb_8',''), m.mb_8, '')) comm,
            coalesce(nullif(med.patch->>'mb_9',''), m.mb_9, '') commval,
            coalesce(m.mb_level,0) level,
            coalesce(stu.n,0) students, coalesce(com.n,0) comms,
            case when coalesce(med.patch->>'mb_leave_date', m.mb_leave_date, '') <> '' then 1 else 0 end left_out,
            case when med.a is not null then 1 else 0 end edited
       from cms.g4_member m
       left join stu on stu.a = lower(m.mb_id)
       left join com on com.a = lower(m.mb_id)
       left join med on med.a = lower(m.mb_id)
      where (coalesce(m.mb_10,'') <> '' or stu.a is not null or com.a is not null
             or coalesce(m.mb_level,0) = 5)
        and coalesce(m.mb_level,0) < 8${own}
      -- 레거시(MySQL utf8_general_ci)와 같은 차례: 대소문자 무시 + 문장부호도 코드값 그대로 비교.
      -- Postgres 기본 콜레이션은 문장부호를 무시해 '.'/'"' 로 시작하는 이름의 자리가 달라진다 → collate "C".
      order by lower(coalesce(nullif(med.patch->>'mb_name',''), m.mb_name, '')) collate "C" asc,
               m.mb_id asc
      limit $1`, params);
  return rows.map((r) => ({
    ...r,
    // CATE — 대표유학원(MAIN) / 지사(BRANCH). 레거시 목록의 CATE 칸과 같은 판정.
    cate: (!r.main || String(r.main).toLowerCase() === String(r.id).toLowerCase()) ? "MAIN" : "BRANCH",
    level: Number(r.level), students: Number(r.students), comms: Number(r.comms),
    left_out: Number(r.left_out), edited: Number(r.edited),
  }));
}

// ═══ 회원정보 수정 폼 1건 (레거시 adm/member_form.php) ═══════════════════════
//  · 목록(loadMembers)과 달리 **단건**만 조회한다. 레거시 수정폼에 실제로 그려지는 칸을 그대로 돌려준다.
//  · 인가: Lv8+(관리자·스태프) 또는 본인 계정. 그 외에는 handler 에서 403.
//    → 목록에는 절대 싣지 않는 칸(주소·생년월일·여분필드 4/5 = 은행·계좌)이 여기에만 들어가므로
//      "한 명씩, 권한 있는 사람만" 이라는 접근 형태를 유지한다(레거시 화면과 동일한 노출 범위).
//  · 절대 제외(레거시 폼에도 값이 안 보이는 것들): mb_password, mb_jumin,
//    mb_password_q, mb_password_a, mb_lost_certify.
//  · 읽기 전용(select 만). 원본 무변경.
async function loadMemberForm(q, id) {
  const { rows } = await q(
    `select m.mb_id id, coalesce(m.mb_name,'') name, coalesce(m.mb_nick,'') nick,
            coalesce(m.mb_level,0) level, coalesce(m.mb_point,0) point,
            coalesce(m.mb_email,'') email, coalesce(m.mb_homepage,'') homepage,
            coalesce(m.mb_tel,'') tel, coalesce(m.mb_hp,'') hp,
            coalesce(m.mb_zip1,'') zip1, coalesce(m.mb_zip2,'') zip2,
            coalesce(m.mb_addr1,'') addr1, coalesce(m.mb_addr2,'') addr2,
            coalesce(m.mb_sns,'') sns, coalesce(m.mb_addr,'') city,   -- 유학원 수정폼(SNS · City)
            coalesce(m.mb_logo,'') logo, coalesce(m.mb_birth,'') birth, coalesce(m.mb_sex,'') sex,
            case when coalesce(m.mb_mailling,0) <> 0 then 1 else 0 end mailling,
            case when coalesce(m.mb_sms,0) <> 0 then 1 else 0 end sms,
            case when coalesce(m.mb_open,0) <> 0 then 1 else 0 end "open",
            coalesce(m.mb_signature,'') signature, coalesce(m.mb_profile,'') profile,
            coalesce(m.mb_memo,'') memo,
            coalesce(to_char(m.mb_datetime,'YYYY-MM-DD HH24:MI:SS'),'') joined,
            coalesce(to_char(m.mb_today_login,'YYYY-MM-DD HH24:MI:SS'),'') login,
            coalesce(m.mb_ip,'') ip, coalesce(m.mb_login_ip,'') login_ip,
            coalesce(m.mb_leave_date,'') leave_date, coalesce(m.mb_intercept_date,'') intercept_date,
            coalesce(to_char(m.mb_email_certify,'YYYY-MM-DD HH24:MI:SS'),'') certify,
            coalesce(m.mb_recommend,0) recommend, coalesce(m.mb_memo_call,'') memo_call,
            coalesce(m.mb_1,'') f1, coalesce(m.mb_2,'') f2, coalesce(m.mb_3,'') f3,
            coalesce(m.mb_4,'') f4, coalesce(m.mb_5,'') f5, coalesce(m.mb_6,'') f6,
            coalesce(m.mb_7,'') f7, coalesce(m.mb_8,'') f8, coalesce(m.mb_9,'') f9,
            coalesce(m.mb_10,'') f10, coalesce(m.mb_11::text,'') f11,
            (select count(*) from cms.g4_group_member gm
              where lower(gm.mb_id) = lower(m.mb_id)) groups
       from cms.g4_member m
      where lower(m.mb_id) = lower($1)
      limit 1`, [S(id)]);
  if (!rows.length) return null;
  const r = rows[0];
  const out = { ...r, level: Number(r.level), point: Number(r.point), groups: Number(r.groups),
    mailling: Number(r.mailling), sms: Number(r.sms), open: Number(r.open),
    recommend: Number(r.recommend) };
  // 신전산 수정분(app.member_edits) 을 레거시 값 위에 덮어서 보여준다. 원본은 그대로.
  // edited: 어느 칸이 신전산에서 바뀌었는지(화면에서 '변경됨' 표시용)
  out.edited = [];
  try {
    const e = await q(
      `select coalesce(e.patch,'{}'::jsonb) patch,
              coalesce(to_char(e.updated_at,'YYYY-MM-DD HH24:MI'),'') updated_at,
              coalesce(e.updated_by,'') updated_by,
              coalesce((select o.mb_level from app.member_level_override o
                         where o.active and lower(o.mb_id) = lower($1)),0) lv_override
         from app.member_edits e where lower(e.mb_id) = lower($1)`, [S(id)]);
    const row = e.rows[0] || {};
    const patch = row.patch || {};
    for (const [k, v] of Object.entries(patch)) {
      const f = MEMBER_FORM_FIELD[k];
      if (!f) continue;
      out[f] = MEMBER_NUM_FIELD.has(f) ? Number(v) : v;
      out.edited.push(f);
    }
    if (Number(row.lv_override) > 0) { out.level = Number(row.lv_override); out.edited.push("level"); }
    if (row.updated_at) { out.edited_at = row.updated_at; out.edited_by = row.updated_by; }
  } catch (_) { /* app.member_edits 미설치 환경 → 레거시 값 그대로 */ }
  return out;
}

// cms.g4_member 컬럼 → 폼 응답 필드명 (app.member_edits.patch 키가 앞쪽)
const MEMBER_FORM_FIELD = {
  mb_name: "name", mb_nick: "nick", mb_email: "email", mb_homepage: "homepage",
  mb_tel: "tel", mb_hp: "hp", mb_zip1: "zip1", mb_zip2: "zip2", mb_addr1: "addr1",
  mb_addr2: "addr2", mb_birth: "birth", mb_sex: "sex", mb_mailling: "mailling",
  mb_sms: "sms", mb_open: "open", mb_signature: "signature", mb_profile: "profile",
  mb_memo: "memo", mb_leave_date: "leave_date", mb_intercept_date: "intercept_date",
  mb_1: "f1", mb_2: "f2", mb_3: "f3", mb_4: "f4", mb_5: "f5", mb_6: "f6",
  mb_7: "f7", mb_8: "f8", mb_9: "f9", mb_10: "f10", mb_11: "f11",
  mb_sns: "sns", mb_addr: "city",
};
const MEMBER_NUM_FIELD = new Set(["mailling", "sms", "open"]);

// ═══ data.js 에 추가할 loader — COMMISSION (uhak_agency_commission.php) ═══════
// 소스: legacy.uhak_agency_com (4,004행) ⨝ cms.g4_member (mb_id → 유학원명)
// 반환: { cols, rows } — loadStudents 와 같은 "칸 배열" 형태(화면 CM_I 인덱스와 1:1)
// 상한: MAX_COMMISSION(5,000) — 실측 4,004행 전량 통과. 응답 ≈ 0.6MB, 조회 ≈ 0.4초.
//
// 실측 근거(전량 미사용 컬럼이라 select 하지 않음):
//   uhak_idx = '' (distinct 1) · percent = '' (4,004/4,004) · before_percent = '0' (4,004/4,004)
//   end_date = null (4,004) · student = null (4,004) · payYN = 'N' (4,004)
// → 계약값은 com_amt 한 칸뿐. com_category('percent'|'amount') 로 %/금액을 구분한다.
// com_amt 는 varchar 이며 잡값 3건('26%' 1건 · '300,000' 2건, 전부 amount)이 있어 숫자용 칸(a4/a5)은
// 정규식으로 숫자만 남긴 값을, 원문은 a14(AMOUNT_RAW)로 함께 싣는다.
// 화면(cmValue)은 숫자칸이 빈 경우 a14 원문을 그대로 노출한다(CM_I.raw).
//
// 실행 검증(QA, 읽기 전용): 전체 4,004행 / 0.65초 / JSON 0.62MB · scope='bonbon' 6행 / 0.15초.
// g4_member.mb_id 중복 0건 → left join 이 행수를 늘리지 않음(4,004 유지).
// D() 는 data.js:125 의 기존 헬퍼(varchar 날짜 형식검증)이며 check_date/confirm_date 는 둘 다 varchar.

const MAX_COMMISSION = 5000;

const COMMISSION_COLS = ["NO", "AGENCY_ID", "AGENCY", "CATEGORY", "PERCENT", "AMOUNT", "MANAGER",
  "CONFIRM", "STATE", "STUDENT", "REG", "NOW", "AGREE", "MEMO", "AMOUNT_RAW"];

async function loadCommission(q, scope) {
  const params = [MAX_COMMISSION];
  let agencyWhere = "";
  // 유학원 계정: 자기 유학원 계약만(다른 유학원의 커미션 조건은 영업기밀 → 절대 노출 금지)
  if (scope.agency) { params.push(scope.agency); agencyWhere = ` where lower(coalesce(a.mb_id,'')) = lower($${params.length})`; }
  const { rows } = await q(
    `select a.no::text a0, coalesce(btrim(a.mb_id),'') a1,
            coalesce(nullif(btrim(m.mb_name),''), nullif(btrim(m.mb_nick),''), btrim(a.mb_id), '') a2,
            lower(btrim(coalesce(a.com_category,''))) a3,
            coalesce(nullif(regexp_replace(coalesce(a.com_amt,''),'[^0-9.]','','g'),''),'') a45,
            coalesce(btrim(a.manager),'') a6,
            ${D("a.confirm_date")} a7, upper(btrim(coalesce(a.state,''))) a8,
            coalesce(a.student::text,'') a9,
            ${D("a.check_date")} a10, upper(btrim(coalesce(a."nowYN",''))) a11,
            upper(btrim(coalesce(a.agree,''))) a12,
            coalesce(btrim(a.content),'') a13, coalesce(btrim(a.com_amt),'') a14
       from legacy.uhak_agency_com a
       left join cms.g4_member m on m.mb_id = a.mb_id${agencyWhere}
      order by a.no desc
      limit $1`, params);
  return {
    cols: COMMISSION_COLS,
    rows: rows.map((r) => [r.a0, r.a1, r.a2, r.a3,
      r.a3 === "percent" ? r.a45 : "",      // PERCENT (정율 계약일 때만)
      r.a3 === "amount" ? r.a45 : "",       // AMOUNT  (정액 계약일 때만)
      r.a6, r.a7, r.a8, r.a9, r.a10, r.a11, r.a12, r.a13, r.a14]),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// deploy/api/data.js 에 붙일 loader — COURSE LIST (course_list.php)
//   소스: legacy.course_info(실측 71행) + legacy.course_category(실측 14행)
//   반환: { cats:[{gid,name,display,order,type}], rows:[{idx,gid,ko,en,limit,order,
//                pay,cn,jp,tw,vt,ru,sa,mgl,etc,info,state,campus}] }
//   · 전량 71행이라 상한 걱정이 없지만 방어적으로 MAX_COURSES 상한을 둔다.
//   · 정렬은 화면 규약 그대로 서버에서 확정: 카테고리 g_order → 코스 c_order → i_idx.
//   · 유학원 계정(scope.agency)도 그대로 전량 허용 — 코스 마스터는 PII 가 아니고
//     유학원 포털(agency_page.php)에서도 코스 선택에 필요한 공개 카탈로그다.
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_COURSES = 500;          // 상단 상수 블록(MAX_DEPOSITS 옆)에 함께 두면 좋음

// courses: 코스 마스터(카테고리 + 코스). scope 무관(공개 카탈로그).
async function loadCourses(q, scope) {
  const { rows: catRows } = await q(
    `select g_idx gid, coalesce(g_name,'') name, upper(coalesce(g_display,'')) display,
            coalesce(g_order,9999) "order", upper(coalesce(g_type,'')) type
       from legacy.course_category
      order by coalesce(g_order,9999), g_idx`);
  const { rows: courseRows } = await q(
    `select ci.i_idx idx, ci.g_idx gid,
            btrim(coalesce(ci.i_name,''))    ko,
            btrim(coalesce(ci.i_name_en,'')) en,
            coalesce(ci.i_limit,0)  "limit",
            coalesce(ci.c_order,9999) "order",
            coalesce(ci.i_pay,0)     pay,
            coalesce(ci.i_pay_cn,0)  cn,  coalesce(ci.i_pay_jp,0)  jp,
            coalesce(ci.i_pay_tw,0)  tw,  coalesce(ci.i_pay_vt,0)  vt,
            coalesce(ci.i_pay_ru,0)  ru,  coalesce(ci.i_pay_sa,0)  sa,
            coalesce(ci.i_pay_mgl,0) mgl, coalesce(ci.i_pay_etc,0) etc,
            btrim(coalesce(ci.i_info,''))   info,
            upper(coalesce(ci.i_state,''))  state,
            upper(coalesce(ci.s_campus,'')) campus
       from legacy.course_info ci
       left join legacy.course_category cc on cc.g_idx = ci.g_idx
      order by coalesce(cc.g_order,9999), coalesce(ci.c_order,9999), ci.i_idx
      limit $1`, [MAX_COURSES]);
  const N = (v) => Number(v || 0);
  return {
    cats: catRows.map((c) => ({
      gid: N(c.gid), name: c.name, display: c.display, order: N(c.order), type: c.type,
    })),
    rows: courseRows.map((r) => ({
      idx: N(r.idx), gid: N(r.gid), ko: r.ko, en: r.en,
      limit: N(r.limit), order: N(r.order),
      pay: N(r.pay), cn: N(r.cn), jp: N(r.jp), tw: N(r.tw), vt: N(r.vt),
      ru: N(r.ru), sa: N(r.sa), mgl: N(r.mgl), etc: N(r.etc),
      info: r.info, state: r.state, campus: r.campus,
    })),
  };
}

// ═══ deploy/api/data.js 에 붙일 loader — parts=tuition ═════════════════════════
//  · 소스: legacy.tution_fee(100행, 일본시장 주차별 요금) ⨝ legacy.course_info(코스명)
//  · 실측: 100행 / 코스 25종 / week ∈ {1,2,3,4} / (course,week) 중복 0 / 고아행 0
//  · 전량(100행) 반환해도 무해 — 그래도 방어적으로 MAX_TUITION 상한을 둔다.
//  · 요금표는 PII 아님 → scope.agency(유학원 계정) 제한 없음(전사 공통 마스터).

// ── (1) 상수: data.js 상단 상수 블록(MAX_DEPOSITS 옆)에 추가 ──────────────────
const MAX_TUITION = 500;

// ── (2) loader 본체: loadDeposits/loadChangelog 옆에 추가 ─────────────────────
// tuition: 일본시장 주차별 요금표(tution_fee ⨝ course_info)
async function loadTuition(q, scope) {                // scope 미사용(요금표는 PII 아님)
  const { rows } = await q(
    `select tf.idx,
            tf.course::text                        as course,
            coalesce(ci.i_name,'')                 as name,
            coalesce(ci.i_name_en,'')              as name_en,
            upper(coalesce(ci.i_state,''))         as state,
            upper(coalesce(ci.s_campus,''))        as campus,
            coalesce(ci.c_order, 999999)           as "order",
            tf.week, tf.agency_jp, tf.student_jp
       from legacy.tution_fee tf
       left join legacy.course_info ci on ci.i_idx = tf.course
      order by coalesce(ci.c_order,999999), tf.course, tf.week
      limit $1`, [MAX_TUITION]);
  const out = rows.map((r) => ({
    idx: Number(r.idx), course: S(r.course), name: r.name, name_en: r.name_en,
    state: r.state, campus: r.campus, order: Number(r.order),
    week: Number(r.week), agency: Number(r.agency_jp), student: Number(r.student_jp),
  }));
  const weeks = [...new Set(out.map((r) => r.week))].sort((a, b) => a - b);
  const courses = [...new Set(out.map((r) => r.course))];
  // 고아행(course_info 에 없는 course) — 실측 0건. 생기면 name 이 빈값이므로 클라이언트가 '#코드'로 표시.
  const orphans = out.filter((r) => !r.name && !r.name_en).map((r) => r.course);
  return { rows: out, weeks, courseCount: courses.length, total: out.length,
    orphans: [...new Set(orphans)], currency: "JPY",
    truncated: out.length >= MAX_TUITION };   // 상한 절단이면 화면에 경고 배너를 띄운다
}

// ============================================================================
// elec — ELEC & WATER (레거시 room_elec.php) 용 loader
// deploy/api/data.js 에 그대로 붙여넣는다(ESM, 외부 의존 없음).
// ----------------------------------------------------------------------------
// legacy.room_elec 은 1,670,841행(268MB) → 절대 전량 반환 금지.
// 서버에서 기간(from~to) 내 검침행을 방(i_idx) 단위로 집계해 최대 1,127행(방 수)만 반환한다.
// 일자별 추이는 방 하나를 클릭했을 때만 elecRoom=i_idx 로 따로 요청(≤ 기간일수 행).
// 읽기 전용(select only).
// ----------------------------------------------------------------------------
// ⚠️⚠️ 이름 충돌 경고 (QA 리뷰 중 발견 — 다른 작업분이 data.js 에 먼저 들어옴)
// 현재 deploy/api/data.js 에는 **이미 `async function loadElec(q)` 가 있다**(ELEC_COLS 기반
// room_elec 원본 최근 500행을 out.tables["room_elec.php"] 로 내리는 spec 폴백용 블록,
// `TABLE_LOADERS = { ..., elec: loadElec, ... }` · `ALL_PARTS` 에 "elec" 등록됨).
//   · 같은 이름의 top-level function 을 또 선언하면 ESM 모듈 전체가 SyntaxError
//     ("Identifier 'loadElec' has already been declared") → /api/data 전부 사망.
//   · 그래서 이 파일의 loader 이름을 **loadElecMeter** 로 바꿔 두었다.
// 통합 방법 (택1):
//   A. 권장 — 전용 렌더러가 spec 폴백을 대체하므로 기존 블록을 제거한다:
//      `ELEC_COLS` + 기존 `loadElec` 삭제, `TABLE_LOADERS` 에서 `elec: loadElec` 삭제.
//      `ALL_PARTS` 의 "elec" 은 그대로 두고 아래 4)번 분기(out.elec)로 처리 → 화면·notes 배선 그대로.
//   B. 둘 다 유지하려면 이 조각의 part 이름을 "elecmeter" 로 바꾸고
//      R.elec__init 의 liveSync({parts:['elec']}) · LIVE_PARTS · liveHave · qs 분기까지 모두 elecmeter 로 통일.
//      (응답 키는 어느 쪽이든 out.elec = REAL.elec 이며 out.tables 와 충돌하지 않는다.)
// ============================================================================

const MAX_ELEC_SPAN_DAYS = 400;   // 기간 상한 — 전기간(20년) 집계는 18.5s 로 statement_timeout(20s) 위험
const ELEC_DAILY_MAX = 800;       // 일자별 추이 상한
const ELEC_SPIKE = 2000;          // 하루 검침 증가분 상한(정상 최대 관측치 227) — 초과분은 오타/계량기 교체로 보고 사용량에서 제외

// 레거시 fsearch.search_condition 값이 그대로 bldg_type: ''=ALL DORM · S=ENCANTO · C=CLASSIC · E=CAPITAL
// 단 room_category.bldg_type 실측값은 5종(C/E/F/P/S)이다 — 레거시 셀렉트에 없는 F(SPARTA)·P(PREMIUM)도
// ALL DORM 에는 포함되므로 표시명만 채워준다(i_state='Y' 836방 중 F 205 / P 는 비활성).
const ELEC_CAMPUS = { E: "CAPITAL", S: "ENCANTO", C: "CLASSIC", F: "SPARTA", P: "PREMIUM" };
const elecCampus = (b) => ELEC_CAMPUS[String(b || "").toUpperCase()] || "ETC";

// 기간 정규화: YYYY-MM-DD 두 개 → [from,to] (형식검증 + 뒤바뀜 교정 + 상한 클램프)
// isYmd/ymd 는 data.js 기존 유틸(중복 정의 금지).
function elecRange(from, to) {
  let f = isYmd(from) ? from : "", t = isYmd(to) ? to : "";
  if (!f && !t) { t = ymd(new Date()); f = t; }
  if (!f) f = t;
  if (!t) t = f;
  if (f > t) { const x = f; f = t; t = x; }
  const days = Math.round((Date.parse(t + "T00:00:00Z") - Date.parse(f + "T00:00:00Z")) / 86400000) + 1;
  if (days > MAX_ELEC_SPAN_DAYS) {
    const d = new Date(Date.parse(t + "T00:00:00Z") - (MAX_ELEC_SPAN_DAYS - 1) * 86400000);
    f = ymd(d);
  }
  return [f, t];
}

// 데이터 최신 검침일 — max(re_date) 는 인덱스가 없어 seq scan(1.1s) 이라
// pkey 역순 5,000행에서만 max 를 취한다(0.18s, 같은 값 '2026-07-13' 확인).
async function elecLatestDate(q) {
  const { rows } = await q(
    `select coalesce(max(re_date),'') d
       from (select re_date from legacy.room_elec order by re_idx desc limit 5000) t`);
  return (rows[0] && rows[0].d) || "";
}

// 방 단위 집계(화면 메인 표). 반환 행수 = room_info 중 (기간 내 검침 있음 ∪ i_state='Y') → 실측 836~1,099행.
//   used  : 일자별 증가분(delta) 중 0~ELEC_SPIKE 인 것만 합산 = 기간 사용량(kWh)
//   spikes: 상한 초과 delta 건수(계량기 교체·오타 의심) → 화면에서 CHECK 배지
//   charge: charge_gage 합계(레거시가 저장한 요금/1인당 사용량 값)
async function loadElecMeter(q, from, to, roomIdx) {
  const [f, t] = elecRange(from, to);
  const main = await q(
    `with src as (
       select i_idx, re_date, re_idx, re_gage, p_count, charge_gage, id_updater, update_timestamp
         from legacy.room_elec
        where re_date >= $1 and re_date <= $2),
     d as (
       select s.i_idx, s.re_date, s.re_gage,
              s.re_gage - lag(s.re_gage) over (partition by s.i_idx order by s.re_date, s.re_idx) dlt
         from src s where s.re_gage > 0),
     dd as (
       select i_idx,
              sum(case when dlt between 0 and $3 then dlt else 0 end) used,
              count(*) filter (where dlt > $3 or dlt < 0) spikes,
              count(*) days_g, min(re_date) d0, max(re_date) d1,
              (array_agg(re_gage order by re_date))[1] g0,
              (array_agg(re_gage order by re_date desc))[1] g1
         from d group by i_idx),
     a as (
       select i_idx, count(*) days,
              round(avg(nullif(p_count,0))::numeric, 2) avg_p, max(p_count) max_p,
              round(sum(charge_gage)::numeric, 2) charge,
              (array_agg(id_updater order by update_timestamp desc nulls last, re_idx desc))[1] last_by,
              coalesce(to_char(max(update_timestamp),'YYYY-MM-DD'),'') last_at
         from src group by i_idx)
     select ri.i_idx idx, coalesce(ri.i_name,'') room, coalesce(rc.g_name,'') grp,
            coalesce(nullif(ri.bldg_type,''), rc.bldg_type, '') bldg,
            coalesce(rc.g_type,'') gtype, coalesce(ri.i_limit,0) lim,
            coalesce(ri.i_state,'') state, coalesce(rc.g_display,'') disp,
            coalesce(a.days,0) days, coalesce(dd.days_g,0) days_g,
            coalesce(dd.d0,'') d0, coalesce(dd.d1,'') d1,
            coalesce(dd.g0,0) g0, coalesce(dd.g1,0) g1,
            coalesce(dd.used,0) used, coalesce(dd.spikes,0) spikes,
            a.avg_p, coalesce(a.max_p,0) max_p, coalesce(a.charge,0) charge,
            coalesce(a.last_by,'') last_by, coalesce(a.last_at,'') last_at
       from legacy.room_info ri
       left join legacy.room_category rc on rc.g_idx = ri.g_idx
       left join a  on a.i_idx  = ri.i_idx
       left join dd on dd.i_idx = ri.i_idx
      where a.i_idx is not null or ri.i_state = 'Y'
      order by coalesce(dd.used,0) desc, ri.i_name`,
    [f, t, ELEC_SPIKE]);

  const rows = main.rows.map((r) => ({
    idx: r.idx, room: r.room, grp: r.grp, bldg: r.bldg,
    campus: elecCampus(r.bldg), gtype: r.gtype, lim: Number(r.lim),
    state: r.state, disp: r.disp,
    days: Number(r.days), daysG: Number(r.days_g), d0: r.d0, d1: r.d1,
    g0: Number(r.g0), g1: Number(r.g1), used: Number(r.used), spikes: Number(r.spikes),
    avgP: r.avg_p == null ? null : Number(r.avg_p), maxP: Number(r.max_p),
    charge: Number(r.charge), lastBy: r.last_by, lastAt: r.last_at,
  }));

  // 요약칩(서버 계산 — 클라이언트 필터와 별개인 "기간 전체" 기준)
  const summary = {
    rooms: rows.length,
    metered: rows.filter((r) => r.days > 0).length,
    missing: rows.filter((r) => r.days === 0).length,
    used: rows.reduce((s, r) => s + r.used, 0),
    charge: Math.round(rows.reduce((s, r) => s + r.charge, 0) * 100) / 100,
    readings: rows.reduce((s, r) => s + r.days, 0),
    spikes: rows.reduce((s, r) => s + (r.spikes ? 1 : 0), 0),
  };

  const out = { window: { from: f, to: t }, spikeCap: ELEC_SPIKE, rows, summary };

  // 방 클릭 → 그 방의 일자별 검침 추이(별도 조각). i_idx 단독 조회도 seq scan 이라 같은 요청에 묶는다.
  if (roomIdx) {
    const one = await q(
      `select re_date "date", coalesce(re_gage,0) gage, coalesce(p_count,0) p,
              coalesce(charge_gage,0) charge, coalesce(id_updater,'') "by"
         from legacy.room_elec
        where i_idx = $1 and re_date >= $2 and re_date <= $3
        order by re_date limit $4`, [roomIdx, f, t, ELEC_DAILY_MAX]);
    let prev = null;
    out.daily = {
      idx: roomIdx,
      rows: one.rows.map((r) => {
        const g = Number(r.gage);
        const dlt = (prev != null && g > 0 && prev > 0) ? g - prev : null;
        if (g > 0) prev = g;
        return { date: r.date, gage: g, p: Number(r.p), charge: Number(r.charge), by: r.by,
          use: (dlt != null && dlt >= 0 && dlt <= ELEC_SPIKE) ? dlt : null };
      }),
    };
  }
  return out;
}

// ※ members·commission·courses·tuition·elec 는 전용 렌더러(응답 out.<part>)로 이관되어
//   표(out.tables) 로더에서 제외했다 — SMEAG-5SCREENS-2026-07-30
//   근거·배선: docs/design-admin/screens-2026-07-30/MERGE_PLAN.md
const TABLE_LOADERS = {
  points: loadPoints, visits: loadVisits,
  farmgym: loadFarmgym, boards: loadBoards,
  agencyvisit: loadAgencyvisit, dayoff: loadDayoff,
};

// 버전 스탬프: 최신 갱신 흔적(학생 timestamp · 예약 최대키 · 변경이력 최대키)
// 신규 명세화면 조각(members·boards·elec…)은 위 4개 테이블과 무관하게 바뀌므로, 요청한 조각에
// 해당하는 최대키를 함께 넣는다. 넣지 않으면 게시판에 새 글이 올라와도 stamp 가 그대로라
// ETag 가 안 바뀌고 클라이언트가 304 를 받아 옛 데이터를 '● DB 최신' 배지와 함께 계속 본다.
// 비용을 위해 전부 PK/인덱스 최대값만 쓰고, 요청한 조각의 것만 계산한다.
const PART_STAMP = {
  members: `coalesce((select max(mb_no) from cms.g4_member)::text,'')`,
  agencies: `coalesce((select max(mb_no) from cms.g4_member)::text,'')`,
  points: `coalesce((select max(po_id) from cms.g4_point)::text,'')`,
  visits: `coalesce((select max(vs_date) from cms.g4_visit_sum)::text,'')`,
  commission: `coalesce((select max(no) from legacy.uhak_agency_com)::text,'')`,
  courses: `coalesce((select max(i_idx) from legacy.course_info)::text,'')`,
  tuition: `coalesce((select max(idx) from legacy.tution_fee)::text,'')`,
  boards: `coalesce((select max(wr_id) from cms."g4_write_office_GAC")::text,'')
           || '/' || coalesce((select max(wr_id) from cms.g4_write_office_holding)::text,'')
           || '/' || coalesce((select max(wr_id) from cms.g4_write_office_share)::text,'')`,
  elec: `coalesce((select max(re_idx) from legacy.room_elec)::text,'')`,
  agencyvisit: `coalesce((select max(d_idx) from legacy.uhak_day_info)::text,'')`,
  dayoff: `coalesce((select max(id) from legacy.smeag_dayoff)::text,'')
           || '/' || coalesce((select max(id) from legacy.smeag_sched_info)::text,'')`,
  // farmgym 은 student_payment 기반 → 기존 sp_max 로 이미 감지됨
};
async function loadStamp(q, parts) {
  const extra = (parts || []).filter((p) => PART_STAMP[p]);
  const extraSel = extra.map((p, i) => `${PART_STAMP[p]} x${i}`).join(", ");
  const { rows } = await q(
    `select coalesce(to_char((select max("timestamp") from legacy.student_info),'YYYY-MM-DD"T"HH24:MI:SS'),'') si_ts,
            coalesce((select max(s_idx) from legacy.student_info)::text,'')      si_max,
            coalesce((select max(rr_idx) from legacy.room_reserve)::text,'')     rr_max,
            coalesce((select max(change_idx) from legacy.room_change_log)::text,'') cl_max,
            coalesce((select max(change_idx) from legacy.student_change)::text,'') sc_max,
            coalesce((select max(student_payment_ctr) from legacy.student_payment)::text,'') sp_max,
            -- 행정팀 수정(약속기한·확정·센터수납)은 새 행을 만들지 않고 기존 행의 칸만 바꾼다.
            -- 위 max(PK) 들로는 그 변경을 감지할 수 없어 저장 후에도 캐시가 옛 값을 돌려줬다.
            -- 저장 1건마다 증가하는 감사 시퀀스를 스탬프에 넣어 캐시를 정확히 무효화한다.
            coalesce((select max(audit_id) from app.write_audit)::text,'') wa_max
            ${extraSel ? "," + extraSel : ""}`);
  const r = rows[0] || {};
  const out = { si_ts: r.si_ts, si_max: r.si_max, rr_max: r.rr_max, cl_max: r.cl_max, sc_max: r.sc_max,
                sp_max: r.sp_max, wa_max: r.wa_max };
  extra.forEach((p, i) => { out[p] = r["x" + i]; });
  return out;
}

// ── 인가(authorization) ──────────────────────────────────────────────────────
// 레거시 로그인은 cms.g4_member 전체(2,000여 계정, 레벨 제한 없음)를 통과시킨다. 즉 로그인에
// 성공했다는 사실만으로는 아무것도 보증하지 않는다. 그래서 조각마다 최소 레벨을 둔다.
//   internal : 내부 운영자료(회원명부·포인트·접속통계·게시판·직원휴무·전기수도·커미션·변경이력) → Lv8+
//   business : 학생/기숙사 업무 → Lv8+ 또는 '유학원 스코프가 확정된' 계정(자기 유학원만 조회)
//   master   : 코스·학비 마스터 → 로그인만 (없으면 다른 화면의 코스명 매핑이 깨진다. PII 아님)
const STAFF_LEVEL = 8;
const PART_ACCESS = {
  members: "internal", agencies: "internal", points: "internal", visits: "internal", boards: "internal",
  dayoff: "internal", elec: "internal", commission: "internal", changelog: "internal",
  students: "business", roomstat: "business", groups: "business", pickup: "business",
  deposits: "business", chgref: "business", farmgym: "business", agencyvisit: "business",
  courses: "master", tuition: "master",
};
// 유효권한: 세션(JWT)의 mb_level 과 신전산 오버라이드(app.member_level_override) 중 큰 값.
// 오버라이드 테이블이 아직 없는 환경(구 배포·로컬)에서도 죽지 않도록 실패 시 세션 값을 쓴다.
async function effectiveLevel(q, session) {
  const base = Number(session.mb_level || 0);
  try {
    const { rows } = await q(`select app.member_level_of($1) lv`, [S(session.mb_id)]);
    return Math.max(base, Number((rows[0] && rows[0].lv) || 0));
  } catch (_) { return base; }
}
function partAllowed(part, level, scope) {
  const kind = PART_ACCESS[part] || "internal";
  if (kind === "master") return true;
  if (level >= STAFF_LEVEL) return true;
  return kind === "business" && !!scope.agency;    // 유학원 확정 계정만, 그것도 자기 유학원만
}
const stampVersion = (stamp) =>
  crypto.createHash("sha1").update(Object.values(stamp).join("|")).digest("hex").slice(0, 16);

// ── 엔트리 ───────────────────────────────────────────────────────────────────
const ALL_PARTS = ["students", "roomstat", "groups", "pickup", "deposits", "changelog", "chgref",
  // 명세화면 라이브(out.tables["<레거시 URL>"] 로 응답)
  "members", "agencies", "points", "visits", "commission", "courses", "tuition",
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
  // elec(ELEC & WATER) 전용 — pickup 의 from/to 와 의미가 달라 별도 파라미터를 쓴다.
  const elecFrom = isYmd(url.searchParams.get("elecFrom")) ? url.searchParams.get("elecFrom") : "";
  const elecTo = isYmd(url.searchParams.get("elecTo")) ? url.searchParams.get("elecTo") : "";
  const elecRoom = /^\d{1,9}$/.test(url.searchParams.get("elecRoom") || "") ? Number(url.searchParams.get("elecRoom")) : 0;

  const t0 = Date.now();
  try {
    const client = await getClient();     // warm 인스턴스에서 커넥션 재사용
    const q = (sql, params) => client.query(sql, params);

    // 유효권한 = max(세션 레벨, app.member_level_override) — 레거시 g4_member 는 건드리지 않는다.
    // (레거시 실무자 다수가 Lv7 이라 STAFF_LEVEL(8) 에 막히는 문제를 신전산 소유 테이블로 해소)
    const level = await effectiveLevel(q, session);
    const scope = { agency: null };
    if (level < STAFF_LEVEL) {
      const { rows } = await q(
        `select 1 from legacy.student_info where lower(coalesce(uhak_id,'')) = lower($1) limit 1`,
        [S(session.mb_id)]);
      if (rows.length) scope.agency = S(session.mb_id);
    }

    // ── 회원정보 수정 폼(레거시 member_form.php) 단건 조회 ──────────────────
    // /api/data?member=<mb_id> → { ok, member:{...} }. 캐시/스탬프 경로를 타지 않는다(단건·개인정보).
    const wantMember = (url.searchParams.get("member") || "").trim();
    if (wantMember) {
      const self = String(session.mb_id || "").toLowerCase() === wantMember.toLowerCase();
      if (level < STAFF_LEVEL && !self) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, error: "forbidden",
          message: "다른 회원의 상세정보를 볼 권한이 없습니다." }));
      }
      const member = await loadMemberForm(q, wantMember);
      if (!member) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ ok: false, error: "not_found", message: "회원을 찾을 수 없습니다." }));
      }
      return res.end(JSON.stringify({ ok: true, source: "supabase", member, ms: Date.now() - t0 }));
    }

    // 인가: 조각별 최소권한. 직원(Lv8+)도 아니고 유학원으로도 확정되지 않은 계정(일반회원 등)은
    // 마스터 조각 외에는 아무것도 받지 못한다(deny 기본값).
    const allowed = parts.filter((p) => partAllowed(p, level, scope));
    const denied = parts.filter((p) => !allowed.includes(p));
    if (parts.length && !allowed.length) {
      res.statusCode = 403;
      return res.end(JSON.stringify({
        ok: false, error: "forbidden", denied,
        message: "이 자료를 조회할 권한이 없습니다. 담당 매니저에게 권한을 요청하세요.",
      }));
    }

    const stamp = await loadStamp(q, allowed);
    // ":s2" = 응답 스키마 리비전. 필드가 바뀌면 올린다 — 스탬프는 데이터 변경만 반영하므로,
    //         배포 시점에 이미 열려 있던 탭이 메모리 ETag 로 304 를 받아 옛 스키마를 계속 쓰는 것을 막는다.
    const version = stampVersion(stamp) + ":s2" + ":" + allowed.join(".") + (allowed.includes("roomstat") ? ":" + month : "")
      + (allowed.includes("pickup") ? ":" + from + "_" + to : "")
      + (allowed.includes("elec") ? ":" + elecFrom + "_" + elecTo + "_" + elecRoom : "")
      + ":L" + (level >= STAFF_LEVEL ? "staff" : "ext") + (scope.agency ? ":" + scope.agency : "");
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
      version: stampVersion(stamp), parts: allowed, month, window: { from, to },
      scope: scope.agency ? { agency: scope.agency } : { agency: null },
      user: { id: session.mb_id, name: session.mb_name, level },
    };
    if (denied.length) out.denied = denied;   // 조용히 빼지 않고 사유를 알린다
    if (allowed.includes("students")) out.studentsFull = await loadStudents(q, scope);
    if (allowed.includes("roomstat")) out.roomstat = await loadRoomstat(q, month);
    if (allowed.includes("groups")) out.groups = await loadGroups(q);
    if (allowed.includes("pickup")) out.pickup = await loadPickup(q, from, to, scope);
    if (allowed.includes("deposits")) out.deposits = await loadDeposits(q, scope);
    if (allowed.includes("changelog")) out.changelog = await loadChangelog(q, scope);
    if (allowed.includes("chgref")) out.chgref = await loadChgref(q, scope);
    if (allowed.includes("members")) out.members = await loadMembers(q, scope);
    if (allowed.includes("agencies")) out.agencies = await loadAgencies(q, scope);
    if (allowed.includes("commission")) out.commission = await loadCommission(q, scope);
    if (allowed.includes("courses")) out.courses = await loadCourses(q, scope);
    if (allowed.includes("tuition")) out.tuition = await loadTuition(q, scope);
    if (allowed.includes("elec")) {                    // 기간 미지정이면 데이터 최신월로 자동
      const last = await elecLatestDate(q);            // 요청당 1회만 호출(0.2s seq scan)
      let ef = elecFrom, et = elecTo;
      if (!ef || !et) {
        const mm = (last || new Date().toISOString().slice(0, 10)).slice(0, 7);
        ef = monthStart(mm); et = monthEnd(mm);
      }
      out.elec = await loadElecMeter(q, ef, et, elecRoom);
      out.elec.latest = last;
    }
    // 명세화면 조각: out.tables["<레거시 URL>"] = {cols, rows} · 500행 상한 초과 URL 은 out.truncated 에 기록
    // (같은 커넥션이라 pg 는 동시 쿼리 미지원 → 순차 실행)
    for (const p of allowed) {
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
    console.error("[/api/data]", (e && e.message) || e);   // 원문은 서버 로그에만
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false, error: "db_error",
      message: "DB 조회에 실패했습니다. 잠시 후 다시 시도하세요.",
      // 오류 원문(컬럼·함수·스키마명)은 스키마 정찰 재료가 되므로 클라이언트에 보내지 않는다.
    }));
  }
}
