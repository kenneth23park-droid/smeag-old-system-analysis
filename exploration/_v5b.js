const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1700,height:1000}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///Users/kwangseobpark/smeag-old-system-analysis/deploy/index.html');await p.waitForTimeout(2000);
await p.evaluate(()=>[...document.querySelectorAll('a,button,[data-u]')].find(x=>/Dormitory Status/i.test(x.textContent)).click());
await p.waitForTimeout(1000);
await p.selectOption('#rsCenter','CAPITAL');await p.selectOption('#rsGender','ALL');await p.waitForTimeout(400);
const t0=Date.now();await p.selectOption('#rsGroup','ALL');
await p.waitForFunction(()=>document.querySelectorAll('tbody.room-block').length>300,{timeout:60000});
console.log('전체 렌더 ms',Date.now()-t0, await p.evaluate(()=>({rooms:document.querySelectorAll('tbody.room-block').length,beds:document.querySelectorAll('td.name').length,named:[...document.querySelectorAll('td.name')].filter(t=>t.textContent.trim()).length})));
for(const [gender,grp] of [['MALE','CAPITAL1 / MALE'],['FEMALE','CAPITAL2 / FEMALE'],['FAMILY','Citadines hotel / FAMILY']]){
  await p.selectOption('#rsGender',gender);await p.waitForTimeout(300);
  const n=await p.evaluate(()=>document.querySelector('#rsGroup').options.length-2);
  await p.selectOption('#rsGroup',grp);await p.waitForTimeout(1200);
  console.log(gender,'방구분수',n,'→',grp,'방수',await p.evaluate(()=>document.querySelectorAll('tbody.room-block').length));
}
await p.selectOption('#rsGender','ALL');await p.selectOption('#rsGroup','ALL');await p.waitForTimeout(2500);
await p.screenshot({path:'shots/new_roomstat_real.png'});
console.log('errors',errs);await b.close();})();
