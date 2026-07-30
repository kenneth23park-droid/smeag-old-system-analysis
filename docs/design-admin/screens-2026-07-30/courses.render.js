/* eslint-disable */
// ═══════════════════════════════════════════════════════════════════════════════
// COURSE LIST (course_list.php) — 코스 마스터 전용 렌더러
//   소스: legacy.course_info(71) + legacy.course_category(14)  → /api/data?parts=courses
//   구성: 카테고리(g_order) 그룹헤더 > 코스행(c_order, 동순위는 i_idx)
//   컬럼: # · 코스명(KO) · COURSE(EN) · 정원 · 학비(KRW) + 국가별가격 8칸(CN/JP/TW/VT/RU/SA/MGL/ETC)
//         · 캠퍼스 · 상태(Y/N pill) · 순서 · 비고(i_info)
//   ※ 국가별 가격은 통화 단위가 서로 다르다(실측: JP=JPY, 그 외=USD, i_pay=KRW) → 헤더에 단위 표기.
//   ※ 레거시에 남은 플레이스홀더 값(999999 / 99999999 / 2147483647)은 금액이 아니라 "미설정"이므로
//     N/A 로 표시하고 원값을 title 로 남긴다(합계·평균 계산에서도 제외).
// ═══════════════════════════════════════════════════════════════════════════════
let courseFilter = { cat:'', campus:'', state:'', q:'' };

// s_campus 코드 → 캠퍼스명. 실측 분포 C=56 · S=10 · A=5 (E 는 실데이터 0건)
const CO_CAMPUS = { S:'ENCANTO', C:'CAPITAL', E:'CLASSIC', A:'ALL' };
// 국가별 가격 컬럼 정의: [필드, 헤더, 통화]
const CO_PAY = [
  ['pay','KRW'],['cn','USD'],['jp','JPY'],['tw','USD'],['vt','USD'],
  ['ru','USD'],['sa','USD'],['mgl','USD'],['etc','USD'],
];
const CO_PAY_LABEL = { pay:'BASE', cn:'CN', jp:'JP', tw:'TW', vt:'VT', ru:'RU', sa:'SA', mgl:'MGL', etc:'ETC' };
// 레거시 플레이스홀더(금액 아님)
const CO_SENTINEL = { 999999:1, 1000000:1, 99999999:1, 2147483647:1 };
function coIsSentinel(v, unit){
  v = +v || 0;
  if (CO_SENTINEL[v]) return unit !== 'KRW' || v >= 99999999;  // KRW 1,000,000·999,999 는 실금액일 수 있어 유지
  return false;
}
function coPayCell(v, unit){
  v = +v || 0;
  if (coIsSentinel(v, unit)) return '<td class="mono" style="color:var(--warn)" title="'
    + T('레거시 미설정 플레이스홀더','legacy placeholder') + ': ' + v + '">N/A</td>';
  if (!v) return '<td class="mono" style="color:var(--faint)">—</td>';
  return '<td class="mono">' + v.toLocaleString() + '</td>';
}
const coCampusCell = (c) => {
  const n = CO_CAMPUS[(c || '').toUpperCase()];
  if (!n) return '<span style="color:var(--faint)">' + esc(c || '—') + '</span>';
  if (n === 'ALL') return '<span class="cch cap" style="background:var(--neutral)">ALL</span>';
  return campusChipName(n);
};
const coStateCell = (s) => ((s || '').toUpperCase() === 'Y'
  ? '<span class="pill good">' + T('사용중','ACTIVE') + '</span>'
  : '<span class="pill warn">' + T('중지','STOPPED') + '</span>');

