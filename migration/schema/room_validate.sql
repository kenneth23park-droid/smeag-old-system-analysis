-- ============================================================================
-- 방 이동 검증 + 등록/확정/승인/취소/완료 RPC  (멱등 실행 가능)
-- ----------------------------------------------------------------------------
-- 기획: docs/기획_방이동관리_2026-08-06.md  §3(검증 엔진) · §4(API) · §11(결정 5)
-- 전제: migration/schema/room_moves.sql, room_facts.sql 적용 완료.
--
-- 판정은 세 갈래다(요청서 §14 + 결정 5).
--   blocks[]        승인해도 불가. 등록 자체를 거부한다.
--   warnings[]      예외 승인 대상. 등록(PLANNED)은 되지만 확정(CONFIRMED)에 Lv10+ 승인 필요.
--   info_required[] 정보 미확인(§13). 등록은 되지만 채우기 전에는 확정 불가.
--
-- 시간대: 세부 시각 판정(청소시간 등)은 현지시각 Asia/Manila 기준으로 날짜를 뽑는다.
--         서버 타임존에 따라 하루가 밀리면 배정 사고로 직결되므로 상수로 고정한다.
--
-- 원본 불가침: legacy/cms 스키마의 **데이터**는 읽기만 한다. 조회용 인덱스만 추가한다.
-- ============================================================================

create schema if not exists app;

-- 침대 단위 조회(app.v_legacy_bed_span 의 r_idx 필터)를 위한 인덱스.
-- 기존 idx_rr_date_ridx 는 선두가 날짜라 "이 침대의 전 구간"에는 쓰이지 않는다.
create index if not exists idx_rr_ridx_date on legacy.room_reserve (r_idx, rr_date);

-- ════════════════════════════════════════════════════════════════════════════
-- 0) app.assignment_terminations — 레거시 구간 "조기 종료" 오버레이
--    이동 완료 시 기존 방 배정을 끝내야 하지만 legacy.room_reserve 는 불가침이다.
--    그래서 "언제부로 끝났는지"를 여기 기록하고, 배치도는 레거시 구간의 끝을
--    이 값으로 잘라서 그린다(원본은 그대로 남아 감사 근거가 된다).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.assignment_terminations (
  id         bigserial primary key,
  ri_idx     bigint,                       -- legacy.reserve_info.ri_idx (예약단위)
  r_idx      integer not null,             -- 침대
  s_idx      integer not null,
  end_date   date    not null,             -- 이 날짜까지만 재실한 것으로 본다
  move_id    bigint  references app.room_moves(id),
  created_by text    not null default 'unknown',
  created_at timestamptz not null default now()
);
create unique index if not exists ux_assign_term_key
  on app.assignment_terminations (r_idx, s_idx, coalesce(ri_idx, -1));
create index if not exists ix_assign_term_bed on app.assignment_terminations (r_idx);
alter table app.assignment_terminations enable row level security;

comment on table app.assignment_terminations is '이동 완료로 조기 종료된 레거시 재실구간 — 원본 room_reserve 는 건드리지 않고 화면에서 잘라 그린다';

-- ════════════════════════════════════════════════════════════════════════════
-- 1) 침대 컨텍스트 — 침대 하나의 방/그룹/정원/성별규칙
-- ════════════════════════════════════════════════════════════════════════════
create or replace view app.v_bed as
select rl.r_idx, rl.r_num, rl.r_state,
       ri.i_idx, ri.i_name as room_no, ri.i_limit, ri.i_state,
       rc.g_idx, rc.g_name as group_name, coalesce(rc.g_type,'C') as g_type,
       rc.bldg_type, rc.g_display,
       'BX|' || upper(coalesce(rc.g_name,'')) || '|' || upper(coalesce(ri.i_name,'')) as room_key
  from legacy.room_list rl
  join legacy.room_info ri on ri.i_idx = rl.i_idx
  left join legacy.room_category rc on rc.g_idx = ri.g_idx;

comment on view app.v_bed is '침대 → 방 → 그룹 평면화. room_key 는 app.room_blocks 와 같은 화면 키 규약';

