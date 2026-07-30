/* eslint-disable */
// ─── ELEC & WATER (room_elec.php) — 전용 렌더러 ───────────────────────────────
// 레거시 3섹션 구조 재현:
//   ① ELEC GAGE LIST CHECK and INSERT (일자별 계량기 측정 조회 및 입력)  → 방별 검침 표
//   ② STUDENT ELEC and WATER BILL (월별 기숙사 이용현황·수도/전기요금 정산) → 방구분별 정산 롤업
//   ③ SEARCH STUDENT ELEC and WATER BILL                                 → 방번호·입력자 검색
// 데이터는 REAL.elec (서버 집계, 방 단위 ≤1,127행). 167만 행 원본은 클라이언트로 오지 않는다.

// 화면 상태(기간·필터·선택방) — liveSync 가 elecFrom/elecTo/elecRoom 파라미터로 읽어간다.
var elecState = {
  from: '', to: '',                    // 미지정이면 서버가 데이터 최신월로 채워 window 로 알려줌
  campus: '', grp: '', st: '', q: '',   // st: ''|metered|missing|check
  dispOnly: false, room: 0, sort: 'used',
};

R.elec = function (m) {
  var E = (typeof REAL !== 'undefined' && REAL && REAL.elec) || null;
  var head = '<div class="ph"><h1>' + T('전기·수도 (ELEC & WATER)', 'Elec & Water') + '</h1>'
    + '<span class="sub">' + T('일자별 계량기 검침 조회 · 월별 기숙사 요금 정산', 'Daily meter readings · monthly dormitory bill') + '</span>'
    + '<span class="url">' + esc(m && m.u || 'room_elec.php') + '</span>'
    + '<span class="actions" style="margin-left:auto">'
    + '<button class="btn" data-tblexcel="ELEC_WATER">📊 EXCEL</button></span></div>';

  if (!E || !E.rows) return head
    + '<div class="card pad" style="color:var(--dim)">⚡ '
    + T('검침 데이터를 불러오지 못했습니다. 로그인 세션이 있으면 기간을 선택해 다시 조회하세요.',
      'Meter data unavailable. With a valid session, pick a period and search again.')
    + '</div>';

  var win = E.window || { from: '', to: '' };
  // 서버가 실제로 집계한 기간으로 항상 동기화한다(MAX_ELEC_SPAN_DAYS 클램프가 걸리면
  // 사용자가 입력한 기간과 달라지므로, 화면 입력칸도 "실제 조회된 기간"을 보여줘야 한다).
  elecState.from = win.from || elecState.from || '';
  elecState.to = win.to || elecState.to || '';

  // ── 클라이언트 필터(서버가 준 ≤1,127행 안에서만 걸러낸다) ──
  var rows = E.rows.filter(function (r) {
    if (elecState.dispOnly && r.disp !== 'Y') return false;
    if (elecState.campus && r.bldg !== elecState.campus) return false;
    if (elecState.grp && r.grp !== elecState.grp) return false;
    if (elecState.st === 'metered' && !(r.days > 0)) return false;
    if (elecState.st === 'missing' && r.days > 0) return false;
    if (elecState.st === 'check' && !r.spikes) return false;
    if (elecState.q) {
      var k = elecState.q.toLowerCase();
      var hay = ((r.room || '') + ' ' + (r.grp || '') + ' ' + (r.lastBy || '')).toLowerCase();
      if (hay.indexOf(k) < 0) return false;
    }
    return true;
  });
  var S = {
    rooms: rows.length,
    metered: rows.filter(function (r) { return r.days > 0; }).length,
    missing: rows.filter(function (r) { return !r.days; }).length,
    used: rows.reduce(function (s, r) { return s + r.used; }, 0),
    charge: rows.reduce(function (s, r) { return s + r.charge; }, 0),
    readings: rows.reduce(function (s, r) { return s + r.days; }, 0),
    check: rows.filter(function (r) { return r.spikes; }).length,
  };
  var n = function (v, d) { return (Math.round((+v || 0) * (d ? 100 : 1)) / (d ? 100 : 1)).toLocaleString(); };

  // ── 필터 UI ──
  var grps = [];
  E.rows.forEach(function (r) { if (r.grp && grps.indexOf(r.grp) < 0) grps.push(r.grp); });
  grps.sort();
  var opt = function (v, t, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(t) + '</option>'; };
  var filters = '<div class="filters" style="align-items:flex-end">'
    + '<div class="field"><label>' + T('기간 시작 (PERIOD)', 'Period from') + '</label><input id="elFrom" type="date" value="' + esc(elecState.from) + '"></div>'
    + '<div class="field"><label>' + T('기간 종료', 'Period to') + '</label><input id="elTo" type="date" value="' + esc(elecState.to) + '"></div>'
    + '<div class="field"><label>' + T('프리셋', 'Preset') + '</label><select id="elPreset"><option value="">' + T('직접선택', 'Custom') + '</option>'
    + '<option value="last">' + T('데이터 최신월', 'Latest data month') + '</option>'
    + '<option value="m1">' + T('지난달', 'Previous month') + '</option>'
    + '<option value="m3">' + T('최근 3개월', 'Last 3 months') + '</option></select></div>'
    + '<div class="field"><label>' + T('구분 (CONDITION)', 'Condition') + '</label><select id="elCampus">'
    + opt('', T('전체 기숙사 (ALL DORM)', 'ALL DORM'), elecState.campus)
    + opt('S', 'ENCANTO', elecState.campus) + opt('C', 'CLASSIC', elecState.campus) + opt('E', 'CAPITAL', elecState.campus)
    // 레거시 셀렉트는 ''/S/C/E 4개뿐이지만 bldg_type 실측값은 F(SPARTA)·P(PREMIUM)도 있고
    // 활성 836방 중 F 가 205방이라 legacy 그대로면 4분의 1을 걸러낼 수 없다 → 2개만 추가.
    + opt('F', 'SPARTA', elecState.campus) + opt('P', 'PREMIUM', elecState.campus)
    + '</select></div>'
    + '<div class="field"><label>' + T('방구분', 'Category') + '</label><select id="elGrp">' + opt('', T('전체', 'ALL'), elecState.grp)
    + grps.map(function (g) { return opt(g, g, elecState.grp); }).join('') + '</select></div>'
    + '<div class="field"><label>' + T('검침상태', 'Reading state') + '</label><select id="elSt">'
    + opt('', T('전체', 'ALL'), elecState.st) + opt('metered', T('검침 있음', 'METERED'), elecState.st)
    + opt('missing', T('검침 누락', 'MISSING'), elecState.st) + opt('check', T('이상값 확인필요', 'CHECK'), elecState.st)
    + '</select></div>'
    + '<div class="field grow"><label>' + T('방번호 · 입력자 검색 (NAME)', 'Room · updater search') + '</label>'
    + '<input id="elQ" value="' + esc(elecState.q) + '" placeholder="' + T('예: 319 / capital1', 'e.g. 319 / capital1') + '"></div>'
    + '<div class="field"><label>&nbsp;</label><label class="dl-chk"><input type="checkbox" id="elDisp"' + (elecState.dispOnly ? ' checked' : '') + '> '
    + T('표시그룹만', 'Displayed groups only') + '</label></div>'
    + '<div class="field"><label>&nbsp;</label><button class="btn primary" id="elSearch">🔍 ' + T('조회', 'SEARCH') + '</button></div>'
    + '</div>';

  var chips = '<div class="chips" style="margin-bottom:10px">'
    + '<span class="chip">' + T('기간', 'Period') + ' <b>' + esc(win.from) + ' ~ ' + esc(win.to) + '</b></span>'
    + '<span class="chip">' + T('대상 방', 'Rooms') + ' <b>' + n(S.rooms) + '</b></span>'
    + '<span class="chip">' + T('검침 방', 'Metered') + ' <b>' + n(S.metered) + '</b></span>'
    + '<span class="chip" style="color:' + (S.missing ? 'var(--warn)' : 'var(--dim)') + '">' + T('검침 누락', 'Missing') + ' <b>' + n(S.missing) + '</b></span>'
    + '<span class="chip">' + T('총 사용량', 'Total use') + ' <b>' + n(S.used) + '</b> kWh</span>'
    + '<span class="chip">' + T('총 요금(charge_gage)', 'Total charge') + ' <b>' + n(S.charge, 1) + '</b></span>'
    + '<span class="chip">' + T('검침 입력행', 'Readings') + ' <b>' + n(S.readings) + '</b></span>'
    + (S.check ? '<span class="chip" style="color:var(--warn)">' + T('이상값 방', 'Anomaly rooms') + ' <b>' + n(S.check) + '</b></span>' : '')
    + (E.latest ? '<span class="chip" style="color:var(--dim)">' + T('데이터 최신 검침일', 'Latest reading') + ' <b>' + esc(E.latest) + '</b></span>' : '')
    + '</div>';

  // ── ① 방별 검침 표 ──
  var spanD = Math.round((Date.parse(win.to) - Date.parse(win.from)) / 86400000) + 1;
  var days = (isFinite(spanD) && spanD > 0) ? spanD : 0;   // window 미지정이면 '13 / NaN' 방지
  var body = rows.map(function (r, i) {
    var perDay = r.daysG > 1 ? r.used / (r.daysG - 1) : 0;
    var perP = (r.avgP && r.used) ? r.used / r.avgP : 0;
    // 선택행 강조는 전용 CSS 클래스가 없어 인라인 스타일로(기존 CSS 변수 사용)
    return '<tr class="el-row" data-idx="' + r.idx + '"'
      + (elecState.room === r.idx ? ' style="background:var(--surface-2);box-shadow:inset 3px 0 0 var(--accent-ink)"' : '') + '>'
      + '<td class="mono">' + (i + 1) + '</td>'
      + '<td><b>' + esc(r.room || '—') + '</b>' + (r.state !== 'Y' ? ' <span style="color:var(--faint);font-size:10px">off</span>' : '')
      // CHECK 배지는 방번호 칸에 둔다 — 사용량 칸에 두면 makeSortable 이 "345 CHECK" 를 문자열로 보고 숫자정렬이 깨진다.
      + (r.spikes ? ' <span class="pill return" title="' + T('계량기 교체/오타 의심 — 사용량에서 제외', 'meter reset/typo suspected — excluded from use') + '">CHECK</span>' : '') + '</td>'
      + '<td>' + esc(r.grp || '—') + '</td>'
      + '<td>' + campusChipName(r.campus) + '</td>'
      + '<td class="mono">' + (r.lim || '—') + '</td>'
      + '<td class="mono">' + r.days + ((r.days && days) ? ' / ' + days : '') + '</td>'
      + '<td class="mono">' + esc(r.d0 || '—') + '</td><td class="mono">' + esc(r.d1 || '—') + '</td>'
      + '<td class="mono">' + (r.g0 ? n(r.g0) : '—') + '</td><td class="mono">' + (r.g1 ? n(r.g1) : '—') + '</td>'
      + '<td class="mono"><b style="color:' + (r.used ? 'var(--accent-ink)' : 'var(--faint)') + '">' + n(r.used) + '</b></td>'
      + '<td class="mono">' + n(perDay, 1) + '</td>'
      + '<td class="mono">' + (r.avgP == null ? '—' : n(r.avgP, 1)) + '</td>'
      + '<td class="mono">' + (perP ? n(perP, 1) : '—') + '</td>'
      + '<td class="mono">' + n(r.charge, 1) + '</td>'
      + '<td>' + esc(r.lastBy || '—') + '</td><td class="mono">' + esc(r.lastAt || '—') + '</td></tr>';
  }).join('');
  var TH = [T('NO', 'NO'), T('방번호', 'ROOM'), T('방구분', 'CATEGORY'), T('센터', 'CENTER'), T('정원', 'LIMIT'),
    T('검침일수', 'READINGS'), T('시작일', 'FROM'), T('종료일', 'TO'), T('시작검침', 'GAGE FROM'), T('종료검침', 'GAGE TO'),
    T('사용량', 'USE') + ' (kWh)', T('일평균', '/DAY'), T('평균인원', 'AVG P'), T('1인당', 'PER P'),
    T('요금합계', 'CHARGE'), T('마지막 입력자', 'LAST BY'), T('입력일', 'AT')];
  var grid = '<div class="twrap"><table class="grid" id="elGrid" data-tblname="ELEC_WATER"><thead><tr>'
    + TH.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>'
    + '<tbody>' + (body || '<tr><td colspan="' + TH.length + '" style="color:var(--dim)">' + T('조건에 맞는 방이 없습니다.', 'No rooms match.') + '</td></tr>') + '</tbody></table></div>';

  // ── ② 방구분(빌딩)별 정산 롤업 ──
  var roll = {};
  rows.forEach(function (r) {
    var k = r.grp || '(none)';
    var o = roll[k] || (roll[k] = { grp: k, campus: r.campus, rooms: 0, met: 0, used: 0, charge: 0, p: 0, pn: 0 });
    o.rooms++; if (r.days) o.met++;
    o.used += r.used; o.charge += r.charge;
    if (r.avgP) { o.p += r.avgP; o.pn++; }
  });
  var rl = Object.keys(roll).map(function (k) { return roll[k]; }).sort(function (a, b) { return b.used - a.used; });
  var maxUsed = rl.reduce(function (mx, o) { return Math.max(mx, o.used); }, 1);
  var rollTbl = '<div class="twrap"><table class="grid" data-tblname="ELEC_BILL"><thead><tr>'
    + ['<th>' + T('방구분', 'CATEGORY') + '</th><th>' + T('센터', 'CENTER') + '</th><th>' + T('방수', 'ROOMS') + '</th>',
      '<th>' + T('검침방', 'METERED') + '</th><th>' + T('사용량', 'USE') + ' (kWh)</th><th>' + T('점유비중', 'SHARE') + '</th>',
      '<th>' + T('평균인원', 'AVG P') + '</th><th>' + T('1인당 사용량', 'USE / PERSON') + '</th><th>' + T('요금합계', 'CHARGE') + '</th>'].join('')
    + '</tr></thead><tbody>' + rl.map(function (o) {
      var avgP = o.pn ? o.p / o.pn : 0;
      return '<tr><td><b>' + esc(o.grp) + '</b></td><td>' + campusChipName(o.campus) + '</td>'
        + '<td class="mono">' + o.rooms + '</td><td class="mono">' + o.met + '</td>'
        + '<td class="mono"><b>' + n(o.used) + '</b></td>'
        + '<td><span style="display:inline-block;height:8px;border-radius:4px;background:var(--accent-ink);width:'
        + Math.round(o.used / maxUsed * 100) + '%;min-width:2px"></span> <span class="mono" style="color:var(--dim)">'
        + n(S.used ? o.used / S.used * 100 : 0, 1) + '%</span></td>'
        + '<td class="mono">' + (avgP ? n(avgP, 1) : '—') + '</td>'
        + '<td class="mono">' + (avgP ? n(o.used / avgP / Math.max(o.met, 1), 1) : '—') + '</td>'
        + '<td class="mono">' + n(o.charge, 1) + '</td></tr>';
    }).join('') + '</tbody></table></div>';

  // ── 방 클릭 시 일자별 검침 추이 ──
  var detail = '<div id="elDetail">' + elecDetailHtml(E) + '</div>';

  return head + filters + chips
    + '<div class="banner"><b>' + T('① 일자별 계량기 검침 조회', 'ELEC GAGE LIST CHECK') + '</b> — '
    + T('선택 기간의 방별 계량기 검침을 <b>서버에서 집계</b>해 표시합니다(원본 1,670,841행은 전송하지 않음). 사용량 = 일자별 증가분 합계, 하루 증가분이 '
      + (E.spikeCap || 2000) + ' 초과/음수면 계량기 교체·오타로 보고 제외(CHECK)합니다. 행을 클릭하면 그 방의 일자별 추이를 조회합니다.',
      'Server-side aggregation of meter readings per room for the selected period (the 1,670,841 source rows are never sent). '
      + 'Use = sum of daily increments; increments above ' + (E.spikeCap || 2000) + ' or negative are treated as meter resets/typos and excluded (CHECK). Click a row for its daily trend.')
    + '</div>'
    + grid
    + detail
    + '<div class="card pad" style="margin-top:16px"><div class="h3">② ' + T('월별 기숙사 이용현황 · 수도/전기요금 정산', 'Monthly dormitory usage · elec/water bill')
    + '</div><p style="color:var(--dim);font-size:12.5px;margin:0 0 10px">'
    + T('방구분(빌딩)별 사용량·요금 롤업과 평균 인원 기준 1인당 사용량입니다. 레거시의 학생 단위 청구는 room_elec 에 학생키(s_idx)가 없어 방↔학생 배정(room_reserve)과 결합해야 산출됩니다 — 2단계 배선 대상.',
      'Roll-up of use/charge per category with per-person use from average occupancy. Legacy per-student billing needs room_reserve (room_elec has no student key) — phase 2.')
    + '</p>' + rollTbl + '</div>';
};

