/* eslint-disable */
// ═══ 회원관리 (member_list.php) — 전용 렌더러 ══════════════════════════════════
//  · 소스: cms.g4_member 2,053행 → /api/data?parts=members (REAL.members)
//  · 이 시스템의 "회원"은 관리자·스태프 계정과 유학원(agency) 계정이 한 테이블에 섞여 있다.
//    구분(kind)은 서버(loadMembers)에서 계산해 내려준다: ADMIN(Lv8+) / AGENCY / STAFF.
//    - AGENCY 판정 = mb_10(유학원코드) 있음 ∨ student_info.uhak_id 존재 ∨ uhak_agency_com.mb_id 존재
//      (실측 AGENCY 1,876 · STAFF 170 · ADMIN 7)
//  · 레벨 의미의 근거: /api/auth 의 app.member_authenticate 가 mb_level>=8 을 관리자로 보고
//    최초 로그인 시 비밀번호 강제변경을 요구하며, /api/data 는 mb_level<8 + uhak_id 존재를
//    유학원 스코프(자기 유학원만)로 취급한다.
//  · 개인정보 보호: 비밀번호(mb_password)·주민(mb_jumin)·비밀번호질문/답은 API 로 나오지 않는다.
//  · 상세는 별도 모달 헬퍼가 없으므로 레거시 상세 컬럼을 표에 포함(행 확장 없음).
// ─────────────────────────────────────────────────────────────────────────────
var memState = { kind:'', level:'', status:'', by:'', q:'', recent:false };

// 레벨 라벨(실측 분포: 1=150 · 2=1 · 3=287 · 5=1,583 · 6=1 · 7=24 · 8=1 · 9=1 · 10=5)
function memLevelLabel(v){
  var n = Number(v||0);
  if(n>=10)return T('최고관리자','SUPER ADMIN');
  if(n>=8) return T('관리자','ADMIN');
  if(n===7)return T('스태프(매니저)','STAFF (manager)');
  if(n===6)return T('스태프','STAFF');
  if(n===5)return T('유학원(정)','AGENCY (main)');
  if(n===4)return T('유학원','AGENCY');
  if(n===3)return T('유학원(부)','AGENCY (sub)');
  return T('일반회원','MEMBER');
}
function memKindPill(k){
  var m={ADMIN:['warn',T('관리자','ADMIN')],STAFF:['install',T('스태프','STAFF')],AGENCY:['good',T('유학원','AGENCY')]}[k]
    ||['neutral',k||'—'];
  return '<span class="pill '+m[0]+'">'+esc(m[1])+'</span>';
}
function memStatusPill(s){
  var m={normal:['good',T('정상','NORMAL')],leave:['neutral',T('탈퇴','LEFT')],block:['return',T('차단','BLOCKED')]}[s]
    ||['neutral',s||'—'];
  return '<span class="pill '+m[0]+'">'+esc(m[1])+'</span>';
}
// mb_8=percent|amount, mb_9=값 → "30 %" / "40,000" (정액은 숫자만, % 유무로 방식 구분)
function memCommText(r){
  if(!r.comm)return '—';
  var v=String(r.commval||'').trim();
  if(!v)return r.comm==='percent'?'%':'—';
  if(r.comm==='percent')return v+' %';
  var n=Number(v);
  return isNaN(n)?v:n.toLocaleString();
}
function memList(){ return (typeof REAL!=='undefined'&&REAL&&REAL.members)?REAL.members:null; }
function memRecentDays(r,days){
  if(!r.login)return false;
  var d=new Date(String(r.login).slice(0,10)+'T00:00:00');
  if(isNaN(d))return false;
  return (Date.now()-d.getTime())<=days*86400000;
}
function memFiltered(){
  var src=memList()||[];
  var q=(memState.q||'').trim().toLowerCase();
  var by=memState.by;
  return src.filter(function(r){
    if(memState.kind && r.kind!==memState.kind)return false;
    if(memState.level!=='' && String(r.level)!==String(memState.level))return false;
    if(memState.status && r.status!==memState.status)return false;
    if(memState.recent && !memRecentDays(r,30))return false;
    if(q){
      var hay = by==='id'?String(r.id||'')
        : by==='name'?(String(r.name||'')+' '+String(r.nick||'')+' '+String(r.agency||''))
        : by==='email'?String(r.email||'')
        : [r.id,r.name,r.nick,r.email,r.agency,r.phone,r.sns,r.memo].join(' ');
      if(hay.toLowerCase().indexOf(q)<0)return false;
    }
    return true;
  });
}

