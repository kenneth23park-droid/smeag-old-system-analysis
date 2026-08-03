-- ════════════════════════════════════════════════════════════════
-- 회원정보 수정 저장 계층 (2026-08-03)
--   화면: 신전산 회원관리 → ✎ 회원정보 수정(레거시 adm/member_form.php 재현)
--
--   왜 cms.g4_member 를 직접 UPDATE 하지 않는가:
--     · cms.g4_member 는 레거시 MySQL 원본의 **이관 미러**다. 재이관하면 통째로 덮이고,
--       역방향 동기화가 붙기 전에는 구전산에도 반영되지 않는다.
--     · 같은 이유로 권한(mb_level)은 이미 app.member_level_override 로 분리해 두었다
--       (migration/schema/member_level_override.sql).
--   → 회원 수정값도 신전산 소유 오버레이 테이블 app.member_edits 에 쌓고,
--     조회 시 레거시 값 위에 덮어(overlay) 보여준다. 원본은 불변.
--     동시에 app.change_log 에 남겨 역방향 일일동기화(legacy_writeback)가 집어가게 한다.
--
--   규약(write_layer.sql · admin_edits.sql 과 동일):
--     · 멱등키: app.write_audit.idempotency_key UNIQUE → 재요청은 최초 응답 재생
--     · 화이트리스트 컬럼만 반영 · PK(mb_id)는 WHERE 로만
--     · 예외는 throw 대신 구조화 응답으로 강등(쓰기 의도 유실 금지)
--   재실행 안전(idempotent).
-- ════════════════════════════════════════════════════════════════
begin;

create schema if not exists app;

do $$
begin
  if to_regclass('cms.g4_member') is null then
    raise exception 'member_edits.sql 전제 미충족: cms.g4_member 없음(재이관 먼저)';
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────
-- 1) 오버레이 원장
-- ────────────────────────────────────────────────────────────────
create table if not exists app.member_edits (
  mb_id      text primary key,
  patch      jsonb       not null default '{}'::jsonb,   -- {"mb_name":"...", "mb_1":"..."}
  updated_by text,
  updated_at timestamptz not null default now()
);

comment on table app.member_edits is
  '신전산 회원정보 수정 오버레이 — 레거시 cms.g4_member 는 건드리지 않고 변경분만 보관(조회 시 덮어 표시).';

-- 역방향 동기화 화이트리스트에 g4_member 추가(기존 4개 테이블 유지)
create or replace function app.log_change(
  p_target_table text,
  p_target_pk    jsonb,
  p_changed_cols jsonb,
  p_source       text default 'admin_ui',
  p_op           text default 'update'
) returns bigint
language plpgsql security definer set search_path = app, public
as $$
declare
  v_allow text[] := array['student_info','student_change','reserve_info','student_payment','g4_member'];
  v_cols  jsonb  := coalesce(p_changed_cols,'{}'::jsonb);
  v_id    bigint;
begin
  if not (p_target_table = any(v_allow)) then
    raise exception '허용되지 않은 테이블: % (화이트리스트: %)', p_target_table, v_allow;
  end if;
  if p_target_pk is null or p_target_pk = '{}'::jsonb then
    raise exception 'target_pk 가 비었습니다(구전산 PK 로 기록해야 함)';
  end if;
  insert into app.change_log(target_table, target_pk, changed_cols, op, source)
  values (p_target_table, p_target_pk, v_cols, coalesce(p_op,'update'), p_source)
  returning id into v_id;
  return v_id;
end $$;

grant execute on function app.log_change(text,jsonb,jsonb,text,text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 2) 저장 RPC — app.member_edit_set
--    허용 컬럼 = 레거시 member_form.php 에서 실제로 입력되는 칸.
--    제외(절대): mb_id(PK) · mb_password · mb_jumin · mb_password_q/a · mb_lost_certify · mb_point
--    mb_level 은 권한이 걸린 값이라 오버레이가 아니라 기존 app.member_level_override 로 보낸다.
-- ────────────────────────────────────────────────────────────────
create or replace function app.member_edit_set(
  p_key   text,                       -- 멱등키
  p_id    text,                       -- cms.g4_member.mb_id
  p_patch jsonb,                      -- {"mb_name":"...","mb_hp":"...","mb_1":"..."}
  p_by    text default 'admin'
) returns jsonb
language plpgsql security definer set search_path = app, public, cms
as $$
declare
  v_allow text[] := array[
    'mb_name','mb_nick','mb_email','mb_homepage','mb_tel','mb_hp',
    'mb_zip1','mb_zip2','mb_addr1','mb_addr2','mb_birth','mb_sex',
    'mb_mailling','mb_sms','mb_open','mb_signature','mb_profile','mb_memo',
    'mb_leave_date','mb_intercept_date',
    'mb_1','mb_2','mb_3','mb_4','mb_5','mb_6','mb_7','mb_8','mb_9','mb_10','mb_11'];
  v_k text; v_v text;
  v_cols  jsonb := '{}'::jsonb;
  v_lvl   int   := null;
  v_res   jsonb;
  v_err   bigint;
  v_name  text;
  v_state text; v_msg text; v_det text; v_hint text; v_ctx text;
