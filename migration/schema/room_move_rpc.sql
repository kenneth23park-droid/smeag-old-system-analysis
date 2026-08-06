-- ============================================================================
-- 방 이동 등록/확정/승인/반려/취소/완료 RPC + 목록·타임라인  (멱등 실행 가능)
-- ----------------------------------------------------------------------------
-- 기획: docs/기획_방이동관리_2026-08-06.md  §4(API 처리 원칙) · §11(결정 5)
-- 전제: room_moves.sql · room_facts.sql · room_validate.sql 적용 완료.
--
-- 트랜잭션: PL/pgSQL 함수 1개 = 1 트랜잭션이다. 이동 완료 중 어느 단계가 실패하면
--           함수 전체가 롤백된다(요청서 §20-13). 별도 트랜잭션 제어 코드가 필요 없다.
--
-- 권한: 등록/확정/취소/완료 = Lv8+ (호출측 /api/moves 가 세션으로 강제)
--       예외 승인/반려      = Lv10+ (여기서도 p_level 로 재검증한다 — 결정 5)
--
-- 원본 불가침: legacy/cms 데이터는 읽기만. 기존 방 배정의 "종료"는 원본을 자르는 대신
--              app.assignment_terminations 오버레이에 기록한다.
-- ============================================================================

create schema if not exists app;

-- 예외 승인에 필요한 최소 레벨(결정 5, 2026-08-06)
create or replace function app.room_move_approver_level() returns integer
language sql immutable as $$ select 10 $$;

-- 내부: 이벤트 기록
create or replace function app.room_move_log(
  p_move_id bigint, p_s_idx integer, p_event text, p_actor text, p_detail jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = app, public as $$
  insert into app.room_move_events(move_id, s_idx, event, actor, detail)
  values (p_move_id, p_s_idx, p_event, coalesce(nullif(p_actor,''),'unknown'), coalesce(p_detail,'{}'::jsonb));
$$;

-- 내부: 이동 1건을 화면용 JSON 으로
create or replace function app.room_move_json(p_move_id bigint)
returns jsonb
language sql stable security definer set search_path = app, public as $$
  select to_jsonb(v) from app.v_room_moves v where v.id = p_move_id;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) 등록 — POST /room-moves
