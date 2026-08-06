-- ============================================================================
-- app.room_assignments / app.room_moves / app.room_move_events
--   기숙사 "방 이동 관리" 1차 원장 (멱등 실행 가능)
-- ----------------------------------------------------------------------------
-- 기획: docs/기획_방이동관리_2026-08-06.md
--
-- 설계 요지
--  · **현재 배정의 정본은 legacy.room_reserve 다.** 이 테이블은 그것을 대체하지 않고,
--    레거시에 아직 없는 **미래/예정 배정만** 담는 오버레이다.
--    그래서 assignment_type 에 CURRENT 가 없다 — CURRENT 행을 여기 만들면 즉시 이중 정본이
--    되어 "한 학생이 같은 날 두 방에 현재 배정" 오류를 우리가 직접 생산하게 된다.
--  · 현재/미래 구분은 저장 구조가 아니라 **기준일(as-of) 파생**이다(아래 뷰 참조).
--  · 침대(r_idx) 는 legacy.room_list.r_idx. 방(i_idx)·그룹(g_idx) 은 조회 성능·표시용 파생.
--  · 침대 기간 겹침은 **EXCLUDE 제약으로 DB 가 물리적으로 거부**한다(앱 로직 신뢰 금지).
--    단 레거시 실적(room_reserve)과의 겹침은 제약으로 못 잡으므로 RPC 검증이 이중 방어한다.
--  · 삭제하지 않는다. 취소도 status='CANCELLED' + cancelled_at 로 남긴다(이력 보존).
--  · 예외 승인(룸타입 불일치·청소시간 부족 등)은 상태를 늘리지 않고 별도 필드로 표현한다
--    — 요청서 §3 의 이동 상태 5단계를 그대로 유지하기 위해서다.
--
-- 원본 불가침: 레거시 MySQL 및 legacy/cms 스키마는 일절 건드리지 않는다. app 스키마 전용.
-- ============================================================================

create schema if not exists app;
create extension if not exists btree_gist;   -- (r_idx with =, period with &&) EXCLUDE 에 필요

-- ════════════════════════════════════════════════════════════════════════════
-- 1) app.room_assignments — 미래/예정 배정 오버레이
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.room_assignments (
  id            bigserial primary key,
  s_idx         integer     not null,                    -- legacy.student_info.s_idx
  r_idx         integer     not null,                    -- legacy.room_list.r_idx (침대)
  i_idx         integer,                                 -- 파생: legacy.room_info.i_idx (방)
  g_idx         integer,                                 -- 파생: legacy.room_category.g_idx (숙소/그룹)
  assignment_type text      not null default 'FUTURE',
  -- 재실 구간(날짜) — 겹침 판정의 기준. 시각은 아래 start_at/end_at 에 따로 둔다.
  start_date    date        not null,
  end_date      date        not null,
  -- 예정 입/퇴실 시각(HH:MM 포함). 미정이면 NULL → "정보 확인 필요" 판정 재료.
  start_at      timestamptz,
  end_at        timestamptz,
  status        text        not null default 'PENDING',
  room_type_at_assignment smallint,                      -- 배정 시점 인실(room_info.i_limit 스냅샷)
  gender_rule   char(1),                                 -- 배정 시점 그룹 성별(M/F/C) 스냅샷
  source_move_id bigint,                                 -- 어느 이동으로 생겼는가(FK 는 아래에서)
  note          text,
  created_by    text        not null default 'unknown',
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz,
  cancelled_at  timestamptz,
  idem_key      text,
  -- 겹침 판정용 생성컬럼(양끝 포함 구간). date 연산이라 immutable → generated 가능.
  period        daterange   generated always as (daterange(start_date, end_date, '[]')) stored,
  constraint room_assign_range_ck  check (start_date <= end_date),
  constraint room_assign_type_ck   check (assignment_type in ('FUTURE','TEMPORARY','HOTEL','FAMILY')),
  constraint room_assign_status_ck check (status in ('DRAFT','PENDING','CONFIRMED','ACTIVE','COMPLETED','CANCELLED')),
  constraint room_assign_gender_ck check (gender_rule is null or gender_rule in ('M','F','C'))
);

