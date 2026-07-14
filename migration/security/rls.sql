-- ════════════════════════════════════════════════════════════════
-- 결정 E: 개인정보 보호 — RLS + 마스킹뷰
--   민감 테이블(student_info 등)은 기본 차단(RLS deny), 서비스롤만 원본 접근.
--   앱/분석용은 마스킹뷰(masked.*)로만 노출. 주민번호/비번/여권/연락처 마스킹.
--   Supabase 역할: authenticated / anon 은 원본 접근 불가, service_role 만 허용.
-- ════════════════════════════════════════════════════════════════
create schema if not exists masked;

-- 1) 민감 테이블 RLS 활성화 + 기본 deny (정책 없음 = 접근 불가)
do $$
declare t text;
begin
  foreach t in array array[
    'legacy.student_info','legacy.student_info_history','legacy.student_change',
    'legacy.student_info_invoice','cms.g4_member','cms.member_score_core'
  ] loop
    if to_regclass(t) is not null then
      execute format('alter table %s enable row level security', t);
      execute format('alter table %s force row level security', t);
      -- service_role 전체 허용 정책
      execute format($f$
        do $inner$ begin
          if not exists (select 1 from pg_policies
                         where schemaname||'.'||tablename = %L and policyname='svc_all') then
            execute format('create policy svc_all on %s for all to service_role using (true) with check (true)');
          end if;
        end $inner$; $f$, t, t);
    end if;
  end loop;
end $$;

-- 2) 마스킹 함수
create or replace function masked.mask_mid(txt text) returns text language sql immutable as $$
  select case when txt is null or txt='' then txt
              else left(txt,1) || repeat('*', greatest(length(txt)-2,0)) || right(txt,1) end;
$$;
create or replace function masked.mask_full(txt text) returns text language sql immutable as $$
  select case when txt is null or txt='' then txt else repeat('*', length(txt)) end;
$$;

-- 3) 마스킹뷰 (컬럼은 실제 존재하는 것만; 없는 컬럼은 배포 시 수정)
--   student_info 예시 — 주민/연락처/이메일/여권 마스킹, 비번 완전마스킹
create or replace view masked.student_info as
select
  s_idx,
  -- 이름류는 부분마스킹(운영 식별 최소화). 실제 컬럼명은 DDL 로 확정 후 조정.
  masked.mask_mid(s_name)          as s_name,
  masked.mask_full(s_jumin)        as s_jumin,
  masked.mask_mid(s_tel)           as s_tel,
  masked.mask_mid(s_email)         as s_email,
  masked.mask_full(s_passport)     as s_passport
from legacy.student_info;

comment on schema masked is '개인정보 마스킹 노출 계층. 앱/분석은 이 스키마만 사용.';

-- 4) 권한: anon/authenticated 는 masked 만, service_role 은 legacy/cms 직접
grant usage on schema masked to anon, authenticated;
grant select on all tables in schema masked to anon, authenticated;
revoke all on schema legacy, cms from anon, authenticated;
