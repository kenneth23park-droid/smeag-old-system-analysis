-- ════════════════════════════════════════════════════════════════
-- 결정 F: DB 쓰기 안전 계층 (insert / update / delete / move[=rewrite])
--   요구사항:
--     · rewrite/update/delete/insert 시 "DB 체크 신뢰도(confidence)" 프리플라이트 반영
--     · 저장·삭제 확인 메세지박스용 구조화 응답(need_confirm/checks) 반환
--     · 에러 시 에러로그를 저장(app.db_error_log)하고 error_id 를 응답에 노출
--     · fallback: 예외를 throw 하지 않고 로그+구조화 응답으로 강등(쓰기 의도 유실 금지)
--     · 중복실행 방지: 멱등키(app.write_audit.idempotency_key UNIQUE) + 더블서밋 가드
--       + DB 유니크 제약(public.dorm_reservations.uq_res_no_dup) 3중 방어
--   전제: reservations.sql 실행되어 public.dorm_reservations / dorm_rooms /
--         dorm_students 존재. 원본 MySQL 불변. 전부 Supabase 내부 작업.
--   재실행 안전(idempotent): create ... if not exists / or replace.
-- ════════════════════════════════════════════════════════════════
begin;

create schema if not exists app;

-- 사전조건 가드: 정본 모델 없으면 명확히 실패
do $$
begin
  if to_regclass('public.dorm_reservations') is null then
    raise exception 'write_layer.sql 전제 미충족: public.dorm_reservations 없음. reservations.sql 먼저 실행';
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────
-- 0) 정원(capacity) 보강 — 정원/충돌 프리플라이트에 필요
--    legacy.room_list.r_limit 있으면 채우고, 없으면 기본 4로 폴백.
-- ────────────────────────────────────────────────────────────────
alter table public.dorm_rooms add column if not exists capacity smallint;

do $$
begin
  if to_regclass('legacy.room_list') is not null then
    -- r_idx 당 대표 정원(최댓값)으로 매핑
    update public.dorm_rooms rm
       set capacity = sub.cap
      from (
        select r_idx, max(nullif(r_limit::text,'')::int) as cap
        from legacy.room_list
        group by r_idx
      ) sub
     where sub.r_idx = rm.r_idx
       and sub.cap is not null;
  end if;
end $$;

update public.dorm_rooms set capacity = 4 where capacity is null or capacity <= 0;

-- ────────────────────────────────────────────────────────────────
-- 1) 에러로그 — "에러 시 에러로그를 보여주고 저장한다"
--    RPC 예외 핸들러가 여기에 적재. UI 는 error_id 로 조회.
-- ────────────────────────────────────────────────────────────────
create table if not exists app.db_error_log (
  error_id        bigserial primary key,
  occurred_at     timestamptz not null default now(),
  op              text not null,                 -- insert|update|delete|move
  idempotency_key text,
  target          jsonb,                         -- {room_id, student_id, check_in, ...}
  payload         jsonb,                         -- 원본 인자 전체(재시도/감사용)
  sqlstate        text,
  err_message     text,
  err_detail      text,
  err_hint        text,
  err_context     text,
  actor           text default current_setting('request.jwt.claim.role', true),
  resolved        boolean not null default false
);
create index if not exists idx_errlog_key  on app.db_error_log(idempotency_key);
create index if not exists idx_errlog_time on app.db_error_log(occurred_at desc);

-- ────────────────────────────────────────────────────────────────
-- 2) 쓰기 감사/멱등 원장 — 더블서밋 가드의 저장소
--    idempotency_key UNIQUE: 같은 키 재요청은 최초 결과를 그대로 재생(replay).
-- ────────────────────────────────────────────────────────────────
create table if not exists app.write_audit (
  audit_id        bigserial primary key,
  idempotency_key text unique not null,
  op              text not null,
  reservation_id  bigint,                        -- 영향받은 dorm_reservations.id
  confidence      smallint,
  level           text,                          -- ok|warn|block
  result          jsonb not null,                -- 최초 성공 응답 스냅샷(재생용)
  actor           text default current_setting('request.jwt.claim.role', true),
  created_at      timestamptz not null default now()
);
create index if not exists idx_audit_res on app.write_audit(reservation_id);

