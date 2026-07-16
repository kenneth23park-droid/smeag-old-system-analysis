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

### 12) GitHub push 완료 (2026-07-14)
- 원격을 jitnet57 → **kenneth23park-droid** 로 변경, private repo `smeag-old-system-analysis` 생성/push(커밋 803d1a3, 25파일).
- 하드코딩 DB 비번 제거(normalize.py/make_dupe_xlsx.py → env). .gitignore에 sql/·*.zip·*.xlsx·.env·.pptx 제외. migration/*.sql은 force-add.
- 키체인 자격증명 kenneth23park-droid로 교체. **PAT·DB비번 노출 → 로테이션 필요.**

### 13) 운영 관리자 UI(smeadmin.com) 화면/메뉴 분석 (2026-07-14)
- 브라우저 세션으로 운영중 관리자(그누보드4) 전 메뉴 순회·캡처. 결과를 `진행사항_화면캡쳐_메뉴설명_정리.md`로 저장.
- 대분류 4개(Record/Student's/Dormitory/Cash Cards). 학생 90,527 / 기숙사 1,127실 / 방변경로그 552,177 / 방이동 4,318.
- 검색폼 파라미터·공통코드(캠퍼스 sparta=ENCANTO/classic/capital, pay_status N/Y/X/R, condition 13종) 도출 + 신규 시스템 설계 초안.
- **캠퍼스 코드 화면별 불일치 발견**: DEPOSIT(sparta/classic/capital) vs DORM SEARCH(1/4/5) vs ELEC&WATER(S/C/E) → 신규는 campus_id 단일화 필요.
- 전 화면 폼 파라미터 명세 + ERD(텍스트) + REST API 초안까지 문서에 확장(11~13장).
- 개인정보는 담지 않고 화면구성/컬럼만 정리.

### 14) 이관 실행 완료·검증 (2026-07-14)
- `migration/` 오케스트레이션 --execute 실행(Phase 0~4). 원본 MySQL 무접속(로컬 sql/ 덤프 읽기전용→Supabase 적재).
- **파서/제약 버그 수정 후 완주**:
  - `mysql_dump.py _split_tuple`: 콤마 뒤 공백이 값에 포함되던 버그(`' F'`,`' 135'` → varchar 초과) → 따옴표/무따옴표 필드 상태추적으로 수정.
  - `pg_ddl.py`: 레거시 NOT NULL enum에 `''` 저장 사례 → CHECK에 `''` 허용, set타입(조합값)은 CHECK 생략(text 보존). 7개 테이블 재적재.
  - `reservations.sql`: 테이블 rename(_prev) 시 제약명 `uq_res_no_dup` 충돌 → _prev 제약 개명.
  - `security/rls.sql`: masked.student_info가 가상 컬럼(s_name/s_email/s_passport) 참조 → 실제 컬럼(k_name/e_name/s_jumin/s_tel/uhak_phone/s_addr)으로 수정.
- **행수 검증 OK**: room_elec 1,670,841 / room_reserve 627,174 / room_change_log 552,118 / reserve_info 69,350 / student_info 90,524 / student_info_history 183,991 / g4_point 146,387 / g4_visit 58,816 — 전부 덤프와 일치.
- **정본 모델**: dorm_reservations 69,326 + rejects 32(≈reserve_info 69,350, 나머지 uq 중복 제거) / dorm_rooms 4,846 / dorm_students 64,883. masked.student_info 90,524 정상.
- 총 54개 테이블 적재 + Phase4 후처리(reservations/g4_score_eav/rls/constraints) 전부 OK. **이관 완료.**

### 15) 신규 관리자 화면설계 + Playwright 자동 화면탐구 (2026-07-14)
- **화면설계서** 작성: `docs/design-admin/화면설계서.md` — 전체 메뉴 IA(4대분류·45화면), 공통 레이아웃/컴포넌트, 핵심6화면 와이어프레임, 설계원칙 P1~P6(캠퍼스코드 단일화·i18n·캠퍼스분기폐지 등).
- **인터랙티브 프로토타입**: `docs/design-admin/prototype.html`(Artifact 게시) + `prototype_local.html`(로컬). teal 강조색, 성별/결제상태/캠퍼스 의미색, 대시보드·STUDENT LIST·DEPOSIT·기숙사배치도·BACK-UP LOG·Admission Date 실렌더. Playwright 검증(콘솔에러 0, bar-fill span display:block 버그 수정).
- **Playwright 자동 화면탐구**(`exploration/`): kenneth 로그인 자동화(핵심: flogin의 onsubmit이 action을 login_check.php로 바꿈 → `<input type=image>` 버튼 **클릭** 필요) → 세션 재사용 병렬 크롤(동시성4) **45화면 100%**. 구조 메타만 수집, PII 미기록, 산출물 gitignore.
- **실측 정정/확장**(기존 문서 대비): `pay_status X=분납(INSTALL)`(문서 "예외"는 오류) / 캠퍼스코드 **4중**(sparta·1·S·SP + SPARTA/CLASSIC/CAPITAL) / 국적 **12종**(sa=러시아 라벨오류) / 코스 71·유학원 111·방구역 31·그룹 36 전량 확보. → `result.md`에 전체 과정·결과 보고.
- **신규 요구사항 반영**: 저장·인보이스 발행 **중복실행 방지(idempotency)** — 더블서밋 가드 + 멱등키 + DB 유니크제약. 화면설계서 §4-1, 프로토타입 데모, result.md §5.

### 16) 정본 vs 레거시 교차검증 + 계획/실제 퇴실 이원화 (2026-07-14)
- **교차검증**(dorm_reservations 정본 vs legacy.room_reserve): 공통키는 **ri_idx**(예약원장). room_reserve.r_idx(1330885 등)는 reserve_info.r_idx(객실ID)와 다른 자체키 → r_idx 조인 금지.
  - ri_idx 커버리지: reserve_info 69,350 / dorm 69,326(−24, null_date rejects) / room_reserve 17,163(최근 부분 스냅샷).
  - 공통 17,149건 중 **날짜구간 완전일치 99.29%(17,028)**. 정본 span_days 총합 2,893,205 = room_reserve_compat 뷰와 100% 일치.
  - 불일치 121건 전부 방향성 설명됨: 정본 퇴실>실적 74(조기퇴실/방변경) + 입실일 상이 49, 역방향(실적>계획) 0건. room_reserve 단독 14건 중 13건은 reserve_info에 없는 고아행 → 정본이 더 정합.
- **계획/실제 퇴실 이원화**(`schema/actual_checkout.sql`, Phase4 배선): dorm_reservations에 `actual_check_in/out`(room_reserve 실적 min/max 주입) + 생성컬럼 `actual_days`·`early_checkout_days`(계획퇴실−실제퇴실). check_in/out(계획)은 정본 유지. 재실행 안전.
  - 결과: 실적매칭 17,149 / 계획만 52,177 / 조기퇴실 74·연장 0·일치 17,075. `dorm_early_checkouts` 뷰 + `idx_res_actual_co` 생성. 최대 조기 147일(ri_idx 174466: 계획167→실적20).

### 2026-07-16 — 배치도 보강 + DB 쓰기 안전 계층
- **배치도(room_stat3) 방/회원 검색**: dorm-bar `#rsSearch` 라이브 필터(재렌더 없이 행 표시/숨김+이름 하이라이트+건수). NAME 폰트 레거시 동일화(`#c15b1e`·12.5px).
- **roomstat 실데이터 전 빌딩 재추출**: 기존 real.json이 4그룹(32방)만 샘플 → `room_category.g_display='Y'` 기준 **30그룹/416방/1016베드**(CAPITAL1~4 남·여, ENCANTO2~4·VIP·O, S hotel(H), Amethyst, Canberry, Casablu, Citadines 등), 2025~2027 예약 11,514건. 조인 검증: g68 room 301-1 "준블락_single use" = 레거시 일치. `build_roomstat.py`.
- **DB 쓰기 안전 계층 `migration/schema/write_layer.sql`** (결정 F): insert/update/delete/move(방변경=rewrite) 멱등 RPC.
  - `app.reservation_preflight()` **신뢰도 4종**(중복/멱등30·정원/충돌30·참조25·날짜15) → confidence 0–100 + level(ok/warn/block) + checks[].
  - **더블서밋 가드**: `app.write_audit.idempotency_key UNIQUE` 재요청 replay + DB `uq_res_no_dup` 유니크 3중 방어.
  - **에러 폴백**: 예외 throw 안 함 → `app.db_error_log` 적재 후 `{error_id,sqlstate,message}` 반환. `need_confirm`+checks[]로 저장/삭제 메세지박스 구동.
  - `dorm_rooms.capacity` 보강(legacy.room_list.r_limit, 폴백 4).
  - **Postgres 16 실검증 전 시나리오 통과**: 정상100 / 멱등 replay / 중복 block / 정원초과 conf70 / 참조·날짜 block / move / 삭제 멱등 / 내부오류 error_id 적재.
  - UI 소비 계약: `smeag system plan/docs/db-write-layer.md`.
- 배포: smeag-bay.vercel.app 갱신(CAPITAL 반영, 인증 게이트 정상).

### 2026-07-16(2) — 배치도 회원 표시 레거시 일치 (전체 방)
- **증상**: 배치도 이름칸이 레거시와 불일치(예: CAPITAL3/FEMALE 519 가 Sofia 대신 2024년 입주자 표시).
- **원인(읽기전용 진단)**: 방/조인/예약 데이터는 정상(reserve_info 에 Sofia Ryzhmanova·Kiseleva 실재, 레거시 일치). 문제는 **이름칸 생성 방식** — `build_roomstat.py` 가 침대별 2025~2027 전체 점유자를 시작일순 concat 후 앞8명만 표시 → **가장 오래된(2024) 입주자**가 이름칸을 차지. 창 필터가 `종료일≥2025-01-01` 이라 2024-10 예약도 유입.
- **수정(전체 방)**: seg 마다 학생명 동봉(`{s,e,t,nm}`) + prototype `R.roomstat` 가 **표시 중 13개월 창과 겹치는 seg 의 학생명만** 이름칸에 렌더(월 이동 시 갱신) — 레거시 배치도와 동일 원리. 30그룹/416방/1016베드 전부 적용.
- **검증**: Playwright — 519 4침대 7월 점유 Margarita/EUNSONG/**Sofia Ryzhmanova**/**Sofia Kiseleva** 표시, 2024 입주자(HARU FUJINE) 선두 아님, JS오류 0.
- **원칙 준수**: 레거시 MySQL `sql/*.sql` **무변경(read-only)**, build 스크립트는 읽기만+scratchpad 기록. Supabase 정본(dorm_reservations)은 예약 단위로 이미 정확 → 본 건은 **표시(렌더) 계층 수정**이라 Supabase 데이터 변경 불필요.
- 배포: smeag-bay.vercel.app 갱신.

