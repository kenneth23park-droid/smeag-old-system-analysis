# 이관 런북 — 레거시 MySQL → 신규 Supabase (실행 순서)

> 실행 절차서. "왜/구조"는 `MIGRATION_METHODOLOGY.md` 참조.
> **철칙**: 원본 MySQL 덤프(`sql/*.sql`) 읽기 전용 · 기본 DRY-RUN · `--execute`로만 실적재 · 전 단계 멱등.
> **예상 소요**: 클린 1회 실행 약 **5~10분**(디버깅 없을 때). 병목 = room_elec(1.67M) 적재 + Phase4 뷰 생성.

---

## 0. 사전 점검 (Pre-flight)

- [ ] 최신 레거시 덤프를 phpMyAdmin에서 추출 → `sql/` 교체 (원본 불변)
- [ ] `.env` 접속정보 확인: `PG_HOST/PORT/DB/USER/PASS/SSLMODE` (Supavisor 풀러)
- [ ] Python + `psycopg2` 설치 확인: `python3 -c "import psycopg2"`
- [ ] 연결 테스트: `python3 -c "import psycopg2,os;print('ok')"` + 실제 접속 1회
- [ ] **현행 백업**(롤백 근거): `pg_dump`로 `public.dorm_*` 물리 백업

```bash
# 접속 테스트 (값은 .env)
psql "host=$PG_HOST port=$PG_PORT dbname=$PG_DB user=$PG_USER sslmode=require" -c "select 1;"
```

---

## 1. DRY-RUN (계획 검토, 적재 안 함)

```bash
python migration/orchestrator.py            # 계획·DDL 미리보기
```
- [ ] 제외 테이블(test/temp/backup/old) 목록 확인
- [ ] 스키마 라우팅(legacy/cms/public) 확인
- [ ] Phase 구성 확인

---

## 2. 실적재 (Phase 0~4)

```bash
python migration/orchestrator.py --execute            # 전체
# 부분: python migration/orchestrator.py --phase 1,2 --execute
# 단일: python migration/orchestrator.py --only reserve_info --execute
```

| Phase | 내용 | 방식 |
|---|---|---|
| 0 | `schema/00_init.sql` 스키마 생성 | 순차 |
| 1 | 대용량 독립 테이블(room_elec/room_reserve/room_change_log…) | 병렬(4워커) |
| 2 | 나머지 legacy | 병렬 |
| 3 | `g4_*` → cms | 병렬 |
| 4 | 후처리(순차): reservations→actual_checkout→g4_score_eav→rls→constraints | 순차 |

- [ ] 각 테이블 `✓ rows=…` 확인, `✗ ERROR` 없을 것
- [ ] `--workers`는 풀러 세션 한도 고려(기본 4, 과도 시 connection 초과)

---

## 3. 검증 (필수 3종)

**(a) 행수 대조** — 덤프 tuple 수 == Supabase COUNT
```bash
grep -c "^(" sql/reserve_info.sql        # 예 69350
# psql: select count(*) from legacy.reserve_info;   → 동일해야
```
- [ ] legacy/cms 전 테이블 행수 100% 일치

**(b) 값 스팟체크** — 임의 N건(연도 분포) ri_idx/s_idx/날짜 일치

**(c) 파생모델 정합**
- [ ] `dorm_reservations + rejects ≈ reserve_info`
- [ ] rejects 사유 확인(null_date/reversed)

---

## 4. 배치도 정본 (room_reserve 기준) ⚠

> **주의**: `reserve_info`(예약원장)는 방변경 미반영. 배치도 "현재 실제 배치"는 **`room_reserve`(방×일자 실적)** 로 구성.

- [ ] room_reserve 기반 배치도 데이터 재구성(방변경 반영)
- [ ] 홀딩 규칙: "첫 점유자는 표시, 이후 홀딩/예약에서 중단"

---

## 5. 앱 계층 적용 (멱등)

```bash
psql "$CONN" -f migration/schema/write_layer.sql     # 쓰기 안전계층(RPC/신뢰도/에러로그)
psql "$CONN" -f migration/schema/admin_auth.sql      # 관리자 4계정/로그/RPC
psql "$CONN" -f migration/schema/perf_interval_mv.sql # 대시보드 MV(구간모델)
# refresh: select app.refresh_dashboard_mvs();  (+pg_cron 15분 스케줄)
```
- [ ] `app.*` 함수/테이블 생성 확인
- [ ] `crypt` 미존재 오류 시: 함수 `search_path`에 `extensions` 포함 확인

---

## 6. 정리 (검증 후, 승인 필요)

```bash
# 백업/이전본 삭제 (되돌릴 수 없음 — 승인 후)
psql "$CONN" -f migration/schema/cleanup_recommended.sql   # 주석 해제 후
```
- [ ] `dorm_reservations_flat` / `_prev` 삭제
- [ ] (선택) `smeag` 전용 스키마 분리

---

## 롤백 절차

1. 재적재 실패 시 → `orchestrator.py`는 멱등(create/replace, on conflict). **재실행**으로 복구.
2. 데이터 이상 시 → 백업(1단계 pg_dump)으로 `public.dorm_*` 복원.
3. rejects 테이블은 재실행 시 **누적**되므로 재적재 전 `truncate public.dorm_reservations_rejects;` 권장.

---

## 트러블슈팅 (재발 주의)

| 증상 | 원인 | 조치 |
|---|---|---|
| varchar 초과 실패 | 콤마 뒤 공백이 값에 포함 | `mysql_dump._split_tuple` 상태추적 파싱(수정됨) |
| enum CHECK 위반 | NOT NULL enum에 `''` 저장 | `pg_ddl.py` CHECK에 `''` 허용, set은 CHECK 생략 |
| 제약명 충돌 | rename 시 `uq_res_no_dup` 딸려옴 | rename 전 제약 개명/제거 |
| rls.sql 실패 | student_info 미적재 | 실패 테이블 재적재 후 Phase4 재실행 |
| crypt 없음(RPC) | pgcrypto가 `extensions` 스키마 | 함수 search_path에 extensions |
| 배치도 회원 불일치 | reserve_info는 방변경 미반영 | 배치도는 room_reserve 기준 |

---

## 완료 사인오프

- [ ] 행수/값/정합 검증 3종 통과
- [ ] 배치도 room_reserve 기준 정상
- [ ] 앱 계층(write_layer/admin_auth/perf_mv) 적용
- [ ] 백업 보관(정리 전) · 키 로테이션
- [ ] 담당/일시 기록: __________

*근거: `migration/` 스크립트 + 2026-07-14 실행 로그(`migration_run.log`) 실측.*
