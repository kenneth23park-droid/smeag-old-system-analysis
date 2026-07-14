# SMEAG 레거시 예약시스템 → Supabase 이관 : 작업 진행 이력

> 이 문서는 모든 작업 진행 내역을 누적 기록한다. **작업이 진행될 때마다 항상 갱신**한다.

---

## 프로젝트 개요
- **대상**: SMEAG 기숙사 객실 예약 시스템
- **레거시**: PHP 5.2 + MySQL 5.1 (MyISAM), phpMyAdmin 덤프 `sunjae2117_backup2.sql` (228MB, 280만 행)
- **타깃**: Supabase (Postgres 17.6, AWS 도쿄 ap-northeast-1)
- **원칙**: UI/화면은 레거시 그대로, **백엔드만 개선**(속도·무결성). 분석 결과에 맞춰 튜닝·이관.

---

## 진행 이력 (시간순)

### 1) 데이터 분석
- 레거시 스키마: `room_reserve` / `room_reserve_2026` (rr_idx, r_idx, ri_idx, rr_date, s_idx, rr_type, bldg_type, timestamp)
- **핵심 안티패턴 발견**: "1일 = 1행" → 예약 7.9만건이 **280만 행**으로 비대화(35배).
- rr_type 의미: S(입실)/I(재실)/E(퇴실)/R(예약대기). bldg_type: E/S/C/P.
- 문제 13종 매트릭스 도출(비대화, 이중예약 방지 부재, 중복입력, 무결성 부재 등).

### 2) 구간(interval) 모델 변환
- 일자행 → `check_in ~ check_out` 구간으로 변환(awk, 20초). **79,953 예약**.
- 무손실 검증: `num_days 합계 = 2,800,593 = 원본 행수` 정확히 일치.
- 부수 발견: 두 테이블 겹침으로 **중복 일자행 103,697개**(3,328그룹, num_days>span_days) → 구간모델이 자동 병합.

### 3) 산출물 (엑셀/문서)
- `SMEAG_예약DB_분석.xlsx` — 10시트(개요/문제분석_솔루션/테이블별/예약유형/건물유형/연도별/데이터품질/월별추이/재실기간/이관_로드맵)
- `SMEAG_중복의심_크로스체크.xlsx` — 3시트(개요 / A_중복day-row 3,328 / B_이중예약의심 90)

### 4) Supabase 이관 (flat 적재)
- 접속: Supavisor 풀러 `aws-0-ap-northeast-1.pooler.supabase.com:5432` (직접접속 db.*는 IPv6-only라 로컬 라우팅 불가 → 풀러 사용).
- `dorm_reservations`(flat) 79,953행 적재 완료(psycopg2 + COPY).

### 5) 정규화 테이블 분리 (2026-07-14)
- r_idx는 건물 유일키 아님(25개가 건물 넘나듦) → 객실키 = **(bldg_type, r_idx)**.
- ri_idx는 예약별(65,746) 속성 → 정규화 대상 아님.
- 원본 bldg_type NULL 32행 → 'X(미지정)' 건물로 매핑.
- 생성 테이블:
  | 테이블 | 행수 | 비고 |
  |---|---|---|
  | `dorm_buildings` | 5 | E/S/C/P + X |
  | `dorm_students` | 61,251 | s_idx |
  | `dorm_rooms` | 2,487 | (building_id, r_idx) FK |
  | `dorm_reservations` | 79,953→79,870 | room_id/student_id FK, 생성열 span_days·status |
- 인덱스: (room_id, check_in), (student_id), (check_in, check_out).
- `dorm_reservations_flat` = 롤백 안전용 백업(검증 후 삭제 예정).

### 6) 중복 크로스체크 & 정제 (2026-07-14)
- 이중예약 의심 90쌍 재분류:
  - 88쌍 = **완전동일 중복입력**(같은 학생·객실·기간, ri_idx만 다름) → **정제 대상**
  - 1쌍 = 학생 다름, 동일기간 → **2인실 룸메이트(정상)** ← 초기 "진짜충돌" 판단 뒤집힘
  - 1쌍 = 부분겹침, 학생 동일 → 연장(정상)