--    처리: 검증 → 미래 배정 생성 → 이동 예정 저장 (한 트랜잭션)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_create(
  p       jsonb,
  p_by    text    default 'unknown',
  p_level integer default 0,
  p_idem  text    default null
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  TZ constant text := 'Asia/Manila';
  v_s_idx    integer := nullif(p->>'s_idx','')::integer;
  v_to       integer := nullif(p->>'to_r_idx','')::integer;
  v_at       timestamptz := nullif(p->>'planned_move_at','')::timestamptz;
  v_end      date    := nullif(p->>'end_date','')::date;
  v_val      jsonb;
  v_flags    jsonb;
  v_cur      record;
  v_bed      record;
  v_start    date;
  v_endeff   date;
  v_assign   bigint;
  v_move     bigint;
  v_status   text;
  v_exreason text := nullif(btrim(coalesce(p->>'exception_reason','')), '');
  v_existing bigint;
begin
  if p_level < 8 then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', '이동 등록 권한이 없습니다.');
  end if;
  if v_s_idx is null or v_to is null or v_at is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request',
                              'message', '학생·대상 침대·이동 예정일시는 필수입니다.');
  end if;

  -- 화면에서 결측 칸(퇴실일·성별·룸타입 등)을 함께 채워 보낼 수 있게 한다.
  -- 왕복을 줄이려는 편의가 아니라, "확인해야 확정된다"(§13)를 등록 흐름 안에서 끝내기 위한 것.
  if p ? 'facts' and jsonb_typeof(p->'facts') = 'object' then
    perform app.stay_facts_set(v_s_idx, p->'facts', p_by);
  end if;

  -- 멱등: 같은 요청(더블서밋/재전송)이면 최초 결과를 그대로 재생한다.
  if p_idem is not null then
    select id into v_existing from app.room_moves where idem_key = p_idem;
    if v_existing is not null then
      return jsonb_build_object('ok', true, 'replayed', true, 'move', app.room_move_json(v_existing));
    end if;
  end if;

  v_val := app.room_move_validate(v_s_idx, v_to, v_at, v_end);
  if (v_val->>'ok')::boolean is not true then
    -- v_val 을 앞에 둔다: 뒤에 오는 객체가 이긴다. 순서를 바꾸면 v_val.ok(true)가
    -- 우리가 방금 세운 ok=false 를 덮어써 "거부했는데 성공"이 나간다.
    return v_val || jsonb_build_object('ok', false, 'error', 'blocked');
  end if;

  -- 경고가 있으면 사유를 반드시 받는다(예외 승인 대상이 된다 — 결정 5)
  v_flags := coalesce((select jsonb_agg(w->>'code') from jsonb_array_elements(v_val->'warnings') w), '[]'::jsonb);
  if jsonb_array_length(v_flags) > 0 and v_exreason is null then
    return v_val || jsonb_build_object('ok', false, 'error', 'need_exception_reason',
                              'message', '경고를 넘기려면 예외 사유를 입력해야 합니다.');
  end if;

  select * into v_bed from app.v_bed where r_idx = v_to;
  select * into v_cur from app.student_current_bed(v_s_idx, (v_at at time zone TZ)::date);
  v_start  := (v_val->'info'->'period'->>'start_date')::date;
  v_endeff := (v_val->'info'->'period'->>'end_date')::date;

  -- 미래 배정(오버레이) — 아직 PENDING. 확정 시점에 CONFIRMED 로 올려 EXCLUDE 를 태운다.
  insert into app.room_assignments(
    s_idx, r_idx, i_idx, g_idx, assignment_type, start_date, end_date, start_at,
    status, room_type_at_assignment, gender_rule, note, created_by, idem_key)
  values (v_s_idx, v_to, v_bed.i_idx, v_bed.g_idx,
          case when v_bed.g_type = 'C' then 'FAMILY' else 'FUTURE' end,
          v_start, v_endeff, v_at,
          'PENDING', v_bed.i_limit, v_bed.g_type, nullif(p->>'note',''),
          coalesce(nullif(p_by,''),'unknown'),
          case when p_idem is null then null else p_idem || '#a' end)
  returning id into v_assign;

  -- 정보 미확인이 남아 있으면 '검토 필요', 아니면 '이동 예정'
  v_status := case when jsonb_array_length(v_val->'info_required') > 0 then 'REVIEW' else 'PLANNED' end;

  insert into app.room_moves(
    s_idx, from_r_idx, from_label, to_r_idx, to_label, to_assignment_id,
    planned_move_at, move_reason, move_status, priority, depends_on_move_id,
    vehicle, staff, note, exception_flags, exception_reason, created_by, idem_key)
  values (v_s_idx, v_cur.r_idx, v_cur.label, v_to,
          v_bed.group_name || ' / ' || v_bed.room_no || ' / Bed ' || v_bed.r_num,
          v_assign, v_at, nullif(p->>'move_reason',''), v_status,
          coalesce(nullif(p->>'priority','')::smallint, 100),
          nullif(p->>'depends_on_move_id','')::bigint,
          nullif(p->>'vehicle',''), nullif(p->>'staff',''), nullif(p->>'note',''),
          v_flags, v_exreason, coalesce(nullif(p_by,''),'unknown'), p_idem)
  returning id into v_move;

  update app.room_assignments set source_move_id = v_move where id = v_assign;
  perform app.room_move_log(v_move, v_s_idx, 'CREATE', p_by,
    jsonb_build_object('assignment_id', v_assign, 'status', v_status,
                       'warnings', v_val->'warnings', 'info_required', v_val->'info_required'));

  return v_val || jsonb_build_object('ok', true, 'move_id', v_move, 'assignment_id', v_assign,
                            'move', app.room_move_json(v_move));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2) 확정 — REVIEW/PLANNED → CONFIRMED
