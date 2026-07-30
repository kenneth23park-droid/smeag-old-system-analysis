/* eslint-disable */
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

// ── handler 배선 (data.js 수정분) ────────────────────────────────────────────
// 1) ALL_PARTS 에 "elec" 추가:
//      const ALL_PARTS = ["students","roomstat","groups","pickup","deposits","changelog","elec"];
// 2) 파라미터 파싱(기존 from/to 는 pickup 주간이라 재사용 금지 — 별도 이름 사용):
//      const elecTo   = isYmd(url.searchParams.get("elecTo"))   ? url.searchParams.get("elecTo")   : "";
//      const elecFrom = isYmd(url.searchParams.get("elecFrom")) ? url.searchParams.get("elecFrom") : "";
//      const elecRoom = /^\d{1,9}$/.test(url.searchParams.get("elecRoom") || "") ? Number(url.searchParams.get("elecRoom")) : 0;
// 3) version(캐시키)에 기간·방을 포함:
//      + (parts.includes("elec") ? ":" + elecFrom + "_" + elecTo + "_" + elecRoom : "")
// 4) parts 분기(기간 미지정이면 데이터 최신월로 자동). elecLatestDate 는 요청당 **한 번만** 호출할 것
//    (0.24s seq scan — 예전 초안처럼 두 번 부르면 그만큼 손해다):
//      if (parts.includes("elec")) {
//        const last = await elecLatestDate(q);
//        let ef = elecFrom, et = elecTo;
//        if (!ef || !et) { const mm = (last || new Date().toISOString().slice(0,10)).slice(0,7);
//                          ef = monthStart(mm); et = monthEnd(mm); }
//        out.elec = await loadElecMeter(q, ef, et, elecRoom);
//        out.elec.latest = last;
//      }
// 5) 유학원 계정 스코프(scope.agency)는 적용하지 않는다 — 방별 계량기 검침값에는 학생 PII 가 전혀 없고
//    (room_elec 에 s_idx 없음) 레거시도 기숙사부 전용 화면이라 유학원 계정은 메뉴 자체가 보이지 않는다.
//    다만 elec 은 부하가 큰 조각이므로 오케스트레이터가 메뉴 권한(dorm_dept/director)으로 접근을 제한할 것.