// 일자별 추이 패널(선택 방) — 서버가 daily 를 함께 준 경우에만 그린다.
function elecDetailHtml(E) {
  if (!elecState.room) return '';
  var meta = null;
  (E.rows || []).forEach(function (r) { if (r.idx === elecState.room) meta = r; });
  var d = (E.daily && E.daily.idx === elecState.room) ? E.daily.rows : null;
  var title = '⚡ ' + T('일자별 검침 추이', 'Daily reading trend') + ' — <b>' + esc(meta ? meta.room : ('#' + elecState.room))
    + '</b> <span style="color:var(--dim)">' + esc(meta ? meta.grp : '') + '</span>';
  if (!d) return '<div class="card pad" style="margin-top:14px">' + title
    + '<div style="color:var(--dim);margin-top:8px">⟳ ' + T('조회 중…', 'Loading…') + '</div></div>';
  if (!d.length) return '<div class="card pad" style="margin-top:14px">' + title
    + '<div style="color:var(--dim);margin-top:8px">' + T('이 기간에 검침 입력이 없습니다.', 'No readings in this period.') + '</div></div>';
  var mx = d.reduce(function (m, r) { return Math.max(m, r.use || 0); }, 1);
  var bars = d.map(function (r) {
    var h = Math.max(1, Math.round((r.use || 0) / mx * 46));
    return '<span title="' + esc(r.date) + ' · ' + (r.use == null ? '—' : r.use) + ' kWh" '
      + 'style="display:inline-block;width:9px;margin-right:1px;height:' + h + 'px;vertical-align:bottom;border-radius:2px 2px 0 0;background:'
      + (r.use == null ? 'var(--faint)' : 'var(--accent-ink)') + '"></span>';
  }).join('');
  var tb = d.map(function (r) {
    return '<tr><td class="mono">' + esc(r.date) + '</td><td class="mono">' + (r.gage || 0).toLocaleString() + '</td>'
      + '<td class="mono">' + (r.use == null ? '—' : r.use.toLocaleString()) + '</td>'
      + '<td class="mono">' + r.p + '</td><td class="mono">' + r.charge + '</td><td>' + esc(r.by || '—') + '</td></tr>';
  }).join('');
  return '<div class="card pad" style="margin-top:14px">'
    + '<div style="display:flex;align-items:center;gap:10px"><div class="h3" style="margin:0">' + title + '</div>'
    + '<button class="btn" id="elClose" style="margin-left:auto">✕ ' + T('닫기', 'Close') + '</button></div>'
    + '<div style="margin:12px 0;height:48px;overflow-x:auto;white-space:nowrap">' + bars + '</div>'
    + '<div class="twrap" style="max-height:320px;overflow:auto"><table class="grid" data-tblname="ELEC_DAILY"><thead><tr>'
    + ['<th>' + T('일자', 'DATE') + '</th><th>' + T('검침값', 'GAGE') + '</th><th>' + T('사용량', 'USE') + '</th>',
      '<th>' + T('인원', 'P') + '</th><th>charge_gage</th><th>' + T('입력자', 'BY') + '</th>'].join('')
    + '</tr></thead><tbody>' + tb + '</tbody></table></div></div>';
}

