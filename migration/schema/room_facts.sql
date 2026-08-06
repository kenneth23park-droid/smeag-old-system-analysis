-- ============================================================================
-- app.student_stay_facts — 학생 체류 확정정보(신전산 전용 입력칸)
-- app.room_settings      — 운영 설정(최소 청소시간 등)
--   (멱등 실행 가능)
-- ----------------------------------------------------------------------------
-- 기획: docs/기획_방이동관리_2026-08-06.md  §11 결정 1 / 결정 4
--
-- 배경: 방 이동 판단에 꼭 필요한 값들이 레거시에 **정형 필드로 없다**.
--   · 졸업일        → 없음 (s_edate 는 수업 종료일이라 실제 퇴실과 다를 수 있다)
--   · 실제 퇴실일   → room_reserve 마지막 날짜로 추정만 가능
--   · 퇴실/도착 시각 → 없음. s_flight 는 자유 텍스트('PR 488 8/9 06:20 arrival' 같은 문장)
--   자유 텍스트 파싱에 기대면 오판이 배정 사고로 직결되므로, 담당자가 직접 확정값을
--   적는 칸을 신전산에 만든다. 레거시 student_info 는 건드리지 않는다.
--
-- 읽기 우선순위(RPC·화면 공통):
--   app.student_stay_facts  →  public.dorm_reservations(실적)  →  legacy.student_info(계획)
--   ※ 요청서 §20-12 "졸업일과 실제 퇴실일이 다르면 실제 퇴실일 우선" 이 이 순서로 성립한다.
--
-- 원본 불가침: legacy/cms 스키마 무수정. app 스키마 전용.
-- ============================================================================

create schema if not exists app;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) app.student_stay_facts
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.student_stay_facts (
  s_idx                integer primary key,          -- legacy.student_info.s_idx
  graduation_date      date,                         -- 졸업일
  actual_checkout_date date,                         -- 실제 퇴실일(졸업일과 다를 수 있다)
  checkout_time        time,                         -- 예상 퇴실 시각
  arrival_at           timestamptz,                  -- 도착 예정 일시(신규 입실자)
  pickup_confirmed     boolean not null default false,
  gender_confirmed     boolean not null default false,
  requested_room_type  smallint,                     -- 신청/승인 룸타입(인실). NULL=미확인
  note                 text,                         -- 예: 'Julie 에게 기존 학생 퇴실일 확인 필요'
  updated_by           text    not null default 'unknown',
  updated_at           timestamptz not null default now(),
  constraint stay_facts_roomtype_ck check (requested_room_type is null or requested_room_type between 1 and 12)
);

comment on table  app.student_stay_facts is '학생 체류 확정정보 — 레거시에 정형 필드가 없는 졸업일/실제퇴실일/시각을 담당자가 확정 입력';
comment on column app.student_stay_facts.actual_checkout_date is '실제 퇴실일. 졸업일과 다르면 이 값이 배정 판단의 기준이다(요청서 §20-12)';

create index if not exists ix_stay_facts_checkout on app.student_stay_facts (actual_checkout_date);
alter table app.student_stay_facts enable row level security;

-- ── 병합 저장(멱등) ─────────────────────────────────────────────────────────
-- p_patch 의 키만 반영한다(없는 키는 기존값 유지). 화면에서 결측 칸만 채울 수 있게.
create or replace function app.stay_facts_set(
  p_s_idx integer,
  p_patch jsonb,
  p_by    text default 'unknown'
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  v_row app.student_stay_facts;
begin
  if p_s_idx is null or p_s_idx <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_student');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_patch');
  end if;

  insert into app.student_stay_facts (s_idx, updated_by, updated_at)
  values (p_s_idx, coalesce(nullif(p_by,''),'unknown'), now())
  on conflict (s_idx) do nothing;

  update app.student_stay_facts f set
    graduation_date      = case when p_patch ? 'graduation_date'
                                then nullif(p_patch->>'graduation_date','')::date else f.graduation_date end,
    actual_checkout_date = case when p_patch ? 'actual_checkout_date'
                                then nullif(p_patch->>'actual_checkout_date','')::date else f.actual_checkout_date end,
    checkout_time        = case when p_patch ? 'checkout_time'
                                then nullif(p_patch->>'checkout_time','')::time else f.checkout_time end,
    arrival_at           = case when p_patch ? 'arrival_at'
                                then nullif(p_patch->>'arrival_at','')::timestamptz else f.arrival_at end,
    pickup_confirmed     = case when p_patch ? 'pickup_confirmed'
                                then coalesce((p_patch->>'pickup_confirmed')::boolean,false) else f.pickup_confirmed end,
    gender_confirmed     = case when p_patch ? 'gender_confirmed'
                                then coalesce((p_patch->>'gender_confirmed')::boolean,false) else f.gender_confirmed end,
    requested_room_type  = case when p_patch ? 'requested_room_type'
                                then nullif(p_patch->>'requested_room_type','')::smallint else f.requested_room_type end,
    note                 = case when p_patch ? 'note'
                                then nullif(p_patch->>'note','') else f.note end,
    updated_by = coalesce(nullif(p_by,''),'unknown'),
    updated_at = now()
  where f.s_idx = p_s_idx
  returning * into v_row;

  return jsonb_build_object('ok', true, 'facts', to_jsonb(v_row));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'bad_value', 'message', left(sqlerrm, 200));