--    여기서 배정이 CONFIRMED 로 올라가며 EXCLUDE 제약이 실제로 겹침을 막는다.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_confirm(
  p_move_id bigint, p_by text default 'unknown', p_level integer default 0
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  v_m   app.room_moves;
  v_val jsonb;
  v_end date;
begin
  if p_level < 8 then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_m from app.room_moves where id = p_move_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_m.move_status not in ('REVIEW','PLANNED') then
    return jsonb_build_object('ok', false, 'error', 'bad_state',
                              'message', format('현재 상태(%s)에서는 확정할 수 없습니다.', v_m.move_status));
  end if;

  -- 등록 때 굳어진 배정 구간으로 재검증한다. 여기서 다시 퇴실일을 유추하면
  -- 저장된 배정과 다른 기간을 검사하게 되어 "검증은 통과했는데 겹친다"가 생긴다.
  select a.end_date into v_end from app.room_assignments a where a.id = v_m.to_assignment_id;
  v_val := app.room_move_validate(v_m.s_idx, v_m.to_r_idx, v_m.planned_move_at,
                                  v_end, v_m.to_assignment_id, v_m.id);
  if (v_val->>'ok')::boolean is not true then
    return v_val || jsonb_build_object('ok', false, 'error', 'blocked');
  end if;
  if jsonb_array_length(v_val->'info_required') > 0 then
    return v_val || jsonb_build_object('ok', false, 'error', 'info_required',
                              'message', '확인이 필요한 정보가 남아 있어 확정할 수 없습니다.');
  end if;
  -- 결정 5: 예외가 걸린 이동은 Lv10+ 승인 없이는 확정 불가
  if jsonb_array_length(v_m.exception_flags) > 0 and v_m.exception_approved_at is null then
    return v_val || jsonb_build_object('ok', false, 'error', 'need_approval',
      'message', format('예외 승인이 필요합니다 (Lv%s 이상). 승인 대기 중입니다.', app.room_move_approver_level()));
  end if;

  begin
    update app.room_assignments
       set status = 'CONFIRMED', updated_by = p_by, updated_at = now()
     where id = v_m.to_assignment_id;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'bed_conflict',
      'message', '같은 침대에 이미 확정된 배정이 있어 확정할 수 없습니다.');
  end;

  update app.room_moves set move_status = 'CONFIRMED', updated_by = p_by, updated_at = now()
   where id = p_move_id;
  perform app.room_move_log(p_move_id, v_m.s_idx, 'CONFIRM', p_by, '{}'::jsonb);
  return v_val || jsonb_build_object('ok', true, 'move', app.room_move_json(p_move_id));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3) 예외 승인 / 반려 — Lv10+ 전용 (결정 5)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_approve(
  p_move_id bigint, p_by text default 'unknown', p_level integer default 0, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare v_m app.room_moves;
begin
  if p_level < app.room_move_approver_level() then
    return jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', format('예외 승인은 Lv%s 이상만 가능합니다.', app.room_move_approver_level()));
  end if;
  select * into v_m from app.room_moves where id = p_move_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if jsonb_array_length(v_m.exception_flags) = 0 then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_approve',
                              'message', '승인할 예외가 없습니다.');
  end if;
  if v_m.move_status in ('COMPLETED','CANCELLED') then
    return jsonb_build_object('ok', false, 'error', 'bad_state');
  end if;
  update app.room_moves
     set exception_approved_by = p_by, exception_approved_at = now(),
         updated_by = p_by, updated_at = now()
   where id = p_move_id;
  perform app.room_move_log(p_move_id, v_m.s_idx, 'APPROVE', p_by,
    jsonb_build_object('flags', v_m.exception_flags, 'note', p_note));
  return jsonb_build_object('ok', true, 'move', app.room_move_json(p_move_id));
end;
$$;

