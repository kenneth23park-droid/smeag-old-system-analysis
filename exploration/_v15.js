const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p=await b.newPage({viewport:{width:1300,height:760},colorScheme:'dark'});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const F='file:///Users/kwangseobpark/smeag-old-system-analysis/docs/design-admin/prototype.realdata.html';
  const nav=async(cat,re)=>{await p.evaluate(c=>[...document.querySelectorAll('.cat')].find(b=>new RegExp(c,'i').test(b.textContent)).click(),cat);await p.waitForTimeout(150);await p.evaluate(r=>{const a=[...document.querySelectorAll('.dropdown.open a')].find(x=>new RegExp(r).test(x.textContent));a&&a.click();},re);await p.waitForTimeout(400);};
  const t0=Date.now(); await p.goto(F+'#student.0'); await p.waitForTimeout(2500); const load=Date.now()-t0;
  const std=await p.evaluate(()=>({total:(document.querySelector('.chips b')||{}).textContent,rows:document.querySelectorAll('#stdBody .grid tbody tr').length}));
  await nav('Student','멀티수강관리'); const mc=await p.evaluate(()=>({info:(document.querySelector('.pginfo')||{}).textContent,rows:document.querySelectorAll('#specBody .grid tbody tr').length,cols:document.querySelectorAll('#specBody .grid thead th').length}));
  await nav('Dormitory','ROOM M-LIST'); const rm=await p.evaluate(()=>({info:(document.querySelector('.pginfo')||{}).textContent,rows:document.querySelectorAll('#specBody .grid tbody tr').length}));
  await nav('Dormitory','ELEC'); const el=await p.evaluate(()=>({info:(document.querySelector('.pginfo')||{}).textContent,rows:document.querySelectorAll('#specBody .grid tbody tr').length}));
  console.log('loadMs~',load,'| STUDENT:',JSON.stringify(std));
  console.log('멀티수강:',JSON.stringify(mc),'| ROOM M-LIST:',JSON.stringify(rm),'| ELEC:',JSON.stringify(el));
  console.log('ERRORS:',errs.length?errs.join(' | '):'none');
  await b.close();
})();
