/* eslint-disable */
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

// ── data.js 배선(오케스트레이터가 넣을 줄) ────────────────────────────────────
// 1) parts 화이트리스트:
//    const ALL_PARTS = ["students","roomstat","groups","pickup","deposits","changelog","courses"];
// 2) handler 의 parts 분기(deposits 줄 옆):
//    if (parts.includes("courses")) out.courses = await loadCourses(q, scope);
// 3) loadStamp 에 코스 마스터 변경 감지 한 줄 추가(QA 확정안 — 실측 83ms, 71행이라 부담 없음):
//    coalesce((select md5(string_agg(i_idx||'|'||coalesce(i_state,'')||'|'||coalesce(i_pay::text,'')
//              ||'|'||coalesce(i_name,''), ',' order by i_idx)) from legacy.course_info),'') ci_h
//    → 추가·삭제뿐 아니라 상태·가격·이름 "수정"까지 잡아 ETag·메모리 캐시가 자동 무효화된다.
//      (max(i_idx) 만 쓰면 가격 수정이 감지되지 않으므로 채택하지 않음.)
