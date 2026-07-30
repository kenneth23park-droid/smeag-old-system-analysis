const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const { loginAndSaveState, G } = require('./lib_login.js');
const OUT = '/private/tmp/claude-501/-Users-kwangseobpark-smeag-old-system-analysis/ecd81dfb-50b0-4aa0-9358-3f178f12fa5f/scratchpad';

(async () => {
  const state = path.join(OUT, 'state.json');
  if (!fs.existsSync(state)) await loginAndSaveState(state);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: state, ignoreHTTPSErrors: true, viewport: { width: 700, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(()=>{}));
  // search a student by name on the student list
  const urls = [
    `${G}/adm/student_list.php?sfl=e_name&stx=SHANG`,
    `${G}/adm/student.php?sfl=e_name&stx=SHANG`,
  ];
  let sid = null;
  for (const u of urls) {
    await page.goto(u, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const m = html.match(/s_idx=(\d+)/g) || html.match(/open_student\((\d+)\)/g);
    fs.writeFileSync(path.join(OUT, 'list_' + encodeURIComponent(u.split('/adm/')[1]).slice(0, 40) + '.html'), html);
    if (m) { sid = m[0].replace(/\D/g, ''); console.log(u, '->', m.slice(0, 5)); break; }
    console.log(u, '-> none');
  }
  if (!sid) { await browser.close(); return; }
  await page.goto(`${G}/adm/student_room.php?s_idx=${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  fs.writeFileSync(path.join(OUT, 'student_room.html'), await page.content());
  await page.screenshot({ path: path.join(OUT, 'student_room.png'), fullPage: true });
  console.log('captured student_room for', sid);
  await browser.close();
})();
