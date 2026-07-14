-- Phase 0: 스키마 준비 (멱등)
-- 원본 MySQL 은 건드리지 않음. Supabase 내부 구조만 생성.
create schema if not exists legacy;   -- 원본 1:1 충실 이관(변환만)
create schema if not exists cms;      -- 그누보드 g4_* (결정 B)
-- public 은 정제·모델링 결과(dorm_* 등, 결정 A). 이미 dorm_* 존재.

comment on schema legacy is 'MySQL 덤프 충실 이관(타입/제로데이트 변환만). 감사·롤백 근거.';
comment on schema cms is '그누보드(Gnuboard) g4_* 커뮤니티/게시판 데이터.';