-- ════════════════════════════════════════════════════════════════════════════
-- 2) app.room_move_validate — 단일 진입점 검증
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_validate(
  p_s_idx              integer,
  p_to_r_idx           integer,
  p_planned_at         timestamptz,
  p_end_date           date    default null,
  p_ignore_assignment  bigint  default null,
  p_ignore_move        bigint  default null
) returns jsonb
language plpgsql stable security definer set search_path = app, public as $$
declare
  TZ        constant text := 'Asia/Manila';
  v_bed     record;
  v_stu     record;
  v_start   date;
  v_end     date;
  v_blocks  jsonb := '[]'::jsonb;
  v_warns   jsonb := '[]'::jsonb;
  v_info    jsonb := '[]'::jsonb;
  v_occ     record;
  v_cur     record;
  v_min_gap integer;
  v_gap_min numeric;
  v_prev_out timestamptz;
  v_cnt     integer;
  v_occupants jsonb := '[]'::jsonb;
begin
  -- ── 대상 침대 ──────────────────────────────────────────────────────────
  select * into v_bed from app.v_bed where r_idx = p_to_r_idx;
  if not found then
    return jsonb_build_object('ok', false,
      'blocks', jsonb_build_array(jsonb_build_object('code','BED_NOT_FOUND','message','대상 침대를 찾을 수 없습니다.')),
      'warnings','[]'::jsonb, 'info_required','[]'::jsonb);
  end if;
  if v_bed.r_state <> 'Y' or v_bed.i_state <> 'Y' then
    v_blocks := v_blocks || jsonb_build_object('code','BED_INACTIVE',
      'message', format('사용하지 않는 방/침대입니다 (%s %s).', v_bed.group_name, v_bed.room_no));
  end if;

  -- ── 학생 ───────────────────────────────────────────────────────────────
  select * into v_stu from app.v_student_stay where s_idx = p_s_idx;
  if not found then
    return jsonb_build_object('ok', false,
      'blocks', jsonb_build_array(jsonb_build_object('code','STUDENT_NOT_FOUND','message','학생을 찾을 수 없습니다.')),
      'warnings','[]'::jsonb, 'info_required','[]'::jsonb);
  end if;

  -- ── 기간 확정 ──────────────────────────────────────────────────────────
  v_start := (p_planned_at at time zone TZ)::date;
  v_end   := coalesce(p_end_date, v_stu.checkout_date);
  if v_end is null then
    v_info := v_info || jsonb_build_object('code','CHECKOUT_DATE',
      'message', format('%s 학생의 퇴실일이 확인되지 않았습니다.', v_stu.name));
    v_end := v_start;                       -- 최소 구간으로 두고 확정은 막는다
  elsif v_end < v_start then
    v_blocks := v_blocks || jsonb_build_object('code','BAD_RANGE',
      'message', format('퇴실일(%s)이 이동 예정일(%s)보다 빠릅니다.', v_end, v_start));
    v_end := v_start;
  end if;

  -- ── 현재 배정(출발지) ──────────────────────────────────────────────────
  select * into v_cur from app.student_current_bed(p_s_idx, v_start);
  if v_cur.r_idx is not null and v_cur.r_idx = p_to_r_idx then
    v_blocks := v_blocks || jsonb_build_object('code','SAME_BED',
      'message','이미 그 침대를 사용 중입니다. 이동할 필요가 없습니다.');
  end if;

  -- ── V5(부분) 운영상 차단: app.room_blocks 활성 블록과 겹치는가 ──────────
  select count(*) into v_cnt
    from app.room_blocks b
   where b.released_at is null
     and b.room_key = v_bed.room_key
     and b.bed_no in (0, v_bed.r_num)
     and (b.from_date is null or b.to_date is null
          or (b.from_date <= v_end and b.to_date >= v_start));
  if v_cnt > 0 then
    v_blocks := v_blocks || jsonb_build_object('code','BED_BLOCKED',
      'message', format('%s %s 는 방막기(차단) 상태입니다. 먼저 해제해야 합니다.', v_bed.group_name, v_bed.room_no));
  end if;

  -- ── V1 기존 입실자(레거시 정본) ─────────────────────────────────────────
  for v_occ in
    select b.s_idx, b.ri_idx, b.start_date, b.end_date,
           least(b.end_date, coalesce(t.end_date, b.end_date))       as eff_end,
           coalesce(f.actual_checkout_date, t.end_date)              as confirmed_end,
           coalesce(nullif(si.e_name,''), si.k_name, '')             as name,
           f.checkout_time
      from app.v_legacy_bed_span b
      left join app.assignment_terminations t on t.r_idx = b.r_idx and t.s_idx = b.s_idx
                                             and coalesce(t.ri_idx, -1) = coalesce(b.ri_idx, -1)
      left join app.student_stay_facts f on f.s_idx = b.s_idx
      left join legacy.student_info si on si.s_idx = b.s_idx
     where b.r_idx = p_to_r_idx
       and b.s_idx is distinct from p_s_idx
       and b.start_date <= v_end
       and least(b.end_date, coalesce(t.end_date, b.end_date)) >= v_start
  loop
    v_occupants := v_occupants || jsonb_build_object(
      's_idx', v_occ.s_idx, 'name', v_occ.name,
      'start_date', v_occ.start_date, 'end_date', v_occ.eff_end,
      'checkout_confirmed', v_occ.confirmed_end is not null,
      'checkout_time', v_occ.checkout_time);

    if v_occ.eff_end >= v_start then
      v_blocks := v_blocks || jsonb_build_object('code','OCCUPANT_NOT_LEFT',
        'message', format('%s 학생이 %s 까지 재실합니다. 이동 예정일(%s) 이전에 퇴실해야 합니다.',
                          coalesce(nullif(v_occ.name,''),'기존'), v_occ.eff_end, v_start),
        'detail', jsonb_build_object('s_idx', v_occ.s_idx, 'end_date', v_occ.eff_end));
    end if;
    if v_occ.confirmed_end is null then
      v_info := v_info || jsonb_build_object('code','OCCUPANT_CHECKOUT',
        'message', format('기존 학생 %s 의 실제 퇴실일이 확인되지 않았습니다.', coalesce(nullif(v_occ.name,''),'(이름없음)')),
        'detail', jsonb_build_object('s_idx', v_occ.s_idx));
    end if;
  end loop;

  -- ── V6 청소 시간(경고) — 직전 퇴실 → 이동 시각 사이 간격 ────────────────
  v_min_gap := app.min_cleaning_minutes(v_bed.i_idx, v_bed.g_idx);
  select max((b.end_date + coalesce(f.checkout_time, time '12:00')) at time zone TZ)
    into v_prev_out
    from app.v_legacy_bed_span b
    left join app.assignment_terminations t on t.r_idx = b.r_idx and t.s_idx = b.s_idx
                                           and coalesce(t.ri_idx,-1) = coalesce(b.ri_idx,-1)
    left join app.student_stay_facts f on f.s_idx = b.s_idx
   where b.r_idx = p_to_r_idx
     and b.s_idx is distinct from p_s_idx
     and least(b.end_date, coalesce(t.end_date, b.end_date)) < v_start;
  if v_prev_out is not null then
    v_gap_min := extract(epoch from (p_planned_at - v_prev_out)) / 60.0;
    if v_gap_min >= 0 and v_gap_min < v_min_gap then
      v_warns := v_warns || jsonb_build_object('code','CLEANING_SHORT',
        'message', format('직전 퇴실 후 %s분만에 입실합니다 (최소 청소시간 %s분).',
                          round(v_gap_min), v_min_gap));
    end if;
  end if;

  -- ── V2 미래 배정 겹침 ───────────────────────────────────────────────────
  for v_occ in
    select a.id, a.s_idx, a.status, a.start_date, a.end_date,
           coalesce(nullif(si.e_name,''), si.k_name, '') as name
      from app.room_assignments a
      left join legacy.student_info si on si.s_idx = a.s_idx
     where a.r_idx = p_to_r_idx
       and a.status in ('PENDING','CONFIRMED','ACTIVE')
       and a.s_idx is distinct from p_s_idx
       and (p_ignore_assignment is null or a.id <> p_ignore_assignment)
       and a.period && daterange(v_start, v_end, '[]')
  loop
    if v_occ.status in ('CONFIRMED','ACTIVE') then
      v_blocks := v_blocks || jsonb_build_object('code','ASSIGNMENT_OVERLAP',
        'message', format('%s 학생의 확정 배정(%s~%s)과 기간이 겹칩니다.',
                          coalesce(nullif(v_occ.name,''),'다른'), v_occ.start_date, v_occ.end_date),
        'detail', jsonb_build_object('assignment_id', v_occ.id, 's_idx', v_occ.s_idx));
    else
      v_warns := v_warns || jsonb_build_object('code','PENDING_ASSIGNMENT_OVERLAP',
        'message', format('%s 학생의 미확정 배정(%s~%s)과 기간이 겹칩니다.',
                          coalesce(nullif(v_occ.name,''),'다른'), v_occ.start_date, v_occ.end_date),
        'detail', jsonb_build_object('assignment_id', v_occ.id, 's_idx', v_occ.s_idx));
    end if;
  end loop;

  -- ── V4 성별 ─────────────────────────────────────────────────────────────
  if v_stu.gender_raw is null or v_stu.gender_raw not in ('M','F') then
    v_info := v_info || jsonb_build_object('code','GENDER',
      'message', format('%s 학생의 성별이 확인되지 않았습니다.', v_stu.name));
  elsif v_bed.g_type in ('M','F') and v_bed.g_type <> v_stu.gender_raw then
    v_blocks := v_blocks || jsonb_build_object('code','GENDER_RULE',
      'message', format('%s 는 %s 전용 구역입니다 (학생 성별 %s).',
                        v_bed.group_name, case v_bed.g_type when 'M' then '남자' else '여자' end,
                        case v_stu.gender_raw when 'M' then '남자' else '여자' end));
  else
    -- 같은 방(다른 침대) 재실자 중 다른 성별이 기간에 겹치는가
    select count(*) into v_cnt
      from app.v_legacy_bed_span b
      join app.v_bed vb on vb.r_idx = b.r_idx
      left join app.assignment_terminations t on t.r_idx = b.r_idx and t.s_idx = b.s_idx
                                             and coalesce(t.ri_idx,-1) = coalesce(b.ri_idx,-1)
      join legacy.student_info si on si.s_idx = b.s_idx
     where vb.i_idx = v_bed.i_idx
       and b.s_idx is distinct from p_s_idx
       and si.s_gender in ('M','F')
       and si.s_gender <> v_stu.gender_raw
       and b.start_date <= v_end
       and least(b.end_date, coalesce(t.end_date, b.end_date)) >= v_start;
    if v_cnt > 0 then
      if v_bed.g_type = 'C' then
        -- 가족실: 관계 정보(app.family_groups)는 2차. 지금은 넘길 수 있는 경고로 둔다.
        v_warns := v_warns || jsonb_build_object('code','FAMILY_ROOM_MIXED',
          'message', format('가족실 %s 에 다른 성별 %s명이 같은 기간에 있습니다. 가족 관계를 확인하세요.',
                            v_bed.room_no, v_cnt));
      else
        v_blocks := v_blocks || jsonb_build_object('code','GENDER_RULE',
          'message', format('%s 방에 다른 성별 %s명이 같은 기간에 재실합니다.', v_bed.room_no, v_cnt));
      end if;
    end if;
  end if;

  -- ── V7 룸타입 ───────────────────────────────────────────────────────────
  if v_stu.requested_room_type is null then
    v_info := v_info || jsonb_build_object('code','ROOM_TYPE',
      'message', format('%s 학생의 신청 룸타입이 확인되지 않았습니다.', v_stu.name));
  elsif v_stu.requested_room_type <> coalesce(v_bed.i_limit, 0) then
    v_warns := v_warns || jsonb_build_object('code','ROOM_TYPE_MISMATCH',
      'message', format('신청 %s인실 ≠ 배정 %s인실 (%s).',
                        v_stu.requested_room_type, v_bed.i_limit, v_bed.room_no));
  end if;

  -- ── V10 같은 학생의 다른 미완료 이동 ────────────────────────────────────
  select count(*) into v_cnt
    from app.room_moves m
   where m.s_idx = p_s_idx
     and m.move_status in ('REVIEW','PLANNED','CONFIRMED')
     and (p_ignore_move is null or m.id <> p_ignore_move);
  if v_cnt > 0 then
    v_warns := v_warns || jsonb_build_object('code','DUPLICATE_FUTURE',
      'message', format('이 학생에게 아직 완료되지 않은 이동이 %s건 더 있습니다.', v_cnt));
  end if;

  -- ── V3 신규 입실 예정자 도착시각(정보) ──────────────────────────────────
  if v_stu.arrival_at is null and v_cur.r_idx is null then
    v_info := v_info || jsonb_build_object('code','ARRIVAL_TIME',
      'message', format('%s 학생의 도착 예정 시각이 확인되지 않았습니다.', v_stu.name));
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_blocks) = 0,
    'blocks', v_blocks,
    'warnings', v_warns,
    'info_required', v_info,
    'confirmable', jsonb_array_length(v_blocks) = 0 and jsonb_array_length(v_info) = 0,
    'info', jsonb_build_object(
      'student', jsonb_build_object('s_idx', p_s_idx, 'name', v_stu.name,
                                    'gender', v_stu.gender_raw, 'nation', v_stu.s_nation,
                                    'checkout_date', v_stu.checkout_date,
                                    'requested_room_type', v_stu.requested_room_type),
      'from', case when v_cur.r_idx is null then null else
              jsonb_build_object('r_idx', v_cur.r_idx, 'label', v_cur.label,
                                 'source', v_cur.source, 'end_date', v_cur.end_date) end,
      'to',   jsonb_build_object('r_idx', v_bed.r_idx, 'bed_no', v_bed.r_num,
                                 'room_no', v_bed.room_no, 'group', v_bed.group_name,
                                 'i_limit', v_bed.i_limit, 'g_type', v_bed.g_type),
      'period', jsonb_build_object('start_date', v_start, 'end_date', v_end),
      'min_cleaning_minutes', v_min_gap,
      'occupants', v_occupants));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3) 학생의 현재 배정 침대 — 신전산 배정(ACTIVE) 우선, 없으면 레거시 정본
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.student_current_bed(p_s_idx integer, p_asof date default null)
returns table (r_idx integer, label text, source text, start_date date, end_date date)
language sql stable security definer set search_path = app, public as $$
  with asof as (select coalesce(p_asof, (now() at time zone 'Asia/Manila')::date) d)
  select x.r_idx, x.label, x.source, x.start_date, x.end_date
  from (
    -- ① 신전산에서 이동 완료된 배정(ACTIVE)
    select a.r_idx,
           b.group_name || ' / ' || b.room_no || ' / Bed ' || b.r_num as label,
           'app'::text as source, a.start_date, a.end_date, 1 as pri
      from app.room_assignments a
      join app.v_bed b on b.r_idx = a.r_idx, asof
     where a.s_idx = p_s_idx and a.status = 'ACTIVE'
       and a.start_date <= asof.d and a.end_date >= asof.d
    union all
    -- ② 레거시 정본(조기종료 오버레이 반영)
    select s.r_idx,
           b.group_name || ' / ' || b.room_no || ' / Bed ' || b.r_num as label,
           'legacy'::text, s.start_date,
           least(s.end_date, coalesce(t.end_date, s.end_date)),
           2
      from app.v_legacy_bed_span s
      join app.v_bed b on b.r_idx = s.r_idx
      left join app.assignment_terminations t on t.r_idx = s.r_idx and t.s_idx = s.s_idx
                                             and coalesce(t.ri_idx,-1) = coalesce(s.ri_idx,-1), asof
     where s.s_idx = p_s_idx
       and s.start_date <= asof.d
       and least(s.end_date, coalesce(t.end_date, s.end_date)) >= asof.d
  ) x
  order by x.pri, x.end_date desc
  limit 1;
$$;

revoke all on function app.room_move_validate(integer,integer,timestamptz,date,bigint,bigint) from public, anon, authenticated;
revoke all on function app.student_current_bed(integer,date) from public, anon, authenticated;
