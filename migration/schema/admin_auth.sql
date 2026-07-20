-- ════════════════════════════════════════════════════════════════
-- 워크스트림 B — 관리자 인증(4계정) + 사용로그
--   계정: admin1, admin2, master, manager  (초기 비밀번호 = 아이디)
--   최초 로그인 후 비밀번호 변경 강제(must_change), 아이디별 사용로그 적재.
--   전부 멱등(재실행 안전). DDL 은 이 파일에만 — 적용은 메인 루프가 수행.
--   해시: pgcrypto bcrypt(crypt + gen_salt('bf')). RPC 는 security definer.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;
create schema if not exists app;

-- ────────────────────────────────────────────────────────────────
-- 1) 계정 테이블
-- ────────────────────────────────────────────────────────────────
create table if not exists app.admin_users (
  username    text primary key,
  pw_hash     text        not null,
  must_change boolean     not null default true,
  last_login  timestamptz,
  created_at  timestamptz not null default now()
);
comment on table app.admin_users is '관리자 계정. pw_hash=bcrypt(crypt). must_change=최초 로그인 후 비번변경 강제.';

-- 4계정 seed. 초기 비밀번호 = 아이디 자신. 이미 있으면 건드리지 않음(멱등).
insert into app.admin_users (username, pw_hash, must_change)
values
  ('admin1',  crypt('admin1',  gen_salt('bf')), true),
  ('admin2',  crypt('admin2',  gen_salt('bf')), true),
  ('master',  crypt('master',  gen_salt('bf')), true),
  ('manager', crypt('manager', gen_salt('bf')), true)
on conflict (username) do nothing;

-- 1-b) 레거시 관리자 계정 등록 (gnuboard cms.g4_member, level>=8)
--   레거시 비밀번호는 MySQL PASSWORD() 해시(복호화 불가) → 표준 이관: 초기 비번=아이디,
--   최초 로그인 시 변경 강제(must_change=true). 기존 계정은 건드리지 않음(멱등).
--   표시/추적용 컬럼(mb_name·mb_level·source) 보강.
alter table app.admin_users add column if not exists mb_name text;
alter table app.admin_users add column if not exists mb_level int;
alter table app.admin_users add column if not exists source  text;

insert into app.admin_users (username, pw_hash, must_change, mb_name, mb_level, source)
select mb_id, crypt(mb_id, gen_salt('bf')), true, mb_name, mb_level, 'legacy_g4_member'
from cms.g4_member
where mb_level >= 8            -- 핵심 관리자(레벨10 최고관리자 포함). 필요 시 >=7 로 확장.
on conflict (username) do nothing;
-- 등록됨(2026-07-20): cebusme/cebusme00/cebusme2(최고관리자)/Joon/katie(lv10), cebusme1(lv9), fumi(lv8)

-- ────────────────────────────────────────────────────────────────
-- 2) 사용로그 테이블
-- ────────────────────────────────────────────────────────────────
create table if not exists app.admin_activity_log (
  id       bigserial primary key,
  username text,
  kind     text,                                   -- create|read|update|delete|auth (로그 분류)
  action   text,
  detail   jsonb        not null default '{}'::jsonb,
  ip       text,
  at       timestamptz  not null default now()
);
-- 재실행 시 kind 컬럼 보강(멱등)
alter table app.admin_activity_log add column if not exists kind text;
comment on table app.admin_activity_log is
  '관리자 사용로그. kind=create/read/update/delete/auth. 조회(read)는 화면 열람 단위·비차단·90일 보존.';
-- 조회키 인덱스 + append-only 시간축 BRIN(대량 조회로그에도 가벼움)
create index if not exists idx_admin_activity_user_at on app.admin_activity_log (username, at desc);
create index if not exists brin_admin_activity_at on app.admin_activity_log using brin (at);
create index if not exists idx_admin_activity_kind_at on app.admin_activity_log (kind, at desc);

-- ────────────────────────────────────────────────────────────────
-- 3) RPC (security definer)
-- ────────────────────────────────────────────────────────────────

-- 3-1) 로그인: crypt 검증 → 성공시 last_login 갱신 + login 로그, 실패시 login_fail 로그
create or replace function app.admin_login(p_user text, p_pw text)
returns jsonb
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare
  v_rec app.admin_users%rowtype;
