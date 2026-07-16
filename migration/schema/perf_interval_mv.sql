-- =============================================================================
-- perf_interval_mv.sql  (Postgres 17)
-- 워크스트림 A — 속도 개선: 구간모델 통계 + Materialized View
-- -----------------------------------------------------------------------------
-- 목적: 대시보드/통계를 느린 "일별 전개 뷰" public.room_reserve_compat
--       (dorm_reservations 를 generate_series 로 하루씩 펼친 ~240만 행) 대신,
--       구간모델 public.dorm_reservations(69,326행) 를 사전집계한 Materialized
--       View 로 서빙한다.
--
-- 멱등성: 각 MV 는 drop materialized view if exists → create 순서. 반복 적용 안전.
-- 원본 불가침: legacy.* 는 읽기전용. 여기서는 SELECT 로만 조인한다.
-- 적용: 이 파일은 정의만 담는다. Supabase 적용은 메인 루프가 수행.
--
-- ── 실측 근거(.env, 읽기전용 EXPLAIN ANALYZE / 타이밍) ──────────────────────
--   월별 재실 학생수 집계(전체 구간 2011-08~2028, 197개월):
--     room_reserve_compat 경유 : 실행 4,481 ms (왕복 ~4,797 ms)
--     구간모델 dorm_reservations: 실행   211 ms (왕복 ~  297 ms)   → 약 16x 단축
--   두 방식 결과값 동일(예: 2026-01=766, 2026-02=824, 2026-03=618명).
--   MV 로 사전집계하면 대시보드 조회는 인덱스 스캔 수 ms 수준.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) pg_stat_statements — 느린 쿼리 상시 계측
-- -----------------------------------------------------------------------------
--   Supabase 에서는 보통 이미 활성화되어 있으나 멱등 생성.
create extension if not exists pg_stat_statements;
--   [사용법]
--   -- 누적 통계 상위 소요 쿼리 확인:
--   --   select substr(query,1,80) q, calls, round(total_exec_time) tot_ms,
--   --          round(mean_exec_time,2) mean_ms, rows
--   --     from pg_stat_statements order by total_exec_time desc limit 20;
--   -- MV 도입 전/후 비교 시 통계 리셋:
--   --   select pg_stat_statements_reset();
--   -- room_reserve_compat 를 참조하는 잔여 쿼리 탐지:
--   --   select query, calls, round(mean_exec_time,2) mean_ms
--   --     from pg_stat_statements where query ilike '%room_reserve_compat%'
--   --     order by total_exec_time desc;


-- =============================================================================
-- 1) MATERIALIZED VIEWS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1-A) mv_occupancy_month — 월 × 재실 학생수 / 예약수 (대시보드 핵심 KPI)
-- -----------------------------------------------------------------------------
--   구간(check_in..check_out)이 해당 월과 겹치면 그 달에 재실:
--       check_in <= 월말  AND  check_out >= 월초
--   범위: 실데이터 시작(2011-08) ~ 미래 2027-12.  인덱스 idx_res_ci_co 활용.
drop materialized view if exists public.mv_occupancy_month cascade;
create materialized view public.mv_occupancy_month as
with months as (
    select generate_series('2011-08-01'::date, '2027-12-01'::date, interval '1 month')::date as month
)
select
    m.month                                          as month,
    (m.month + interval '1 month - 1 day')::date      as month_end,
    count(distinct r.student_id)                      as students,   -- 재실 학생수(중복제거)
    count(*)                                          as reservations,-- 겹친 예약행수
    count(*) filter (where r.ri_type = 'L')           as long_stay,   -- 장기(L)
    count(*) filter (where r.ri_type = 'M')           as mid_stay     -- 중기(M)
from months m
join public.dorm_reservations r
  on r.check_in  <= (m.month + interval '1 month - 1 day')::date
 and r.check_out >= m.month
group by m.month;

comment on materialized view public.mv_occupancy_month is
  '월별 재실 학생수/예약수 KPI. 구간모델 dorm_reservations 를 월 겹침으로 사전집계(2011-08~2027-12). room_reserve_compat 대체.';

-- concurrent refresh 용 UNIQUE 인덱스(필수) + 조회 정렬 키
create unique index if not exists uq_mv_occupancy_month
    on public.mv_occupancy_month (month);


