/* eslint-disable */
// ═══ TUITION FEE (tution_fee.php) — 일본시장 주차별 요금표 ═══════════════════
//  · 소스: legacy.tution_fee(100행) ⨝ legacy.course_info(코스명)  → REAL.tuition
//  · 실측: week ∈ {1,2,3,4} (각 25행), 코스 25종, 고아행 0건 → 25×4 = 100 완전격자.
//  · 100행뿐이므로 기본 뷰 = 코스×주차 매트릭스(AGENCY/STUDENT/마진), 원본 목록은 토글.
//  · 금액 단위 YEN(¥). 마진 = student_jp - agency_jp (유학원 판매 마진).
// ────────────────────────────────────────────────────────────────────────────
var tfState={view:'matrix',course:'',week:'',q:'',showMargin:true};

// course_info.s_campus 는 단문자 코드(실측 A/C/S). 요금표 25코스는 전부 'C'.
// ※ 미지의 코드는 campusChipName 이 원문을 그대로 HTML 로 내보내므로 여기서 esc() 한다(XSS 차단).
function tfCampus(c){var k=(''+(c||'')).toUpperCase();
  return {C:'CAPITAL',S:'ENCANTO',A:'CLASSIC'}[k]||(k?esc(k):'—');}
const tfYen=(v)=>(v==null||v===''||isNaN(v))?'—':Number(v).toLocaleString();
// 표시용 코스명 — 언어에 따라 영문/한글 우선(없으면 반대쪽, 둘 다 없으면 코드)
function tfCourseName(r){var en=(r.name_en||'').trim(),ko=(r.name||'').trim();
  return (LANG==='en'?(en||ko):(ko||en))||('#'+r.course);}

// REAL.tuition 정규화 → {rows:[{course,name,name_en,state,campus,week,agency,student}], weeks:[…]}
function tfData(){
  var t=(typeof REAL!=='undefined'&&REAL&&REAL.tuition)||null;
  if(!t)return null;
  var rows=(t.rows||t)||[];
  if(!rows.length)return null;
  rows=rows.map(function(r){return {
    idx:+r.idx||0, course:''+(r.course==null?'':r.course),
    name:r.name||'', name_en:r.name_en||'', state:(''+(r.state||'')).toUpperCase(),
    campus:r.campus||'', order:(r.order==null?9e9:+r.order),
    week:+r.week||0, agency:+r.agency||0, student:+r.student||0};});
  var weeks=(t.weeks&&t.weeks.length?t.weeks.map(Number):Array.from(new Set(rows.map(function(r){return r.week;})))).slice().sort(function(a,b){return a-b;});
  return {rows:rows,weeks:weeks,orphans:(t.orphans||[]),truncated:!!t.truncated};
}
// 코스 단위 그룹화(c_order → 코스코드 순, 레거시 course_list 정렬과 동일)
function tfCourses(d){
  var by={};
  d.rows.forEach(function(r){
    var k=r.course;
    if(!by[k])by[k]={course:k,name:r.name,name_en:r.name_en,state:r.state,campus:r.campus,order:r.order,w:{}};
    by[k].w[r.week]=r;});
  return Object.keys(by).map(function(k){return by[k];})
    .sort(function(a,b){return (a.order-b.order)||(+a.course-+b.course);});
}

