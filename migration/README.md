# SMEAG 레거시 → Supabase 이관 스크립트

> **원칙: 원본 MySQL(sql/*.sql)은 읽기 전용. 모든 변환은 Supabase 내부.**
> **기본은 DRY-RUN. 실제 적재는 `--execute` 명시해야 실행됨.**
> 현재 상태: 스크립트만 작성됨. 실행(코드진행) 안 함 — 승인 후 진행.

## 구조 (병렬 + 오케스트레이션)

```
migration/
  config.py           결정 A~E 인코딩(매니페스트: 제외/라우팅/PII/페이즈)
  mysql_dump.py       phpMyAdmin 덤프 스트리밍 파서(DDL + INSERT 튜플) — 읽기전용
  transforms.py       타입매핑, 제로데이트→NULL, enum→CHECK, 문자열날짜, COPY 이스케이프
  pg_ddl.py           MySQL DDL → Postgres CREATE TABLE 생성
  loader.py           단일 테이블 워커: 스트리밍→변환→COPY 적재
  orchestrator.py     ★ 병렬 워커풀 + 페이즈 DAG 오케스트레이션
  scripts/
    g4_score_eav.py   (C) g4_score 1593컬럼 → EAV 특수 적재
  schema/
    00_init.sql       (Phase0) 스키마 생성(legacy/cms)
    reservations.sql  (A) reserve_info 정본 → public.dorm_* 모델 + 호환뷰
    g4_score_eav.sql  (C) EAV 타깃 DDL
    constraints.sql   (7) FK/인덱스 후처리
  security/
    rls.sql           (E) RLS + PII 마스킹뷰
  run.sh              실행 래퍼(기본 dry-run)
```

## 5가지 결정 반영 지점

| 결정 | 내용 | 스크립트 |
|---|---|---|
| **A** 예약 정본 | `reserve_info`(예약원장) 기준 재구성, 기존 dorm_*는 `_prev` 보존 | `schema/reservations.sql` |
| **B** CMS 포함 | `g4_*` → `cms` 스키마로 분리 적재(Phase 3) | `config.route_schema`, `orchestrator` |
| **C** g4_score | 1593컬럼 → `cms.member_score_core` + `..._values`(EAV) | `scripts/g4_score_eav.py`, `schema/g4_score_eav.sql` |
| **D** 임시/백업 제외 | test/temp/backup/copy/export/old 제외 | `config.EXCLUDE_TABLES` |
| **E** 개인정보 | RLS deny + `masked.*` 마스킹뷰, service_role만 원본 | `security/rls.sql` |

부수 처리: 제로데이트('0000-00-00')→NULL, 문자열 날짜 캐스팅, enum/set→CHECK,
하이픈 테이블명 리네임(`student_payment-new`→`_new`), MyISAM→PK/FK 재정의, 대용량 COPY.

## 페이즈 (오케스트레이션 DAG)

```
Phase 0  스키마 준비(SQL, 순차)
Phase 1  대용량 독립 테이블  ──┐
Phase 2  나머지 업무 테이블   ├─ ProcessPoolExecutor(workers=MIG_WORKERS) 병렬
Phase 3  CMS g4_*            ──┘
Phase 4  후처리(순차): reservations → g4_score_eav → rls → constraints
```

## 실행 방법 (승인 후)

```bash
# 0) 자격증명(.env: PG_PASS 등) 준비  — 이미 프로젝트 루트에 존재
# 1) 계획/DDL 미리보기 (적재 없음)
./run.sh plan
# 2) 실제 이관
./run.sh execute
# 개별
./run.sh phase 1,2          # 특정 페이즈만
./run.sh only reserve_info  # 특정 테이블만
./run.sh g4score --execute  # g4_score EAV
```

## 안전장치
- 기본 dry-run. `--execute` 없으면 어떤 것도 적재/변경하지 않음.
- 원본 sql/*.sql 파일은 열기만(쓰기 없음).
- legacy/cms 스키마만 DROP/CREATE. public.dorm_*는 `reservations.sql`에서 `_prev`로 보존 후 교체.
- 대용량은 인덱스/FK 없이 COPY → 이후 constraints.sql.

## 미결(승인 필요)
- A~E 최종 확정(특히 A 정본, B CMS 포함범위, E 마스킹 컬럼 실제명).
- `security/rls.sql`의 마스킹뷰 컬럼명은 student_info 실제 DDL로 확정 후 조정.
