// 01: 로그인 + 관리자 메뉴/링크 구조 발견 (구조만, 개인정보 값 미수집)
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://www.smeadmin.com';
const G = `${BASE}/gnuboard4`;
const USER = 'kenneth';
const PASS = 'kenneth';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // 1) 로그인 페이지 (그누보드4)
  await page.goto(`${G}/bbs/login.php?url=%2Fgnuboard4%2Fadm%2Findex.php`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  const loginForm = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({name:i.name, type:i.type, id:i.id}));
    const forms = [...document.querySelectorAll('form')].map(f => ({action:f.action, method:f.method, name:f.name}));
    return { url: location.href, title: document.title, inputs, forms };
  });
  fs.writeFileSync('loginform.json', JSON.stringify(loginForm, null, 2));
  console.log('login inputs:', loginForm.inputs.map(i=>i.name).join(','));

  // 2) 로그인
  try {
    await page.fill('input[name="mb_id"]', USER);
    await page.fill('input[name="mb_password"]', PASS);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(()=>{}),
      page.click('input[type="submit"], button[type="submit"], input[type="image"]'),
    ]);
  } catch (e) { fs.writeFileSync('login_error.txt', String(e)); console.log('login err', e.message); }
  await page.waitForTimeout(1500);

  // 3) 관리자 진입
  await page.goto(`${G}/adm/index.php`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForTimeout(1000);

  const admInfo = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ text: (a.textContent||'').trim().slice(0,60), href: a.getAttribute('href') }))
      .filter(l => l.href && !l.href.startsWith('javascript') && l.text);
    // 프레임(그누보드 관리자는 iframe/frameset 가능성)
    const frames = [...document.querySelectorAll('frame,iframe')].map(f => ({name:f.name, src:f.getAttribute('src')}));
    return { url: location.href, title: document.title, linkCount: links.length, links, frames };
  });
  fs.writeFileSync('adm_landing.json', JSON.stringify(admInfo, null, 2));

  console.log('landing url:', admInfo.url);
  console.log('title:', admInfo.title);
  console.log('links found:', admInfo.linkCount);
  console.log('frames:', JSON.stringify(admInfo.frames));

  await ctx.storageState({ path: 'state.json' });
  console.log('storage state saved.');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
