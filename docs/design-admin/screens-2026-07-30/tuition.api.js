/* eslint-disable */
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

// ── (3) handler 배선 ─────────────────────────────────────────────────────────
// 3-1. ALL_PARTS 배열에 "tuition" 추가:
//   const ALL_PARTS = ["students","roomstat","groups","pickup","deposits","changelog","tuition"];
// 3-2. parts 분기(loadChangelog 줄 아래)에 한 줄 추가:
//   if (parts.includes("tuition")) out.tuition = await loadTuition(q, scope);
// 3-3. 파일 상단 라우팅 주석의 parts 목록에 | tuition 추가.
//
// ※ 버전 스탬프(loadStamp)는 tution_fee 를 보지 않는다. 이 표는 사실상 정적 마스터이므로
//   ETag 가 학생 데이터 변경에만 반응해도 무방하다. 굳이 정밀 감지가 필요하면 loadStamp 에
//   `coalesce((select max(idx) from legacy.tution_fee)::text,'') tf_max` 를 한 줄 추가하면 된다.