create or replace function app.room_move_reject(
  p_move_id bigint, p_by text default 'unknown', p_level integer default 0, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare v_m app.room_moves;
begin
  if p_level < app.room_move_approver_level() then
    return jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', format('예외 반려는 Lv%s 이상만 가능합니다.', app.room_move_approver_level()));
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    return jsonb_build_object('ok', false, 'error', 'need_reason', 'message', '반려 사유는 필수입니다.');
  end if;
  select * into v_m from app.room_moves where id = p_move_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_m.move_status in ('COMPLETED','CANCELLED') then
    return jsonb_build_object('ok', false, 'error', 'bad_state');
  end if;
  -- 승인 취소 + 확정 상태였다면 되돌린다(배정도 PENDING 으로 내려 자리를 놓아준다)
  update app.room_moves
     set exception_approved_by = null, exception_approved_at = null,
         move_status = 'REVIEW', updated_by = p_by, updated_at = now()
   where id = p_move_id;
  update app.room_assignments set status = 'PENDING', updated_by = p_by, updated_at = now()
   where id = v_m.to_assignment_id and status = 'CONFIRMED';
  perform app.room_move_log(p_move_id, v_m.s_idx, 'REJECT', p_by,
    jsonb_build_object('reason', p_reason, 'flags', v_m.exception_flags));
  return jsonb_build_object('ok', true, 'move', app.room_move_json(p_move_id));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4) 취소 — 미래 배정만 취소하고 현재 배정은 그대로 둔다 (요청서 §17, §20-5)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_cancel(
  p_move_id bigint, p_by text default 'unknown', p_level integer default 0, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare v_m app.room_moves;
begin
  if p_level < 8 then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_m from app.room_moves where id = p_move_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_m.move_status = 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error', 'bad_state',
      'message', '이미 완료된 이동은 취소할 수 없습니다. 되돌리려면 반대 방향 이동을 등록하세요.');
  end if;
  if v_m.move_status = 'CANCELLED' then
    return jsonb_build_object('ok', true, 'replayed', true, 'move', app.room_move_json(p_move_id));
  end if;

  -- 미래 배정만 취소. 레거시(현재 배정)는 손대지 않는다 — 애초에 손댄 적이 없다.
  update app.room_assignments
     set status = 'CANCELLED', cancelled_at = now(), updated_by = p_by, updated_at = now()
   where id = v_m.to_assignment_id;
  update app.room_moves
     set move_status = 'CANCELLED', cancelled_by = p_by, cancelled_at = now(),
         updated_by = p_by, updated_at = now()
   where id = p_move_id;
  perform app.room_move_log(p_move_id, v_m.s_idx, 'CANCEL', p_by, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true, 'move', app.room_move_json(p_move_id));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5) 완료 — POST /room-moves/{id}/complete