R.tuition=function(m){
  const d=tfData();
  const hdr=`
  <div class="ph"><h1>${T('등록금 요금표 (TUITION FEE)','TUITION FEE')}</h1>
    <span class="sub">${T('일본시장 전용 · 코스 × 주차 요금(YEN) · 유학원가/학생가','Japan market only · course × week price (YEN) · agency / student')}</span>
    <span class="url">tution_fee.php</span>
    <span class="actions" style="margin-left:auto"><button class="btn" data-tblexcel="tution_fee.php">📊 EXCEL</button></span></div>`;
  if(!d)return hdr+`<div class="card pad" style="color:var(--dim)">
    ${T('요금표 데이터가 아직 없습니다 — 로그인 후 DB(legacy.tution_fee)에서 조회됩니다.','No fee data yet — it is read from the DB (legacy.tution_fee) after login.')}
    </div><div class="banner">${T('소스','Source')}: <b>legacy.tution_fee</b> ⨝ <b>legacy.course_info</b> · 100 ${T('행','rows')}</div>`;

  const cs=tfCourses(d);
  const wmin=d.weeks[0],wmax=d.weeks[d.weeks.length-1];
  const onCnt=cs.filter(function(c){return c.state==='Y';}).length;
  // 고아행(코스마스터 없음)·상한절단 경고 — 실측 0건이지만 조용히 숨기지 않는다.
  const warn=(d.orphans.length?`<div class="banner" style="color:var(--warn)">⚠ ${T('코스 마스터에 없는 요금행','Fee rows without a course master')}: <span class="mono">${esc(d.orphans.join(', '))}</span></div>`:'')
    +(d.truncated?`<div class="banner" style="color:var(--warn)">⚠ ${T('응답 상한에 걸려 일부 행이 잘렸습니다 — data.js 의 MAX_TUITION 을 올리세요.','Response hit the row cap — raise MAX_TUITION in data.js.')}</div>`:'');
  const courseOpts=cs.map(function(c){return `<option value="${esc(c.course)}">${esc(tfCourseName(c))}${c.state==='Y'?'':' ·off'}</option>`;}).join('');
  const weekOpts=d.weeks.map(function(w){return `<option value="${w}">${w} ${T('주','wk')}</option>`;}).join('');
  return hdr+warn+`
  <div class="chips" style="margin-bottom:10px">
    <span class="chip">${T('코스','Courses')} <b>${cs.length}</b>${onCnt<cs.length?` <span style="color:var(--dim)">(${T('운영중','active')} ${onCnt})</span>`:''}</span>
    <span class="chip">${T('주차','Weeks')} <b>${wmin}~${wmax}</b> (${d.weeks.length})</span>
    <span class="chip">${T('요금행','Fee rows')} <b>${d.rows.length.toLocaleString()}</b></span>
    <span class="chip">${T('통화','Currency')} <b>YEN (¥)</b></span>
  </div>
  <div class="filters" style="align-items:flex-end">
    <div class="field"><label>${T('보기','View')}</label><select id="tfView">
      <option value="matrix"${tfState.view==='matrix'?' selected':''}>${T('매트릭스 (코스×주차)','Matrix (course × week)')}</option>
      <option value="list"${tfState.view==='list'?' selected':''}>${T('원본 목록','Raw list')}</option></select></div>
    <div class="field"><label>COURSE</label><select id="tfCourse"><option value="">${T('전체 코스','All courses')}</option>${courseOpts}</select></div>
    <div class="field" style="max-width:130px"><label>WEEK</label><select id="tfWeek"><option value="">${T('전체','ALL')}</option>${weekOpts}</select></div>
    <div class="field grow"><label>${T('코스명 검색','Search course')}</label><input id="tfQ" placeholder="${T('예 IELTS / TOEIC','e.g. IELTS / TOEIC')}"></div>
    <div class="field"><label>&nbsp;</label><label class="dl-chk" title="${T('마진(학생가-유학원가) 표시','Show margin (student - agency)')}"><input type="checkbox" id="tfMargin"${tfState.showMargin?' checked':''}> ${T('마진 표시','Show margin')}</label></div>
  </div>
  <div id="tfBody"></div>
  <div class="banner">${T('셀 = <b>AGENCY(유학원가)</b> / <b>STUDENT(학생가)</b> · 단위 YEN. 마진 = 학생가 − 유학원가. 원본은 <span class="mono">course·week</span> 당 1행(25코스 × 4주차 = 100행) 완전격자입니다.','Cell = <b>AGENCY</b> / <b>STUDENT</b> price in YEN. Margin = student − agency. Source has exactly one row per <span class="mono">course·week</span> (25 courses × 4 weeks = 100 rows).')}</div>`;
};