R.members=function(m){
  var src=memList();
  var hdr='<div class="ph"><h1>'+T('회원관리','Members')+'</h1>'
    +'<span class="sub">'+T('관리자·스태프·유학원 계정 통합 (레벨/상태 구분)','Admin · staff · agency accounts (by level/status)')+'</span>'
    +'<span class="url">member_list.php</span>'
    +'<span class="actions" style="margin-left:auto"><button class="btn" data-tblexcel="MEMBERS">📊 EXCEL</button></span></div>';
  if(!src||!src.length){
    return hdr+'<div class="card pad" style="color:var(--dim)">'
      +T('회원 데이터가 없습니다. 로그인 세션이 있어야 <span class="mono">/api/data?parts=members</span> 로 실데이터를 조회합니다.',
         'No member data. A server session is required to read live data from <span class="mono">/api/data?parts=members</span>.')
      +'</div>';
  }
  // 통계칩 — 총원 / 구분별 / 레벨별 / 최근30일 로그인 / 탈퇴·차단
  var n=src.length, byKind={}, byLv={}, login30=0, leave=0, block=0;
  src.forEach(function(r){
    byKind[r.kind]=(byKind[r.kind]||0)+1;
    byLv[r.level]=(byLv[r.level]||0)+1;
    if(memRecentDays(r,30))login30++;
    if(r.status==='leave')leave++;
    if(r.status==='block')block++;
  });
  var lvChips=Object.keys(byLv).sort(function(a,b){return b-a;}).map(function(k){
    return '<span class="chip">Lv'+esc(k)+' <b>'+byLv[k].toLocaleString()+'</b></span>';}).join('');
  var lvOpts=Object.keys(byLv).sort(function(a,b){return b-a;}).map(function(k){
    return '<option value="'+esc(k)+'">Lv'+esc(k)+' · '+esc(memLevelLabel(k))+' ('+byLv[k]+')</option>';}).join('');

  return hdr
  +'<div class="chips" style="margin-bottom:10px">'+(typeof REALBADGE!=='undefined'?REALBADGE:'')
    +'<span class="chip on">'+T('총원','Total')+' <b>'+n.toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('유학원','Agency')+' <b>'+(byKind.AGENCY||0).toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('스태프','Staff')+' <b>'+(byKind.STAFF||0).toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('관리자','Admin')+' <b>'+(byKind.ADMIN||0).toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('최근30일 접속','Login ≤30d')+' <b>'+login30.toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('탈퇴','Left')+' <b>'+leave.toLocaleString()+'</b></span>'
    +'<span class="chip">'+T('차단','Blocked')+' <b>'+block.toLocaleString()+'</b></span>'
    +lvChips+'</div>'
  +'<div class="filters" style="align-items:flex-end">'
    +'<div class="field"><label>'+T('구분','Kind')+'</label><select id="mbKind">'
      +'<option value="">ALL</option><option value="AGENCY">'+T('유학원','AGENCY')+'</option>'
      +'<option value="STAFF">'+T('스태프','STAFF')+'</option><option value="ADMIN">'+T('관리자','ADMIN')+'</option></select></div>'
    +'<div class="field"><label>'+T('레벨','Level')+'</label><select id="mbLevel"><option value="">ALL</option>'+lvOpts+'</select></div>'
    +'<div class="field"><label>'+T('상태','Status')+'</label><select id="mbStatus">'
      +'<option value="">ALL</option><option value="normal">'+T('정상','NORMAL')+'</option>'
      +'<option value="leave">'+T('탈퇴','LEFT')+'</option><option value="block">'+T('차단','BLOCKED')+'</option></select></div>'
    +'<div class="field"><label>'+T('검색기준','Search by')+'</label><select id="mbBy">'
      +'<option value="">'+T('전체','Any')+'</option><option value="id">ID</option>'
      +'<option value="name">'+T('이름','Name')+'</option><option value="email">'+T('이메일','E-mail')+'</option></select></div>'
    +'<div class="field grow"><label>'+T('검색','Search')+'</label>'
      +'<input id="mbQ" placeholder="'+T('ID · 이름 · 이메일','ID · name · e-mail')+'"></div>'
    +'<div class="field"><label>&nbsp;</label><label class="dl-chk"><input type="checkbox" id="mbRecent"> '
      +T('최근30일 접속만','Login ≤30d only')+'</label></div>'
    +'<div class="field"><label>&nbsp;</label><button class="btn" id="mbReset">'+T('초기화','Reset')+'</button></div>'
    +'<div class="field"><label>&nbsp;</label><span class="chip" id="mbCount"></span></div>'
  +'</div>'
  +'<div id="memBody"></div>'
  +'<div class="banner">'+T('레거시 <span class="mono">member_list.php</span>(그누보드4 회원목록) 재현 — 관리자/스태프 계정과 유학원 계정이 같은 테이블(<span class="mono">cms.g4_member</span>)에 있어 <b>구분·레벨</b>로 나눠 표기합니다. 유학원 계정은 <span class="mono">student_info.uhak_id</span>·<span class="mono">uhak_agency_com.mb_id</span> 와 연결됩니다. 비밀번호·주민번호는 API 로 내보내지 않습니다.',
     'Reproduces legacy <span class="mono">member_list.php</span> (gnuboard4 member list). Admin/staff and agency accounts share one table (<span class="mono">cms.g4_member</span>), so they are labelled by <b>kind·level</b>. Agency accounts join <span class="mono">student_info.uhak_id</span> / <span class="mono">uhak_agency_com.mb_id</span>. Passwords and national IDs are never exposed by the API.')
  +'</div>';
};