begin
  -- 멱등: 같은 키면 최초 결과 재생(더블서밋·재시도 안전)
  if exists (select 1 from app.write_audit where idempotency_key = p_key) then
    return app._replay(p_key);
  end if;

  if coalesce(p_id,'') = '' then
    return jsonb_build_object('ok',false,'error','no_pk','message','회원아이디가 필요합니다.');
  end if;
  if p_patch is null or p_patch = '{}'::jsonb then
    return jsonb_build_object('ok',false,'error','empty_patch','message','수정할 값이 없습니다.');
  end if;

  select coalesce(mb_name,'') into v_name from cms.g4_member where lower(mb_id) = lower(p_id);
  if not found then
    return jsonb_build_object('ok',false,'error','not_found',
      'message',format('회원 %s 를 찾을 수 없습니다.',p_id));
  end if;

  for v_k, v_v in select key, value #>> '{}' from jsonb_each(p_patch) loop
    if v_k = 'mb_level' then
      if v_v !~ '^([1-9]|10)$' then
        return jsonb_build_object('ok',false,'error','bad_level','message','권한은 1~10 이어야 합니다.');
      end if;
      v_lvl := v_v::int;
      continue;
    end if;
    if not (v_k = any(v_allow)) then
      return jsonb_build_object('ok',false,'error','col_not_allowed',
        'message',format('허용되지 않은 컬럼: %s',v_k));
    end if;
    if v_k in ('mb_mailling','mb_sms','mb_open') and coalesce(v_v,'') not in ('0','1') then
      return jsonb_build_object('ok',false,'error','bad_flag',
        'message',format('%s 는 0/1 이어야 합니다.',v_k));
    end if;
    if v_k in ('mb_leave_date','mb_intercept_date') and coalesce(v_v,'') <> ''
       and v_v !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('ok',false,'error','bad_date',
        'message',format('%s 형식 오류(YYYY-MM-DD): %s',v_k,v_v));
    end if;
    if length(coalesce(v_v,'')) > 4000 then
      return jsonb_build_object('ok',false,'error','too_long',
        'message',format('%s 값이 너무 깁니다(4000자 초과).',v_k));
    end if;
    v_cols := v_cols || jsonb_build_object(v_k, coalesce(v_v,''));
  end loop;

  begin
    if v_cols <> '{}'::jsonb then
      insert into app.member_edits(mb_id, patch, updated_by, updated_at)
        values (lower(p_id), v_cols, p_by, now())
      on conflict (mb_id) do update
        set patch = app.member_edits.patch || excluded.patch,   -- 마지막 값 승리(칸 단위 병합)
            updated_by = excluded.updated_by,
            updated_at = now();

      -- 구전산 역방향 동기화용 변경로그(구전산 정체성으로 기록)
      perform app.log_change('g4_member', jsonb_build_object('mb_id',p_id), v_cols, 'admin_ui', 'update');
    end if;

    -- 권한은 기존 오버라이드 테이블로(유효권한 = max(레거시, 오버라이드))
    if v_lvl is not null then
      insert into app.member_level_override(mb_id, mb_level, active, memo, updated_by, updated_at)
        values (p_id, v_lvl, true, '회원정보 수정 화면에서 변경', p_by, now())
      on conflict (mb_id) do update
        set mb_level = excluded.mb_level, active = true,
            memo = excluded.memo, updated_by = excluded.updated_by, updated_at = now();
    end if;

    v_res := jsonb_build_object('ok',true,'mb_id',p_id,'name',v_name,
                                'patch',v_cols,'level',v_lvl,'by',p_by,'at',now());
    insert into app.write_audit(idempotency_key,op,level,result,actor)
      values (p_key,'member_edit_set','ok',v_res,p_by);
    return v_res;
  exception when others then
    get stacked diagnostics v_state=RETURNED_SQLSTATE, v_msg=MESSAGE_TEXT,
      v_det=PG_EXCEPTION_DETAIL, v_hint=PG_EXCEPTION_HINT, v_ctx=PG_EXCEPTION_CONTEXT;
    v_err := app._log_error('member_edit_set',p_key,jsonb_build_object('mb_id',p_id),p_patch,
                            v_state,v_msg,v_det,v_hint,v_ctx);
    return jsonb_build_object('ok',false,'error','db_error','error_id',v_err,'message',v_msg);
  end;
end $$;

grant execute on function app.member_edit_set(text,text,jsonb,text) to authenticated, service_role;

alter table app.member_edits enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='app' and tablename='member_edits'
                 and policyname='svc_all') then
    create policy svc_all on app.member_edits for all to service_role using (true) with check (true);
  end if;
end $$;

commit;