R.tuition__init=function(m){
  const root=document.getElementById('main');if(!root)return;
  const box=root.querySelector('#tfBody');if(!box)return;
  const d=tfData();if(!d)return;

  function filtered(){
    const q=tfState.q.trim().toLowerCase();
    return d.rows.filter(function(r){
      if(tfState.course&&r.course!==tfState.course)return false;
      if(tfState.week&&r.week!==+tfState.week)return false;
      if(q){const s=(r.name+' '+r.name_en+' '+r.course).toLowerCase();if(s.indexOf(q)<0)return false;}
      return true;});
  }
  // ── 매트릭스: 행=코스, 열=주차(AGENCY/STUDENT[/마진]) ──
  function paintMatrix(){
    const rows=filtered();
    const weeks=d.weeks.filter(function(w){return !tfState.week||w===+tfState.week;});
    const cs=tfCourses({rows:rows,weeks:weeks});
    if(!cs.length){box.innerHTML=`<div class="card pad" style="color:var(--dim)">${T('조건에 맞는 요금이 없습니다.','No fees match the filter.')}</div>`;return;}
    const mg=tfState.showMargin;
    const head=`<tr><th>#</th><th>COURSE</th><th>${T('캠퍼스','CAMPUS')}</th><th>${T('상태','STATE')}</th>`
      +weeks.map(function(w){return `<th colspan="${mg?3:2}" style="text-align:center">${w} ${T('주','WEEK')}</th>`;}).join('')+'</tr>'
      +`<tr><th></th><th></th><th></th><th></th>`
      +weeks.map(function(){return `<th style="font-size:11px;color:var(--dim)">AGENCY</th><th style="font-size:11px;color:var(--dim)">STUDENT</th>`+(mg?`<th style="font-size:11px;color:var(--dim)">${T('마진','MARGIN')}</th>`:'');}).join('')+'</tr>';
    const body=cs.map(function(c,i){
      const cells=weeks.map(function(w){
        const r=c.w[w];
        if(!r)return `<td class="mono" style="color:var(--faint)">—</td><td class="mono" style="color:var(--faint)">—</td>`+(mg?'<td class="mono" style="color:var(--faint)">—</td>':'');
        const gap=r.student-r.agency;
        return `<td class="mono">${tfYen(r.agency)}</td><td class="mono"><b>${tfYen(r.student)}</b></td>`
          +(mg?`<td class="mono" style="color:${gap>0?'var(--good)':'var(--dim)'}">${gap>0?'+':''}${tfYen(gap)}</td>`:'');}).join('');
      return `<tr><td class="mono">${i+1}</td>
        <td>${esc(tfCourseName(c))}${(c.name&&c.name_en&&c.name!==c.name_en)?` <span style="color:var(--dim);font-size:11px">${esc(LANG==='en'?c.name:c.name_en)}</span>`:''}
          <span class="mono" style="color:var(--faint);font-size:11px">#${esc(c.course)}</span></td>
        <td>${campusChipName(tfCampus(c.campus))}</td>
        <td class="mono" style="color:${c.state==='Y'?'var(--good)':'var(--dim)'}">${c.state==='Y'?'Y':'N'}</td>${cells}</tr>`;}).join('');
    box.innerHTML=`<div class="twrap"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    // 헤더 2줄(colspan) 매트릭스는 컬럼정렬을 걸지 않는다(정렬은 원본 목록 뷰에서).
  }
  // ── 원본 목록: 레거시 컬럼(#/COURSE/WEEK/AGENCY(JP)/STUDENT(JP)) + 마진 ──
  function paintList(){
    const rows=filtered().slice().sort(function(a,b){return (a.order-b.order)||(+a.course-+b.course)||(a.week-b.week);});
    if(!rows.length){box.innerHTML=`<div class="card pad" style="color:var(--dim)">${T('조건에 맞는 요금이 없습니다.','No fees match the filter.')}</div>`;return;}
    const mg=tfState.showMargin;
    const body=rows.map(function(r,i){
      const gap=r.student-r.agency;
      return `<tr><td class="mono">${i+1}</td>
        <td>${esc(tfCourseName(r))} <span class="mono" style="color:var(--faint);font-size:11px">#${esc(r.course)}</span></td>
        <td class="mono">${r.week}</td><td class="mono">${tfYen(r.agency)}</td><td class="mono"><b>${tfYen(r.student)}</b></td>`
        +(mg?`<td class="mono" style="color:${gap>0?'var(--good)':'var(--dim)'}">${gap>0?'+':''}${tfYen(gap)}</td>`:'')+'</tr>';}).join('');
    box.innerHTML=`<div class="twrap"><table class="grid"><thead><tr><th>#</th><th>COURSE</th><th>WEEK</th><th>AGENCY(JP)</th><th>STUDENT(JP)</th>${mg?`<th>${T('마진','MARGIN')}</th>`:''}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="chips" style="margin-top:10px"><span class="chip">${T('표시','Shown')} <b>${rows.length.toLocaleString()}</b> / ${d.rows.length.toLocaleString()}</span></div>`;
    makeSortable(box);
  }
  function paint(){ (tfState.view==='list'?paintList:paintMatrix)(); }

  const vw=root.querySelector('#tfView');if(vw)vw.onchange=function(e){tfState.view=e.target.value;paint();};
  const cf=root.querySelector('#tfCourse');if(cf){cf.value=tfState.course;cf.onchange=function(e){tfState.course=e.target.value;paint();};}
  const wf=root.querySelector('#tfWeek');if(wf){wf.value=tfState.week;wf.onchange=function(e){tfState.week=e.target.value;paint();};}
  // 검색어는 HTML 속성으로 넣지 않고 여기서 되살린다(esc() 는 따옴표를 escape 하지 않으므로 속성주입 방지).
  const qf=root.querySelector('#tfQ');if(qf){qf.value=tfState.q;qf.oninput=function(e){tfState.q=e.target.value;paint();};}
  const mf=root.querySelector('#tfMargin');if(mf)mf.onchange=function(e){tfState.showMargin=!!e.target.checked;paint();};
  paint();
};
