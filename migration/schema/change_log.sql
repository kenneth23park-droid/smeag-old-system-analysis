-- ════════════════════════════════════════════════════════════════
-- 역방향 동기화 소스: app.change_log
--   신전산이 저장할 때마다 "구전산 어느 표·어느 행·무슨 값이 바뀌었나"를 한 줄 남긴다.
--   export_daily_changes.py --source changelog 가 그날치(changed_at::date)를 읽어
--   changes.json 을 만들고 → legacy_writeback.py 가 구전산 MySQL 에 UPDATE 한다.
--
--   중요: target_table / target_pk 는 **구전산(MySQL) 정체성**으로 기록한다.
--         (예: target_table='student_info', target_pk={"s_idx":12345})
--         모델링표(public.dorm_*)를 수정하더라도, 로그는 레거시 표/키로 환산해 남긴다.
--         이 환산이 역방향 반영의 유일한 '배선 결정'이다.
--
--   재실행 안전(멱등 DDL): create ... if not exists / or replace.
--   전제: write_layer.sql 등에서 schema app 이미 생성됨(없으면 여기서 생성).
-- ════════════════════════════════════════════════════════════════
begin;

create schema if not exists app;

-- ────────────────────────────────────────────────────────────────
-- 1) 변경로그 원장
--    exporter 가 읽는 컬럼: target_table, target_pk, changed_cols, changed_at, id
-- ────────────────────────────────────────────────────────────────
create table if not exists app.change_log (
  id           bigserial   primary key,
  target_table text        not null,               -- 구전산(MySQL) 테이블명
  target_pk    jsonb       not null,               -- {"s_idx":12345}
  changed_cols jsonb       not null,               -- {"s_room":"CAPITAL2 508", ...}(반영할 값)
  op           text        not null default 'update',  -- 현재 역방향은 update 만 소비
  source       text,                               -- 어느 화면/RPC 에서 발생했는지(감사)
  actor        text        default current_setting('request.jwt.claim.role', true),
  changed_at   timestamptz not null default now(),
  synced_at    timestamptz,                        -- 구전산 반영 완료 시각(선택 표시용)
  sync_note    text                                -- 반영 결과/스킵 사유(선택)
);
create index if not exists ix_changelog_day  on app.change_log ((changed_at::date));
create index if not exists ix_changelog_tbl  on app.change_log (target_table);
create index if not exists ix_changelog_unsy on app.change_log (synced_at) where synced_at is null;

comment on table app.change_log is
  '신전산→구전산 역방향 일일 동기화 소스. 그날치를 export_daily_changes.py 가 읽어 changes.json 생성.';

-- ────────────────────────────────────────────────────────────────
-- 2) 명시적 로깅 RPC — 앱/기존 RPC 안에서 호출
--    화이트리스트(구전산 반영 가능 표)만 기록, PK 는 changed_cols 에서 자동 제외.
-- ────────────────────────────────────────────────────────────────
create or replace function app.log_change(
  p_target_table text,
  p_target_pk    jsonb,
  p_changed_cols jsonb,
  p_source       text default null,
  p_op           text default 'update'
) returns bigint
language plpgsql security definer set search_path = app, public
as $$
declare
  v_id   bigint;
  v_cols jsonb;
  -- legacy_writeback.py / export_daily_changes.py 와 동일한 화이트리스트·PK
  v_allow text[] := array['student_info','student_change','reserve_info','student_payment'];
  v_pk_key text;
begin
  if not (p_target_table = any(v_allow)) then
    raise exception '허용되지 않은 테이블: % (화이트리스트: %)', p_target_table, v_allow;
  end if;
  if p_target_pk is null or p_target_pk = '{}'::jsonb then
    raise exception 'target_pk 필요(WHERE 없는 대량변경 방지)';
  end if;

  -- PK 컬럼은 SET(changed_cols)에서 제거 — PK 는 WHERE 로만
  v_cols := p_changed_cols;
  for v_pk_key in select jsonb_object_keys(p_target_pk) loop
    v_cols := v_cols - v_pk_key;
  end loop;
  if v_cols is null or v_cols = '{}'::jsonb then
    raise exception '기록할 컬럼 없음(PK 제외 후 공백)';
  end if;

  insert into app.change_log(target_table, target_pk, changed_cols, op, source)
  values (p_target_table, p_target_pk, v_cols, coalesce(p_op,'update'), p_source)
  returning id into v_id;
  return v_id;