end;
$$;

-- ── 유효 체류정보(우선순위 병합) ─────────────────────────────────────────────
-- 화면·검증 RPC 가 공통으로 쓰는 단일 진실. 어떤 칸이 비었는지(missing) 도 함께 준다.
create or replace view app.v_student_stay as
select
  st.s_idx,
  coalesce(nullif(st.e_name,''), st.k_name, '')            as name,
  nullif(st.s_gender,'')                                    as gender_raw,
  st.s_nation,
  f.graduation_date,
  -- 실제 퇴실일: 담당자 확정값 > 실적(dorm_reservations) > 레거시 계획(s_edate)
  coalesce(f.actual_checkout_date, d.actual_check_out,
           case when st.s_edate ~ '^\d{4}-\d{2}-\d{2}$' then st.s_edate::date end) as checkout_date,
  f.actual_checkout_date is not null                        as checkout_confirmed,
  f.checkout_time,
  f.arrival_at,
  f.pickup_confirmed,
  coalesce(f.gender_confirmed, false)                       as gender_confirmed,
  f.requested_room_type,
  f.note                                                    as facts_note,
  st.s_flight                                               as pickup_text
from legacy.student_info st
left join app.student_stay_facts f on f.s_idx = st.s_idx
-- 실적 퇴실일은 예약원장(reserve_info.s_idx 인덱스)으로 바로 찾는다.
-- v_legacy_bed_span 을 경유하면 학생 1명마다 room_reserve 전체를 group by 하게 되어 못 쓴다.
left join lateral (
  select max(dr.actual_check_out) as actual_check_out
    from legacy.reserve_info ri
    join public.dorm_reservations dr on dr.ri_idx = ri.ri_idx
   where ri.s_idx = st.s_idx
) d on true;

comment on view app.v_student_stay is '학생 체류 유효값 — stay_facts > dorm_reservations 실적 > legacy 계획 순으로 병합';

-- ════════════════════════════════════════════════════════════════════════════
-- 2) app.room_settings — 운영 설정(키-값)
--   결정 4: 최소 청소시간 기본 60분, 관리자가 변경 가능.
--   조회는 "가장 구체적인 값 우선" — 방(i_idx) > 그룹(g_idx) > 전역.
--   1차에서는 전역값만 화면에 노출하고, 방/그룹 오버라이드는 스키마만 준비한다.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.room_settings (
  key        text        not null,
  scope      text        not null default 'GLOBAL',   -- GLOBAL / GROUP / ROOM
  scope_id   integer     not null default 0,          -- GROUP=g_idx, ROOM=i_idx, GLOBAL=0
  value      text        not null,
  updated_by text        not null default 'unknown',
  updated_at timestamptz not null default now(),
  primary key (key, scope, scope_id),
  constraint room_settings_scope_ck check (scope in ('GLOBAL','GROUP','ROOM'))
);
alter table app.room_settings enable row level security;

insert into app.room_settings (key, scope, scope_id, value, updated_by)
values ('min_cleaning_minutes', 'GLOBAL', 0, '60', 'seed')
on conflict (key, scope, scope_id) do nothing;

-- 최소 청소시간(분) 조회 — 방 → 그룹 → 전역 순
create or replace function app.min_cleaning_minutes(p_i_idx integer default null, p_g_idx integer default null)
returns integer
language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select value::int from app.room_settings where key='min_cleaning_minutes' and scope='ROOM'  and scope_id = p_i_idx),
    (select value::int from app.room_settings where key='min_cleaning_minutes' and scope='GROUP' and scope_id = p_g_idx),
    (select value::int from app.room_settings where key='min_cleaning_minutes' and scope='GLOBAL' and scope_id = 0),
    60);
$$;

revoke all on function app.stay_facts_set(integer,jsonb,text) from public, anon, authenticated;
revoke all on function app.min_cleaning_minutes(integer,integer) from public, anon, authenticated;