## 남은 작업 / TODO
- [ ] 핵심 6화면 고해상도 목업 확정 + 나머지 화면 실렌더 확장
- [ ] `sa=러시아` 등 라벨오류 신규 마스터에서 교정(SA=사우디), 캠퍼스 4중코드→campus_id 매핑표 확정
- [ ] course(71)/agency(111)/zone(31) 마스터를 신규 DB 시드로 이관
- [x] ~~sql/ 덤프 이관 실행~~ **완료(2026-07-14)** — 54테이블 + Phase4 후처리, 행수검증 OK.
- [ ] 대시보드 통계 쿼리 최적화(구간 테이블 직접 집계 or 요약 뷰) — 첫 로드 6.7s 단축
- [ ] 검증 후 `dorm_reservations_flat` 백업 테이블 삭제
- [ ] (선택) 대시보드 통계 쿼리 최적화(구간 테이블 직접 집계 or 요약 뷰)
- [ ] GitHub push (인증 이슈 — gh auth login 또는 새 PAT 필요)
- [ ] **보안**: 노출된 Supabase secret key / DB 비밀번호 마이그레이션 완료 후 **로테이션**

## 접속 정보(참고, 비밀번호는 .env)
- host=`aws-0-ap-northeast-1.pooler.supabase.com` port=5432 user=`postgres.bauhnnpioaephlwurxzg` db=postgres sslmode=require
