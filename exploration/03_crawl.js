// 03: 전 화면 병렬 크롤 — 구조 메타데이터만 수집(개인정보 셀 값 미수집)
// 수집: 제목 · 폼(필드명/셀렉트옵션=코드사전) · 데이터테이블 컬럼헤더 · 건수 텍스트 · 페이지수
// 스크린샷: shots/<slug>.png (로컬 전용, gitignore) — result.md에는 PII 미포함
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://www.smeadmin.com';
const ADM = `${BASE}/gnuboard4/adm/`;
const BBS = `${BASE}/gnuboard4/bbs/`;

// 대분류별 대상(발견 + 문서 병합)
const TARGETS = [
  // ── Student's ──
  ['Student', 'STUDENT LIST', 'student.php'],
  ['Student', '수강등록관리', 'student_list.php'],
  ['Student', '멀티수강관리', 'student_list3.php?multi_course=check'],
  ['Student', 'MC Report 1', 'student_list3_en1.php?multi_course=check'],
  ['Student', 'MC Report 2', 'student_list3_en2.php?multi_course=check'],
  ['Student', 'Graduate', 'student_list3_en3.php?multi_course=check'],
  ['Student', 'APPLY LIST', 'student_list2.php'],
  ['Student', 'HISTORY', 'student_history.php'],
  ['Student', '변경환불홀딩', 'student_list_change.php'],
  ['Student', 'CHG-REF-HOLD', 'student_list_change-back.php'],
  ['Student', '수금관리', 'student_list_pay.php'],
  ['Student', 'DEPOSIT', 'student_payment.php'],
  ['Student', 'Deposit(test)', 'student_payment-2.php'],
  ['Student', 'FARM & GYM', 'student_farm.php'],
  ['Student', 'GYM 리포트', 'student_gym.php'],
  ['Student', 'FARM 리포트', 'student_farm2.php'],
  ['Student', 'POPULATION', 'student_population.php'],
  ['Student', 'POPULATION2', 'student_population2.php'],
  ['Student', 'STDNT STATUS', 'student_present2.php'],
  ['Student', 'STDNT Fullsize', 'student_present2-rey.php'],
  ['Student', 'STDNT Encanto', 'student_present2-sparta.php'],
  ['Student', 'STDNT Classic', 'student_present2-classic.php'],
  ['Student', 'STDNT Capital', 'student_present2-capital.php'],
  ['Student', 'REGISTER STATS', 'student_register.php'],
  // ── Dormitory ──
  ['Dorm', 'DORM SEARCH', 'room_search2.php'],
  ['Dorm', '기숙사현황', 'room_stat3.php'],
  ['Dorm', 'DORM STATUS', 'room_stat2.php'],
  ['Dorm', '기숙사이동관리', 'room_move_list.php'],
  ['Dorm', 'ROOM M-LIST', 'room_move_list2.php'],
  ['Dorm', '일별 입실퇴실', 'room_use_count_list.php'],
  ['Dorm', 'DAY IN&OUT', 'room_use_count_list2.php'],
  ['Dorm', 'ELEC&WATER', 'room_elec.php'],
  ['Dorm', 'VISIT(detail)', 'uhak_agency_visit.php'],
  ['Dorm', 'VISIT(calenda)', 'uhak_agency_schedule_list.php'],
  ['Dorm', 'DORM LIST', 'room_list.php'],
  ['Dorm', 'BACK-UP LOG', 'room_change_log.php'],
  ['Dorm', 'DAYOFF', 'scheduler_index.php'],
  ['Dorm', 'Scheduler', 'scheduler_index-all.php'],
  ['Dorm', 'Admission Date', 'smeag_admissiondate.php'],
  // ── Cash Cards ──
  ['Cash', 'Manage Cash', 'student_cash_payment.php'],
  ['Cash', 'Group Students', 'student_group_payment.php'],
  ['Cash', 'Pre-paid Info', 'student_payment-2.php'],
  // ── Boards ──
  ['Board', 'GAC BOARD', '__BBS__board.php?bo_table=office_GAC'],
  ['Board', 'Campus Holding', '__BBS__board.php?bo_table=office_holding'],
  ['Board', 'SME_BOARD', '__BBS__board.php?bo_table=office_share'],
];

function urlOf(path) {
  return path.startsWith('__BBS__') ? BBS + path.slice(7) : ADM + path;
}
function slug(path) { return path.replace('__BBS__','bbs_').replace(/[^\w.-]/g,'_'); }

