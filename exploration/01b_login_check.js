const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://www.smeadmin.com';
const G = `${BASE}/gnuboard4`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  await page.goto(`${G}/bbs/login.php`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="mb_id"]', 'kenneth');
  await page.fill('input[name="mb_password"]', 'kenneth');
  // 폼 직접 제출
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(()=>{}),
    page.evaluate(() => { const f=document.querySelector('form[name="flogin"], form#flogin, form'); if(f) f.submit(); }),
  ]);
  await page.waitForTimeout(1200);

  // 로그인 직후 상태 텍스트
  const afterLogin = await page.evaluate(() => document.body.innerText.slice(0, 400));
  fs.writeFileSync('after_login.txt', afterLogin);

  const cookies = await ctx.cookies();
  console.log('cookies:', cookies.map(c=>c.name).join(','));

  // 여러 후보 페이지 접근 테스트
  const targets = [
    '/gnuboard4/', '/gnuboard4/adm/index.php', '/gnuboard4/adm/student.php',
    '/gnuboard4/adm/room_stat3.php', '/gnuboard4/adm/main.php',
  ];
  const out = [];
  for (const t of targets) {
    try {
      const resp = await page.goto(BASE + t, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const info = await page.evaluate(() => ({ title: document.title, url: location.href, bodyLen: document.body.innerText.length, hasLoginForm: !!document.querySelector('input[name="mb_password"]') }));
      out.push({ target: t, status: resp && resp.status(), ...info });
      console.log(t, '->', resp && resp.status(), '|', info.url, '| login?', info.hasLoginForm, '| title', info.title);
    } catch (e) { out.push({ target: t, error: e.message }); console.log(t, 'ERR', e.message); }
  }
  fs.writeFileSync('access_test.json', JSON.stringify(out, null, 2));
  await ctx.storageState({ path: 'state.json' });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
