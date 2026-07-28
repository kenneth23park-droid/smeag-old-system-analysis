-- ============================================================================
-- SMEAG 신시스템 · Supabase 백엔드 "1단계"
--   실행: Supabase 대시보드 → SQL Editor → 붙여넣기 → Run
--   안전: 재실행 가능(idempotent) · 원본 테이블은 안 건드림(뷰/함수만 추가)
--   순서: [A] 진단 먼저 → 결과 확인 → [B] 로그인 → [C] 데이터 뷰(컬럼 맞춘 뒤)
-- ============================================================================


-- ========================================================================
-- [A] 진단 (읽기 전용) — 이것부터 실행하고 결과를 확인/공유하세요
--     목적: 이름 데이터(student_info)가 어느 스키마에 있고, 컬럼이 뭔지 확인
-- ========================================================================
-- A-1) student_info 가 있는 스키마
select table_schema, table_name
from information_schema.tables
where table_name = 'student_info'
order by table_schema;

-- A-2) student_info 컬럼 목록 (이름·생년월일 등 확인)
select table_schema, column_name, data_type
from information_schema.columns
where table_name = 'student_info'
order by table_schema, ordinal_position;

-- A-3) (스키마 확인 후) 건수 — 예: legacy 면 legacy.student_info
--     아래 주석을 풀어 스키마명 맞춰 실행:
-- select count(*) from legacy.student_info;


-- ========================================================================
-- [B] 로그인 백엔드 — 지금 바로 실행 가능(데이터와 무관, 자기완결)
--     결과: admin_login RPC 생성 + 기본 관리자 계정(비번=아이디)
-- ========================================================================
create schema if not exists app;
create extension if not exists pgcrypto;   -- 비밀번호 해시(bcrypt)용

-- 관리자 계정 표 (비밀번호는 해시로만 저장)
create table if not exists app.admin_users (
  username    text primary key,
  pw_hash     text not null,
  role        text not null default 'admin',
  must_change boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 기본 계정 시드 (비번=아이디, 최초 로그인 후 변경 권장) · 이미 있으면 유지
insert into app.admin_users(username, pw_hash, must_change) values
  ('admin',   crypt('admin',   gen_salt('bf')), true),
  ('master',  crypt('master',  gen_salt('bf')), true),
  ('manager', crypt('manager', gen_salt('bf')), true),
  ('kenneth', crypt('kenneth', gen_salt('bf')), true)
on conflict (username) do nothing;

-- 로그인 RPC: 성공 {ok:true,user,role,must_change} / 실패 {ok:false,message}
create or replace function public.admin_login(p_user text, p_pw text)
returns jsonb
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare rec app.admin_users%rowtype;
begin
  select * into rec from app.admin_users where username = lower(p_user);
  if not found then
    return jsonb_build_object('ok', false, 'message', '등록되지 않은 아이디입니다.');
  end if;
  if rec.pw_hash = crypt(p_pw, rec.pw_hash) then
    return jsonb_build_object('ok', true, 'user', rec.username,
                             'role', rec.role, 'must_change', rec.must_change);
  end if;
  return jsonb_build_object('ok', false, 'message', '비밀번호가 올바르지 않습니다.');
end $$;

-- 비밀번호 변경 RPC
create or replace function public.admin_change_password(p_user text, p_old text, p_new text)
returns jsonb
language plpgsql security definer set search_path = app, public, extensions
as $$
declare rec app.admin_users%rowtype;
begin
  select * into rec from app.admin_users where username = lower(p_user);
  if not found or rec.pw_hash <> crypt(p_old, rec.pw_hash) then
    return jsonb_build_object('ok', false, 'message', '기존 정보가 올바르지 않습니다.');
  end if;
  if length(coalesce(p_new,'')) < 4 or p_new = lower(p_user) then
    return jsonb_build_object('ok', false, 'message', '새 비밀번호는 4자 이상·아이디와 달라야 합니다.');
  end if;
  update app.admin_users
     set pw_hash = crypt(p_new, gen_salt('bf')), must_change = false
   where username = lower(p_user);
  return jsonb_build_object('ok', true);
end $$;

-- 보안 권한: 계정표 직접접근 차단 · 로그인 함수만 호출 허용
revoke all on table app.admin_users from anon, authenticated;
grant execute on function public.admin_login(text, text)                 to anon, authenticated;
grant execute on function public.admin_change_password(text, text, text) to anon, authenticated;
-- (새 계정 추가 예:)
-- insert into app.admin_users(username, pw_hash) values ('newid', crypt('newpw', gen_salt('bf')));


-- ========================================================================
-- [C] 데이터 노출 뷰 — [A] 로 스키마/컬럼 확인한 뒤 실행
--     ⚠ 아래 컬럼명은 '예상값'입니다. [A] 결과와 다르면 이름을 맞추세요.
--     ⚠ 주민번호(s_jumin) 등 민감정보는 노출하지 않습니다.
--     ⚠ from 절의 스키마(legacy)를 [A]에서 확인한 실제 스키마로 바꾸세요.
-- ========================================================================
create or replace view public.v_students as
select
  s_idx,
  e_name       as name_en,       -- 영문이름
  k_name       as name_kr,       -- 한글이름
  s_gender     as gender,        -- 성별
  s_age        as age,           -- 나이
  s_date       as begin_date,    -- 시작일
  s_departure  as departure_date,-- 출발일
  s_regdate    as apply_date,    -- 등록일
  s_room       as room,          -- 객실
  course_info  as course,        -- 연수코스
  now_status   as status         -- 상태
from legacy.student_info;        -- ← [A]에서 확인한 실제 스키마로 조정

-- 보안(핵심): 비로그인(anon)은 차단, 로그인 사용자·서버만 조회
revoke all on public.v_students from anon;
grant select on public.v_students to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- ⚠ 인증 모델 주의(2단계 연결 시 결정 필요)
--   현재 신 시스템 로그인은 위 admin_login(커스텀) 방식이라, 브라우저는 여전히
--   anon 역할로 데이터를 호출합니다. 그러면 위 v_students(anon 차단) 를 '직접'
--   읽지 못합니다(= 개인정보가 안 새는 안전한 기본값).
--   실제로 화면에 데이터를 뿌리려면 2단계에서 아래 둘 중 하나를 택해야 합니다:
--     (가) Supabase Auth 로 로그인 → 'authenticated' 역할로 v_students 조회
--     (나) Vercel 서버리스 함수(프록시)가 service_role 로 조회해 화면에 전달
--   → 어느 쪽이든 "anon 키로 브라우저가 PII 직접 조회"는 하지 않습니다.
-- ────────────────────────────────────────────────────────────────────────
