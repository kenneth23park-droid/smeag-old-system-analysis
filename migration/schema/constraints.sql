-- ════════════════════════════════════════════════════════════════
-- 결정 7: MyISAM(FK 없음) → Postgres 무결성 보강.
--   대용량 COPY 이후 실행(로드 중엔 인덱스/FK 없이 빠르게 적재).
--   조인 컬럼 인덱스 + 검증된 관계만 FK. 고아행은 NOT VALID 로 우선 부여 후 점진 검증.
-- ════════════════════════════════════════════════════════════════

-- 1) 공통 조인 컬럼 인덱스 (존재하는 테이블/컬럼만 안전 생성)
do $$
declare r record;
begin
  for r in
    select * from (values
      ('legacy','reserve_info','s_idx'),('legacy','reserve_info','r_idx'),
      ('legacy','reserve_info','ri_idx'),
      ('legacy','room_reserve','ri_idx'),('legacy','room_reserve','s_idx'),
      ('legacy','room_reserve','rr_date'),
      ('legacy','room_move','s_idx'),('legacy','room_change_log','s_idx'),
      ('legacy','room_elec','r_idx'),
      ('legacy','student_payment','s_idx'),('legacy','student_info_invoice','s_idx'),
      ('legacy','student_info_history','s_idx'),
      ('cms','g4_point','mb_id'),('cms','g4_board_new','mb_id')
    ) as t(sch,tbl,col)
  loop
    if exists (select 1 from information_schema.columns
               where table_schema=r.sch and table_name=r.tbl and column_name=r.col) then
      execute format('create index if not exists %I on %I.%I (%I)',
                     'idx_'||r.tbl||'_'||r.col, r.sch, r.tbl, r.col);
    end if;
  end loop;
end $$;

-- 2) FK (검증된 관계). NOT VALID 로 부여 → 신규행만 강제, 기존 고아는 이후 VALIDATE.
--    reserve_info.s_idx → student_info.s_idx 는 student_info 의 PK 확인 필요(그누보드 아님).
--    관계가 코드리뷰로 확정되면 아래 주석 해제.
-- alter table legacy.reserve_info
--   add constraint fk_ri_student foreign key (s_idx)
--   references legacy.student_info (s_idx) not valid;
-- alter table legacy.reserve_info validate constraint fk_ri_student;

-- 3) 고아행 점검 리포트(참고용)
-- select 'reserve_info.s_idx orphan' t, count(*) from legacy.reserve_info ri
--   left join legacy.student_info si on si.s_idx=ri.s_idx where si.s_idx is null;
