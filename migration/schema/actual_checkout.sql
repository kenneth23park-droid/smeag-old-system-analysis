-- ════════════════════════════════════════════════════════════════
-- 계획/실제 퇴실 이원화
--   정본(dorm_reservations)은 reserve_info 기반 "계획" 구간(check_in/check_out).
--   room_reserve(일자전개 실적)에서 ri_idx별 실제 재실 최소/최대일을 끌어와
--   actual_check_in / actual_check_out 을 채운다(스냅샷 미포함분은 NULL 유지).
--   실적일(actual_days)·조기퇴실일(early_checkout_days)은 생성컬럼으로 자동계산.
-- 전제: public.dorm_reservations, legacy.room_reserve 적재 완료.
-- 재실행 안전(idempotent): 컬럼 add if not exists, 값은 room_reserve로 재계산.
-- ════════════════════════════════════════════════════════════════
begin;

-- 1) 실적 컬럼 추가 (계획값 check_in/check_out 은 그대로 정본 유지)
alter table public.dorm_reservations
  add column if not exists actual_check_in  date,
  add column if not exists actual_check_out date;

-- 생성컬럼: 실적 재실일수, 조기퇴실일수(계획퇴실 - 실제퇴실; 양수=조기, 0=일치, 음수=연장)
alter table public.dorm_reservations
  drop column if exists actual_days,
  drop column if exists early_checkout_days;
alter table public.dorm_reservations
  add column actual_days integer
    generated always as
      (case when actual_check_out is not null and actual_check_in is not null
            then (actual_check_out - actual_check_in) + 1 end) stored,
  add column early_checkout_days integer
    generated always as
      (case when actual_check_out is not null
            then (check_out - actual_check_out) end) stored;

-- 2) room_reserve 실적 주입 (유효 날짜만; ri_idx 단위 min/max)
with rr as (
  select ri_idx,
         min(rr_date::date) as mn,
         max(rr_date::date) as mx
  from legacy.room_reserve
  where rr_date ~ '^\d{4}-\d{2}-\d{2}$'
  group by ri_idx
)
update public.dorm_reservations d
set actual_check_in  = rr.mn,
    actual_check_out = rr.mx
from rr
where rr.ri_idx = d.ri_idx
  and (d.actual_check_in is distinct from rr.mn
       or d.actual_check_out is distinct from rr.mx);

create index if not exists idx_res_actual_co on public.dorm_reservations(actual_check_out);

-- 3) 조기퇴실 조회용 뷰 (입실 동일 + 계획퇴실 > 실제퇴실 = 순수 조기퇴실)
create or replace view public.dorm_early_checkouts as
select d.id, d.ri_idx, st.s_idx, rm.r_idx,
       d.check_in, d.check_out       as planned_check_out,
       d.actual_check_out,
       d.span_days                   as planned_days,
       d.actual_days,
       d.early_checkout_days
from public.dorm_reservations d
join public.dorm_students st on st.student_id = d.student_id
join public.dorm_rooms    rm on rm.room_id    = d.room_id
where d.actual_check_out is not null
  and d.actual_check_in = d.check_in
  and d.early_checkout_days > 0;

commit;

-- 4) 요약(커밋 후 확인용):
--   select count(*) filter (where actual_check_out is not null) as 실적있음,
--          count(*) filter (where actual_check_out is null)     as 계획만,
--          count(*) filter (where early_checkout_days > 0)      as 조기퇴실,
--          count(*) filter (where early_checkout_days < 0)      as 연장,
--          count(*) filter (where early_checkout_days = 0)      as 계획일치
--   from public.dorm_reservations;