-- ────────────────────────────────────────────────────────────────
-- 3) 허용 예약 유형(enum 대용 참조표) — 참조 무결성 체크용
-- ────────────────────────────────────────────────────────────────
create table if not exists app.ri_type_dict (code char(1) primary key, label text);
insert into app.ri_type_dict(code,label) values
  ('L','장기(Long)'),('M','이동/변경(Move)'),('R','예약(Reserve)'),
  ('I','입실(In)'),('O','퇴실(Out)')
on conflict (code) do nothing;

-- ════════════════════════════════════════════════════════════════
-- 4) 프리플라이트 — "DB 체크 신뢰도" 계산 (4종 검증)
--   반환 jsonb:
--     { confidence:int(0-100), level:'ok|warn|block', blocked:bool,
--       checks:[{key,label,severity:'pass|warn|block',detail}] }
--   가중치(합 100): 중복/멱등 30 · 정원/충돌 30 · 참조무결성 25 · 날짜규칙 15
--   confidence = 100 - Σ(block=가중치, warn=가중치/2)
-- ════════════════════════════════════════════════════════════════
create or replace function app.reservation_preflight(
  p_op         text,                 -- insert|update|delete|move
  p_room_id    bigint,
  p_student_id bigint,
  p_check_in   date,
  p_check_out  date,
  p_ri_type    char(1) default 'L',
  p_exclude_id bigint  default null   -- update/move 시 자기 자신 제외
) returns jsonb
language plpgsql stable as $$
declare
  checks   jsonb := '[]'::jsonb;
  conf     int := 100;
  blocked  boolean := false;
  v_cap    int;
  v_dup    int;
  v_overlap int;
  v_self_overlap int;
  v_room_ok boolean;
  v_stu_ok  boolean;
  v_type_ok boolean;
  sev text; det text;
