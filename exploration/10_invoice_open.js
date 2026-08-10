// 인보이스 발행 화면 + 발행물(학생/에이전시) 실측
const { chromium } = require('playwright');
const fs = require('fs');
const G = 'http://www.smeadmin.com/gnuboard4';
const ROOT = 'http://www.smeadmin.com';

(async () => {
  const sid = process.argv[2] || '101300';
  const inv = process.argv[3] || '128709';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: 'state.json', viewport: { width: 1200, height: 1000 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  const targets = [
    ['modify', `${G}/adm/student_modify.php?mode=modify&modify_no=${sid}`],
    ['inv_student', `${ROOT}/invoice_student2.html?invoice_no=${inv}&sid=${sid}`],
    ['inv_agency', `${ROOT}/invoice_agency2.html?invoice_no=${inv}`],
    ['inv_student_for', `${ROOT}/invoice_student2_for.html?invoice_no=${inv}`],
  ];
  for (const [k, url] of targets) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const html = await page.content();
    fs.writeFileSync(`invopen_${k}.html`, html);
    await page.screenshot({ path: `shots/invopen_${k}.png`, fullPage: true }).catch(() => {});
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1200)).catch(() => '');
    console.log('#####', k, url, '\n', txt, '\n');
  }
  await browser.close();
})();