- **완전중복 83행 삭제** (79,953 → 79,870). 그룹당 최소 id 1행만 보존.
- 정제 후 확정예약 이중배정 오류 **실제 0건**.

### 7) 무결성 제약 (2026-07-14)
- GiST exclusion 미적용(2인실/연장 실재 → 전면 겹침금지 불가).
- `UNIQUE(room_id, student_id, check_in, check_out, is_reserved)` = **uq_res_no_dup** 추가 → 유령행 재발 차단.

### 8) 레거시 UI → Supabase 리포인트 (2026-07-14)
- **호환 뷰** 재생성:
  - `room_reserve_compat` — 구간을 일자행으로 전개(레거시 컬럼 + timestamp=created_at). bldg_type는 nullif('X')로 원복.
  - `room_reserve`(rr_date < 2026, 2,466,323행) / `room_reserve_2026`(>= 2026, 232,226행) — 두 탭 UX 유지.
- **PHP 데이터계층 교체** (HTML/화면 불변):
  - `src/db.php`: mysqli → **PDO pgsql**(Supabase). 자격증명은 env(PG_*), 소스 하드코딩 금지.
  - `src/index.php`: mysqli_* → PDO. 쿼리/화면 동일.
- **Docker**: `config/web.Dockerfile` php:5.6+mysqli → **php:8.2 + pdo_pgsql**.
  - 이유: PHP 5.6의 구형 libpq는 Supabase의 **scram-sha-256 인증 미지원** → 접속 불가. 모던 PHP 필수.
  - `docker-compose.yml` web 서비스 env를 PG_*로 전환, `.env`(gitignore) 사용.
- 쿼리 성능(풀러): 목록/검색 0.08s, 대시보드 통계 2건 각 ~1.5s(전개 뷰 COUNT/GROUP).

---

### 9) Docker 구동 & 화면 확인 (2026-07-14)
- 로컬 Docker 데몬은 OrbStack으로 기동(Server 29.4.0). docker 바이너리 경로: `/Applications/OrbStack.app/Contents/MacOS/xbin`.
- `docker compose up --build -d web` 성공 → http://localhost:8000 **HTTP 200 정상 렌더**.
- 버그 수정: index.php 테이블 감지 루프에 옛 `$conn` 잔존 → `$pdo`로 교체(볼륨마운트라 즉시 반영).
- 화면 확인: 탭(room_reserve/room_reserve_2026), 총 행 수 2,466,323, 목록/학생링크 정상.
- 성능: 첫 로드 ~6.7s(대시보드 통계 2쿼리 각 ~1.5s over 2.4M 전개행 + 콜드커넥션). 목록/검색 페이지는 빠름 → 대시보드 통계 최적화 여지.

## 현재 상태 (2026-07-14 기준)
- ✅ 정규화 분리 / ✅ 중복 정제(83행) / ✅ uq_res_no_dup 제약 / ✅ 호환 뷰 / ✅ PHP PDO 전환 / ✅ Docker php8.2 / ✅ 화면 구동 확인
- 실행: 루트에서 `docker compose up --build -d web` → http://localhost:8000 (docker 데몬=OrbStack)

### 10) 전체 DB 덤프(sql/ 63개 테이블) 분석 (2026-07-14)
- 위치: `sql/` — 전체 시스템 phpMyAdmin 덤프(테이블별 파일, 총 ~1.7GB). 전부 MyISAM/utf8(mb3), 튜플 1줄=1행 포맷.
- **결정적 발견**:
  - `reserve_info`(69,350행) = **예약 원장(구간모델)**. ri_idx PK, s_date~e_date(입·퇴실일), s_idx/r_idx. → 우리가 room_reserve에서 파생시킨 구간모델이 원본에 이미 존재.
  - `room_reserve`(일자전개)는 reserve_info를 일자로 편 것(ri_idx로 연결).
  - `room_reserve_old.sql` = **2,800,593행**(내부 테이블명 room_reserve) = 이전 Desktop 백업과 동일 = **이미 이관한 dorm_reservations의 원천**.
  - `room_reserve.sql` = 627,174행(현재 스냅샷, 별도 버전).
