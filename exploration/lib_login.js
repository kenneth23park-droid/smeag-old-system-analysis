// 공용 로그인 헬퍼 — flogin 폼을 정확히 지정
const { chromium } = require('playwright');
const G = 'http://www.smeadmin.com/gnuboard4';

async function loginAndSaveState(statePath) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('dialog', async d => { await d.accept().catch(()=>{}); });

  await page.goto(`${G}/bbs/login.php`, { waitUntil: 'domcontentloaded' });
  // flogin 폼 내부 필드만 채움
  await page.fill('form[name="flogin"] input[name="mb_id"]', 'kenneth');
  await page.fill('form[name="flogin"] input[name="mb_password"]', 'kenneth');
  // onsubmit(flogin_submit)이 action을 login_check.php로 바꾸므로 반드시 제출 '버튼'을 클릭
  const btn = await page.$('form[name="flogin"] input[type="image"], form[name="flogin"] input[type="submit"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{}),
    btn ? btn.click() : page.evaluate(() => { document.forms['flogin'].submit(); }),
  ]);
  await page.waitForTimeout(1200);

  // 검증: 커스텀 관리자 페이지가 로그인폼으로 튕기지 않는지
  await page.goto(`${G}/adm/student.php`, { waitUntil: 'domcontentloaded' });
  const ok = await page.evaluate(() => !document.querySelector('input[name="mb_password"]'));
  if (statePath) await ctx.storageState({ path: statePath });
  await browser.close();
  return ok;
}

module.exports = { loginAndSaveState, G };

if (require.main === module) {
  loginAndSaveState('state.json').then(ok => {
    console.log('LOGIN OK:', ok);
    process.exit(ok ? 0 : 2);
  });
}