R.elec__init = function (m) {
  var root = document.getElementById('main'); if (!root) return;
  var g = function (id) { return root.querySelector('#' + id); };
  var mmShift = function (ymdStr, k) {
    var p = String(ymdStr || '').split('-');
    var d = new Date(Date.UTC(+p[0], (+p[1] - 1) + k, 1));
    return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0')];
  };
  var mmRange = function (y, mo) {
    var last = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
    return [y + '-' + mo + '-01', y + '-' + mo + '-' + String(last).padStart(2, '0')];
  };
  // 기간·방 변경 → 서버 재집계(파라미터는 liveSync 가 elecState 에서 읽는다)
  var reload = function () {
    if (typeof liveSync !== 'function') return;
    liveSync({ parts: ['elec'], force: true }).then(function () {
      if (typeof renderMain === 'function') renderMain();
      if (typeof i18nApply === 'function') i18nApply(document.body);
    });
  };
  var repaint = function () { if (typeof renderMain === 'function') renderMain(); };

  var p = g('elPreset');
  if (p) p.onchange = function () {
    var E = (typeof REAL !== 'undefined' && REAL && REAL.elec) || {};
    var base = (E.latest || (E.window && E.window.to) || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    var r;
    if (p.value === 'last') { var a = mmShift(base, 0); r = mmRange(a[0], a[1]); }
    else if (p.value === 'm1') { var b = mmShift(base, -1); r = mmRange(b[0], b[1]); }
    else if (p.value === 'm3') { var c = mmShift(base, -2); r = [mmRange(c[0], c[1])[0], mmRange(mmShift(base, 0)[0], mmShift(base, 0)[1])[1]]; }
    else return;
    elecState.from = r[0]; elecState.to = r[1];
    if (g('elFrom')) g('elFrom').value = r[0];
    if (g('elTo')) g('elTo').value = r[1];
  };
  var doSearch = function () {
    var f = g('elFrom'), t = g('elTo');
    var nf = (f && f.value) || elecState.from, nt = (t && t.value) || elecState.to;
    var changed = (nf !== elecState.from || nt !== elecState.to);
    elecState.from = nf; elecState.to = nt;
    elecState.campus = (g('elCampus') || {}).value || '';
    elecState.grp = (g('elGrp') || {}).value || '';
    elecState.st = (g('elSt') || {}).value || '';
    elecState.q = ((g('elQ') || {}).value || '').trim();
    elecState.dispOnly = !!(g('elDisp') && g('elDisp').checked);
    if (changed) { elecState.room = 0; reload(); } else repaint();
  };
  if (g('elSearch')) g('elSearch').onclick = doSearch;
  ['elCampus', 'elGrp', 'elSt', 'elDisp'].forEach(function (id) { if (g(id)) g(id).onchange = doSearch; });
  if (g('elQ')) g('elQ').onkeydown = function (e) { if (e.key === 'Enter') doSearch(); };

  // 행 클릭 → 그 방의 일자별 추이 조회(별도 파라미터 elecRoom)
  root.querySelectorAll('tr.el-row').forEach(function (tr) {
    tr.style.cursor = 'pointer';
    tr.onclick = function () {
      var idx = +tr.dataset.idx || 0;
      if (elecState.room === idx) { elecState.room = 0; repaint(); return; }
      elecState.room = idx; reload();
    };
  });
  if (g('elClose')) g('elClose').onclick = function () { elecState.room = 0; repaint(); };
  if (typeof makeSortable === 'function') makeSortable(root);
};