begin
  -- delete 는 존재/무결성 위주(정원/중복 무관)
  ------------------------------------------------------------------
  -- (a) 중복/멱등 검사 [30]
  ------------------------------------------------------------------
  if p_op in ('insert','update','move') then
    select count(*) into v_dup
    from public.dorm_reservations r
    where r.room_id = p_room_id and r.student_id = p_student_id
      and r.check_in = p_check_in and r.check_out = p_check_out
      and (p_exclude_id is null or r.id <> p_exclude_id);
    if v_dup > 0 then
      sev:='block'; det:=format('동일 (방,학생,기간) 예약 %s건 존재 — 이중 저장', v_dup);
      conf := conf - 30; blocked := true;
    else
      sev:='pass'; det:='중복 예약 없음';
    end if;
  else
    sev:='pass'; det:='삭제 — 중복검사 해당없음';
  end if;
  checks := checks || jsonb_build_object('key','dup','label','중복/멱등','severity',sev,'detail',det);

  ------------------------------------------------------------------
  -- (b) 정원/충돌 검사 [30] — 방 정원 초과 + 동일학생 기간겹침
  ------------------------------------------------------------------
  if p_op in ('insert','update','move') then
    select capacity into v_cap from public.dorm_rooms where room_id = p_room_id;
    -- 기간이 겹치는 서로 다른 예약 수(자기 자신/대상 제외) : 동시 재실 인원
    select count(*) into v_overlap
    from public.dorm_reservations r
    where r.room_id = p_room_id
      and (p_exclude_id is null or r.id <> p_exclude_id)
      and r.check_in <= p_check_out and r.check_out >= p_check_in;
    -- 같은 학생이 같은 기간 다른 예약(재실 충돌)
    select count(*) into v_self_overlap
    from public.dorm_reservations r
    where r.student_id = p_student_id
      and (p_exclude_id is null or r.id <> p_exclude_id)
      and r.check_in <= p_check_out and r.check_out >= p_check_in;

    if v_overlap + 1 > coalesce(v_cap,4) then
      sev:='block'; det:=format('정원 초과: 겹침 %s + 신규 1 > 정원 %s', v_overlap, coalesce(v_cap,4));
      conf := conf - 30; blocked := true;
    elsif v_self_overlap > 0 then
      sev:='warn'; det:=format('동일 학생 기간겹침 %s건(재실 충돌 가능)', v_self_overlap);
      conf := conf - 15;
    else
      sev:='pass'; det:=format('정원 %s / 겹침 %s — 여유', coalesce(v_cap,4), v_overlap);
    end if;
  else
    sev:='pass'; det:='삭제 — 정원검사 해당없음';
  end if;
  checks := checks || jsonb_build_object('key','capacity','label','정원/충돌','severity',sev,'detail',det);

  ------------------------------------------------------------------
  -- (c) 참조 무결성 [25] — 방/학생 존재 + ri_type 유효
  ------------------------------------------------------------------
  select exists(select 1 from public.dorm_rooms    where room_id=p_room_id)    into v_room_ok;
  select exists(select 1 from public.dorm_students where student_id=p_student_id) into v_stu_ok;
  select exists(select 1 from app.ri_type_dict where code=p_ri_type) into v_type_ok;

  if p_op = 'delete' then
    -- 삭제는 대상행(p_exclude_id) 존재만 확인
    if p_exclude_id is null or not exists(select 1 from public.dorm_reservations where id=p_exclude_id) then
      sev:='block'; det:='삭제 대상 예약이 존재하지 않음'; conf:=conf-25; blocked:=true;
    else
      sev:='pass'; det:='삭제 대상 존재 확인';
    end if;
  elsif not v_room_ok or not v_stu_ok then
    sev:='block';
    det:=format('참조 없음: %s%s',
                case when not v_room_ok then format('room_id=%s ',p_room_id) else '' end,
                case when not v_stu_ok  then format('student_id=%s',p_student_id) else '' end);
    conf:=conf-25; blocked:=true;
  elsif not v_type_ok then
    sev:='warn'; det:=format('알 수 없는 ri_type=%s (허용: L/M/R/I/O)', p_ri_type); conf:=conf-12;
  else
    sev:='pass'; det:='방·학생·유형 참조 유효';
  end if;
  checks := checks || jsonb_build_object('key','fk','label','참조 무결성','severity',sev,'detail',det);

  ------------------------------------------------------------------
  -- (d) 날짜 규칙 [15] — 역전/과도한 기간/과거일
  ------------------------------------------------------------------
  if p_op = 'delete' then
    sev:='pass'; det:='삭제 — 날짜검사 해당없음';
  elsif p_check_in is null or p_check_out is null then
    sev:='block'; det:='체크인/체크아웃 날짜 누락'; conf:=conf-15; blocked:=true;
  elsif p_check_out < p_check_in then
    sev:='block'; det:=format('날짜 역전: 체크아웃(%s) < 체크인(%s)', p_check_out, p_check_in);
    conf:=conf-15; blocked:=true;
  elsif (p_check_out - p_check_in) > 400 then
    sev:='warn'; det:=format('기간 %s일 — 과도(400일 초과) 검토', (p_check_out - p_check_in)); conf:=conf-7;
  elsif p_check_in < (now()::date - 3650) then
    sev:='warn'; det:='체크인이 과거 10년 이전 — 데이터 확인'; conf:=conf-7;
  else
    sev:='pass'; det:=format('기간 %s일 정상', (p_check_out - p_check_in)+1);
  end if;
  checks := checks || jsonb_build_object('key','date','label','날짜 규칙','severity',sev,'detail',det);

  if conf < 0 then conf := 0; end if;

  return jsonb_build_object(
    'confidence', conf,
    'blocked', blocked,
    'level', case when blocked then 'block' when conf < 90 then 'warn' else 'ok' end,
    'checks', checks
  );
end $$;

-- ════════════════════════════════════════════════════════════════
-- 5) 공통 헬퍼: 멱등 재생 + 에러로그 폴백
-- ════════════════════════════════════════════════════════════════
create or replace function app._replay(p_key text) returns jsonb
language sql stable as $$
  select result || jsonb_build_object('replayed', true)
  from app.write_audit where idempotency_key = p_key;
$$;

-- 진단값은 호출 RPC의 예외블록에서 GET STACKED DIAGNOSTICS 로 캡처해 인자로 전달
-- (스택 진단은 함수 경계를 넘지 못하므로 파라미터로 받는다)
create or replace function app._log_error(
  p_op text, p_key text, p_target jsonb, p_payload jsonb,
  p_sqlstate text, p_msg text, p_detail text, p_hint text, p_context text
) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  insert into app.db_error_log(op, idempotency_key, target, payload,
     sqlstate, err_message, err_detail, err_hint, err_context)
  values (p_op, p_key, p_target, p_payload,
     p_sqlstate, p_msg, p_detail, p_hint, p_context)
  returning error_id into v_id;
  return v_id;
