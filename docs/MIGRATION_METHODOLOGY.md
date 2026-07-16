# SMEAG 레거시(MySQL) → 신전산(Supabase) 데이터 이관 방법론 · 재이관 런북

> **목적**: 기존 방식 그대로 재현해, 시스템 안정화 후 레거시 데이터를 신전산으로 다시 이관할 때 사용.
> **철칙**: 원본 MySQL(`sql/*.sql`)은 **읽기 전용**. 모든 변환은 Supabase(Postgres) 내부에서만. 기본 **DRY-RUN**, 실제 적재는 `--execute` 명시.

---

## 1. 개요

| 항목 | 값 |
|---|---|
| 원본 | MySQL 5.1 (MyISAM), phpMyAdmin 덤프 `sql/*.sql` (테이블별 파일, ~1.7GB, 63테이블) |
| 대상 | Supabase Postgres 17 (AWS, Supavisor 풀러 접속) |
| 접속 | `.env`의 `PG_HOST/PORT/DB/USER/PASS/SSLMODE` (풀러 `aws-0-*.pooler.supabase.com:5432`) |
| 방식 | 스트리밍 파서 → 타입변환 → `COPY` 병렬 적재 → SQL 후처리(모델링/제약/RLS) |
| 검증 | 행수 대조(덤프 vs Supabase) + 값 스팟체크 + 파생모델 정합 |

**핵심 원리**: "적재는 충실(1:1) → 모델링은 Postgres에서". 원본을 `legacy`/`cms` 스키마에 그대로 넣고(감사·롤백 근거), 정제·정규화 결과는 `public`(dorm_*)에 별도로 만든다.

---

## 2. 아키텍처 (스키마 라우팅)

```
MySQL 덤프(sql/*.sql, 읽기전용)
        │  스트리밍 파서 + 타입변환
        ▼
┌─────────────────────────────────────────────┐
│ Supabase Postgres                            │
│  legacy.*   원본 1:1 충실 적재(변환만)  ← 감사/롤백 │
│  cms.*      그누보드 g4_* (결정 B)                │
│  public.*   정제·정규화(dorm_*, 결정 A) + 호환뷰    │
│  masked.*   PII 마스킹뷰(결정 E)                  │
│  app.*      쓰기 안전계층·RPC(결정 F, 이관 후 추가)   │
└─────────────────────────────────────────────┘
```

---

## 3. 도구 구성 (`migration/`)

| 파일 | 역할 |
|---|---|
| `config.py` | 매니페스트: 제외 테이블, 스키마 라우팅, PHASE 그룹, PII 대상, 접속(env) |
| `mysql_dump.py` | phpMyAdmin 덤프 **스트리밍 파서**(`parse_ddl`, `iter_rows`) — O(1) 메모리, 읽기전용 |
| `transforms.py` | 타입매핑, 제로데이트→NULL, enum/set→CHECK, 문자열날짜, COPY 이스케이프 |
| `pg_ddl.py` | MySQL DDL → Postgres `CREATE TABLE` 생성 |
| `loader.py` | 단일 테이블 워커: 스트리밍→변환→`COPY` 적재 |
| `orchestrator.py` | ★ 병렬 워커풀(ProcessPoolExecutor) + **Phase DAG** |
| `scripts/g4_score_eav.py` | (C) g4_score 1593컬럼 → EAV 특수 적재 |
| `schema/00_init.sql` | (Phase0) 스키마 생성 |
| `schema/reservations.sql` | (A) reserve_info 정본 → `public.dorm_*` + 레거시 호환뷰 |
| `schema/actual_checkout.sql` | 계획/실제 퇴실 이원화(room_reserve 실적 주입) |
| `schema/g4_score_eav.sql` | (C) EAV 타깃 DDL |
| `schema/constraints.sql` | FK/인덱스 후처리(결정 7) |
| `security/rls.sql` | (E) RLS + `masked.*` 마스킹뷰 |
| `run.sh` | 실행 래퍼(기본 dry-run) |

---

## 4. 이관 결정 (A~F)

