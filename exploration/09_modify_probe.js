// student_modify*.php 팝업 3종의 정체 파악 (인보이스 발행 화면 찾기)
const { chromium } = require('playwright');
const fs = require('fs');
const { G } = require('./lib_login');

(async () => {
  const no = process.argv[2] || '101957';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: 'state.json', viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const targets = ['student_modify.php', 'student_modify2.php', 'student_modify3.php', 'student_modify_group.php'];
  const rep = [];
  for (const t of targets) {
    const url = `${G}/adm/${t}?mode=modify&modify_no=${no}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const html = await page.content();
    fs.writeFileSync(`inv_${t}.html`, html);
    const d = await page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')].map(f => ({
        name: f.name, action: f.getAttribute('action'), method: f.method,
        fields: [...f.elements].map(e => e.name).filter(Boolean).slice(0, 120),
      }));
      const btns = [...document.querySelectorAll('input[type=submit],input[type=button],input[type=image],button,a')]
        .map(e => (e.value || e.innerText || e.alt || '').trim()).filter(Boolean).slice(0, 40);
      return { title: document.title, h: document.body.innerText.slice(0, 300), forms, btns };
    }).catch(e => ({ err: String(e) }));
    rep.push({ file: t, url, ...d });
    await page.screenshot({ path: `shots/inv_${t}.png`, fullPage: true }).catch(() => {});
    console.log('==', t, '|', d.title, '| invoice-mention:', /invoice/i.test(html));
  }
  fs.writeFileSync('invoice_modify_probe.json', JSON.stringify(rep, null, 2));
  await browser.close();
})();