exception when others then
  -- 로깅 자체 실패 시에도 죽지 않음(최후 폴백)
  return -1;
end $$;

-- ════════════════════════════════════════════════════════════════
-- 6) 쓰기 RPC — insert / update / delete / move
--   공통 계약(응답 jsonb):
--     성공: {ok:true, op, id, confidence, level, checks, audit_id, replayed?}
--     확인필요(블록·미강제): {ok:false, need_confirm:true, confidence, level, checks}
--     에러(폴백): {ok:false, error:true, error_id, sqlstate, message}
--   p_confirm=true 면 block 이라도 강제 저장(UI 메세지박스에서 사용자가 '저장' 선택).
-- ════════════════════════════════════════════════════════════════

-- 6-1) INSERT (입실/신규 예약)
create or replace function app.reserve_insert(
  p_key text, p_room_id bigint, p_student_id bigint,
  p_check_in date, p_check_out date, p_ri_type char(1) default 'L',
  p_confirm boolean default false
) returns jsonb
language plpgsql security definer as $$
declare pf jsonb; v_id bigint; res jsonb; eid bigint; v_audit bigint;
  v_state text; v_msg text; v_detail text; v_hint text; v_ctx text;
  tgt jsonb := jsonb_build_object('room_id',p_room_id,'student_id',p_student_id,
               'check_in',p_check_in,'check_out',p_check_out,'ri_type',p_ri_type);
