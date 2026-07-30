/* eslint-disable */
// ═══ COMMISSION (uhak_agency_commission.php) — 유학원 커미션 계약 이력 (레거시 실데이터) ═══
//  · 소스: legacy.uhak_agency_com (4,004행) ⨝ cms.g4_member(mb_id → 유학원명)
//  · 상단: 유학원별 "현재 유효 계약"(nowYN='Y') 요약 · 하단: 전체 계약 이력(필터·정렬·페이지·엑셀)
//  · 신전산의 'COMMISSION RULES'(R.commrules, 브라우저 저장 규칙)와는 **다른 화면**이다.
//    이 화면은 레거시 DB 의 실제 체결 이력(읽기 전용)이며 규칙 계산에 관여하지 않는다(로직 분리).
//  · 레거시 컬럼 실측: uhak_idx·percent·before_percent·end_date·student·payYN 은 전량 미사용값
//    (''·'0'·null·'N') → 실제 계약값은 com_amt 하나에 담긴다(구분에 따라 % 또는 금액). notes 참조.

// 행 배열 인덱스(loadCommission 과 1:1) — 0 NO 1 AGENCY_ID 2 AGENCY 3 CATEGORY 4 PERCENT 5 AMOUNT
//   6 MANAGER 7 CONFIRM 8 STATE 9 STUDENT 10 REG 11 NOW 12 AGREE 13 MEMO 14 AMOUNT_RAW(com_amt 원문)
const CM_I = { no:0, aid:1, ag:2, cat:3, pct:4, amt:5, mgr:6, conf:7, st:8, stu:9, reg:10, now:11, agree:12, memo:13, raw:14 };
// REAL 은 index.html 에서 `let REAL=…`(스크립트 스코프)로 선언되어 window 에 붙지 않는다 → typeof 로 접근.
const cmData = () => (typeof REAL !== 'undefined' && REAL && REAL.commission && REAL.commission.rows) ? REAL.commission : null;
const cmNum = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
// 계약값 표시: percent → '30%' · amount → '500,000'(천단위)
// com_amt 는 varchar 라 '26%','300,000' 같은 잡값 3건이 있다 → 숫자칸이 비면 원문(AMOUNT_RAW)을 그대로 노출
const cmValue = (r) => {
  let raw = r[CM_I.cat] === 'percent' ? r[CM_I.pct] : r[CM_I.amt];
  if (!String(raw == null ? '' : raw).trim()) raw = r[CM_I.raw];
  if (!String(raw == null ? '' : raw).trim()) return '—';
  const n = cmNum(raw);
  if (n == null) return String(raw);
  return r[CM_I.cat] === 'percent' ? (n + '%') : n.toLocaleString();
};
const cmCatLabel = (c) => c === 'percent' ? T('정율(%)', 'PERCENT (%)') : (c === 'amount' ? T('정액', 'AMOUNT') : (c || '—'));
// state 실측분포: E 2,266 / N 1,738 — 이력 성격(N=신규체결 / E=변경·인상). notes 의 코드값표 참조.
const cmStateLabel = (s) => s === 'N' ? 'N · ' + T('신규', 'NEW') : (s === 'E' ? 'E · ' + T('변경/인상', 'CHANGE') : (s || '—'));
const cmYN = (v) => v === 'Y' ? 'Y' : (v === 'N' ? 'N' : (v || ''));

// 필터 상태(화면 재진입에도 유지)
const cmState = { ag:'', cat:'', st:'', now:'', from:'', to:'', q:'' };

