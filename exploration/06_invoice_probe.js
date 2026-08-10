// 인보이스 발행 화면 직접 탐색: student_list.php 의 INVOICE 진입점 → 실제 발행 페이지 구조 수집
const { chromium } = require('playwright');
const fs = require('fs');
const { loginAndSaveState, G } = require('./lib_login');

(async () => {
  if (!fs.existsSync('state.json')) await loginAndSaveState('state.json');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: 'state.json' });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`${G}/adm/student_list.php`, { waitUntil: 'domcontentloaded' });
  if (await page.$('input[name="mb_password"]')) {
    await browser.close();
    await loginAndSaveState('state.json');
    return console.log('SESSION EXPIRED — rerun');
  }

  // INVOICE 관련 진입점 수집
  const entries = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a,input[type=button],input[type=image],button').forEach(el => {
      const t = (el.innerText || el.value || el.alt || '') + ' ' + (el.getAttribute('href') || '') +
                ' ' + (el.getAttribute('onclick') || '') + ' ' + (el.getAttribute('src') || '');
      if (/invoice/i.test(t)) out.push({
        tag: el.tagName, text: (el.innerText || el.value || el.alt || '').trim().slice(0, 60),
        href: el.getAttribute('href'), onclick: el.getAttribute('onclick'), src: el.getAttribute('src'),
      });
    });
    return out;
  });
  console.log('ENTRIES(', entries.length, ')');
  entries.slice(0, 15).forEach(e => console.log(JSON.stringify(e)));

  // 후보 URL 직접 접근 테스트
  const guesses = ['student_info_invoice.php', 'invoice.php', 'student_invoice.php',
    'student_list_invoice.php', 'invoice_form.php', 'student_info_invoice_list.php'];
  const found = new Set();
  entries.forEach(e => {
    const m = ((e.href || '') + ' ' + (e.onclick || '')).match(/[\w\-\/\.]*invoice[\w\-]*\.php[^'"\s)]*/gi);
    if (m) m.forEach(x => found.add(x));
  });
  for (const g of guesses) {
    const r = await page.goto(`${G}/adm/${g}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
    const st = r ? r.status() : 'ERR';
    const title = await page.title().catch(() => '');
    const len = (await page.content().catch(() => '')).length;
    console.log('PROBE', g, st, len, '|', title.slice(0, 50));
  }
  console.log('FOUND_IN_PAGE', [...found]);
  fs.writeFileSync('invoice_probe.json', JSON.stringify({ entries, found: [...found] }, null, 2));
  await browser.close();
})();