end $$;

-- ────────────────────────────────────────────────────────────────
-- 3) 제네릭 트리거 함수 — 레거시 충실사본(legacy.*) 을 직접 UPDATE 하는 경우
--    변경된 컬럼만 자동으로 change_log 에 남긴다.
--    사용법(예: legacy.student_info, PK=s_idx):
--      create trigger tg_log_student_info
--        after update on legacy.student_info
--        for each row execute function app.tg_change_log('s_idx');
--    ※ public.dorm_* 모델을 수정하는 구조라면 이 트리거 대신 (2)의 log_change 를
--       RPC 안에서 레거시 표/키로 환산해 호출하는 방식을 쓴다.
-- ────────────────────────────────────────────────────────────────
create or replace function app.tg_change_log()
returns trigger
language plpgsql security definer set search_path = app, public
as $$
declare
  v_pk_cols text[] := tg_argv;      -- 트리거 인자 = PK 컬럼 목록
  v_pk   jsonb := '{}'::jsonb;
  v_cols jsonb := '{}'::jsonb;
  v_col  text;
  v_old  jsonb := to_jsonb(old);
  v_new  jsonb := to_jsonb(new);
  c text;
begin
  -- PK 수집
  foreach c in array v_pk_cols loop
    v_pk := v_pk || jsonb_build_object(c, v_new -> c);
  end loop;
  -- 값이 실제로 바뀐 컬럼만(PK 제외) 수집
  for v_col in select jsonb_object_keys(v_new) loop
    if not (v_col = any(v_pk_cols))
       and (v_new -> v_col) is distinct from (v_old -> v_col) then
      v_cols := v_cols || jsonb_build_object(v_col, v_new -> v_col);
    end if;
  end loop;

  if v_cols <> '{}'::jsonb then
    insert into app.change_log(target_table, target_pk, changed_cols, op, source)
    values (tg_table_name, v_pk, v_cols, 'update', 'trigger:'||tg_table_name);
  end if;
  return new;
end $$;

-- ────────────────────────────────────────────────────────────────
-- 4) RLS + 권한
-- ────────────────────────────────────────────────────────────────
alter table app.change_log enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='app' and tablename='change_log' and policyname='svc_all') then
    create policy svc_all on app.change_log for all to service_role using (true) with check (true);
  end if;
  -- authenticated 는 자기 변경을 남기기만(select 는 service_role/export 계정만)
  if not exists (select 1 from pg_policies
                 where schemaname='app' and tablename='change_log' and policyname='auth_insert') then
    create policy auth_insert on app.change_log for insert to authenticated with check (true);
  end if;
end $$;

grant usage  on schema app to authenticated, service_role;
grant execute on function app.log_change(text,jsonb,jsonb,text,text) to authenticated, service_role;

commit;

-- ════════════════════════════════════════════════════════════════
-- 사용 예
--   1) 앱에서 방배정 저장 직후(레거시 정체성으로 기록):
--        select app.log_change('student_info', '{"s_idx":12345}'::jsonb,
--               '{"s_room":"CAPITAL2 508"}'::jsonb, 'room_replacement');
--   2) 그날 export → 구전산 반영:
--        PG_PASS=... python export_daily_changes.py --date 2026-07-25 --out changes_2026-07-25.json
--        MYSQL_*=...  python legacy_writeback.py --changes changes_2026-07-25.json          # dry-run
--        MYSQL_*=...  python legacy_writeback.py --changes changes_2026-07-25.json --commit --yes
--   3) 반영 완료 표시(선택):
--        update app.change_log set synced_at=now(), sync_note='ok'
--         where changed_at::date='2026-07-25' and synced_at is null;
-- ════════════════════════════════════════════════════════════════
