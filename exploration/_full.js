const { loginAndSaveState, G } = require('./lib_login');
const { chromium } = require('playwright');const fs=require('fs');
const SH=process.env.SP+'/legfull';
const M=[
 ["Member's",'회원관리','member_list.php'],["Member's",'포인트관리','point_list.php'],["Member's",'회원메일발송','mail_list.php'],["Member's",'접속자현황','visit_list.php'],["Member's",'투표관리','poll_list.php'],["Member's",'게시판관리','board_list.php'],["Member's",'게시판그룹관리','boardgroup_list.php'],
 ['Agency','AGENCY LIST','uhak_agency_list.php'],['Agency','AGENCY ADDR','uhak_agency_list2.php'],['Agency','COMMISSION','uhak_agency_commission.php'],['Agency','AGENCY OUT','uhak_agency_exit_list.php'],['Agency','BRANCH RECORD','uhak_agency_stat22.php'],['Agency','GROUP RECORD','uhak_agency_stat33.php'],['Agency','EACH NATIONALITY','uhak_agency_stat34.php'],
 ["Student's",'STUDENT LIST','student.php'],["Student's",'수강등록관리','student_list.php'],["Student's",'멀티수강관리','student_list3.php?multi_course=check'],["Student's",'MC Report 1','student_list3_en1.php?multi_course=check'],["Student's",'MC Report 2','student_list3_en2.php?multi_course=check'],["Student's",'Graduate','student_list3_en3.php?multi_course=check'],["Student's",'APPLY LIST','student_list2.php'],["Student's",'HISTORY','student_history.php'],["Student's",'변경환불홀딩','student_list_change.php'],["Student's",'CHG-REF-HOLD','student_list_change-back.php'],["Student's",'수금관리','student_list_pay.php'],["Student's",'DEPOSIT','student_payment.php'],["Student's",'Deposit(test)','student_payment-2.php'],["Student's",'FARM & GYM','student_farm.php'],["Student's",'GYM 리포트','student_gym.php'],["Student's",'FARM 리포트','student_farm2.php'],["Student's",'POPULATION','student_population.php'],["Student's",'POPULATION2','student_population2.php'],["Student's",'STDNT STATUS','student_present2.php'],["Student's",'STDNT Fullsize','student_present2-rey.php'],["Student's",'STDNT Encanto','student_present2-sparta.php'],["Student's",'STDNT Classic','student_present2-classic.php'],["Student's",'STDNT Capital','student_present2-capital.php'],["Student's",'REGISTER STATS','student_register.php'],
 ['Dormitory','DORM SEARCH','room_search2.php'],['Dormitory','기숙사현황','room_stat3.php'],['Dormitory','DORM STATUS','room_stat2.php'],['Dormitory','기숙사이동관리','room_move_list.php'],['Dormitory','ROOM M-LIST','room_move_list2.php'],['Dormitory','일별 입실&퇴실','room_use_count_list.php'],['Dormitory','DAY IN&OUT','room_use_count_list2.php'],['Dormitory','ELEC&WATER','room_elec.php'],['Dormitory','VISIT(detail)','uhak_agency_visit.php'],['Dormitory','VISIT(calendar)','uhak_agency_schedule_list.php'],['Dormitory','DORM LIST','room_list.php'],['Dormitory','BACK-UP LOG','room_change_log.php'],['Dormitory','Admission Date','smeag_admissiondate.php'],['Dormitory','Update Rooms(new)','room_list-rey.php'],
 ['Financial','한국학생등록현황','student_tution_fee_list2.php'],['Financial','외국학생등록현황','student_tution_fee_list_for2.php'],['Financial','학생등록통합관리','student_tution_fee_list3.php'],['Financial','연장학생통합관리','student_tution_fee_list4.php'],['Financial','변경환불홀딩관리','student_tution_fee_list_change.php'],['Financial','COURSE LIST','course_list.php'],
 ['Cash Cards','Manage Cash','student_cash_payment.php'],['Cash Cards','Group Students','student_group_payment.php'],['Cash Cards','Pre-paid Info','student_payment-2.php'],
];
(async()=>{
  const ok=await loginAndSaveState('state.json');console.log('LOGIN:',ok);if(!ok)return;
  const b=await chromium.launch();
  const ctx=await b.newContext({storageState:'state.json',ignoreHTTPSErrors:true,viewport:{width:1500,height:950}});
  const p=await ctx.newPage();p.on('dialog',d=>d.accept().catch(()=>{}));
  const out=[];
  for(const [grp,label,u] of M){
    const rec={grp,label,u};
    try{
      const r=await p.goto(`${G}/adm/${u}`,{waitUntil:'domcontentloaded',timeout:40000});
      await p.waitForTimeout(1400);
      rec.status=r?r.status():0;rec.title=await p.title();
      rec.rows=await p.evaluate(()=>{const t=[...document.querySelectorAll('table')].sort((a,b)=>b.rows.length-a.rows.length)[0];return t?t.rows.length:0;});
      const f=u.replace(/[^\w]/g,'_')+'.png';await p.screenshot({path:SH+'/'+f});rec.shot=f;
      console.log(`  ${grp[0]} ${label.slice(0,20).padEnd(20)} [${rec.status}] "${(rec.title||'').slice(0,26)}" r=${rec.rows}`);
    }catch(e){rec.err=e.message.slice(0,30);console.log(`  ✗ ${label} ${rec.err}`);}
    out.push(rec);
  }
  fs.writeFileSync(SH+'/full.json',JSON.stringify(out,null,1));
  console.log('완료:',out.length,'· 성공',out.filter(x=>x.shot).length);
  await b.close();
})().catch(e=>console.log('ERR',e.message));
