const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1700,height:1000}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/api\/(auth|data)/.test(m.text()))errs.push('C:'+m.text());});
await p.goto('file:///Users/kwangseobpark/smeag-old-system-analysis/deploy/index.html');await p.waitForTimeout(1800);
await p.evaluate(()=>[...document.querySelectorAll('a,button,[data-u]')].find(x=>/Dormitory Status/i.test(x.textContent)).click());
await p.waitForTimeout(900);
await p.selectOption('#rsCenter','CAPITAL');await p.selectOption('#rsGender','MALE');await p.waitForTimeout(400);
await p.selectOption('#rsGroup','CAPITAL1 / MALE');await p.waitForTimeout(1800);
const st=()=>p.evaluate(()=>{const t=document.querySelector('table.gantt'),l=document.querySelector('.dlab');
  return {on:t.classList.contains('rs-dlab'),op:t.style.getPropertyValue('--dlabop'),labs:document.querySelectorAll('.dlab').length,
    vis:l?getComputedStyle(l).display:null,opac:l?getComputedStyle(l).opacity:null,txt:l?l.textContent:null,
    btn:document.querySelector('#rsDlab')?.className,range:document.querySelector('#rsDlabOp')?.value,v:document.querySelector('#rsDlabOpV')?.textContent};});
console.log('초기(기본 OFF)',await st());
// 룰러 버튼 아래에 배치됐는지(좌표)
console.log('배치',await p.evaluate(()=>{const r=document.querySelector('#rsRuler').getBoundingClientRect(),d=document.querySelector('#rsDlab').getBoundingClientRect();
  return {rulerBottom:Math.round(r.bottom),dlabTop:Math.round(d.top),sameCol:Math.abs(r.left-d.left)<3,below:d.top>=r.bottom-1};}));
await p.evaluate(()=>document.querySelector('#rsDlab').click());await p.waitForTimeout(400);
console.log('토글 ON',await st());
await p.evaluate(()=>{const r=document.querySelector('#rsDlabOp');r.value=25;r.dispatchEvent(new Event('input',{bubbles:true}));});
await p.waitForTimeout(300);console.log('투명도 25%',await st());
await p.evaluate(()=>{const r=document.querySelector('#rsDlabOp');r.value=90;r.dispatchEvent(new Event('input',{bubbles:true}));});
await p.waitForTimeout(300);console.log('투명도 90%',await st());
// 재렌더(월 이동) 후에도 상태 유지되는지
await p.selectOption('#rsGender','FEMALE');await p.waitForTimeout(400);await p.selectOption('#rsGroup','CAPITAL2 / FEMALE');await p.waitForTimeout(1500);
console.log('재렌더 후',await st());
await p.evaluate(()=>document.querySelector('#rsDlab').click());await p.waitForTimeout(300);console.log('토글 OFF',await st());
console.log('errors',errs.slice(0,5));await b.close();})();