| 결정 | 내용 | 스크립트 |
|---|---|---|
| **A 예약 정본** | `reserve_info`(예약원장) 기준으로 `public.dorm_*` 재구성. 기존은 `_prev` 보존 | `schema/reservations.sql` |
| **B CMS 포함** | 그누보드 `g4_*` → `cms` 스키마로 분리 적재(Phase 3) | `config`, `orchestrator` |
| **C g4_score** | 1593컬럼(PG 1600 한계 근접) → `cms.member_score_core` + `_values`(EAV) | `scripts/g4_score_eav.py` |
| **D 제외** | test/temp/backup/copy/export/old = 이관 제외 | `config.EXCLUDE_TABLES` |
| **E 개인정보** | 민감테이블 RLS deny + `masked.*` 마스킹뷰, `service_role`만 원본 | `security/rls.sql` |
| **F 쓰기계층** *(이관 후)* | 멱등 RPC + 신뢰도 프리플라이트 + 에러로그 | `schema/write_layer.sql` |

> ⚠ **배치도(room_stat3) 정본 주의**: 예약원장 `reserve_info`는 **방변경(room move)을 반영하지 않는다.** 배치도 "현재 실제 배치"는 **`room_reserve`(방×일자 일별 실적)** 를 써야 한다. (결정 A는 예약원장 용도, 배치도는 room_reserve 기준으로 별도 구성)

---

## 5. 실행 절차

```bash
# 0) 사전: .env 에 PG_* 채우기(풀러 자격증명). psycopg2 설치. sql/ 덤프 준비.

# 1) 계획/DDL 미리보기 (실제 적재 안 함)
python migration/orchestrator.py

# 2) 실제 이관 (전체)
python migration/orchestrator.py --execute

# 부분 실행
python migration/orchestrator.py --only reserve_info,room_reserve --execute
python migration/orchestrator.py --phase 1,2 --execute
```

**Phase DAG**
| Phase | 내용 | 실행 |
|---|---|---|
| 0 | `schema/00_init.sql` 스키마 생성 | 순차 |
| 1 | 대용량 독립 테이블(`PHASE_BIG`: room_elec, room_reserve, room_change_log 등) | 병렬 |
| 2 | 나머지 legacy 테이블 | 병렬 |
| 3 | `g4_*` → cms | 병렬 |
| 4 | 후처리(순차): reservations.sql → actual_checkout.sql → g4_score_eav.sql → rls.sql → constraints.sql | 순차 |

> 병렬 워커수는 풀러 세션 한도 고려(`--workers`, 기본 4). 과도하면 connection 초과.

---

## 6. 변환 규칙 (`transforms.py` / `pg_ddl.py`)

| 원본(MySQL) | 처리 |
|---|---|
| `int/varchar/char` | Postgres 대응 타입 그대로 |
| `datetime` | `timestamptz` |
| **문자열 날짜** `varchar(10)` (s_date 등) | **원형 보존**(text), 정합성은 파생모델에서 `~ '^\d{4}-\d{2}-\d{2}$'` 검사 후 date 캐스팅 |
| **제로데이트** `'0000-00-00'` | `NULL` (24개 테이블 존재) |
| **enum** | `CHECK` 제약. 단 레거시가 NOT NULL enum에 `''` 저장 → **CHECK에 `''` 허용** |
| **set**(조합값) | CHECK 생략, text 보존(IN 검사 금지) |
| **하이픈 테이블명** `student_payment-new` | `student_payment_new` 로 리네임 |
| MyISAM(FK 없음) | 적재 후 인덱스 + 검증된 관계만 FK(NOT VALID→VALIDATE) |
| 대용량 | `COPY`(배치 5000행), 로드 중 인덱스/FK 없이 빠르게 |

---

## 7. 검증 방법 (필수)

```python
# (a) 행수 대조: 덤프 tuple 수 vs Supabase COUNT(*)  — 전 테이블
#     grep -c "^(" sql/<t>.sql   ==   select count(*) from legacy."<t>"
# (b) 값 스팟체크: 임의 N건(연도 분포) ri_idx/s_idx/날짜 일치
# (c) 파생모델 정합: dorm_reservations + rejects ≈ reserve_info,
#     dorm_reservations_flat(구백업) vs 신정본 span_days 합계 비교
```

