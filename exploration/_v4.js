const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1600,height:1000}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/api\/(auth|data)/.test(m.text()))errs.push('C:'+m.text());});
await p.goto('file:///Users/kwangseobpark/smeag-old-system-analysis/deploy/index.html');await p.waitForTimeout(2000);
console.log('REAL meta',await p.evaluate(()=>window.REAL&&REAL.roomstat&&REAL.roomstat.meta));
await p.evaluate(()=>[...document.querySelectorAll('a,button,[data-u]')].find(x=>/Dormitory Status/i.test(x.textContent)).click());
await p.waitForTimeout(1200);
await p.selectOption('#rsCenter','CAPITAL');await p.selectOption('#rsGender','ALL');await p.waitForTimeout(500);
const g=await p.evaluate(()=>({n:document.querySelector('#rsGroup').options.length,list:[...document.querySelector('#rsGroup').options].map(o=>o.textContent)}));
console.log('방구분 옵션수(placeholder+ALL 제외):',g.n-2);
// CAPITAL1/MALE 선택 후 301-1·302 이름 확인
await p.selectOption('#rsGroup','CAPITAL1 / MALE');await p.waitForTimeout(2500);
console.log(await p.evaluate(()=>{
  const out=[];document.querySelectorAll('tbody.room-block').forEach(tb=>{
    const no=tb.querySelector('td.rno')?.textContent.trim();
    const nms=[...tb.querySelectorAll('td.name')].map(td=>td.textContent.trim());
    out.push(no+' :: '+nms.join(' | '));});
  return out.slice(0,6);}));
// CAPITAL3/FEMALE 519호 검증
await p.selectOption('#rsGender','FEMALE');await p.waitForTimeout(400);
await p.selectOption('#rsGroup','CAPITAL3 / FEMALE');await p.waitForTimeout(2500);
console.log('519:',await p.evaluate(()=>{const tb=[...document.querySelectorAll('tbody.room-block')].find(t=>/519/.test(t.querySelector('td.rno')?.textContent||''));
  return tb?[...tb.querySelectorAll('td.name')].map(td=>td.textContent.trim()):null;}));
await p.screenshot({path:'shots/new_roomstat_real.png'});
console.log('errors',errs.slice(0,5));await b.close();})();