R.commission = function (m) {
  const d = cmData();
  const head = `
  <div class="ph"><h1>${T('커미션 계약 (COMMISSION)', 'COMMISSION')}</h1>
    <span class="sub">${T('유학원별 커미션 계약 · 현재 유효계약 + 인상/변경 이력', 'Agency commission contracts · current deals + change history')}</span>
    <span class="url">uhak_agency_commission.php</span>
    <span class="actions" style="margin-left:auto">
      <button class="btn" id="cmXlsCur">📊 ${T('현재계약 EXCEL', 'CURRENT EXCEL')}</button>
      <button class="btn primary" id="cmXlsHist">📊 ${T('이력 EXCEL', 'HISTORY EXCEL')}</button></span></div>`;
  const notice = `<div class="banner">⚠ ${T(
    '이 화면은 <b>레거시 DB의 실제 체결 이력</b>(uhak_agency_com, 읽기 전용)입니다. 커미션 <b>계산 규칙</b>은 별도 화면 <b>COMMISSION RULES</b>(Agency 메뉴)에서 관리하며, 두 화면은 데이터·로직이 서로 분리되어 있습니다.',
    'This screen shows the <b>actual contract history from the legacy DB</b> (uhak_agency_com, read-only). Commission <b>calculation rules</b> live in the separate <b>COMMISSION RULES</b> screen (Agency menu); the two screens keep their data and logic separate.')}
    <button class="btn" id="cmGoRules" style="margin-left:10px">→ COMMISSION RULES</button></div>`;

  // 무데이터 폴백 — ① 미로딩/비로그인 ② 조회결과 0행(유학원 스코프에 계약이 없는 경우)
  if (!d || !d.rows.length) return head + notice + `<div class="card pad" style="color:var(--dim)">
    ${d ? T('조회된 커미션 계약이 없습니다. (유학원 계정은 자기 유학원 계약만 조회됩니다)',
            'No commission contracts found. (Agency accounts only see their own contracts.)')
        : T('커미션 데이터가 아직 로딩되지 않았습니다. 로그인 세션이 있으면 DB에서 자동으로 불러옵니다.',
            'Commission data is not loaded yet. It is fetched from the DB automatically when a login session exists.')}
    <div style="margin-top:8px;font-size:12.5px">${T('소스', 'Source')}: <span class="mono">legacy.uhak_agency_com ⨝ cms.g4_member</span></div></div>`;

  const rows = d.rows;
  const cur = rows.filter(r => r[CM_I.now] === 'Y');
  const agSet = {};
  rows.forEach(r => { const k = r[CM_I.aid]; if (!agSet[k]) agSet[k] = r[CM_I.ag] || k; });
  const agOpts = Object.keys(agSet).sort((a, b) => String(agSet[a]).localeCompare(String(agSet[b]), 'ko'))
    .map(k => `<option value="${esc(k)}">${esc(agSet[k])} (${esc(k)})</option>`).join('');
  const nPct = rows.filter(r => r[CM_I.cat] === 'percent').length;
  const nAmt = rows.filter(r => r[CM_I.cat] === 'amount').length;
  // 현재계약이 2건 이상인 유학원(실측 19곳) — 레거시 데이터 특성이므로 경고만 표기하고 임의 정리는 하지 않는다
  const dupCnt = {};
  cur.forEach(r => { dupCnt[r[CM_I.aid]] = (dupCnt[r[CM_I.aid]] || 0) + 1; });
  const dupAg = Object.keys(dupCnt).filter(k => dupCnt[k] > 1).length;

  return head + notice + `
  <div class="chips" style="margin-bottom:10px">${(typeof REALBADGE === 'string' ? REALBADGE : '')}
    <span class="chip">${T('전체 이력', 'History')} <b>${rows.length.toLocaleString()}</b>${T('건', '')}</span>
    <span class="chip">${T('유학원', 'Agencies')} <b>${Object.keys(agSet).length.toLocaleString()}</b></span>
    <span class="chip on">${T('현재 유효계약', 'Active deals')} <b>${cur.length.toLocaleString()}</b></span>
    <span class="chip">${T('정율', 'PERCENT')} <b>${nPct.toLocaleString()}</b></span>
    <span class="chip">${T('정액', 'AMOUNT')} <b>${nAmt.toLocaleString()}</b></span>
    ${dupAg ? `<span class="chip" style="color:var(--warn)">▲ ${T('현재계약 중복 유학원', 'Agencies w/ multiple active')} <b>${dupAg}</b></span>` : ''}</div>

  <div class="card pad" style="margin-bottom:14px">
    <b style="color:var(--accent-ink)">📌 ${T('유학원별 현재 계약 (nowYN = Y)', 'Current contract per agency (nowYN = Y)')}</b>
    <div class="filters" style="margin-top:10px;align-items:flex-end">
      <div class="field grow"><label>${T('유학원명·아이디·담당 검색', 'Search agency·id·manager')}</label>
        <input id="cmCurQ" placeholder="${T('예: 봉봉 / bonbon / Joon', 'e.g. bonbon / Joon')}"></div>
      <div class="field"><label>${T('구분', 'Type')}</label><select id="cmCurCat">
        <option value="">${T('전체', 'ALL')}</option><option value="percent">${T('정율(%)', 'PERCENT (%)')}</option><option value="amount">${T('정액', 'AMOUNT')}</option></select></div>
    </div>
    <div id="cmCurBody"></div>
  </div>

  <div class="card pad">
    <b style="color:var(--accent-ink)">🧾 ${T('전체 계약 이력', 'Full contract history')}</b>
    <div class="filters" style="margin-top:10px;align-items:flex-end">
      <div class="field"><label>${T('유학원', 'Agency')}</label><select id="cmAg"><option value="">${T('전체 유학원', 'ALL AGENCIES')}</option>${agOpts}</select></div>
      <div class="field"><label>${T('구분', 'Type')}</label><select id="cmCat">
        <option value="">${T('전체', 'ALL')}</option><option value="percent">${T('정율(%)', 'PERCENT (%)')}</option><option value="amount">${T('정액', 'AMOUNT')}</option></select></div>
      <div class="field"><label>${T('상태', 'State')}</label><select id="cmSt">
        <option value="">${T('전체', 'ALL')}</option><option value="N">N · ${T('신규', 'NEW')}</option><option value="E">E · ${T('변경/인상', 'CHANGE')}</option></select></div>
      <div class="field"><label>${T('유효', 'Active')}</label><select id="cmNow">
        <option value="">${T('전체', 'ALL')}</option><option value="Y">${T('현재 유효(Y)', 'Active (Y)')}</option><option value="N">${T('과거(N)', 'Past (N)')}</option></select></div>
      <div class="field"><label>${T('등록일 FROM', 'Registered FROM')}</label><input id="cmFrom" type="date"></div>
      <div class="field"><label>${T('등록일 TO', 'Registered TO')}</label><input id="cmTo" type="date"></div>
      <div class="field grow"><label>${T('검색(유학원·담당·사유·NO)', 'Search (agency·manager·memo·NO)')}</label>
        <input id="cmQ" placeholder="${T('예: 커미션인상 / Joon / 3820', 'e.g. Joon / 3820')}"></div>
      <div class="field"><label>&nbsp;</label><button class="btn" id="cmReset">${T('필터 초기화', 'Reset')}</button></div>
      <div class="field"><label>&nbsp;</label><span class="chip" id="cmCount"></span></div>
    </div>
    <div id="cmHistBody"></div>
  </div>
  <div class="banner" style="margin-top:12px">${T(
    '레거시 실측: <b>uhak_idx·percent·before_percent·end_date·student·payYN</b> 컬럼은 전량 미사용값이라 화면에서 제외했습니다. 계약값은 <b>com_amt</b> 한 칸에 저장되며 <b>구분(com_category)</b> 에 따라 %(정율) 또는 금액(정액)으로 해석합니다.',
    'Measured in legacy: <b>uhak_idx·percent·before_percent·end_date·student·payYN</b> hold no data at all, so they are omitted. The contract value is stored in the single <b>com_amt</b> column and read as % or a fixed amount depending on <b>com_category</b>.')}</div>`;
};

