const { chromium } = require('playwright');
const fs = require('fs');
const { G } = require('./lib_login');
(async () => {
  const url = process.argv[2] || `${G}/adm/student_list.php`;
  const out = process.argv[3] || 'student_list.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: 'state.json' });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  fs.writeFileSync(out, await page.content());
  console.log('saved', out, (await page.title()));
  await browser.close();
})();
