-- ════════════════════════════════════════════════════════════════
-- 결정 A: 예약 "정본" = legacy.reserve_info (예약원장/구간모델)
--   reserve_info(ri_idx, s_idx, r_idx, s_date, e_date, ri_type) 를 정본으로
--   public.dorm_* 정규화 모델을 (재)구성. 문자열 날짜는 정제 후 date 캐스팅.
--   기존 dorm_* (room_reserve_old 파생, 79,870)는 dorm_*_prev 로 보존 후 교체.
-- 전제: Phase 1~2 에서 legacy.reserve_info / legacy.room_list / legacy.room_info 적재 완료.
-- 원본 MySQL 불변. 아래는 전부 Supabase 내부 작업.
-- ════════════════════════════════════════════════════════════════
begin;

-- 0) 기존 모델 보존(감사/롤백) — 존재할 때만. 재실행 안전(제약명 충돌 방지).
do $$
begin
  -- 이전 재실행 잔재(_prev) 정리
  if to_regclass('public.dorm_reservations_prev') is not null then
    execute 'drop table public.dorm_reservations_prev cascade';
  end if;
  if to_regclass('public.dorm_reservations') is not null then
    execute 'alter table public.dorm_reservations rename to dorm_reservations_prev';
    -- rename 시 딸려온 제약(uq_res_no_dup)이 새 테이블과 충돌하지 않도록 개명
    if exists (select 1 from pg_constraint
               where conname = 'uq_res_no_dup'
                 and conrelid = 'public.dorm_reservations_prev'::regclass) then
      execute 'alter table public.dorm_reservations_prev rename constraint uq_res_no_dup to uq_res_no_dup_prev';
    end if;
  end if;
end $$;

-- 재실행 안전: 어느 테이블에 남아있든 uq_res_no_dup 잔재를 먼저 제거(중복 인덱스명 충돌 방지)
do $$
declare r record;
begin
  for r in select conrelid::regclass as tbl from pg_constraint where conname = 'uq_res_no_dup' loop
    execute format('alter table %s drop constraint uq_res_no_dup', r.tbl);
  end loop;
end $$;

-- 1) 정본 스테이징: reserve_info 정제 (제로데이트/이상치 → null, 문자열 → date)
create temporary table _ri as
select
  ri_idx::bigint                                   as ri_idx,
  nullif(s_idx::text,'')::int                      as s_idx,
  nullif(r_idx::text,'')::int                      as r_idx,
  case when s_date ~ '^\d{4}-\d{2}-\d{2}$' then s_date::date end as check_in,
  case when e_date ~ '^\d{4}-\d{2}-\d{2}$' then e_date::date end as check_out,
  coalesce(ri_type,'L')                            as ri_type
from legacy.reserve_info;

-- 유효성: check_in/out 결측 또는 역전 행 격리(감사 테이블)
create table if not exists public.dorm_reservations_rejects (
  ri_idx bigint, s_idx int, r_idx int, check_in date, check_out date, reason text
);
insert into public.dorm_reservations_rejects
select ri_idx, s_idx, r_idx, check_in, check_out,
       case when check_in is null or check_out is null then 'null_date'
            when check_out < check_in then 'reversed' else 'unknown' end
from _ri
where check_in is null or check_out is null or check_out < check_in;

-- 2) 정규화 마스터 (이미 있으면 재사용; 없으면 생성)
create table if not exists public.dorm_buildings (
  building_id smallserial primary key, bldg_type char(1) unique not null, name text
);
insert into public.dorm_buildings (bldg_type, name) values
  ('E','E동'),('S','S동'),('C','C동'),('P','P동'),('X','미지정(NULL)')
on conflict (bldg_type) do nothing;

create table if not exists public.dorm_students (
  student_id bigserial primary key, s_idx integer unique not null
);
insert into public.dorm_students (s_idx)
select distinct s_idx from _ri where s_idx is not null
on conflict (s_idx) do nothing;

-- 객실: reserve_info.r_idx 기준 (건물 매핑은 legacy.room_list 있으면 보강)
create table if not exists public.dorm_rooms (
  room_id bigserial primary key,
  building_id smallint references public.dorm_buildings(building_id),
  r_idx integer not null,
  unique (building_id, r_idx)
);
-- r_idx 만 있는 경우 미지정(X) 건물로 우선 배치(후에 room_list 로 정밀 매핑)
insert into public.dorm_rooms (building_id, r_idx)
select distinct (select building_id from public.dorm_buildings where bldg_type='X'), r_idx
from _ri where r_idx is not null
on conflict (building_id, r_idx) do nothing;

-- 3) 예약(정본) 재구성
create table public.dorm_reservations (
  id          bigserial primary key,
  ri_idx      bigint unique,                 -- 원본 예약원장 키(추적성)
  room_id     bigint references public.dorm_rooms(room_id),
  student_id  bigint references public.dorm_students(student_id),
  ri_type     char(1),
  check_in    date not null,
  check_out   date not null,
  span_days   integer generated always as ((check_out - check_in) + 1) stored,
  created_at  timestamptz default now(),
  constraint uq_res_no_dup unique (room_id, student_id, check_in, check_out)
);
insert into public.dorm_reservations (ri_idx, room_id, student_id, ri_type, check_in, check_out)
select r.ri_idx, rm.room_id, st.student_id, r.ri_type, r.check_in, r.check_out
from _ri r
join public.dorm_rooms    rm on rm.r_idx = r.r_idx
join public.dorm_students st on st.s_idx = r.s_idx
where r.check_in is not null and r.check_out is not null and r.check_out >= r.check_in
on conflict do nothing;

create index if not exists idx_res_room_ci on public.dorm_reservations(room_id, check_in);
create index if not exists idx_res_student on public.dorm_reservations(student_id);
create index if not exists idx_res_ci_co   on public.dorm_reservations(check_in, check_out);

-- 4) 레거시 UI 호환뷰 재생성 (일자 전개)
drop view if exists public.room_reserve cascade;
drop view if exists public.room_reserve_2026 cascade;
drop view if exists public.room_reserve_compat cascade;
create view public.room_reserve_compat as
select r.id as rr_idx, rm.r_idx, r.ri_idx, d::date as rr_date, st.s_idx,
       case when r.ri_type='R' then 'R' else 'I' end as rr_type,
       nullif(b.bldg_type,'X') as bldg_type, r.created_at as "timestamp"
from public.dorm_reservations r
join public.dorm_rooms rm on rm.room_id=r.room_id
join public.dorm_buildings b on b.building_id=rm.building_id
join public.dorm_students st on st.student_id=r.student_id
cross join lateral generate_series(r.check_in::timestamp, r.check_out::timestamp, interval '1 day') d;
create view public.room_reserve      as select * from public.room_reserve_compat where extract(year from rr_date) < 2026;
create view public.room_reserve_2026 as select * from public.room_reserve_compat where extract(year from rr_date) >= 2026;

-- 5) 정합성 리포트 (커밋 전 확인용)
--   기존(_prev) vs 신규(reserve_info 정본) 예약 수 비교는 커밋 후 아래 쿼리로:
--   select (select count(*) from public.dorm_reservations_prev) prev,
--          (select count(*) from public.dorm_reservations) now_,
--          (select count(*) from public.dorm_reservations_rejects) rejected;

commit;
