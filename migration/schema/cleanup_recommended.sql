-- ════════════════════════════════════════════════════════════════
-- 이관 검증 후 "정리 권고" — 준비 스크립트 (기본 미실행)
--   실행하려면 각 블록의 주석(--)을 해제. 되돌릴 수 없으니 반드시 백업/승인 후.
--   원칙: 레거시(legacy.*) 원본은 절대 건드리지 않는다. 여기 대상은 파생/백업뿐.
-- ════════════════════════════════════════════════════════════════

-- ── (A) 백업/이전본 테이블 정리 ─────────────────────────────────
--   검증이 끝난 롤백용 백업. 삭제 전 pg_dump 로 물리 백업 권장.
-- drop table if exists public.dorm_reservations_flat;   -- 79,953 (구 room_reserve_old 파생)
-- drop table if exists public.dorm_reservations_prev;   -- 69,326 (reservations.sql 재실행 시 보존본)

-- ── (B) 전용 스키마 분리 (smeag) ───────────────────────────────
--   public 에 타 앱 테이블 24개가 dorm_* 와 혼재 → 네임스페이스 분리.
--   주의: 배포 PHP/뷰가 public.dorm_* / room_reserve* 를 참조 → 뷰·검색경로 동시 조정 필요.
--   권장 절차(무중단):
--     1) create schema if not exists smeag;
--     2) alter table public.dorm_reservations set schema smeag;  (+ dorm_rooms/students/buildings)
--     3) 호환 뷰: create view public.dorm_reservations as select * from smeag.dorm_reservations; (읽기 경로 유지)
--     4) app.* 함수의 참조를 smeag.* 로 갱신(또는 search_path 조정) 후 검증
--   ※ 실제 실행은 배포 앱 다운타임/롤백 계획 확정 후.

-- ── (C) 확인용 조회 (읽기전용, 안전) ───────────────────────────
-- public 스키마의 SMEAG 무관 테이블 목록:
--   select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   where c.relkind='r' and n.nspname='public' and relname not like 'dorm_%' order by 1;