begin
  select * into v_rec from app.admin_users where username = p_user;

  if not found or v_rec.pw_hash <> crypt(p_pw, v_rec.pw_hash) then
    insert into app.admin_activity_log (username, kind, action, detail)
    values (p_user, 'auth', 'login_fail', jsonb_build_object('reason','bad_credentials'));
    return jsonb_build_object('ok', false, 'must_change', false,
                              'message', '아이디 또는 비밀번호가 올바르지 않습니다.');
  end if;

  update app.admin_users set last_login = now() where username = p_user;
  insert into app.admin_activity_log (username, kind, action, detail)
  values (p_user, 'auth', 'login', jsonb_build_object('must_change', v_rec.must_change));

  return jsonb_build_object('ok', true, 'must_change', v_rec.must_change,
                            'message', case when v_rec.must_change
                              then '최초 로그인입니다. 비밀번호를 변경하세요.'
                              else '로그인 성공' end);
end;
$$;

-- 3-2) 비밀번호 변경: old 검증 → 새 비번(≠아이디) 적용 → must_change=false + 로그
create or replace function app.admin_change_password(p_user text, p_old text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare
  v_rec app.admin_users%rowtype;
begin
  select * into v_rec from app.admin_users where username = p_user;

  if not found or v_rec.pw_hash <> crypt(p_old, v_rec.pw_hash) then
    insert into app.admin_activity_log (username, action, detail)
    values (p_user, 'change_password_fail', jsonb_build_object('reason','bad_old_password'));
    return jsonb_build_object('ok', false, 'message', '기존 비밀번호가 올바르지 않습니다.');
  end if;

  if p_new is null or length(p_new) < 4 then
    return jsonb_build_object('ok', false, 'message', '새 비밀번호는 4자 이상이어야 합니다.');
  end if;

  if p_new = p_user then
    return jsonb_build_object('ok', false, 'message', '새 비밀번호는 아이디와 달라야 합니다.');
  end if;

  if p_new = p_old then
    return jsonb_build_object('ok', false, 'message', '새 비밀번호는 기존 비밀번호와 달라야 합니다.');
  end if;

  update app.admin_users
     set pw_hash = crypt(p_new, gen_salt('bf')),
         must_change = false
   where username = p_user;

  insert into app.admin_activity_log (username, kind, action, detail)
  values (p_user, 'auth', 'change_password', '{}'::jsonb);

  return jsonb_build_object('ok', true, 'message', '비밀번호가 변경되었습니다.');
end;
$$;

-- 3-3) 사용로그 적재(진입 후 동작) — kind: create/read/update/delete/auth
--   CRUD(쓰기)는 즉시, 조회(read)는 클라이언트가 화면 열람 단위·비차단으로 호출.
create or replace function app.admin_log(
  p_user text, p_action text, p_detail jsonb default '{}'::jsonb, p_kind text default null)
returns void
language plpgsql
security definer
set search_path = app, public, extensions
as $$
begin
  insert into app.admin_activity_log (username, kind, action, detail)
  values (p_user, p_kind, p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

-- 3-4) 조회(read) 로그 보존정책 — 90일 초과분 정리(부하·팽창 방지). CRUD/auth 는 유지.
create or replace function app.purge_admin_read_logs(p_days int default 90)
returns bigint
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare v_cnt bigint;
begin
  delete from app.admin_activity_log
   where kind = 'read' and at < now() - make_interval(days => p_days);
  get diagnostics v_cnt = row_count;
  return v_cnt;
end;
$$;
comment on function app.purge_admin_read_logs(int) is
  '조회(read) 로그 90일 초과분 삭제. CRUD/auth 로그는 보존. pg_cron 일간 스케줄 권장.';

-- ────────────────────────────────────────────────────────────────
-- 4) RLS + 권한
-- ────────────────────────────────────────────────────────────────
alter table app.admin_users        enable row level security;
alter table app.admin_activity_log enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='app' and tablename='admin_users' and policyname='svc_all') then
    create policy svc_all on app.admin_users for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='app' and tablename='admin_activity_log' and policyname='svc_all') then
    create policy svc_all on app.admin_activity_log for all to service_role using (true) with check (true);
  end if;
end $$;

-- 함수는 security definer 이므로 anon/authenticated 도 검증·로깅만 안전하게 수행.
-- (테이블 직접 접근은 RLS 로 service_role 만 허용 → 자격증명/로그 무단열람 차단)
grant usage on schema app to anon, authenticated, service_role;
grant execute on function app.admin_login(text, text)                     to anon, authenticated, service_role;
grant execute on function app.admin_change_password(text, text, text)     to anon, authenticated, service_role;
grant execute on function app.admin_log(text, text, jsonb, text)          to anon, authenticated, service_role;
grant execute on function app.purge_admin_read_logs(int)                  to service_role;
