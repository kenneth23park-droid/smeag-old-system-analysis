/* eslint-disable */
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

// ── handler 의 parts 분기에 넣을 한 줄 ───────────────────────────────────────
//   if (parts.includes("commission")) out.commission = await loadCommission(q, scope);
// ── ALL_PARTS 에 "commission" 추가 ───────────────────────────────────────────
//   const ALL_PARTS = ["students", "roomstat", "groups", "pickup", "deposits", "changelog", "commission"];
// ── loadStamp 에 커미션 최대키 추가(변경감지) ────────────────────────────────
//   coalesce((select max(no) from legacy.uhak_agency_com)::text,'') ac_max