begin
  -- 더블서밋 가드: 같은 키면 최초 결과 재생
  if exists(select 1 from app.write_audit where idempotency_key=p_key) then
    return app._replay(p_key);
  end if;

  pf := app.reservation_preflight('insert', p_room_id, p_student_id, p_check_in, p_check_out, p_ri_type, null);
  if (pf->>'blocked')::boolean and not p_confirm then
    return jsonb_build_object('ok',false,'need_confirm',true,'op','insert',
      'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  end if;

  insert into public.dorm_reservations(room_id, student_id, ri_type, check_in, check_out)
  values (p_room_id, p_student_id, p_ri_type, p_check_in, p_check_out)
  on conflict on constraint uq_res_no_dup do nothing
  returning id into v_id;

  if v_id is null then   -- 유니크 제약이 최종 이중저장 차단(멱등)
    select id into v_id from public.dorm_reservations
     where room_id=p_room_id and student_id=p_student_id
       and check_in=p_check_in and check_out=p_check_out;
  end if;

  res := jsonb_build_object('ok',true,'op','insert','id',v_id,
    'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  insert into app.write_audit(idempotency_key,op,reservation_id,confidence,level,result)
  values (p_key,'insert',v_id,(pf->>'confidence')::int,pf->>'level',res)
  returning audit_id into v_audit;
  return res || jsonb_build_object('audit_id',v_audit);

exception when others then
  get stacked diagnostics v_state=returned_sqlstate, v_msg=message_text,
    v_detail=pg_exception_detail, v_hint=pg_exception_hint, v_ctx=pg_exception_context;
  eid := app._log_error('insert', p_key, tgt, jsonb_build_object('confirm',p_confirm),
         v_state, v_msg, v_detail, v_hint, v_ctx);
  return jsonb_build_object('ok',false,'error',true,'op','insert',
    'error_id',eid,'sqlstate',v_state,'message',v_msg);
end $$;

-- 6-2) UPDATE (기간/유형 변경 — 방/학생 동일)
create or replace function app.reserve_update(
  p_key text, p_id bigint, p_check_in date, p_check_out date,
  p_ri_type char(1) default null, p_confirm boolean default false
) returns jsonb
language plpgsql security definer as $$
declare pf jsonb; cur record; res jsonb; eid bigint; v_audit bigint;
  v_state text; v_msg text; v_detail text; v_hint text; v_ctx text;
  tgt jsonb := jsonb_build_object('id',p_id,'check_in',p_check_in,'check_out',p_check_out);
begin
  if exists(select 1 from app.write_audit where idempotency_key=p_key) then
    return app._replay(p_key);
  end if;
  select * into cur from public.dorm_reservations where id=p_id;
  if not found then
    eid := app._log_error('update',p_key,tgt,'{}'::jsonb,'P0002',
             format('대상 예약 없음 id=%s',p_id),null,null,null);
    return jsonb_build_object('ok',false,'error',true,'op','update','error_id',eid,
      'sqlstate','P0002','message',format('대상 예약 없음 id=%s',p_id));
  end if;

  pf := app.reservation_preflight('update', cur.room_id, cur.student_id,
        p_check_in, p_check_out, coalesce(p_ri_type,cur.ri_type), p_id);
  if (pf->>'blocked')::boolean and not p_confirm then
    return jsonb_build_object('ok',false,'need_confirm',true,'op','update',
      'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  end if;

  update public.dorm_reservations
     set check_in=p_check_in, check_out=p_check_out,
         ri_type=coalesce(p_ri_type,ri_type)
   where id=p_id;

  res := jsonb_build_object('ok',true,'op','update','id',p_id,
    'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  insert into app.write_audit(idempotency_key,op,reservation_id,confidence,level,result)
  values (p_key,'update',p_id,(pf->>'confidence')::int,pf->>'level',res)
  returning audit_id into v_audit;
  return res || jsonb_build_object('audit_id',v_audit);

exception when others then
  get stacked diagnostics v_state=returned_sqlstate, v_msg=message_text,
    v_detail=pg_exception_detail, v_hint=pg_exception_hint, v_ctx=pg_exception_context;
  eid := app._log_error('update', p_key, tgt, jsonb_build_object('confirm',p_confirm),
         v_state, v_msg, v_detail, v_hint, v_ctx);
  return jsonb_build_object('ok',false,'error',true,'op','update',
    'error_id',eid,'sqlstate',v_state,'message',v_msg);
end $$;

-- 6-3) DELETE (퇴실 취소/예약 삭제)
create or replace function app.reserve_delete(
  p_key text, p_id bigint, p_confirm boolean default false
) returns jsonb
language plpgsql security definer as $$
declare pf jsonb; cur record; res jsonb; eid bigint; v_audit bigint;
  v_state text; v_msg text; v_detail text; v_hint text; v_ctx text;
  tgt jsonb := jsonb_build_object('id',p_id);
begin
  if exists(select 1 from app.write_audit where idempotency_key=p_key) then
    return app._replay(p_key);
  end if;
  select * into cur from public.dorm_reservations where id=p_id;
  if not found then   -- 이미 삭제됨 → 멱등 성공으로 간주
    res := jsonb_build_object('ok',true,'op','delete','id',p_id,'already_absent',true,
      'confidence',100,'level','ok','checks','[]'::jsonb);
    insert into app.write_audit(idempotency_key,op,reservation_id,confidence,level,result)
    values (p_key,'delete',p_id,100,'ok',res);
    return res;
  end if;

  pf := app.reservation_preflight('delete', cur.room_id, cur.student_id,
        cur.check_in, cur.check_out, cur.ri_type, p_id);
  if (pf->>'blocked')::boolean and not p_confirm then
    return jsonb_build_object('ok',false,'need_confirm',true,'op','delete',
      'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  end if;

  delete from public.dorm_reservations where id=p_id;
  res := jsonb_build_object('ok',true,'op','delete','id',p_id,
    'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  insert into app.write_audit(idempotency_key,op,reservation_id,confidence,level,result)
  values (p_key,'delete',p_id,(pf->>'confidence')::int,pf->>'level',res)
  returning audit_id into v_audit;
  return res || jsonb_build_object('audit_id',v_audit);

exception when others then
  get stacked diagnostics v_state=returned_sqlstate, v_msg=message_text,
    v_detail=pg_exception_detail, v_hint=pg_exception_hint, v_ctx=pg_exception_context;
  eid := app._log_error('delete', p_key, tgt, jsonb_build_object('confirm',p_confirm),
         v_state, v_msg, v_detail, v_hint, v_ctx);
  return jsonb_build_object('ok',false,'error',true,'op','delete',
    'error_id',eid,'sqlstate',v_state,'message',v_msg);
end $$;

-- 6-4) MOVE (방변경 = rewrite) — 방/기간을 원자적으로 교체
create or replace function app.reserve_move(
  p_key text, p_id bigint, p_new_room_id bigint,
  p_check_in date default null, p_check_out date default null,
  p_confirm boolean default false
) returns jsonb
language plpgsql security definer as $$
declare pf jsonb; cur record; ci date; co date; res jsonb; eid bigint; v_audit bigint;
  v_state text; v_msg text; v_detail text; v_hint text; v_ctx text;
  tgt jsonb := jsonb_build_object('id',p_id,'new_room_id',p_new_room_id);
begin
  if exists(select 1 from app.write_audit where idempotency_key=p_key) then
    return app._replay(p_key);
  end if;
  select * into cur from public.dorm_reservations where id=p_id;
  if not found then
    eid := app._log_error('move',p_key,tgt,'{}'::jsonb,'P0002',
             format('이동 대상 예약 없음 id=%s',p_id),null,null,null);
    return jsonb_build_object('ok',false,'error',true,'op','move','error_id',eid,
      'sqlstate','P0002','message',format('이동 대상 예약 없음 id=%s',p_id));
  end if;
  ci := coalesce(p_check_in, cur.check_in);
  co := coalesce(p_check_out, cur.check_out);

  pf := app.reservation_preflight('move', p_new_room_id, cur.student_id, ci, co, cur.ri_type, p_id);
  if (pf->>'blocked')::boolean and not p_confirm then
    return jsonb_build_object('ok',false,'need_confirm',true,'op','move',
      'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  end if;

  -- 원자적 rewrite: 같은 트랜잭션에서 방/기간 교체(유니크 제약이 이중저장 차단)
  update public.dorm_reservations
     set room_id=p_new_room_id, check_in=ci, check_out=co, ri_type='M'
   where id=p_id;

  res := jsonb_build_object('ok',true,'op','move','id',p_id,'new_room_id',p_new_room_id,
    'confidence',(pf->>'confidence')::int,'level',pf->>'level','checks',pf->'checks');
  insert into app.write_audit(idempotency_key,op,reservation_id,confidence,level,result)
  values (p_key,'move',p_id,(pf->>'confidence')::int,pf->>'level',res)
  returning audit_id into v_audit;
  return res || jsonb_build_object('audit_id',v_audit);

exception when others then
  get stacked diagnostics v_state=returned_sqlstate, v_msg=message_text,
    v_detail=pg_exception_detail, v_hint=pg_exception_hint, v_ctx=pg_exception_context;
  eid := app._log_error('move', p_key, tgt, jsonb_build_object('confirm',p_confirm,'ci',ci,'co',co),
         v_state, v_msg, v_detail, v_hint, v_ctx);
  return jsonb_build_object('ok',false,'error',true,'op','move',
    'error_id',eid,'sqlstate',v_state,'message',v_msg);
end $$;

-- ════════════════════════════════════════════════════════════════
-- 7) RLS + 권한 — 로그/감사는 service_role 만, RPC 는 SECURITY DEFINER
-- ════════════════════════════════════════════════════════════════
alter table app.db_error_log enable row level security;
alter table app.write_audit  enable row level security;
do $$
begin
  if not exists(select 1 from pg_policies where schemaname='app' and tablename='db_error_log' and policyname='svc_all') then
    create policy svc_all on app.db_error_log for all to service_role using (true) with check (true);
  end if;
  if not exists(select 1 from pg_policies where schemaname='app' and tablename='write_audit' and policyname='svc_all') then
    create policy svc_all on app.write_audit for all to service_role using (true) with check (true);
  end if;
end $$;

-- RPC 실행 권한: authenticated 는 RPC 만 호출(테이블 직접 접근 불가)
grant usage on schema app to authenticated, service_role;
grant execute on function app.reservation_preflight(text,bigint,bigint,date,date,char,bigint) to authenticated, service_role;
grant execute on function app.reserve_insert(text,bigint,bigint,date,date,char,boolean) to authenticated, service_role;
grant execute on function app.reserve_update(text,bigint,date,date,char,boolean) to authenticated, service_role;
grant execute on function app.reserve_delete(text,bigint,boolean) to authenticated, service_role;
grant execute on function app.reserve_move(text,bigint,bigint,date,date,boolean) to authenticated, service_role;

commit;

-- ════════════════════════════════════════════════════════════════
-- 사용 예 (UI 소비 계약):
--   1) 미리보기(신뢰도만):
--      select app.reservation_preflight('insert', 12, 345, '2026-07-10','2026-08-06','L');
--   2) 저장(더블서밋 가드 위해 UI가 생성한 멱등키 전달):
--      select app.reserve_insert('ins:12:345:2026-07-10:uuid', 12,345,'2026-07-10','2026-08-06','L', false);
--      → need_confirm=true 면 메세지박스 표시 후 사용자 '저장' 클릭 시 동일 키+ p_confirm=true 재호출
--   3) 방변경(rewrite):
--      select app.reserve_move('mv:777:uuid', 777, 88, null, null, false);
--   4) 에러 조회:
--      select * from app.db_error_log where error_id = <응답의 error_id>;
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 인보이스 발행 멱등 계층 (중복발행/이중기표 방지)
--   방어 순서: ①UI 잠금 ②멱등키 ③UNIQUE 제약(TOCTOU 최종 방어) ④예외→중복안내
--   재실행 안전(멱등 DDL).
-- ════════════════════════════════════════════════════════════════
create table if not exists app.invoice_issue (
  id         bigserial primary key,
  target_key text        not null,                    -- 발행 대상(학생/화면 컨텍스트)
  seq        int         not null default 1,
  idem_key   text        not null,                    -- 클릭 1회 = 멱등키 1개
  invoice_no text,
  amount     numeric,
  issued_by  text,
  detail     jsonb       not null default '{}'::jsonb,
  issued_at  timestamptz not null default now()
);
comment on table app.invoice_issue is
  '인보이스 발행 원장. idem_key/target_key UNIQUE 로 중복발행(이중기표) 차단. TOCTOU 방어의 최종 계층.';
