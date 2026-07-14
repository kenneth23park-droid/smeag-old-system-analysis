// 02: 관리자 메뉴 구조 발견 — 대분류/사이드바에서 adm/*.php, board 링크 수집
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://www.smeadmin.com';
const G = `${BASE}/gnuboard4`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: 'state.json' });
  const page = await ctx.newPage();

  // 관리자 진입점 후보
  const entries = ['/gnuboard4/adm/', '/gnuboard4/adm/index.php', '/gnuboard4/adm/student.php'];
  const allLinks = new Map();
  const frameSrcs = new Set();

  for (const e of entries) {
    await page.goto(BASE + e, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(600);
    // 메인 문서 + 모든 프레임에서 링크 수집
    for (const fr of page.frames()) {
      try {
        const links = await fr.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({
          text: (a.textContent||'').trim().replace(/\s+/g,' ').slice(0,50),
          href: a.getAttribute('href')
        })));
        for (const l of links) {
          if (!l.href) continue;
          if (/^(javascript|#|mailto)/.test(l.href)) continue;
          // adm 페이지 또는 board만
          if (/adm\/[\w-]+\.php|board\.php\?bo_table=/.test(l.href)) {
            const key = l.href.split('#')[0];
            if (!allLinks.has(key) || (l.text && !allLinks.get(key))) allLinks.set(key, l.text);
          }
        }
        const fsrc = await fr.evaluate(() => [...document.querySelectorAll('frame,iframe')].map(f=>f.getAttribute('src')));
        fsrc.forEach(s => s && frameSrcs.add(s));
      } catch(_) {}
    }
  }

  const discovered = [...allLinks.entries()].map(([href, text]) => ({ href, text }));
  fs.writeFileSync('discovered_links.json', JSON.stringify({ count: discovered.length, frameSrcs:[...frameSrcs], discovered }, null, 2));
  console.log('discovered adm/board links:', discovered.length);
  console.log('frame srcs:', [...frameSrcs].join(', ') || '(none)');
  discovered.slice(0, 40).forEach(d => console.log(' -', d.href, '|', d.text));
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