// 페이지 내부 추출기 (개인정보 값 미수집)
const EXTRACT = () => {
  const norm = s => (s||'').replace(/\s+/g,' ').trim();
  // 로그인 리다이렉트?
  if (document.querySelector('input[name="mb_password"]')) return { redirectedToLogin: true, title: document.title };

  // 폼: 필드명 + 셀렉트 옵션(코드사전)
  const forms = [...document.querySelectorAll('form')].map(f => {
    const fields = [...f.elements].filter(e => e.name).map(e => {
      const o = { name: e.name, type: e.type || e.tagName.toLowerCase() };
      if (e.tagName === 'SELECT') {
        o.options = [...e.options].slice(0, 80).map(op => ({ v: op.value, t: norm(op.textContent).slice(0,40) }));
      } else if (e.type === 'hidden') {
        o.value = norm(String(e.value)).slice(0, 40); // 설정성 hidden만(코드/모드)
      }
      return o;
    });
    // 중복 필드명 제거
    const seen = new Set(); const uniq = [];
    for (const fl of fields) { const k = fl.name+':'+fl.type; if (!seen.has(k)) { seen.add(k); uniq.push(fl); } }
    let action = f.getAttribute('action') || '';
    try { const u = new URL(f.action, location.href); action = u.pathname.split('/').pop() + u.search; } catch(_){}
    return { name: f.getAttribute('name')||'', method: (f.method||'get').toLowerCase(), action, fields: uniq };
  }).filter(f => f.fields.length);

  // 데이터 그리드 탐지: 레이아웃 테이블(넓은 spacer행) 배제.
  //  = 데이터행(셀 4~30개)의 '최빈 컬럼수(modeCol)'가 일정하고, 그 행이 가장 많은 테이블.
  const looksData = (cells) => {
    // 헤더행 후보: 숫자/날짜 없는 짧은 라벨들 → PII(이름/생일) 회피
    return cells.every(c => c.length <= 28 && !/\d{4}|\d{2}[-/.]\d{2}|@/.test(c));
  };
  const tableStats = [...document.querySelectorAll('table')].map((t) => {
    const rows = [...t.rows];
    const freq = {};
    rows.forEach(r => { const n = r.cells.length; if (n >= 4 && n <= 30) freq[n] = (freq[n]||0)+1; });
    let modeCol = 0, modeN = 0;
    for (const k in freq) if (freq[k] > modeN) { modeN = freq[k]; modeCol = +k; }
    // 헤더행: modeCol개 셀을 가진 첫 행 중, 라벨성(숫자/날짜 없음)인 것
    let header = null;
    for (const r of rows) {
      if (r.cells.length !== modeCol) continue;
      const cells = [...r.cells].map(c => norm(c.textContent).slice(0,30));
      const hasTh = [...r.cells].some(c => c.tagName === 'TH');
      if (hasTh || looksData(cells)) { header = cells; break; }
    }
    return { modeCol, dataRows: modeN, header };
  });
  // 주 데이터그리드 = 데이터행이 가장 많고 컬럼수 4~25, 헤더 확보된 테이블
  const dataTable = tableStats
    .filter(t => t.modeCol >= 4 && t.modeCol <= 25 && t.dataRows >= 1 && t.header)
    .sort((a,b) => b.dataRows - a.dataRows)[0] || null;
  const dataGrid = dataTable ? { colN: dataTable.modeCol, dataRows: dataTable.dataRows, cols: dataTable.header } : null;

  // 건수 텍스트 (개인정보 아님)
  const bodyText = norm(document.body.innerText);
  const counts = [];
  const re = /(총\s*)?([\d,]{2,})\s*(건|명|실|개|Cases|records)/gi;
  let m; let guard=0;
  while ((m = re.exec(bodyText)) && guard++ < 12) counts.push(m[0].slice(0,25));

  // 페이지네이션 마지막 페이지 번호
  let lastPage = null;
  document.querySelectorAll('a[href]').forEach(a => {
    const mm = /[?&]page=(\d+)/.exec(a.getAttribute('href')||'');
    if (mm) { const n = +mm[1]; if (!lastPage || n > lastPage) lastPage = n; }
  });

  return {
    redirectedToLogin: false,
    title: norm(document.title),
    forms,
    tableN: tableStats.length,
    dataTable: dataGrid,
    counts: [...new Set(counts)].slice(0, 8),
    lastPage,
  };
};

async function crawlOne(ctx, [cat, label, path]) {
  const page = await ctx.newPage();
  page.on('dialog', async d => { await d.accept().catch(()=>{}); });
  const url = urlOf(path);
  const rec = { cat, label, path, url };
  try {
    let resp;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e1) {
      // 대용량 페이지 재시도: commit까지만 기다린 뒤 DOM 안정 대기
      resp = await page.goto(url, { waitUntil: 'commit', timeout: 90000 });
      await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(700);
    rec.status = resp ? resp.status() : null;
    rec.finalUrl = page.url();
    const data = await page.evaluate(EXTRACT);
    Object.assign(rec, data);
    // 스크린샷 (로컬 전용)
    try { await page.screenshot({ path: `shots/${slug(path)}.png`, fullPage: false }); rec.shot = `shots/${slug(path)}.png`; } catch(_){}
  } catch (e) {
    rec.error = e.message;
  } finally {
    await page.close();
  }
  const tag = rec.error ? 'ERR' : (rec.redirectedToLogin ? 'LOGIN!' : rec.status);
  console.log(`[${cat}] ${label.padEnd(16)} ${String(tag).padEnd(6)} cols:${rec.dataTable?rec.dataTable.colN:'-'} forms:${rec.forms?rec.forms.length:'-'} ${rec.counts?rec.counts.join('/'):''}`);
  return rec;
}

// 동시성 제한 병렬 풀
async function pool(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: 'state.json', viewport: { width: 1440, height: 900 } });
  console.log(`크롤 시작: ${TARGETS.length}개 화면, 동시성 4\n`);
  const t0 = Date.now();
  const results = await pool(TARGETS, 4, (t) => crawlOne(ctx, t));
  const secs = ((Date.now()-t0)/1000).toFixed(1);
  fs.writeFileSync('crawl_results.json', JSON.stringify({ crawledAt: 'session', totalScreens: results.length, elapsedSec: +secs, results }, null, 2));
  const okN = results.filter(r=>!r.error && !r.redirectedToLogin).length;
  console.log(`\n완료: ${okN}/${results.length} 정상, ${secs}s`);
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
