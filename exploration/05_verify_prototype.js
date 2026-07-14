// 05: 프로토타입 렌더 검증 — 콘솔에러/메뉴/네비게이션/중복방지 데모 확인
const { chromium } = require('playwright');
const path = require('path');
const fileUrl = 'file://' + path.resolve(__dirname, '../docs/design-admin/prototype_local.html');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport:{width:1440,height:960} })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(fileUrl, { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(400);

  const cats = await page.$$eval('#cats .cat', els => els.map(e=>e.textContent.trim()));
  const navCount = await page.$$eval('#nav a', els => els.length);
  const h1 = await page.$eval('.ph h1', e=>e.textContent);
  console.log('카테고리:', cats.join(' / '));
  console.log('사이드바 메뉴 수(Student):', navCount, '| 첫화면 h1:', h1);

  // 각 카테고리 클릭 → 메뉴 수 + 첫 h1
  const cnts = {};
  for (let i=0;i<cats.length;i++){
    await page.$$('#cats .cat').then(bs=>bs[i].click());
    await page.waitForTimeout(200);
    const n = await page.$$eval('#nav a', els=>els.length);
    const t = await page.$eval('.ph h1', e=>e.textContent);
    cnts[cats[i]] = { menus:n, first:t };
    await page.screenshot({ path: `shots/proto_${i}_${cats[i].replace(/[^\w]/g,'')}.png` });
  }
  console.log('카테고리별:', JSON.stringify(cnts));

  // 핵심 화면 렌더 확인: Student > DEPOSIT, Dorm > 기숙사현황
  await page.$$('#cats .cat').then(bs=>bs[1].click()); await page.waitForTimeout(150);
  await page.$$eval('#nav a', els=>{ const t=els.find(a=>/DEPOSIT/.test(a.textContent)); t&&t.click(); });
  await page.waitForTimeout(200);
  const depRows = await page.$$eval('table.grid tbody tr', r=>r.length).catch(()=>0);
  console.log('DEPOSIT 렌더 행:', depRows);

  // 중복방지 데모: Cash > Manage Cash > 인보이스 발행 2회 클릭
  await page.$$('#cats .cat').then(bs=>bs[3].click()); await page.waitForTimeout(200);
  const invBtn = await page.$('[data-guard="invoice"]');
  await invBtn.click(); await page.waitForTimeout(120);
  await invBtn.click().catch(()=>{}); // 처리중 재클릭 (disabled면 무시)
  // disabled여도 직접 이벤트로 재트리거되는지 별개로, 토스트/버튼상태 확인
  await page.waitForTimeout(300);
  const btnState = await page.$eval('[data-guard="invoice"]', b=>({disabled:b.disabled, html:b.textContent.trim()}));
  const toastN = await page.$$eval('#toasts .toast', t=>t.length);
  console.log('인보이스 버튼 상태(처리중):', JSON.stringify(btnState), '| 토스트:', toastN);
  await page.screenshot({ path:'shots/proto_guard.png' });

  console.log('\n=== 콘솔/페이지 에러 ===');
  console.log(errors.length ? errors.join('\n') : '없음 ✅');
  await browser.close();
  process.exit(errors.length?3:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