comment on table  app.room_assignments is '미래/예정 배정 오버레이 — 현재 배정의 정본은 legacy.room_reserve 다(여기에 CURRENT 는 없다)';
comment on column app.room_assignments.period is '겹침 판정용 [start_date, end_date] 양끝 포함 구간';
comment on column app.room_assignments.assignment_type is 'FUTURE=예정 / TEMPORARY=임시방 / HOTEL=외부숙소 / FAMILY=가족실';

-- ── 겹침 차단(요청서 §20-11): 같은 침대에 살아있는 배정 두 개가 겹칠 수 없다 ──
--    확정(CONFIRMED)·재실(ACTIVE) 만 대상. 초안/취소/완료는 자리를 잡지 않는다.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ex_room_assign_overlap') then
    alter table app.room_assignments
      add constraint ex_room_assign_overlap
      exclude using gist (r_idx with =, period with &&)
      where (status in ('CONFIRMED','ACTIVE'));
  end if;
end $$;

create unique index if not exists ux_room_assign_idem
  on app.room_assignments (idem_key) where idem_key is not null;
create index if not exists ix_room_assign_bed
  on app.room_assignments (r_idx, start_date, end_date) where status <> 'CANCELLED';
create index if not exists ix_room_assign_student
  on app.room_assignments (s_idx) where status <> 'CANCELLED';
create index if not exists ix_room_assign_period
  on app.room_assignments using gist (period) where status <> 'CANCELLED';

alter table app.room_assignments enable row level security;
-- 접근은 서버리스(/api/moves, /api/data)의 postgres 직결로만. anon/authenticated 정책 없음 = 기본 거부.

-- ════════════════════════════════════════════════════════════════════════════
-- 2) app.room_moves — 이동 원장(사건)
--    레거시 room_move 에 없던 것: 상태·사유·담당자·예정시각·실제시각·취소·예외승인
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.room_moves (
  id              bigserial primary key,
  s_idx           integer     not null,
  -- 출발: 레거시 현재 배정에서 읽어 스냅샷으로 굳힌다(이후 레거시가 바뀌어도 이동 기록은 불변).
  from_r_idx      integer,                               -- NULL = 신규 입실(출발 침대 없음)
  from_label      text,                                  -- 'CAPITAL1 / 309 / Bed 2'
  to_r_idx        integer     not null,
  to_label        text,
  to_assignment_id bigint     references app.room_assignments(id),
  planned_move_at timestamptz not null,                  -- 이동 예정 일시
  actual_move_at  timestamptz,                           -- 실제 이동 완료 일시
  move_reason     text,
  move_status     text        not null default 'REVIEW',
  priority        smallint    not null default 100,      -- 낮을수록 먼저(§11 이동 순서)
  depends_on_move_id bigint   references app.room_moves(id),   -- 선행 이동
  vehicle         text,
  staff           text,
  note            text,
  -- 예외 승인(결정 5, 2026-08-06): 상태를 6개로 늘리지 않고 별도 필드로 표현한다.
  exception_flags jsonb       not null default '[]'::jsonb,
  exception_reason text,
  exception_approved_by text,
  exception_approved_at timestamptz,
  created_by      text        not null default 'unknown',
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz,
  completed_by    text,
  cancelled_by    text,
  cancelled_at    timestamptz,
  idem_key        text,
  constraint room_moves_status_ck check (move_status in ('REVIEW','PLANNED','CONFIRMED','COMPLETED','CANCELLED')),
  constraint room_moves_exflags_ck check (jsonb_typeof(exception_flags) = 'array'),
  constraint room_moves_selfdep_ck check (depends_on_move_id is null or depends_on_move_id <> id)
);

comment on table  app.room_moves is '방 이동 원장 — 신전산이 이동의 유일한 정본(2026-08-06 결정 3: 신전산 단독 운영)';
comment on column app.room_moves.exception_flags is '넘기려는 경고 코드 배열. 비어있지 않으면 CONFIRMED 전이에 Lv10+ 승인 필요';
comment on column app.room_moves.priority is '이동 순서(낮을수록 먼저). 선행 이동은 depends_on_move_id 로 강제';