create unique index if not exists uq_invoice_idem   on app.invoice_issue (idem_key);
create unique index if not exists uq_invoice_target on app.invoice_issue (target_key, seq);
create index        if not exists ix_invoice_issued on app.invoice_issue (issued_at desc);

-- 발행 RPC — 중복이면 에러가 아니라 기존 발행건 정보를 돌려준다(사용자에겐 안내 메시지)
create or replace function app.invoice_publish(
  p_target text, p_idem text, p_by text default null,
  p_amount numeric default null, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = app, public, extensions
as $$
declare v_rec app.invoice_issue%rowtype;
begin
  -- 1차: 이미 발행된 대상인지 확인(빠른 경로)
  select * into v_rec from app.invoice_issue
   where target_key = p_target or idem_key = p_idem order by seq limit 1;
  if found then
    return jsonb_build_object('ok',false,'duplicate',true,'invoice_no',v_rec.invoice_no,
      'issued_at',v_rec.issued_at,'issued_by',v_rec.issued_by,'message','이미 발행되었습니다.');
  end if;
  -- 2차: UNIQUE 제약이 최종 방어(동시요청은 여기서 걸림)
  begin
    insert into app.invoice_issue(target_key,seq,idem_key,invoice_no,amount,issued_by,detail)
    values (p_target,1,p_idem,'(pending)',p_amount,p_by,coalesce(p_detail,'{}'::jsonb))
    returning * into v_rec;
    update app.invoice_issue
       set invoice_no = 'INV-'||to_char(issued_at,'YYYYMMDD')||'-'||lpad(id::text,6,'0')
     where id = v_rec.id returning * into v_rec;
  exception when unique_violation then
    select * into v_rec from app.invoice_issue
     where target_key = p_target or idem_key = p_idem order by seq limit 1;
    return jsonb_build_object('ok',false,'duplicate',true,'invoice_no',v_rec.invoice_no,
      'issued_at',v_rec.issued_at,'issued_by',v_rec.issued_by,'message','이미 발행되었습니다.');
  end;
  return jsonb_build_object('ok',true,'duplicate',false,'invoice_no',v_rec.invoice_no,
    'issued_at',v_rec.issued_at,'message','인보이스가 발행되었습니다.');
end $$;

alter table app.invoice_issue enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='app' and tablename='invoice_issue' and policyname='svc_all') then
    create policy svc_all on app.invoice_issue for all to service_role using (true) with check (true);
  end if;
end $$;
grant execute on function app.invoice_publish(text,text,text,numeric,jsonb) to anon, authenticated, service_role;