-- -----------------------------------------------------------------------------
-- 1-B) mv_campus_population — 국적(s_nation) × 캠퍼스 인원
-- -----------------------------------------------------------------------------
--   캠퍼스 매핑(legacy.student_info.s_campus):
--     SPARTA / 스파르타 / 'SPARTA PREMIUM' / 프리미엄 → ENCANTO
--     CLASSIC / 클래식                                → CLASSIC
--     CAPITAL                                         → CAPITAL
--     그 외/공백                                       → UNKNOWN
--   모집단: 예약이 존재하는 학생 정본 public.dorm_students → student_info 조인.
drop materialized view if exists public.mv_campus_population cascade;
create materialized view public.mv_campus_population as
select
    coalesce(nullif(si.s_nation, ''), 'unknown')     as s_nation,
    case
        when si.s_campus in ('SPARTA', '스파르타', 'SPARTA PREMIUM', '프리미엄') then 'ENCANTO'
        when si.s_campus in ('CLASSIC', '클래식')                                then 'CLASSIC'
        when si.s_campus = 'CAPITAL'                                             then 'CAPITAL'
        else 'UNKNOWN'
    end                                              as campus,
    count(*)                                         as students
from public.dorm_students ds
join legacy.student_info si on si.s_idx = ds.s_idx
group by 1, 2;

comment on materialized view public.mv_campus_population is
  '국적 × 캠퍼스(ENCANTO/CLASSIC/CAPITAL) 인원. dorm_students→legacy.student_info.s_campus 매핑 규칙 적용.';

create unique index if not exists uq_mv_campus_population
    on public.mv_campus_population (s_nation, campus);
create index if not exists ix_mv_campus_population_campus
    on public.mv_campus_population (campus);


-- -----------------------------------------------------------------------------
-- 1-C) mv_building_occupancy — 빌딩(room_category.g_name) × 현재월 재실
-- -----------------------------------------------------------------------------
--   빌딩 경로: dorm_rooms.r_idx → legacy.room_list.r_idx → g_idx
--              → legacy.room_category.g_name (빌딩명).
--   재실 기준월 = refresh 시점의 date_trunc('month', current_date).
--   (MV 는 정적이므로 refresh 할 때마다 "그 시점의 현재월" 로 재계산됨.)
drop materialized view if exists public.mv_building_occupancy cascade;
create materialized view public.mv_building_occupancy as
with cur as (
    select date_trunc('month', current_date)::date as month
)
select
    rc.g_name                                        as building,     -- 빌딩명(room_category.g_name)
    max((cur.month)::date)                            as month,        -- 기준월(현재월)
    count(distinct r.student_id)                      as students,     -- 재실 학생수
    count(*)                                          as reservations  -- 재실 예약수
from cur
join public.dorm_reservations r
  on r.check_in  <= (cur.month + interval '1 month - 1 day')::date
 and r.check_out >= cur.month
join public.dorm_rooms      dr on dr.room_id = r.room_id
join legacy.room_list       rl on rl.r_idx   = dr.r_idx
join legacy.room_category   rc on rc.g_idx   = rl.g_idx
group by rc.g_name;

comment on materialized view public.mv_building_occupancy is
  '빌딩(room_category.g_name) × 현재월 재실 학생수/예약수. dorm_rooms→room_list→room_category 경로. refresh 시점 기준월로 재계산.';

create unique index if not exists uq_mv_building_occupancy
    on public.mv_building_occupancy (building);


-- =============================================================================
-- 2) REFRESH 함수 — app.refresh_dashboard_mvs()
-- =============================================================================
--   REFRESH ... CONCURRENTLY 는 조회 잠금 없이 갱신(각 MV 의 UNIQUE 인덱스 필요,
--   위에서 생성). 단, 최초 1회는 CREATE MATERIALIZED VIEW ... (WITH DATA) 로 이미
--   채워져 있으므로 이후 CONCURRENTLY 가 정상 동작한다.
create schema if not exists app;

create or replace function app.refresh_dashboard_mvs()
returns void
language plpgsql
security definer
set search_path = public, legacy, app
as $$
begin
    refresh materialized view concurrently public.mv_occupancy_month;
    refresh materialized view concurrently public.mv_campus_population;
    refresh materialized view concurrently public.mv_building_occupancy;
end;
$$;

comment on function app.refresh_dashboard_mvs() is
  '대시보드 MV 3종을 CONCURRENTLY 로 갱신. 스케줄러(pg_cron 등) 또는 쓰기 후 호출.';

grant execute on function app.refresh_dashboard_mvs() to service_role;

-- =============================================================================
-- [운영 메모]
--   * 스케줄: pg_cron 사용 시 예)
--       select cron.schedule('refresh-dashboard-mvs', '*/15 * * * *',
--                             $$select app.refresh_dashboard_mvs();$$);
--   * mv_building_occupancy 는 "현재월" 스냅샷이라 월이 바뀌면 다음 refresh 에서
--     기준월이 자동 이동한다(월초 강제 refresh 권장).
--   * 읽기 권한: 대시보드 role 에 맞춰 grant select on <mv> to <role>; 를 별도 부여.
-- =============================================================================