--    ① 상태 재확인 ② 선행 이동 확인 ③ 기존 배정 종료 ④ 미래→현재 전환
--    ⑤ 실제 이동시각·담당자 기록 ⑥ 이력 저장   — 전부 한 트랜잭션
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_complete(
  p_move_id bigint, p_by text default 'unknown', p_level integer default 0,
  p_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  TZ constant text := 'Asia/Manila';
  v_m     app.room_moves;
  v_dep   app.room_moves;
  v_at    timestamptz := coalesce(p_at, now());
  v_day   date;
  v_span  record;
  v_term  integer := 0;
begin
  if p_level < 8 then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_m from app.room_moves where id = p_move_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_m.move_status = 'COMPLETED' then
    return jsonb_build_object('ok', true, 'replayed', true, 'move', app.room_move_json(p_move_id));
  end if;
  if v_m.move_status <> 'CONFIRMED' then
    return jsonb_build_object('ok', false, 'error', 'bad_state',
      'message', format('이동 확정 상태에서만 완료할 수 있습니다 (현재 %s).', v_m.move_status));
  end if;
  if jsonb_array_length(v_m.exception_flags) > 0 and v_m.exception_approved_at is null then
    return jsonb_build_object('ok', false, 'error', 'need_approval',
      'message', '승인되지 않은 예외가 남아 있어 완료할 수 없습니다.');
  end if;

  -- 선행 이동(§11): 먼저 끝나야 할 이동이 안 끝났으면 완료 불가
  if v_m.depends_on_move_id is not null then
    select * into v_dep from app.room_moves where id = v_m.depends_on_move_id;
    if v_dep.move_status is distinct from 'COMPLETED' then
      return jsonb_build_object('ok', false, 'error', 'dependency_open',
        'message', format('선행 이동 #%s 가 아직 완료되지 않았습니다 (현재 %s).',
                          v_m.depends_on_move_id, coalesce(v_dep.move_status,'없음')));
    end if;
  end if;

  v_day := (v_at at time zone TZ)::date;

  -- ③ 기존 방 배정 종료 — 원본(room_reserve)은 자르지 않고 오버레이에 종료일을 남긴다.
  if v_m.from_r_idx is not null then
    for v_span in
      select b.ri_idx, b.r_idx, b.s_idx, b.end_date
        from app.v_legacy_bed_span b
       where b.r_idx = v_m.from_r_idx and b.s_idx = v_m.s_idx
         and b.end_date >= v_day
    loop
      insert into app.assignment_terminations(ri_idx, r_idx, s_idx, end_date, move_id, created_by)
      values (v_span.ri_idx, v_span.r_idx, v_span.s_idx, v_day - 1, p_move_id, p_by)
      on conflict (r_idx, s_idx, coalesce(ri_idx, -1))
      do update set end_date = excluded.end_date, move_id = excluded.move_id,
                    created_by = excluded.created_by, created_at = now();
      v_term := v_term + 1;
    end loop;
    -- 신전산에서 이미 이동해 온 배정(ACTIVE)이 출발지였다면 그것도 종료 처리
    update app.room_assignments
       set end_date = greatest(start_date, v_day - 1), status = 'COMPLETED',
           updated_by = p_by, updated_at = now()
     where s_idx = v_m.s_idx and r_idx = v_m.from_r_idx and status = 'ACTIVE';
  end if;

  -- ④ 미래 배정 → 현재 배정(ACTIVE). 실제 이동일부터 재실한 것으로 굳힌다.
  begin
    update app.room_assignments
       set status = 'ACTIVE',
           start_date = v_day,
           end_date = greatest(end_date, v_day),
           start_at = v_at,
           updated_by = p_by, updated_at = now()
     where id = v_m.to_assignment_id;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'bed_conflict',
      'message', '실제 이동일 기준으로 대상 침대에 겹치는 배정이 있어 완료할 수 없습니다.');
  end;

  -- ⑤ 실제 이동 시각·담당자
  update app.room_moves
     set move_status = 'COMPLETED', actual_move_at = v_at, completed_by = p_by,
         updated_by = p_by, updated_at = now()
   where id = p_move_id;

  -- ⑥ 이력
  perform app.room_move_log(p_move_id, v_m.s_idx, 'COMPLETE', p_by,
    jsonb_build_object('actual_move_at', v_at, 'from_r_idx', v_m.from_r_idx,
                       'to_r_idx', v_m.to_r_idx, 'terminated_spans', v_term,
                       'from_label', v_m.from_label, 'to_label', v_m.to_label));

  return jsonb_build_object('ok', true, 'terminated_spans', v_term,
                            'move', app.room_move_json(p_move_id));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6) 목록 / 이력 / 타임라인
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.room_move_list(
  p_from date default null, p_to date default null,
  p_status text default null, p_s_idx integer default null, p_limit integer default 500
) returns jsonb
language sql stable security definer set search_path = app, public as $$
  select coalesce(jsonb_agg(to_jsonb(v) order by v.priority, v.planned_move_at, v.id), '[]'::jsonb)
  from (
    select * from app.v_room_moves m
     where (p_from is null or (m.planned_move_at at time zone 'Asia/Manila')::date >= p_from)
       and (p_to   is null or (m.planned_move_at at time zone 'Asia/Manila')::date <= p_to)
       and (p_status is null or p_status = 'ALL'
            or (p_status = 'OPEN'    and m.move_status in ('REVIEW','PLANNED','CONFIRMED'))
            or (p_status = 'APPROVE' and m.awaiting_approval)
            or m.move_status = p_status)
       and (p_s_idx is null or m.s_idx = p_s_idx)
     order by m.priority, m.planned_move_at, m.id
     limit greatest(1, least(coalesce(p_limit,500), 2000))
  ) v;
$$;

-- 학생 상세용 이동 이력(시간순) — 이벤트까지 함께
create or replace function app.room_move_history(p_s_idx integer)
returns jsonb
language sql stable security definer set search_path = app, public as $$
  select coalesce(jsonb_agg(t.row order by t.planned_move_at desc), '[]'::jsonb)
  from (
    select to_jsonb(m) || jsonb_build_object('events', coalesce(
             (select jsonb_agg(jsonb_build_object('event', e.event, 'actor', e.actor,
                                                  'at', e.at, 'detail', e.detail) order by e.at)
                from app.room_move_events e where e.move_id = m.id), '[]'::jsonb)) as row,
           m.planned_move_at
      from app.v_room_moves m
     where m.s_idx = p_s_idx
  ) t;
$$;

