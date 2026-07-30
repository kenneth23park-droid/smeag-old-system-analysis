const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const { loginAndSaveState, G } = require('./lib_login.js');
const OUT = '/private/tmp/claude-501/-Users-kwangseobpark-smeag-old-system-analysis/ecd81dfb-50b0-4aa0-9358-3f178f12fa5f/scratchpad';

(async () => {
  const state = path.join(OUT, 'state.json');
  if (!fs.existsSync(state)) await loginAndSaveState(state);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: state, ignoreHTTPSErrors: true, viewport: { width: 640, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(()=>{}));
  await page.goto(`${G}/adm/room_stat3.php`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.selectOption('select[name="center_gubun"]', 'capital').catch(()=>{});
  await page.selectOption('select[name="gender"]', 'M').catch(()=>{});
  await page.evaluate(() => document.forms['sf'].submit()).catch(()=>{});
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForTimeout(2500);
  let idxs = await page.evaluate(() => (document.documentElement.innerHTML.match(/open_student\((\d+)\)/g) || []).slice(0, 10));
  fs.writeFileSync(path.join(OUT, 'room_stat3_capital.html'), await page.content());
  console.log('url', page.url());
  console.log('idxs', idxs);
  const sid = (idxs[0] || '').replace(/\D/g, '');
  if (!sid) { await browser.close(); return; }
  await page.goto(`${G}/adm/student_room.php?s_idx=${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  fs.writeFileSync(path.join(OUT, 'student_room.html'), await page.content());
  await page.screenshot({ path: path.join(OUT, 'student_room.png'), fullPage: true });
  console.log('saved for s_idx', sid);
  await browser.close();
})();