- 실측 행수(주요): reserve_info 69,350 / reserve_info_history 54,698 / room_reserve 627,174 / room_reserve_old 2,800,593 / room_elec 1,670,841 / room_elec_temp 709,230 / room_change_log 552,118 / room_move 148,854 / student_info 90,524 / student_info_history 183,991 / student_info_invoice 128,580 / student_payment 89,477 / g4_point 146,387 / g4_score 14,271(×1593컬럼) / zipcode 52,032.
- **이관 리스크(요약)**: ①예약 정본 불일치(reserve_info vs room_reserve vs 기이관분) ②g4_score 1593컬럼→PG 1600 한계근접 ③제로데이트 '0000-00-00' 24개 테이블 ④문자열 날짜 char(10) ⑤enum/set 10개 ⑥하이픈 테이블명 student_payment-new ⑦MyISAM FK부재/고아행 ⑧임시·백업·테스트 중복테이블 ⑨민감 개인정보(주민번호/비번/여권) ⑩대용량 COPY전략 ⑪g4_* 그누보드 CMS 25개 이관범위.
- **상태: 이관 보류. 사용자 승인/결정 대기(정본 선택·CMS 포함여부·개인정보 요건).**

### 11) 이관 스크립트 작성(실행 안 함) (2026-07-14)
- 사용자 요청: "스크립트만 만들고 코드진행은 하지마", "파랄렐+오케스트레이션으로 5가지 모두".
- `migration/` 생성 — 병렬(ProcessPoolExecutor) + 페이즈 DAG 오케스트레이션. **기본 dry-run, --execute 없으면 무적재. 원본 sql/ 읽기전용.**
  - config.py(결정 A~E 매니페스트) / mysql_dump.py(덤프 스트리밍 파서) / transforms.py(타입·제로데이트·enum·날짜) / pg_ddl.py / loader.py(COPY 워커) / orchestrator.py.
  - schema/00_init.sql, reservations.sql(A: reserve_info 정본→dorm_*, 기존은 _prev 보존), g4_score_eav.sql(C), constraints.sql(7)
  - scripts/g4_score_eav.py(C: 1593컬럼→EAV) / security/rls.sql(E: RLS+masked뷰) / run.sh / README.md
  - 결정 매핑: A=reservations.sql, B=g4_*→cms스키마, C=EAV, D=EXCLUDE_TABLES, E=rls.sql.
- 검증: 파이썬 7개 py_compile 통과. **미실행(승인 대기).**

## 남은 작업 / TODO
- [ ] **sql/ 덤프 이관 결정 승인 후 `migration/run.sh execute` 진행** (정본=reserve_info? / g4_* 포함? / 임시테이블 제외 / 개인정보 보호수준 / rls.sql 마스킹 컬럼 실제명 확정)
- [ ] 대시보드 통계 쿼리 최적화(구간 테이블 직접 집계 or 요약 뷰) — 첫 로드 6.7s 단축
- [ ] 검증 후 `dorm_reservations_flat` 백업 테이블 삭제
- [ ] (선택) 대시보드 통계 쿼리 최적화(구간 테이블 직접 집계 or 요약 뷰)
- [ ] GitHub push (인증 이슈 — gh auth login 또는 새 PAT 필요)
- [ ] **보안**: 노출된 Supabase secret key / DB 비밀번호 마이그레이션 완료 후 **로테이션**

## 접속 정보(참고, 비밀번호는 .env)
- host=`aws-0-ap-northeast-1.pooler.supabase.com` port=5432 user=`postgres.bauhnnpioaephlwurxzg` db=postgres sslmode=require