-- 침대 타임라인(§10): 레거시 재실 + 미래 배정 + 방막기를 한 줄로
create or replace function app.bed_timeline(p_r_idx integer, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = app, public as $$
  with win as (
    select coalesce(p_from, (now() at time zone 'Asia/Manila')::date - 30) f,
           coalesce(p_to,   (now() at time zone 'Asia/Manila')::date + 180) t
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.start_date, x.kind), '[]'::jsonb)
  from (
    select 'CURRENT'::text as kind, b.s_idx,
           coalesce(nullif(si.e_name,''), si.k_name, '') as name,
           b.start_date,
           least(b.end_date, coalesce(tm.end_date, b.end_date)) as end_date,
           null::text as status
      from app.v_legacy_bed_span b
      left join app.assignment_terminations tm on tm.r_idx = b.r_idx and tm.s_idx = b.s_idx
                                              and coalesce(tm.ri_idx,-1) = coalesce(b.ri_idx,-1)
      left join legacy.student_info si on si.s_idx = b.s_idx
      cross join win
     where b.r_idx = p_r_idx
       and b.start_date <= win.t
       and least(b.end_date, coalesce(tm.end_date, b.end_date)) >= win.f
    union all
    select 'FUTURE', a.s_idx, coalesce(nullif(si.e_name,''), si.k_name, ''),
           a.start_date, a.end_date, a.status
      from app.room_assignments a
      left join legacy.student_info si on si.s_idx = a.s_idx
      cross join win
     where a.r_idx = p_r_idx and a.status in ('PENDING','CONFIRMED','ACTIVE')
       and a.period && daterange(win.f, win.t, '[]')
    union all
    select 'BLOCK', null, bl.reason, coalesce(bl.from_date, win.f), coalesce(bl.to_date, win.t), null
      from app.room_blocks bl
      join app.v_bed vb on vb.room_key = bl.room_key and bl.bed_no in (0, vb.r_num)
      cross join win
     where vb.r_idx = p_r_idx and bl.released_at is null
       and (bl.from_date is null or bl.to_date is null
            or (bl.from_date <= win.t and bl.to_date >= win.f))
  ) x;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7) 배치도 오버레이 — /api/data?parts=roomstat 이 한 번에 집어가는 묶음
--    · assignments: 침대별 미래/확정 배정 (IN 배지)
--    · moves      : 출발 침대 기준 예정 이동 (OUT 배지)
--    · terminations: 조기 종료된 레거시 구간(끝을 잘라 그린다)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.roomstat_overlay(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = app, public as $$
  select jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'rid', a.r_idx, 'si', a.s_idx,
               'nm', coalesce(nullif(si.e_name,''), si.k_name, ''),
               's', a.start_date, 'e', a.end_date,
               'st', a.status, 'ty', a.assignment_type,
               'at', a.start_at, 'mv', a.source_move_id) order by a.r_idx, a.start_date)
        from app.room_assignments a
        left join legacy.student_info si on si.s_idx = a.s_idx
       where a.status in ('PENDING','CONFIRMED','ACTIVE')
         and a.period && daterange(p_from, p_to, '[]')), '[]'::jsonb),
    'moves', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'from', m.from_r_idx, 'to', m.to_r_idx, 'si', m.s_idx,
               'nm', m.student_name, 'at', m.planned_move_at, 'st', m.move_status,
               'ap', m.awaiting_approval, 'pr', m.priority) order by m.planned_move_at)
        from app.v_room_moves m
       where m.move_status in ('REVIEW','PLANNED','CONFIRMED')
         and (m.planned_move_at at time zone 'Asia/Manila')::date between p_from and p_to), '[]'::jsonb),
    'terminations', coalesce((
      select jsonb_agg(jsonb_build_object('rid', t.r_idx, 'si', t.s_idx, 'e', t.end_date))
        from app.assignment_terminations t
       where t.end_date >= p_from - 400), '[]'::jsonb));
$$;

revoke all on function app.room_move_create(jsonb,text,integer,text) from public, anon, authenticated;
revoke all on function app.room_move_confirm(bigint,text,integer) from public, anon, authenticated;
revoke all on function app.room_move_approve(bigint,text,integer,text) from public, anon, authenticated;
revoke all on function app.room_move_reject(bigint,text,integer,text) from public, anon, authenticated;
revoke all on function app.room_move_cancel(bigint,text,integer,text) from public, anon, authenticated;
revoke all on function app.room_move_complete(bigint,text,integer,timestamptz) from public, anon, authenticated;
revoke all on function app.room_move_list(date,date,text,integer,integer) from public, anon, authenticated;
revoke all on function app.room_move_history(integer) from public, anon, authenticated;
revoke all on function app.bed_timeline(integer,date,date) from public, anon, authenticated;
revoke all on function app.roomstat_overlay(date,date) from public, anon, authenticated;
