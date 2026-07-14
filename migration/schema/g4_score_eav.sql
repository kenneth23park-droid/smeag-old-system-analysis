-- ════════════════════════════════════════════════════════════════
-- 결정 C: g4_score (14,271행 × 1,593컬럼) → EAV 정규화
--   Postgres 컬럼 하드리밋(1600)에 근접 → 1:1 리프트 위험.
--   전략: 회원 식별 핵심 컬럼만 좁은 테이블로, 나머지 점수/설문 컬럼은 (mb_no, key, value) 롱포맷.
--   이 스크립트는 cms.g4_score 가 "충실이관"된 경우를 가정하지 않고,
--   loader 가 g4_score 를 SKIP(SPECIAL) 하므로, 원본 덤프를 별도 세션모드로 직접 로드해야 한다.
--   ▶ 실제 EAV 적재는 파이썬 special 핸들러(scripts/g4_score_eav.py)에서 수행(주석 참조).
-- 아래는 EAV 타깃 스키마(DDL)만 정의. 원본 MySQL 불변.
-- ════════════════════════════════════════════════════════════════

-- 회원 핵심(좁은 테이블): 그누보드 표준 mb_* 중 식별/연락 최소 집합
create table if not exists cms.member_score_core (
  mb_no       integer primary key,
  mb_id       varchar(255),
  mb_name     varchar(255),
  mb_nick     varchar(255),
  mb_level    smallint,
  mb_email    varchar(255),
  mb_datetime timestamptz
);

-- 점수/설문 롱포맷(EAV): 나머지 ~1580 컬럼을 (키,값) 으로
create table if not exists cms.member_score_values (
  mb_no    integer references cms.member_score_core(mb_no) on delete cascade,
  attr_key text not null,             -- 원본 컬럼명 (예: sc_001, q_042 ...)
  attr_val text,                      -- 값(빈문자/제로데이트는 로드시 null)
  primary key (mb_no, attr_key)
);
create index if not exists idx_msv_key on cms.member_score_values(attr_key);

-- 조회 편의뷰(피벗이 꼭 필요할 때만; 기본은 롱포맷 권장)
comment on table cms.member_score_values is
  'g4_score 광폭 컬럼의 EAV 적재. 특정 항목만 crosstab 으로 넓게 조회.';