create unique index if not exists ux_room_moves_idem
  on app.room_moves (idem_key) where idem_key is not null;
create index if not exists ix_room_moves_open
  on app.room_moves (planned_move_at, priority) where move_status in ('REVIEW','PLANNED','CONFIRMED');
create index if not exists ix_room_moves_student on app.room_moves (s_idx);
create index if not exists ix_room_moves_to_bed  on app.room_moves (to_r_idx);
create index if not exists ix_room_moves_pending_approval
  on app.room_moves (planned_move_at)
  where exception_approved_at is null and move_status in ('REVIEW','PLANNED');

alter table app.room_moves enable row level security;

-- room_assignments.source_move_id → room_moves.id (순환 참조라 테이블 생성 후에 건다)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'room_assign_source_move_fk') then
    alter table app.room_assignments
      add constraint room_assign_source_move_fk
      foreign key (source_move_id) references app.room_moves(id);
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3) app.room_move_events — 감사 로그(append-only)
--    요청서 §15: 모든 방 이동은 삭제하지 않고 이력으로 보관한다.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists app.room_move_events (
  id        bigserial primary key,
  move_id   bigint      not null references app.room_moves(id),
  s_idx     integer     not null,
  event     text        not null,      -- CREATE/UPDATE/CONFIRM/APPROVE/REJECT/COMPLETE/CANCEL
  actor     text        not null default 'unknown',
  at        timestamptz not null default now(),
  detail    jsonb       not null default '{}'::jsonb
);
create index if not exists ix_room_move_events_move on app.room_move_events (move_id, at);
create index if not exists ix_room_move_events_student on app.room_move_events (s_idx, at desc);
alter table app.room_move_events enable row level security;

-- ════════════════════════════════════════════════════════════════════════════
-- 4) 파생 뷰 — "현재 배정"은 저장하지 않고 레거시에서 읽는다
-- ════════════════════════════════════════════════════════════════════════════

-- 침대별 레거시 재실 구간(예약단위로 압축). 배치도 loadRoomstat 과 같은 규칙.
create or replace view app.v_legacy_bed_span as
select rr.r_idx,
       rr.ri_idx,
       rr.s_idx,
       min(rr.rr_date)::date as start_date,
       max(rr.rr_date)::date as end_date
  from legacy.room_reserve rr
 where rr.rr_date ~ '^\d{4}-\d{2}-\d{2}$'
 group by rr.r_idx, rr.ri_idx, rr.s_idx;

comment on view app.v_legacy_bed_span is '레거시 room_reserve 일자행 → 침대별 재실 구간(현재 배정의 정본)';

-- 이동 목록 표시용(학생명·방번호까지 조인해 화면이 그대로 쓰게)
create or replace view app.v_room_moves as
select m.*,
       coalesce(nullif(st.e_name,''), st.k_name, '') as student_name,
       st.s_gender, st.s_nation,
       fr_i.i_name as from_room_no, fr_c.g_name as from_group, fr.r_num as from_bed_no,
       to_i.i_name as to_room_no,   to_c.g_name as to_group,   to_bed.r_num as to_bed_no,
       (jsonb_array_length(m.exception_flags) > 0 and m.exception_approved_at is null) as awaiting_approval
  from app.room_moves m
  left join legacy.student_info st on st.s_idx = m.s_idx
  left join legacy.room_list  fr     on fr.r_idx = m.from_r_idx
  left join legacy.room_info  fr_i   on fr_i.i_idx = fr.i_idx
  left join legacy.room_category fr_c on fr_c.g_idx = fr_i.g_idx
  left join legacy.room_list  to_bed on to_bed.r_idx = m.to_r_idx
  left join legacy.room_info  to_i   on to_i.i_idx = to_bed.i_idx
  left join legacy.room_category to_c on to_c.g_idx = to_i.g_idx;

comment on view app.v_room_moves is '이동 목록 화면용 — 학생명·출발/도착 방번호까지 조인';
