const { chromium } = require('playwright');
const fs = require('fs');
const G = 'http://www.smeadmin.com/gnuboard4';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept().catch(()=>{}); });

  await page.goto(`${G}/bbs/login.php`, { waitUntil: 'domcontentloaded' });
  // flogin 폼 필드 전체 나열
  const fields = await page.evaluate(() => {
    const f = document.forms['flogin'];
    if (!f) return null;
    return [...f.elements].map(e => ({ name:e.name, type:e.type, value:(e.type==='password'?'***':e.value) }));
  });
  fs.writeFileSync('flogin_fields.json', JSON.stringify(fields, null, 2));
  console.log('flogin fields:', JSON.stringify(fields));

  await page.fill('form[name="flogin"] input[name="mb_id"]', 'kenneth');
  await page.fill('form[name="flogin"] input[name="mb_password"]', 'kenneth');

  const [resp] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>null),
    page.evaluate(() => { document.forms['flogin'].submit(); }),
  ]);
  await page.waitForTimeout(1500);
  console.log('post url:', page.url());
  console.log('dialogs:', JSON.stringify(dialogs));
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g,' ').slice(0, 600));
  fs.writeFileSync('post_submit_body.txt', body);
  // 로그인 성공시 보통 메인/이전 url로 이동. 로그인폼 재노출 여부:
  const stillLogin = await page.evaluate(()=> !!(document.forms['flogin']));
  console.log('still has flogin form:', stillLogin);
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
