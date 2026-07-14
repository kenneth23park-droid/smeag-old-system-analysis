const { chromium } = require('playwright');
const fs = require('fs');
const G = 'http://www.smeadmin.com/gnuboard4';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ignoreHTTPSErrors:true})).newPage();

  // 콘솔/다이얼로그(alert) 캡처
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept().catch(()=>{}); });

  await page.goto(`${G}/bbs/login.php`, { waitUntil:'domcontentloaded' });
  const forms = await page.evaluate(() => {
    return [...document.querySelectorAll('form')].map(f => ({
      name:f.name, id:f.id, action:f.action, method:f.method, onsubmit: f.getAttribute('onsubmit'),
      html: f.outerHTML.slice(0, 1500)
    }));
  });
  fs.writeFileSync('login_forms.json', JSON.stringify(forms, null, 2));

  // 로그인 시도: 필드 채우고 실제 submit 버튼 클릭
  await page.fill('input[name="mb_id"]', 'kenneth');
  await page.fill('input[name="mb_password"]', 'kenneth');
  const btn = await page.$('form[name="flogin"] input[type="submit"], form[name="flogin"] button, input[type="image"], .btn_submit');
  console.log('submit btn found:', !!btn);
  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded', timeout:15000}).catch(()=>{}),
    (btn ? btn.click() : page.keyboard.press('Enter')),
  ]);
  await page.waitForTimeout(1500);
  console.log('after submit url:', page.url());
  console.log('dialogs:', JSON.stringify(dialogs));
  const stillLogin = await page.evaluate(()=> !!document.querySelector('input[name="mb_password"]'));
  console.log('still on login form:', stillLogin);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