// ── 데이터 접근 ───────────────────────────────────────────────────────────────
function coData(){
  const d = (typeof REAL !== 'undefined' && REAL && REAL.courses) || null;
  if (!d || !d.rows || !d.rows.length) return null;
  return { cats: d.cats || [], rows: d.rows };
}
// 필터 적용 → 표시할 코스행
function coRows(d){
  const f = courseFilter, q = (f.q || '').trim().toLowerCase();
  return d.rows.filter(r => {
    if (f.cat && String(r.gid) !== String(f.cat)) return false;
    if (f.campus && (r.campus || '').toUpperCase() !== f.campus) return false;
    if (f.state && (r.state || '').toUpperCase() !== f.state) return false;
    if (q) {
      const hay = [r.idx, r.ko, r.en, r.info].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}
// 표 전체 컬럼수: # · KO · EN · LIMIT (4) + 가격 9 + 캠퍼스 · 상태 · 순서 · 비고 (4) = 17
const CO_SPAN = 8 + CO_PAY.length;
// 카테고리 그룹헤더 + 코스행 (그룹은 g_order 순, 행은 c_order 순 — 서버 정렬을 그대로 신뢰)
function coBody(d, rows){
  if (!rows.length) return '<tr><td colspan="' + CO_SPAN + '" style="color:var(--dim);text-align:center;padding:18px">'
    + T('조건에 맞는 코스가 없습니다','No courses match the filter') + '</td></tr>';
  const catName = {};
  (d.cats || []).forEach(c => { catName[String(c.gid)] = c.name; });
  const cnt = {};                                    // 그룹별 표시행수(1패스 집계)
  rows.forEach(r => { const g = String(r.gid); cnt[g] = (cnt[g] || 0) + 1; });
  const span = CO_SPAN;
  let out = '', cur = null;
  rows.forEach(r => {
    const g = String(r.gid);
    if (g !== cur) {
      cur = g;
      const n = cnt[g];
      out += '<tr class="grp"><td colspan="' + span + '">'
        + esc(catName[g] || ('CATEGORY ' + g)) + ' <span class="mono" style="color:var(--faint)">#' + esc(g) + '</span>'
        + ' · ' + n + T('개 코스',' course(s)') + '</td></tr>';
    }
    out += '<tr>'
      + '<td class="mono">' + esc(r.idx) + '</td>'
      + '<td>' + (esc(r.ko) || '—') + '</td>'
      + '<td><b>' + (esc(r.en) || esc(r.ko) || '—') + '</b></td>'
      + '<td class="mono">' + (+r.limit ? (+r.limit).toLocaleString() : '<span style="color:var(--faint)">—</span>') + '</td>'
      + CO_PAY.map(p => coPayCell(r[p[0]], p[1])).join('')
      + '<td>' + coCampusCell(r.campus) + '</td>'
      + '<td>' + coStateCell(r.state) + '</td>'
      + '<td class="mono" style="color:var(--faint)">' + esc(r.order == null ? '' : r.order) + '</td>'
      + '<td style="color:var(--dim);font-size:11.5px">' + (esc(r.info) || '') + '</td>'
      + '</tr>';
  });
  return out;
}
function coChips(d, rows){
  const act = d.rows.filter(r => (r.state || '').toUpperCase() === 'Y').length;
  const cats = new Set(d.rows.map(r => String(r.gid))).size;
  const shown = rows.length;
  return '<span class="chip on">' + T('전체','Total') + ' <b>' + d.rows.length.toLocaleString() + '</b></span>'
    + '<span class="chip" style="color:var(--good);border-color:var(--good)">' + T('사용중','Active') + ' <b>' + act + '</b></span>'
    + '<span class="chip" style="color:var(--warn);border-color:var(--warn)">' + T('중지','Stopped') + ' <b>' + (d.rows.length - act) + '</b></span>'
    + '<span class="chip">' + T('카테고리','Categories') + ' <b>' + cats + '</b>/' + (d.cats.length || cats) + '</span>'
    + (shown !== d.rows.length ? '<span class="chip">' + T('표시','Shown') + ' <b>' + shown + '</b></span>' : '');
}

R.courses = function (m) {
  const url = (m && m.u) || 'course_list.php';
  const hdr = '<div class="ph"><h1>' + T('코스 목록 (COURSE LIST)','Course List') + '</h1>'
    + '<span class="sub">' + T('코스 마스터 — 카테고리별 · 국가별 학비','Course master — by category · price per country') + '</span>'
    + '<span class="url">' + esc(url) + '</span>'
    + '<span class="actions" style="margin-left:auto"><button class="btn" data-tblexcel="COURSE_LIST">📊 EXCEL</button></span></div>';
  const d = coData();
  if (!d) {
    return hdr + '<div class="card pad" style="color:var(--dim)"><b>' + T('코스 데이터가 없습니다','No course data') + '</b><br>'
      + T('로그인 세션이 있으면 DB(legacy.course_info)에서 자동으로 불러옵니다. 상단 우측 상태표시가 “샘플(로그인 필요)”이면 /login 에서 다시 로그인하세요.',
          'Course master is loaded from the DB (legacy.course_info) when a session exists. If the status badge shows “Sample (login required)”, re-login at /login.')
      + '</div>';
  }
  const rows = coRows(d);
  const catOpts = '<option value="">' + T('전체 카테고리','ALL CATEGORIES') + '</option>'
    + d.cats.map(c => {
        const n = d.rows.filter(r => String(r.gid) === String(c.gid)).length;
        return '<option value="' + esc(c.gid) + '"' + (String(courseFilter.cat) === String(c.gid) ? ' selected' : '') + '>'
          + esc(c.name) + ' (' + n + ')</option>';
      }).join('');
  const campOpts = '<option value="">' + T('전체 캠퍼스','ALL CAMPUS') + '</option>'
    + ['S','C','A','E'].map(k => '<option value="' + k + '"' + (courseFilter.campus === k ? ' selected' : '') + '>'
        + CO_CAMPUS[k] + ' (' + k + ')</option>').join('');
  const th = '<tr><th>#</th><th>' + T('코스명','COURSE (KO)') + '</th><th>COURSE (EN)</th><th>' + T('정원','LIMIT') + '</th>'
    // 라벨 뒤 공백은 엑셀 export(textContent)에서 'BASEKRW' 로 붙지 않게 하기 위함
    + CO_PAY.map(p => '<th>' + CO_PAY_LABEL[p[0]] + ' <br><span style="font-weight:600;color:var(--faint);font-size:10px">' + p[1] + '</span></th>').join('')
    + '<th>' + T('캠퍼스','CAMPUS') + '</th><th>' + T('상태','STATE') + '</th><th>' + T('순서','ORDER') + '</th><th>' + T('비고','NOTE') + '</th></tr>';
  return hdr
    + '<div class="chips" style="margin-bottom:10px" id="coChips">' + coChips(d, rows) + '</div>'
    + '<div class="filters">'
    + '<div class="field"><label>' + T('카테고리','CATEGORY') + '</label><select id="coCat">' + catOpts + '</select></div>'
    + '<div class="field"><label>' + T('캠퍼스','CAMPUS') + '</label><select id="coCampus">' + campOpts + '</select></div>'
    + '<div class="field"><label>' + T('상태','STATE') + '</label><select id="coState">'
    + '<option value="">' + T('전체','ALL') + '</option>'
    + '<option value="Y"' + (courseFilter.state === 'Y' ? ' selected' : '') + '>' + T('사용중(Y)','ACTIVE (Y)') + '</option>'
    + '<option value="N"' + (courseFilter.state === 'N' ? ' selected' : '') + '>' + T('중지(N)','STOPPED (N)') + '</option>'
    + '</select></div>'
    + '<div class="field grow"><label>' + T('검색 (코스명·#·비고)','SEARCH (name · # · note)') + '</label>'
    // esc() 는 따옴표를 변환하지 않으므로 속성값에 넣을 때만 &quot; 추가 처리
    + '<input id="coQ" value="' + esc(courseFilter.q).replace(/"/g, '&quot;') + '" placeholder="' + T('예: IELTS, 14, family','e.g. IELTS, 14, family') + '"></div>'
    + '<div class="field"><label>&nbsp;</label><button class="btn" id="coClear">' + T('초기화','Clear') + '</button></div>'
    + '</div>'
    + '<div class="twrap"><table class="grid"><thead>' + th + '</thead><tbody id="coBody">' + coBody(d, rows) + '</tbody></table></div>'
    + '<div class="banner">' + T(
      '학비 통화 단위가 컬럼마다 다릅니다 — <b>BASE=KRW</b>, <b>JP=JPY</b>, 그 외 국가는 <b>USD</b>(실데이터 자릿수로 확인). '
      + '<b>N/A</b> 는 레거시에 남은 미설정 플레이스홀더(999,999 / 99,999,999 / 2,147,483,647)이며 실제 금액이 아닙니다. '
      + '주차별 실제 청구액은 <b>TUITION FEE</b> 화면(tution_fee)을 사용하세요.',
      'Currency differs per column — <b>BASE=KRW</b>, <b>JP=JPY</b>, others <b>USD</b> (inferred from real magnitudes). '
      + '<b>N/A</b> marks legacy placeholder values (999,999 / 99,999,999 / 2,147,483,647), not real prices. '
      + 'For the amount actually billed per week use the <b>TUITION FEE</b> screen (tution_fee).') + '</div>';
};

R.courses__init = function (m) {
  const root = document.getElementById('main'); if (!root) return;
  const d = coData(); if (!d) return;
  const repaint = () => {
    const rows = coRows(d);
    const body = root.querySelector('#coBody'); if (body) body.innerHTML = coBody(d, rows);
    const chips = root.querySelector('#coChips'); if (chips) chips.innerHTML = coChips(d, rows);
  };
  const cat = root.querySelector('#coCat');
  if (cat) cat.onchange = () => { courseFilter.cat = cat.value; repaint(); };
  const cam = root.querySelector('#coCampus');
  if (cam) cam.onchange = () => { courseFilter.campus = cam.value; repaint(); };
  const st = root.querySelector('#coState');
  if (st) st.onchange = () => { courseFilter.state = st.value; repaint(); };
  const q = root.querySelector('#coQ');
  if (q) { let t = null; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { courseFilter.q = q.value; repaint(); }, 180); }; }
  const cl = root.querySelector('#coClear');
  if (cl) cl.onclick = () => { courseFilter = { cat:'', campus:'', state:'', q:'' }; renderMain(); };
};