R.members__init=function(m){
  var root=m||document.getElementById('main');if(!root)return;
  var box=root.querySelector('#memBody');if(!box)return;
  var cols=[T('구분','KIND'),'ID',T('이름','NAME'),T('닉네임','NICK'),'LV',T('레벨','LEVEL'),
    T('이메일','E-MAIL'),T('연락처','PHONE'),'LINE',T('유학원명','AGENCY'),T('커미션','COMM'),
    T('학생수','STUDENTS'),T('커미션건','COMM ROWS'),T('실적','RECOMM'),T('비중','WEIGHT'),
    T('계약일','CONTRACT'),T('가입일','JOINED'),T('최근접속','LAST LOGIN'),T('최근IP','LAST IP'),
    T('상태','STATUS'),T('메모','MEMO')];
  var PILLCOLS=[0,19];   // pill(HTML) 을 담은 열 인덱스 — cols 순서를 바꾸면 반드시 같이 고칠 것
  // paintPaged 는 모든 셀을 esc() 하므로 pill 열만 원래 HTML 로 되돌린다.
  // 페이저(«◀▶» · 이동 · 표시개수)는 paintPaged 를 내부에서 다시 호출해 box 를 통째로 다시 그리므로
  // 그 핸들러를 감싸서 재페인트 직후에도 다시 복원한다(안 하면 2페이지부터 태그가 글자로 보인다).
  function pills(){
    box.querySelectorAll('tbody tr').forEach(function(tr){
      PILLCOLS.forEach(function(ci){
        var td=tr.children[ci];
        if(td&&td.textContent.slice(0,12)==='<span class=')td.innerHTML=td.textContent;
      });
    });
    ['#ppFirst','#ppPrev','#ppNext','#ppLast'].forEach(function(s){
      var b=box.querySelector(s);if(!b||b._mbWrap)return;b._mbWrap=1;
      var f=b.onclick;b.onclick=function(e){if(f)f.call(this,e);pills();};
    });
    ['#ppJump','#ppPer'].forEach(function(s){
      var e2=box.querySelector(s);if(!e2||e2._mbWrap)return;e2._mbWrap=1;
      var f=e2.onchange;e2.onchange=function(ev){if(f)f.call(this,ev);pills();};
    });
  }
  function paint(){
    var rows=memFiltered().map(function(r){return [
      memKindPill(r.kind), r.id||'', r.name||'', r.nick||'', String(r.level==null?'':r.level), memLevelLabel(r.level),
      r.email||'', r.phone||'', r.sns||'', r.agency||'', memCommText(r),
      Number(r.students||0)?Number(r.students).toLocaleString():'', Number(r.comms||0)?Number(r.comms).toLocaleString():'',
      Number(r.recommend||0)||'', Number(r.weight||0)||'',
      r.contract||'', r.joined||'', r.login||'', r.ip||'', memStatusPill(r.status), r.memo||''];});
    paintPaged(box,cols,rows,'members');
    pills();
    var cnt=root.querySelector('#mbCount');
    if(cnt)cnt.innerHTML=T('표시','Shown')+' <b>'+rows.length.toLocaleString()+'</b> / '+((memList()||[]).length).toLocaleString();
  }
  function reset0(){if(typeof pgState!=='undefined'&&pgState.members)pgState.members.page=0;}
  function upd(){
    var v=function(s){var e=root.querySelector(s);return e?e.value:'';};
    memState.kind=v('#mbKind');memState.level=v('#mbLevel');memState.status=v('#mbStatus');
    memState.by=v('#mbBy');memState.q=v('#mbQ');
    var rc=root.querySelector('#mbRecent');memState.recent=!!(rc&&rc.checked);
    reset0();paint();
  }
  ['#mbKind','#mbLevel','#mbStatus','#mbBy','#mbRecent'].forEach(function(s){
    var e=root.querySelector(s);if(e)e.addEventListener('change',upd);});
  var qi=root.querySelector('#mbQ');
  if(qi)qi.addEventListener('input',function(){clearTimeout(window._mbq);window._mbq=setTimeout(upd,220);});
  var rs=root.querySelector('#mbReset');
  if(rs)rs.addEventListener('click',function(){
    memState={kind:'',level:'',status:'',by:'',q:'',recent:false};
    ['#mbKind','#mbLevel','#mbStatus','#mbBy'].forEach(function(s){var e=root.querySelector(s);if(e)e.value='';});
    var c=root.querySelector('#mbRecent');if(c)c.checked=false;
    var i=root.querySelector('#mbQ');if(i)i.value='';
    reset0();paint();});
  // 화면 재진입 시 이전 필터값 복원
  (function(){
    var set=function(s,v){var e=root.querySelector(s);if(e&&v!=='')e.value=v;};
    set('#mbKind',memState.kind);set('#mbLevel',memState.level);set('#mbStatus',memState.status);
    set('#mbBy',memState.by);set('#mbQ',memState.q);
    var c=root.querySelector('#mbRecent');if(c)c.checked=!!memState.recent;
  })();
  paint();
};