- 2026-07-16 실측: **legacy/cms 51테이블 행수 100% 일치, 값 스팟 전건 동일**.
- 파생 `dorm_reservations` = `reserve_info` − 날짜불량 격리(rejects) − uq 중복.

---

## 8. 실전 이슈 & 수정 (재이관 시 재발 주의)

| 이슈 | 원인 | 수정 |
|---|---|---|
| varchar 초과 적재 실패 | `_split_tuple`이 콤마 뒤 공백을 값에 포함(`' F'`) | 따옴표/무따옴표 상태추적 파싱 |
| enum CHECK 위반 | NOT NULL enum에 `''` 저장 | CHECK에 `''` 허용, set은 CHECK 생략 |
| 제약명 충돌 | 테이블 rename(_prev) 시 `uq_res_no_dup` 딸려옴 | rename 전 제약 개명/제거 |
| 마스킹뷰 컬럼 오류 | 가상 컬럼(s_name 등) 참조 | 실제 컬럼(k_name/e_name/s_jumin/s_tel/s_addr)으로 |
| `crypt` 함수 없음(RPC) | Supabase pgcrypto가 `extensions` 스키마 | 함수 `search_path`에 `extensions` 포함 |
| 배치도 회원 불일치 | reserve_info는 방변경 미반영 | 배치도는 `room_reserve`(일별실적) 기준 |
| 홀딩 표기 | staff 상시점유(준블락)와 임시홀딩(Tammy) 모두 now_status='checking' | "첫 점유자는 표시, 이후 홀딩/예약에서 중단" 규칙 |

---

## 9. 재이관 체크리스트 (안정화 후)

1. **최신 덤프 확보**: 레거시에서 phpMyAdmin 덤프 재추출 → `sql/` 교체 (원본 불변).
2. `.env` 접속정보 확인(풀러). psycopg2/psql 준비.
3. **DRY-RUN**: `orchestrator.py` (계획·DDL 검토).
4. **기존본 백업**: 재적재 전 현행 `public.dorm_*` → pg_dump 물리백업(롤백).
5. **실행**: `orchestrator.py --execute` (Phase 0~4). 멱등 SQL이라 재실행 안전(단 rejects 테이블은 누적 → 재실행 시 초기화 권장).
6. **검증**: 7장(행수·값·파생정합) 전부 통과 확인.
7. **배치도 정본**: room_reserve 기반 재구성 확인(방변경 반영).
8. **쓰기계층/인증**: `write_layer.sql`, `admin_auth.sql` 재적용(멱등).
9. **성능**: `perf_interval_mv.sql`(MV) 적용 + `refresh_dashboard_mvs()` 스케줄.
10. **정리**: 검증 후 `_prev`/`_flat` 백업 테이블 삭제(승인 후, `cleanup_recommended.sql`).

---

## 10. 보안

- 민감테이블(student_info 등) **RLS deny 기본**, `service_role`만 원본. 앱/분석은 `masked.*`(주민번호/여권/연락처 마스킹).
- **접속 비밀번호·키는 `.env`/서버 env에만**. 소스/깃 금지. 이관 완료 후 **노출된 키 로테이션**.
- 관리자 계정: `app.admin_users`(bcrypt), 초기 PW=ID, 최초 로그인 후 변경 강제. 사용로그 `app.admin_activity_log`(조회로그 90일 보존).

---

## 11. 접속 정보(참고, 값은 .env)

```
PG_HOST = aws-0-ap-northeast-1.pooler.supabase.com   PG_PORT = 5432
PG_DB   = postgres   PG_USER = postgres.<projectRef>   PG_SSLMODE = require
```
> 직접접속 `db.*`는 IPv6-only라 로컬 라우팅 불가 → **풀러(Supavisor) 사용**.

---
*작성 2026-07-16 · 근거: `migration/` 스크립트 + `workflow-progress-history.md` 실측. 원본 MySQL 불가침.*