R.commission__init = function (m) {
  const root = m || document.getElementById('main');
  if (!root) return;
  const d = cmData();
  const q = (s) => root.querySelector(s);
  const val = (s) => (q(s) || {}).value || '';

  // COMMISSION RULES 화면으로 이동(안내 링크만 — 로직/데이터는 서로 통합하지 않음)
  const gr = q('#cmGoRules');
  if (gr) gr.onclick = () => {
    try {
      // MENU 도 `const MENU=`(스크립트 스코프)라 window 에 없다 → typeof 로 접근
      const list = (typeof MENU !== 'undefined' && MENU.agency) || [];
      const hit = list.filter(x => x.k === 'commrules')[0];
      if (hit) { curCat = 'agency'; curKey = 'commrules'; curMenu = hit; goMenu(); return; }
    } catch (e) { /* noop */ }
    toast(T('안내', 'Info'), T('Agency ▸ COMMISSION RULES 메뉴에서 규칙을 편집하세요.', 'Edit rules under Agency ▸ COMMISSION RULES.'), true);
  };
  if (!d || !d.rows.length) return;
  const rows = d.rows;

  // ── 상단: 유학원별 현재 유효계약 ──
  const curCols = [T('유학원', 'AGENCY'), 'ID', T('구분', 'TYPE'), T('현재 금액/%', 'VALUE'),
    T('담당', 'MANAGER'), T('확인일', 'CONFIRM'), T('상태', 'STATE'), T('등록일', 'REG'), 'NO'];
  function curRows() {
    const s = val('#cmCurQ').trim().toLowerCase(), c = val('#cmCurCat');
    return rows.filter(r => r[CM_I.now] === 'Y')
      .filter(r => !c || r[CM_I.cat] === c)
      .filter(r => !s || (r[CM_I.ag] + ' ' + r[CM_I.aid] + ' ' + r[CM_I.mgr]).toLowerCase().indexOf(s) >= 0)
      .sort((a, b) => String(a[CM_I.ag]).localeCompare(String(b[CM_I.ag]), 'ko') || (cmNum(b[CM_I.no]) - cmNum(a[CM_I.no])))
      .map(r => [r[CM_I.ag] || r[CM_I.aid], r[CM_I.aid], cmCatLabel(r[CM_I.cat]), cmValue(r),
        r[CM_I.mgr] || '—', r[CM_I.conf] || '—', cmStateLabel(r[CM_I.st]), r[CM_I.reg] || '—', r[CM_I.no]]);
  }
  function paintCur() {
    const box = q('#cmCurBody'); if (!box) return;
    paintPaged(box, curCols, curRows(), 'commissionCur');
  }

  // ── 하단: 전체 이력 ──
  const histCols = ['NO', T('유학원', 'UHAK'), 'ID', T('구분', 'TYPE'), '%', T('금액', 'AMOUNT'),
    T('담당', 'MANAGER'), T('확인일', 'CONFIRM'), T('상태', 'STATE'), T('유효', 'ACTIVE'),
    T('등록일', 'REG'), T('동의', 'AGREE'), T('사유', 'REASON')];
  function histRows() {
    const s = cmState.q.trim().toLowerCase();
    return rows
      .filter(r => !cmState.ag || r[CM_I.aid] === cmState.ag)
      .filter(r => !cmState.cat || r[CM_I.cat] === cmState.cat)
      .filter(r => !cmState.st || r[CM_I.st] === cmState.st)
      .filter(r => !cmState.now || r[CM_I.now] === cmState.now)
      .filter(r => !cmState.from || (r[CM_I.reg] && r[CM_I.reg] >= cmState.from))
      .filter(r => !cmState.to || (r[CM_I.reg] && r[CM_I.reg] <= cmState.to))
      .filter(r => !s || (r[CM_I.ag] + ' ' + r[CM_I.aid] + ' ' + r[CM_I.mgr] + ' ' + r[CM_I.memo] + ' ' + r[CM_I.no]).toLowerCase().indexOf(s) >= 0)
      .map(r => [r[CM_I.no], r[CM_I.ag] || r[CM_I.aid], r[CM_I.aid], cmCatLabel(r[CM_I.cat]),
        r[CM_I.cat] === 'percent' ? cmValue(r) : '', r[CM_I.cat] === 'amount' ? cmValue(r) : '',
        r[CM_I.mgr] || '—', r[CM_I.conf] || '—', cmStateLabel(r[CM_I.st]), cmYN(r[CM_I.now]),
        r[CM_I.reg] || '—', cmYN(r[CM_I.agree]), r[CM_I.memo] || '']);
  }
  function paintHist() {
    const box = q('#cmHistBody'); if (!box) return;
    const rs = histRows();
    paintPaged(box, histCols, rs, 'commissionHist');
    const c = q('#cmCount');
    if (c) c.innerHTML = T('조회', 'Found') + ' <b>' + rs.length.toLocaleString() + '</b> / ' + rows.length.toLocaleString();
  }

  // 필터 배선(값 복원 → 이벤트)
  const setv = (s, v) => { const e = q(s); if (e) e.value = v; };
  setv('#cmAg', cmState.ag); setv('#cmCat', cmState.cat); setv('#cmSt', cmState.st);
  setv('#cmNow', cmState.now); setv('#cmFrom', cmState.from); setv('#cmTo', cmState.to); setv('#cmQ', cmState.q);
  const sync = () => {
    cmState.ag = val('#cmAg'); cmState.cat = val('#cmCat'); cmState.st = val('#cmSt'); cmState.now = val('#cmNow');
    cmState.from = val('#cmFrom'); cmState.to = val('#cmTo'); cmState.q = val('#cmQ');
    if (pgState.commissionHist) pgState.commissionHist.page = 0;
    paintHist();
  };
  ['#cmAg', '#cmCat', '#cmSt', '#cmNow', '#cmFrom', '#cmTo'].forEach(s => { const e = q(s); if (e) e.addEventListener('change', sync); });
  const qi = q('#cmQ'); if (qi) qi.addEventListener('input', sync);
  const rst = q('#cmReset'); if (rst) rst.onclick = () => {
    cmState.ag = cmState.cat = cmState.st = cmState.now = cmState.from = cmState.to = cmState.q = '';
    setv('#cmAg', ''); setv('#cmCat', ''); setv('#cmSt', ''); setv('#cmNow', ''); setv('#cmFrom', ''); setv('#cmTo', ''); setv('#cmQ', '');
    if (pgState.commissionHist) pgState.commissionHist.page = 0;
    paintHist();
  };
  ['#cmCurQ', '#cmCurCat'].forEach(s => {
    const e = q(s); if (!e) return;
    e.addEventListener(s === '#cmCurQ' ? 'input' : 'change', () => {
      if (pgState.commissionCur) pgState.commissionCur.page = 0;
      paintCur();
    });
  });

  // 엑셀: 표가 2개라 전역 exportGridXls(=#main 의 "첫" table.grid 고정)는 쓸 수 없다.
  //  → 기존 헬퍼 toXls(headers,rows,fname,redCols) 를 재사용하되, 화면에 보이는 한 페이지(50행)가 아니라
  //    **필터 적용된 전체 행**을 넘긴다(data-specexcel 방식과 동일한 사용자 기대).
  function xls(cols, rws, fname) {
    if (typeof toXls !== 'function') { toast(T('내보내기 불가', 'Export unavailable'), '', false); return; }
    if (!rws.length) { toast(T('내보낼 데이터 없음', 'No data to export'), '', false); return; }
    toXls(cols, rws, fname, []);
    toast(T('엑셀 내보내기 완료', 'Excel exported'),
      rws.length.toLocaleString() + T('행 · 현재 필터 기준', ' rows · current filters'), true);
  }
  const bc = q('#cmXlsCur'); if (bc) bc.onclick = () => xls(curCols, curRows(), 'SMEAG_COMMISSION_CURRENT.xls');
  const bh = q('#cmXlsHist'); if (bh) bh.onclick = () => xls(histCols, histRows(), 'SMEAG_COMMISSION_HISTORY.xls');

  paintCur();
  paintHist();
};
