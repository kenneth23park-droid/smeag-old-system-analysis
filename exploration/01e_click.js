const { chromium } = require('playwright');
const fs = require('fs');
const G = 'http://www.smeadmin.com/gnuboard4';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('dialog', async d => { console.log('DIALOG:', d.message()); await d.accept().catch(()=>{}); });

  await page.goto(`${G}/bbs/login.php`, { waitUntil: 'domcontentloaded' });

  // flogin 폼의 제출 관련 요소(버튼/이미지/링크) 나열
  const submitters = await page.evaluate(() => {
    const f = document.forms['flogin'];
    const out = [];
    f.querySelectorAll('input[type="submit"],input[type="image"],button,a[href]').forEach(el => {
      out.push({ tag:el.tagName, type:el.type, text:(el.textContent||el.value||'').trim().slice(0,30), href:el.getAttribute&&el.getAttribute('href'), onclick: el.getAttribute&&el.getAttribute('onclick') });
    });
    // flogin_submit 함수 소스
    let src = '';
    try { src = window.flogin_submit ? window.flogin_submit.toString().slice(0,500) : 'n/a'; } catch(e){ src=String(e); }
    return { submitters: out, flogin_submit_src: src, action: f.action };
  });
  fs.writeFileSync('flogin_submitters.json', JSON.stringify(submitters, null, 2));
  console.log('action:', submitters.action);
  console.log('flogin_submit:', submitters.flogin_submit_src);
  console.log('submitters:', JSON.stringify(submitters.submitters));

  await page.fill('form[name="flogin"] input[name="mb_id"]', 'kenneth');
  await page.fill('form[name="flogin"] input[name="mb_password"]', 'kenneth');
  // 실제 제출 버튼 클릭 (onsubmit 실행되도록)
  const btnSel = 'form[name="flogin"] input[type="submit"], form[name="flogin"] input[type="image"], form[name="flogin"] button';
  const has = await page.$(btnSel);
  console.log('has submit el in flogin:', !!has);
  await Promise.all([
    page.waitForNavigation({ waitUntil:'domcontentloaded', timeout:20000 }).catch(()=>null),
    has ? has.click() : page.evaluate(()=>document.forms['flogin'].submit()),
  ]);
  await page.waitForTimeout(1500);
  console.log('post url:', page.url());

  // 최종 검증
  await page.goto(`${G}/adm/student.php`, { waitUntil:'domcontentloaded' });
  const ok = await page.evaluate(()=> !document.querySelector('input[name="mb_password"]'));
  console.log('ADM ACCESS OK:', ok, '| url:', page.url());
  if (ok) await ctx.storageState({ path:'state.json' });
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
