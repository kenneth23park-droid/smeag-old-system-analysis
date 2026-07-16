const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p=await b.newPage({viewport:{width:1100,height:600},colorScheme:'dark'});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const F='file:///Users/kwangseobpark/smeag-old-system-analysis/docs/design-admin/prototype.html';
  await p.goto(F+'#dorm.2'); await p.waitForTimeout(300); // pickup (sample: no data)
  const pk=(document.title,await p.evaluate(()=>({h1:(document.querySelector('.ph h1')||{}).textContent})));
  await p.goto(F+'#student.2'); await p.waitForTimeout(200); // spec sample fallback
  const sp=await p.evaluate(()=>({h1:(document.querySelector('.ph h1')||{}).textContent, hasColgrid:!!document.querySelector('.colgrid')}));
  console.log('sample pickup h1:',JSON.stringify(pk),'| sample spec:',JSON.stringify(sp),'| ERRORS:',errs.length?errs.join(' | '):'none');
  await b.close();
})();
