// student_list.php 표에서 INVOICE 칸의 실제 링크/스크립트를 추출
const { chromium } = require('playwright');
const fs = require('fs');
const { G } = require('./lib_login');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: 'state.json' });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(`${G}/adm/student_list.php`, { waitUntil: 'domcontentloaded' });

  const info = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    let best = null, bestIdx = -1;
    for (const t of tables) {
      const ths = [...t.querySelectorAll('tr')][0];
      if (!ths) continue;
      const cells = [...ths.children].map(c => c.innerText.trim().toUpperCase());
      const i = cells.indexOf('INVOICE');
      if (i >= 0) { best = t; bestIdx = i; var hdr = cells; break; }
    }
    if (!best) return { err: 'no INVOICE header', headers: tables.map(t => (t.rows[0] ? [...t.rows[0].cells].map(c => c.innerText.trim()) : [])).slice(0, 6) };
    const rows = [...best.rows].slice(1, 4).map(r => {
      const c = r.cells[bestIdx];
      if (!c) return null;
      return { html: c.innerHTML.trim().slice(0, 500) };
    });
    return { headerIdx: bestIdx, headers: hdr, rows };
  });
  console.log(JSON.stringify(info, null, 2).slice(0, 4000));
  fs.writeFileSync('invoice_cell.json', JSON.stringify(info, null, 2));
  await browser.close();
})();
