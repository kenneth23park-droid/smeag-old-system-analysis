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

### 2026-07-16(3) — 배치도 소스 교체: reserve_info → room_reserve (방변경 반영, 레거시 일치)
- **불일치 근본원인(읽기전용 진단)**: 배치도 데이터 소스가 신·구 다름.
  - 신전산(구): `reserve_info`(예약원장) = **최초 예약 방**. 방변경(room move) 미반영.
  - 구전산(레거시 room_stat3): `room_reserve`(방×일자 일별 실적) = **방변경 반영 실제 배치**.
  - 증거(519, 2026-07): XU WEI reserve_info=417→room_reserve=519bed1 / RINKA=100-temp→519bed2 / Margarita=519→417. `room_change_log`에 XU WEI(417→519 2026-06-24 katie), RINKA(100-temp→…→519 2026-06-23 katie) 이동 확정. 세 명 자리바뀜이 화면차와 정확히 일치.
  - 이관 "결정 A(정본=reserve_info)"가 배치도엔 부적절. 배치도 정답 소스 = room_reserve.
- **수정**: `build_roomstat_rr.py` — room_reserve(627,174행·2014~2036, 2025~2027 충분)에서 bed-slot(r_idx=room_list.r_idx, slot밖 0건)별 연속일 구간을 세그먼트화(방변경 자연 반영). 30그룹/416방/1016베드/12,887세그.
- **검증**: 519 2026-07 = XU WEI / RINKA·LIN CHUN CHIEN / Sofia Ryzhmanova / Sofia Kiseleva → **레거시 스크린샷과 일치**. Playwright OK, JS오류 0.
- 원본 MySQL read-only 유지. 배포: smeag-bay.vercel.app.

### 2026-07-16(4) — 배치도 이름칸 규칙 레거시 완전 일치
- 잔차: room_reserve 교체 후에도 이름칸 명단이 레거시와 미세 불일치(뒤 학생 누락/홀딩 노출).
- 원인: (1) 내 규칙이 "선택월만" 봐서 뒤 확정재실(TASHIRO/HSU) 누락, (2) 홀딩(Tammy for=now_status checking)이 노출.
- 규칙 확정(레거시 room_stat3 동일): 선택월부터 앞으로 **확정 재실(rr_type=S)** 만 표기, **예약(R)** 또는 **홀딩(now_status∈checking/holding/holdinguse/waiting)** 만나면 중단.
- 결과 519 4침대 전부 레거시 일치(XU WEI / RINKA·LIN CHUN CHIEN·TASHIRO KAON / Sofia Ryzhmanova·HSU JIA JIE / Sofia Kiseleva), 520도 일치. build_roomstat_rr.py 에 seg.h(홀딩) 플래그.
- 잔여(경미): 이름 언어 — 레거시는 한국인 k_name(안미진), 내 추출은 e_name 우선(AN mijin). 배치는 100% 일치, 표기 언어만 상이(선택 시 k_name 우선으로 전환 가능).

### 2026-07-16(5) — 이관 검증 대조 + write_layer 적용 + 리포트
- **레거시(sql/) ↔ Supabase 대조(읽기전용)**: exact COUNT 51개 테이블 전부 일치(불일치 0), 값 스팟체크 reserve_info 5건 전건 동일. 스키마 타입변환 정상(varchar 날짜 원형 보존, datetime→timestamptz).
- 파생 정본 dorm_reservations 69,326 = reserve_info 69,350 − 격리32 − uq중복. 미이관 ≈3.53M행(room_reserve_old 2.8M 등 테스트/백업/대체분, 의도적 제외).
- **write_layer.sql 운영 Supabase 적용**(additive): app 7함수/3테이블 + dorm_rooms.capacity 4,846. 운영 preflight 검증(신규100/ok, 중복48/block). ※ MCP 계정에 이관 프로젝트 없어 .env pooler 직결로 대조/적용.
- 산출: 검증 리포트 아티팩트 게시. 정리 권고 스크립트 `migration/schema/cleanup_recommended.sql`(미실행: 백업 drop·smeag 스키마 분리 — 승인 후).
- 부수: ROOM M-LIST 등 데이터그리드 헤더/좌측컬럼 freeze, Manage Cash 실데이터 전체컬럼 반영.

## 남은 작업 / TODO
- [ ] (이관 반영) Supabase 배치도용 정본을 room_reserve 기반으로 재구성(현 dorm_reservations=reserve_info 파생은 예약원장 용도로 유지, 배치도는 room_reserve 뷰 별도) — 방변경 반영 필요
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

- **2026-07-16** 배치도 셀 클릭 → 레거시 ROOM REPLACEMENT(reserve_move.php) 직접 표시. 학생 실데이터(studentsFull)·후보방 실그룹 416행·빠른작업 통합. 배포 smeag-bay.vercel.app, 커밋 7869d9d. (re.sub 백슬래시 이스케이프 주입버그 → str.replace 로 수정)

- **2026-07-16** 모바일 버전 신설: `docs/design-admin/prototype.mobile.html`(단일파일, 동일 REAL/토큰/게이트). 5탭(홈·학생·기숙사·픽업·더보기)+바텀시트. 섹션 렌더러 7종(홈·학생·배치도·픽업·캐시·범용표·백업로그)을 워크플로 7에이전트 병렬 생성 후 CSS 스코프 격리(.mvsc-*)로 조립. window.REAL/DICT 브리지 버그 수정. `/m/` 배포(smeag-bay.vercel.app/m/), 데스크톱↔모바일 상호링크. Playwright 모바일 뷰포트 전수검증 무오류.

- **2026-07-17** 배치도 십자선(룰러) 개선: 휠클릭 없이 **📏 룰러 토글 버튼**(헤더)으로 표시/숨김. 컨트롤러 전역노출(window.__xhRuler), 재렌더 후 버튼 상태 동기화, ON 시 강조. 휠클릭/Esc 토글 병행 유지. 배포·검증 완료.

- **2026-07-17** 메뉴 실작동 보강: R.spec 이 데이터 없으면 명세(골격) 폴백만 뜨던 19개 메뉴 중 14개를 파생 데이터 계층(specDerived)으로 실제 작동시킴 — studentsFull/deposits/기존테이블/roomstat로 계산(Graduate 7,344·변경환불홀딩 2,061·POPULATION2·STDNT STATUS·MC Report2·REGISTER STATS 42·DAY IN&OUT·VISIT캘린더·FARM리포트·Deposit(test)/Pre-paid·Group Students). DORM STATUS는 배치도 재사용. 나머지 5개(게시판3·DAYOFF·외부포털4종)는 데이터 미크롤/외부라 사유 명확화. 무오류.

- **2026-07-17** Group Students(student_group_payment.php)를 레거시와 동일하게 구현: Supabase legacy.student_group_info(12행) + student_info.group_id 카운트를 추출해 REAL.groups 임베드. R.groups 전용화면(#·Group Name·Country·#of Students(View)·Status·Added by·Created·Action(EDIT)) + Group Name 검색·EXCEL·Add New Group·(View)학생명단·EDIT/추가 모달(확인 플로우). 국적그룹 파생은 제거. 배포·검증 완료.

- **2026-07-17** ① 모바일/데스크톱 자동 분리: 데스크톱 루트에서 모바일 기기 감지 시 /m/ 자동 이동, 모바일 "PC 버전"=../?pc=1(강제 데스크톱·루프방지). E2E 검증(데스크톱 유지/모바일→m//?pc=1 유지). ② AGENCY PAGE(유학원 포털) 신설: R.agency — 히어로(3캠퍼스)+MY PAGE 사이드바(MY INFO/STUDENT LIST/APPLICATION/LOGOUT), 레거시 컬럼 17종(NO~Score), UHAK ID·연도·월·이름 검색·EXCEL·페이지네이션·Edit(상세폼)·등록신청 폼. studentsFull에 uhak_id 백필(이름+출발일 조인 99.7
- **2026-07-17** ① 모바일/데스크톱 자동 분리: 데스크톱 루트에서 모바일 기기 감지 시 /m/ 자동 이동, 모바일 "PC 버전"=../?pc=1(강제 데스크톱·루프방지). E2E 검증(데스크톱 유지 / 모바일→m/ / ?pc=1 유지). ② AGENCY PAGE(유학원 포털) 신설: R.agency — 히어로(3캠퍼스)+MY PAGE 사이드바, 레거시 컬럼 17종, UHAK ID·연도·월·이름 검색·EXCEL·페이지네이션·Edit(상세폼)·등록신청 폼. studentsFull에 uhak_id 백필(조인 99.7%)로 유학원 필터 실동작.

- **2026-07-17** AGENCY PAGE 항공/픽업 등록에 마감 규칙 적용: 출발일 7일 전까지 등록 가능, 지나면 입력·저장 비활성 + 안내메세지("등록은 출발일 기준 일주일 전입니다"). STUDENT LIST FILE열에 ✈ 버튼(등록가능=녹색·완료=✓), openFlightReg 모달(출발일·마감일·항공편/도착/픽업 입력, 마감일 당일까지 편집 허용, 출발일 미정 시 비활성). 마감일 표시는 로컬(KST) 기준으로 계산해 UTC 밀림 방지. Playwright 검증(OPEN/CLOSED/미정/경계일) 무오류.

- **2026-07-17** AGENCY 등록화면(APPLICATION 등록신청) 실연결: 제출→"등록신청 하시겠습니까?" 확인→studentsFull에 실제 학생행 추가(상태 waiting, 종료일=시작+기간주 자동계산)→STUDENT LIST에 즉시 표시(해당 유학원+이름검색으로 확인). 유학원(UHAK ID) 드롭다운을 DICT.uhak(불일치) 대신 실 studentsFull uhak_id 값·건수순으로 생성해 검색/등록 모두 실데이터 연결.

- **2026-07-20** 레거시 관리자 로그인 계정을 Supabase(app.admin_users)에 등록: gnuboard cms.g4_member level>=8 관리자 7명(cebusme·cebusme00·cebusme2[최고관리자]·Joon·katie[lv10]·cebusme1[lv9]·fumi[lv8]). 레거시 비번은 MySQL PASSWORD() 해시(복호화 불가) → 초기 비번=아이디·must_change=true(최초 로그인 시 변경 강제). mb_name/mb_level/source 컬럼 보강. app.admin_login RPC 인증 검증 통과. admin_auth.sql에 멱등 등록 블록 반영.

- **2026-07-20** 출발일 기준 만나이 + 미성년(만18미만) 빨강 블링크: 여권 생년월일(studentsFull col17)+출발일(col7)로 만나이 계산, 없으면 저장나이(col4) 근사(≈배지). 적용 섹션 — 수강등록관리/STUDENT LIST, AGENCY PAGE STUDENT LIST, ROOM REPLACEMENT. 여권 생년월일 입력칸 추가(AGENCY 등록신청 apDob, 상세폼 smiBirth 라이브계산·row[17] 저장). prefers-reduced-motion 대응. 데이터 확인: 학생 생년월일 미저장(s_age만) → DOB 입력 시 정확, 기존건 근사. Playwright 단위·렌더 검증 무오류.

- **2026-07-20** 수강등록관리 상세폼(openStudentEdit)을 레거시 student_modify.php 전체와 동일하게 확장: AGENCY INFO(COUNTRY 라디오·BANK·ACCOUNT·CONSULTANT·OFFICE PHONE), STUDENT INFO(NAME/eng·Apply·Group·AGE·SEX·BIRTHDAY(만나이)·PASSPORT·DEPARTURE·PICKUP항공·PERIOD·Medical·Parents·AGENCY COMMENT·ROOM·PRE PAY·DORMITORY·CAMPUS(하이라이트)·INVOICE FORMAT·MULTI COURSE·COURSE CHOICE 2행·MODULE), DORMITORY CONDITION 표, DETAIL COST(REGIST·TUITION·DORMITORY·ETC FEE·PRE PAY·TOTAL), PAY INFORMATION(PAY CHECK·ETC DOC·LOA/RECEIPT·STUDENT CONDITION·AMOUNT·STAFF COMMENT), COMMISSION INFO(COMMISSION·ETC COMMISSION·INVOICE 이력·FINANCIAL·NEW INVOICE PUBLISH), SUBMIT/LIST. Playwright 7섹션 렌더 검증 무오류.

- **2026-07-20** 생년월일 입력 시 나이 자동계산+AGE칸 잠금(수정불가): 상세폼(openStudentEdit smiAgeInput)·등록폼(apAge) 모두, 여권 생년월일 입력하면 출발일 기준(없으면 오늘 기준) 만나이로 자동채움·disabled, 삭제 시 재편집. 출발일 기준 + 오늘(생일) 기준 두 나이 동시 표시(미성년 블링크). Playwright 검증 무오류.

- **2026-07-20** 리스트에서 학생 이름 클릭 시 작업 팝업(수정·변경·연장·상담·약식) 표시: openStudentActions 신설, STUDENT LIST/수강등록관리(.std-name)·AGENCY PAGE STUDENT LIST(.std-name-ag) 이름 클릭 → 5버튼 팝업 → 수정/연장/상담/약식=상세폼, 변경=ROOM REPLACEMENT. Playwright 검증 무오류.

- **2026-07-20** ① 리스트 행 아무 곳이나 클릭 시 작업 팝업(버튼/링크 제외) — STUDENT LIST·수강등록관리·AGENCY PAGE. ② 메뉴 기본 영어화: langBtn(EN/한) 토글, MENU_EN 매핑(대시보드→Dashboard·수강등록관리→Course Registration·기숙사현황→Dormitory Status(Batch) 등), 기본 en·localStorage 저장, m.t 기반 페이지 제목도 연동. Playwright 검증 무오류.

- **2026-07-20** 만나이 기준일 개선: 기준일=출발일과 오늘 중 나중(ageRef). 미래출발→출발일 기준, 출발일 경과→오늘 기준(그 사이 생일 지났으면 +1 자동). manAge/manAgeCell·상세폼 chkAge·등록폼 apAgeCalc 모두 적용, 적용 만나이·기준 표기·미성년 블링크 유지. Playwright 경계 검증 무오류.

- **2026-07-20** 화면 문구 영어화 시작: T(ko,en) 헬퍼 추가, 작업팝업(Edit/Move/Extend/Consult/Brief)·배치도 화면(제목·룰러·센터/성별/방구분 필터·범례·상태범례·placeholder·note) 언어 연동(EN 기본, 한 토글). Playwright EN/KO 검증 무오류.

- **2026-07-20** 인보이스 중복발행 방지(4중 방어) 구현·적용: ①UI 즉시 잠금+스피너 ②클릭당 멱등키 ③Supabase app.invoice_issue UNIQUE(idem_key / target_key,seq) + app.invoice_publish RPC(중복 시 기존 발행건 반환) ④중복 시 "이미 발행되었습니다" 메시지박스(인보이스번호·발행일시·발행자) + 감사로그. 상세폼 NEW INVOICE PUBLISH도 동일 경로. DB 검증(3회 호출→1건), Playwright 검증(연타/완료후 재클릭) 무오류. 용어: TOCTOU 경쟁상태·중복제출·비멱등연산·이중발행.

- **2026-07-21** ① 비밀번호 변경 강제 화면 비활성(로그인 즉시 진입) + Supabase must_change 전 계정 해제. ② 로그인 폴백 계정목록에 레거시 관리자 7명 추가(데스크톱·모바일) — anon 키 없이도 실 관리자 아이디로 로그인 가능. ③ 전 메뉴 영어화: 런타임 번역 계층(I18N_EN 사전 294항목 + 동적 패턴 규칙 + MutationObserver로 모달까지 자동 적용). 전 메뉴 순회 검증 결과 UI 잔여 한글 4건(학생명 등 데이터는 미번역 유지). 무오류 배포.

- **2026-07-21** 학생리스트 UX 조정: ①행 클릭 작업팝업 제거(STUDENT LIST·AGENCY) → 오른쪽 ACTION 버튼(수정·변경·연장·상담·약식)으로만 진행 ②이름 컬럼 선택·복사 가능(user-select:text, 전체 이름 title 툴팁) ③이름/KOR 폭 제한·말줄임, KOR이 NAME과 동일하면 생략, 셀 여백·액션버튼 축소 → 1500px 이상에서 가로스크롤 없이 한 화면 표시.

- **2026-07-21** 레거시 표 타이포 조건 반영: 실 레거시(student_list.php) 로그인 측정값(Tahoma,굴림 · 본문11px/헤더11px · #222 · 행 30px · 가운데정렬, AGENCY만 좌측)을 신전산 리스트 표(#stdBody·#specBody·AGENCY)에 적용. 이름 강조 해제(폭제한·복사·툴팁 유지), 미성년 빨강·상태 pill·캠퍼스 칩은 유지. 부수효과로 1440px에서도 가로스크롤 제거.

- **2026-07-21** 학생리스트 한 페이지 맞춤: ①freeze 레이아웃의 min-height:0 로 행 영역이 0으로 눌리던 버그 수정(.main.freeze #stdBody .twrap{min-height:280px}) → 짧은 화면·확대에서도 행 항상 표시 ②날짜 YY-MM-DD 축약(전체 날짜는 title 툴팁) ③이름150/KOR88, 셀 여백 3px → 1000~1500px 전 구간 가로스크롤 없음(확대 150%까지).

- **2026-07-22** 이름 클릭 → 상세정보(STUDENT MANAGEMENT INFORMATION 7섹션) 열기: STUDENT LIST/수강등록관리(.std-name)·AGENCY PAGE(.std-name-ag) 이름 클릭 시 openStudentEdit(row,'edit') 오픈. 이름 셀 링크 스타일(밑줄·포인터)·툴팁, 오른쪽 ACTION 버튼은 그대로. 드래그 복사 유지.

- **2026-07-22** 기본 테마 낮(라이트) 고정: 데스크톱·모바일 모두 저장된 선택 없으면 OS가 다크여도 light로 초기화(head 조기 스크립트로 FOUC 방지). 데스크톱 테마 토글이 선택을 localStorage(smeag-theme)에 저장·재로드 유지. Playwright(OS=dark 에뮬) 검증: 초기 light, 토글 dark 저장·유지, 모바일 light 확인.

- **2026-07-22** 표 화면(spec)에서도 이름 클릭 → 상세정보: STUPROJ(studentsFull 1:1) 표(멀티수강관리·APPLY LIST·HISTORY·수금관리·MC Report1)의 이름 컬럼을 클릭 가능(td.sp-name, data-abs)하게 하고 paintPaged 에 nameCol/getFull 옵션 추가 → openStudentEdit. 5개 표 검증 정상.

- **2026-07-22** 배치도(기숙사현황) 학생 이름 클릭 → 상세정보: 좌측 이름 셀에 .rs-name(data-name) 부여, document 클릭 핸들러에서 셀 팝업보다 우선 처리 → findStudent 로 studentsFull 조회 후 openStudentEdit. 실학생 매칭 정상(비학생 홀드는 '학생 정보 없음' 안내), 날짜 셀 클릭은 기존대로 ROOM REPLACEMENT/팝업 유지.

- **2026-07-22** 배치도 방구분에 Temporary(임시방) 옵션 추가: rsPer 에 TEMP 추가, 선택 시 센터·성별 무관 TEMPORARY 카테고리 전체 표시(임시방 15실). 검증 정상.

- **2026-07-22** ① Vercel Basic Auth 미들웨어(deploy/middleware.js, admin/smeagadmin) 제거 → 사이트 직접 접근(200). ② 로그인 계정 5개로 정리(admin·master·admin1·admin2·manager, 비번=아이디), Supabase에 admin 계정 추가. ③ 로그인 게이트 비활성 — 데스크톱·모바일 모두 아이디/비번 없이 즉시 실행(기본 admin 세션 자동). ⚠ PII 임베드 상태에서 접근 보호가 사라짐(주의 고지).

- **2026-07-22** 만나이 기준·표기 변경: 기준일=시작일(BEGIN col8, 지났으면 오늘). 빨강 임계 만18미만→만14세 이하(MINOR_AGE 15). 셀에서 "만/age" 접두어 생략(숫자만, 빨강). 생년월일 병기·근사(≈)는 유지. 적용: STUDENT LIST·수강등록관리·AGENCY·ROOM REPLACEMENT.

- **2026-07-22** 배치도 CAPITAL 권역 기숙사 분류 보정: campusOf 가 CAPITAL로 시작하지 않는 실제 CAPITAL 권역 빌딩(S hotel(H)·Amethyst(AM)·Canberry(Cb)·Casablu·Citadines·Commercial·CAPITAL RECORD ROOM)을 ETC로 분류해 CAPITAL 센터에서 누락되던 문제 수정 → CAPITAL 센터 남/여/공용(FAMILY) 모두에 해당 카테고리 표시. 이름/방 클릭 → ROOM REPLACEMENT(후보방 포함)도 반영.

- **2026-07-22** 배치도 이름 클릭 = STUDENT INFORMATION 전용(infoOnly): openRoomReplace 에 infoOnly 파라미터 추가 → 이름 클릭 시 후보방(CHANGE PERIOD)·빠른작업 바 숨기고 STUDENT INFORMATION+DORMITORY RESERVED만 단일컬럼 표시(헤더 'STUDENT INFORMATION'). 방번호/방구분 클릭은 전체 ROOM REPLACEMENT(후보방 MOVE 포함) 유지.

- **2026-07-22** 배치도 휠(가운데) 버튼 드래그 패닝: .twrap.dorm-scroll 에서 가운데 버튼 누른 채 드래그하면 상하좌우 이동(scrollLeft/scrollTop). 브라우저 기본 autoscroll(auxclick) 차단, panning 중 grabbing 커서. 휠클릭 룰러 토글은 제거(룰러는 상단 버튼 유지). 검증: 가로180·세로120 이동.

- **2026-07-22** 배치도 이름 셀에서 '/'로 묶인 다중 학생을 개별 클릭 가능화: 각 이름을 .rs-nameseg(data-name)로 분리, 클릭 시 해당 학생의 STUDENT INFORMATION(infoOnly) 표시. 핸들러에서 클릭한 segment 우선. 검증: 1·2번째 이름 각각 정확한 학생 표시.

- **2026-07-22** 배치도 Name 컬럼 폭 조절: 툴바에 이름폭 드롭다운(좁게160/보통230/넓게320/아주넓게460), roomFilter.nameW→INFOW·colgroup 반영, localStorage 저장. 검증: 160/230/460 정확 반영.

- **2026-07-23** 레거시 캡처 기반 남은 메뉴 대거 구현(파랄렐+오케스트레이션, BMAD·LangGraph 프레이밍):
  ① Supabase 7테이블 실추출(회원2053·포인트·방문·유학원커미션4004·코스71·등록금100·유학원방문) → REAL.tables.
  ② 상단 카테고리 3개 신설: Member's(회원/포인트/접속자)·Agency(AGENCY LIST/COMMISSION/방문)·Financial(등록금·인보이스/COURSE/TUITION).
  ③ 부서별 권한(RBAC): DEPTS 5부서 + PERMS 매트릭스 화면(부서×카테고리 체크박스, localStorage) + 상단 부서선택기 + 사이드바 필터 + 접근가드.
  ④ 인보이스: 멱등 발행(기존 4중 방어) + PDF 생성(openPdf 인쇄→PDF, 외부라이브러리 없음) — financial 화면 학생별 발행/PDF 버튼.
  ⑤ 워크플로 3에이전트 병렬(perms·agencylist·financial) + 적대적 QA 후 조립. Playwright 검증: 7카테고리·신규화면·인보이스발행·PDF팝업·부서전환 필터 무오류.

- **2026-07-23** 남은 메뉴 마무리 — Financial 변형 4종 + Agency 통계 3종:
  ① Financial 필터 모드(FIN_MODES): 등록금·인보이스(전체 12,150) / 한국학생(5,139) / 외국학생(7,011) / 연장학생(279) / 변경환불홀딩(1,782). URL(m.u)→모드 매핑(FIN_URLMODE), 화면 제목·대상행 모드연동. finFiltered에 모드필터 삽입.
  ② Agency 통계(R.agencystat): BRANCH RECORD·GROUP RECORD(유학원×캠퍼스 ENCANTO/CLASSIC/CAPITAL/기타) + EACH NATIONALITY(유학원×국적 KOR/CHI/JAP/TWA/VTN/ETC). studentsFull에서 실시간 집계, DICT.uhak로 유학원명 해석, 총계순 상위 80. Playwright 검증: 3화면 렌더·80행·필터카운트 정확·무오류. 배포·별칭 완료.

- **2026-07-25** 신전산(Supabase) → 구전산(MySQL) **역방향 일일 동기화** 파이프라인 신설(migration/):
  ① `legacy_writeback.py`(기존, 안전모드) = import 실행부. UPDATE 전용·화이트리스트 테이블(student_info/student_change/reserve_info/student_payment)·PK SET 금지·before-image 백업·감사로그·멱등·트랜잭션·DRY-RUN 기본(--commit --yes 시만 실반영).
  ② `export_daily_changes.py`(신규) = 그날 반영된 Supabase 변경분 → `changes.json` 생성기(**Supabase 읽기전용**, 원본·Supabase 모두 미변경). source 2방식: (기본)`changelog`=앱이 저장 시 남기는 app.change_log(target_table/target_pk/changed_cols/changed_at) 그날치 추출 / (폴백)`column`=updated_at류 컬럼 기준 지정컬럼 export. 매핑은 충실리프트라 identity 기본(MAPPING으로 재정의). writeback과 동일 화이트리스트로 사전 검증. py_compile OK, 검증 4케이스(정상/PK-SET거부/허용외테이블/PK누락) 통과.
  ③ `run_daily_sync.sh`(신규) = export→import 래퍼. import는 DRY-RUN 기본, `COMMIT=1`일 때만 --commit --yes. 접속정보는 env(PG_PASS / MYSQL_*)로만. bash -n OK.
  ⚠ 전제: (a) 이는 기존 원칙 '단방향·원본 불가침'을 의도적으로 벗어남(정책 확인 필요). (b) 실행은 구전산 라이브 MySQL 접속정보 + 앱이 Supabase에 변경로그(app.change_log)를 남기는 배선이 있어야 함 — 아직 미배선(Supabase anon 키 대기와 동일 임계경로). 코드만 제공, 실행 안 함.

- **2026-07-25** 역방향 동기화 **소스 DDL** 추가 `migration/schema/change_log.sql`(멱등):
  ① `app.change_log`(target_table/target_pk/changed_cols/op/changed_at) = export_daily_changes.py 가 읽는 그날 변경분 원장. changed_at::date·미반영 인덱스. ② `app.log_change()` RPC = 앱/기존 RPC에서 구전산 정체성(예: student_info, {s_idx})으로 명시 로깅(화이트리스트 검증+PK 자동제외). ③ `app.tg_change_log()` = legacy.* 직접 UPDATE 시 변경컬럼만 자동 로깅하는 제네릭 트리거. RLS/grant 포함. → 이로써 export→import 파이프라인의 **소스까지 코드로 완결**(단, 앱 저장 로직에서 log_change 호출 배선은 Supabase 쓰기 연동 시 연결 필요). psql 미접속 환경이라 DB 실행검증은 미실시(문법·타입 정합만 검토).

- **2026-07-25** **정방향 최종 이관 원샷화** `migration/migrate_all.py`(+run.sh `all`/`all-exec`): 구 MySQL 백업(sql 디렉터리 또는 단일 통합 .sql 자동분할) → Supabase 전체를 한 번에 이관(phase0 스키마→1~3 병렬적재→4 모델링·보안 후처리) + **100% 검증**(테이블별 원본행=적재행=Supabase행 대조) + **이관 리포트**(reports/*.md·json) 자동생성. 불일치/에러 시 종료코드1로 '에러없는 100% 이전' 강제. 원본(sql/*.sql) 읽기전용·기본 DRY-RUN. DRY-RUN 검증: 63파일→대상55개, 원본 총 3,930,211행 집계 정확(student_info 90,524·room_elec 1,670,841·room_reserve 627,174·g4_point 146,387·g4_score 14,271[특수EAV·1:1검증제외]), 리포트 생성 정상. reports/는 gitignore. 실제 적재는 PG_PASS+--execute 필요(미실행).

- **2026-07-25** 로그인 화면 **운영 콘솔(데이터 이관/일일 동기화)** 추가 `prototype.html`(자기완결·인라인·접두사 ops*):
  ① 로그인 카드 + 하단 관리자 바에 아이콘 2개 주입(🗄️ 데이터 이관 · 🔄 일일 동기화). ② 이관 콘솔: migrate_all.py 산출 `migration_report_*.json` 불러오기→테이블별 원본=적재=Supabase 검증표·요약·후처리·판정 렌더 + **엑셀 export**(HTML→.xls UTF-8 BOM). ③ 동기화 콘솔: 날짜선택+실행+`changes_*.json` 불러오기→테이블별 변경분 표 + 엑셀. ④ 실행(위험작업)은 러너 엔드포인트(window.OPS_MIGRATE_URL/OPS_SYNC_URL) 설정 시 호출, 없으면 실행명령 표시·복사. ⑤ **실행 인증 게이트: `kenneth / 2300555` 통과해야만 이관/동기화 실행**(오답 차단·로그 기록). Playwright 검증: 아이콘 카드2·바2, 모달·탭, 인증(오답 차단/정답 진행), 리포트 렌더(2행·PASS)·엑셀 활성, 동기화 렌더·엑셀, 콘솔에러 0. ⚠ 배포는 real 데이터 주입 소스 확인 후 진행(미배포).

- **2026-07-26** 배치도(Dormitory Status) 그룹 필터 개선: ① 그룹 드롭다운에 **`::Select group::` placeholder**(미선택 기본) 추가 — "All groups (SELECT ALL)"(value=ALL) 위. ② **조회 게이트를 center+gender+group** 으로 변경(방구분/인실은 선택적 추가필터로 강등) → 그룹까지 선택해야 배치도 렌더. 필터 로직 group!=='ALL' 가드, placeholder 안내문 갱신. Playwright 검증: placeholder·ALL 옵션·게이트(센터+성별만=미표시, 그룹선택=조회)·콘솔에러0.

- **2026-07-27** **행정팀 요구사항 5건 분석·기획**(코딩 없음) `docs/ADMIN_TEAM_REQUESTS_2026-07-27.md`: 제출 자료 2장(레거시 캡처+지적) 해독 → 레거시 DDL·신전산 prototype.html 라인 대조. 5건 모두 신규기능이 아닌 **패리티(누락)** 이슈로 판정. ①커미션 % 선택란(유학원 계약회차 `uhak_agency_com` 4,004행 기반 선택 모델 ↔ 신전산은 국적/코스/빌딩 규칙 자동계산 — **산출모델 불일치**, student_info.com_no 참조) ②변경환불 서류(`student_change` 26,857행·60+컬럼 업무축 **통째 미구현**, 코스5·기숙사8 슬롯·차액·환율) ③센터수납 현장결제(`center_pay_amount/date/memo`·`exchange_rate/date` 5필드 누락 — 컬럼은 이미 존재, **최저공수**) ④변경환불 체크목록(컬럼 정의만 있고 실동작·상태전이 없음, info_result=DICT pay_result 기 정의) ⑤학비 완납체크(pay_status 4값 중 반환(R) 누락·분납금액/환불일자 없음, 인보이스 이력 1행 하드코딩 — `student_info_invoice` 128,580행 미연결). 착수순서 제안 ③→⑤→①→④→②. **재이관 범위 (A)안으로는 4건 구현 불가 → (B)안(전체+전필드, uhak_agency_com·student_change·student_info_invoice 포함) 권장**. 행정팀 확인필요 7건(커미션 기준·소급, 완납 판정범위, 센터수납 이력, 슬롯 가변화, 승인단계, 차액 규칙) 제시.

- **2026-07-27** **레거시 계정 로그인 → Supabase 연동**(기존 아이디/비번 그대로, 사용자 결정 A):
  ① 조사(코딩전): Supabase(`bauhnnpioaephlwurxzg`)에 레거시 로그인 데이터 **전부 이관 확인** — `cms.g4_member` 2,053계정(lv10 관리자 5·lv9 1·lv8 1·lv7 스태프 24·lv5 유학원 1,583·lv3 지점 287·lv1~2 내부 151), 비번은 MySQL `PASSWORD()` 해시 2,040건 보존. 관리자 bcrypt는 `app.admin_users`(admin_auth.sql)에 기구축. `public.adminuser/user`는 0행(빈껍데기).
  ② 검증: MySQL `PASSWORD()` = `'*'+UPPER(SHA1(SHA1(pw)))`를 pgcrypto로 재현 가능 확인(공개상수 `PASSWORD('1234')=*A4B6157319…` 완전일치). → 기존 비번 무변경으로 검증 가능(A안 성립).
  ③ RPC `migration/schema/member_auth.sql`(멱등·적용완료): `app.mysql_password(text)` + `app.member_login(p_id,p_pw)`(security definer, 읽기전용). 폴백순서 **admin_users(bcrypt) → g4_member(MySQL해시)**, 성공시 {mb_id,mb_name,mb_level,source} 반환·`app.admin_activity_log`에 auth 로그, 실패시 invalid_credentials. anon/authenticated에 execute 부여(비번/해시 미반환). 실DB 테스트 통과(cebusme00/1234 lv10, cebusme1/1234 lv9, admin1/admin1 bcrypt, 오답·빈값·없는계정 거부).
  ④ 화면(`src/`): `login.php`(그누보드 flogin 재현—mb_id/mb_password/auto_login, PDO로 RPC 호출·세션·오픈리다이렉트 가드), `auth.php`(세션·require_login/require_level), `logout.php`, `index.php`에 `require_login()`+사용자바(이름·Lv·로그아웃) 주입. 컨테이너(web:8000, php8.2+pdo_pgsql)에서 구동. 로컬 PHP/도커 미가용으로 php -l 은 미실시(DB/RPC 계층은 실검증 완료).

- **2026-07-27** 행정팀 5건 **작업 투두 파일** 생성 `docs/TODO_ADMIN_TEAM_2026-07-27.md`: 대시보드(ID·상태·선행·공수) + Q(확인 7건)·D(재이관 선행)·A3/A5/A1/A4/A2 항목별 체크리스트 40여개 + 진행로그. 상태표기 ☐대기/▶진행/✅완료/⛔차단. **현재 착수 가능한 것은 Q(회신)와 A3(센터수납, 단독) 둘뿐이고 나머지는 재이관(D)+anon키 대기로 ⛔.** 코드 변경 없음.

- **2026-07-27** 배치도(room_stat3) 개선 커밋(2건 함께):
  ① 방번호·인실 셀 **rowspan 병합** — 같은 방(모든 침대)을 좌측 방번호/인실 1칸으로 합침(빌딩구분 CAPITAL1 등은 방번호 앞 표시 유지). Playwright 검증: 다침대방 10개 전부 병합·콘솔에러0.
  ② **구간막대(dlane) 렌더링**(기존 워킹트리 반영분): 하루당 `<td>` 대신 colspan 1칸 + 절대배치 막대(span) — 전체 방 조회 렌더비용 대폭↓. `.dlane/.dbar/.dcap` CSS, realPat(같은날 퇴실+입실 대각선 boutin), dcells 재작성, rsLaneIdx/rsOccAt 헬퍼, rsAfterWrite(쓰기 후 재렌더).

- **2026-07-28** **PHP 전면 폐기 → Supabase 네이티브 로그인(Edge Function, 방식 B)** 전환. 사용자 지시 "PHP 절대 사용 안 함" 반영:
  ① 인증 RPC `migration/schema/member_auth_edge.sql`(적용·테스트 완료): `app.member_authenticate(p_id,p_pw,p_ip)` = 기존 member_login 로직 + **레이트리밋(15분·10회, IP 또는 아이디 기준)** + **IP 로깅**. security definer·**service_role 전용**(anon 미노출 → 브루트포스 표면 제거). 구 2-arg member_login 은 anon 권한 회수(service_role만). 실DB 검증: 성공(cebusme00/1234 Lv10·admin1 bcrypt), 실패 거부, **잠금 동작 확인**(동일 IP 10회 후 정답도 차단·타 IP 정상·테스트로그 정리).
  ② Edge Function `supabase/functions/auth/index.ts`(Deno, **의존성 0**, Web Crypto만): GET=로그인폼/랜딩, POST login=검증→**httpOnly·Secure 쿠키 JWT(HS256) 발급**→303, POST logout=쿠키파기, GET ?me=세션JSON. 검증은 service_role 로 RPC 호출(키·로직 서버측 은닉). 레거시 로그인 화면(아이디/비번/자동로그인) 재현.
  ③ `supabase/config.toml`(verify_jwt=false, 공개 로그인) + `functions/auth/README.md`(배포순서: CLI설치→link→`secrets set AUTH_SESSION_SECRET`→`functions deploy auth --no-verify-jwt`, 접속 `…supabase.co/functions/v1/auth`).
  ⚠ 로컬에 supabase CLI·Deno 없어 함수 실행검증은 미실시(코드·DB계층은 실검증). 배포는 사용자 CLI 인증 필요 → 가이드 제공. ⚠ 기존 `src/*.php`(login/auth/logout/index/db) + web(php) 컨테이너는 **사표(死票)** — 정리 대상. ⚠ 배포 전 약한 비번(1234 등) 관리자단 must_change 강제 권장.

- **2026-07-28** **PHP 정리 + 관리자(Lv8+) 강제 비밀번호 변경** 추가:
  ① PHP 폐기 정리: `src/{login,auth,logout}.php` 삭제, `src/index.php`(조회앱)에 넣었던 로그인 가드·사용자바 원복(기존 예약 조회앱 상태로). 로그인은 전부 Edge Function 이관.
  ② 강제변경 정책 `migration/schema/member_auth_forcechange.sql`(적용·테스트 완료): member_authenticate 재정의 — **앱 자격증명(admin_users) 우선·독점**(must_change=false면 레거시 폴백 차단) + 레거시 g4_member 성공 시 **mb_level≥8이면 must_change=true**(강제). `app.member_set_password(id,old,new,ip)` 신설 — 현재비번 검증→새비번 정책(8자+·아이디≠·단순값 금지·기존≠)→**app.admin_users bcrypt upsert(원본 g4_member 불가침)**→이후 레거시 무력화. seed 되었던 legacy 관리자행(초기비번=아이디) 제거. service_role 전용. 실DB 검증 6케이스 통과: 관리자 강제(must_change=true)/유학원 비강제(false)/약한새비번 거부/정상설정/새비번 로그인 성공/**옛 1234 무력화 거부**. 테스트 데이터 롤백.
  ③ Edge Function `auth/index.ts` 확장: must_change 시 세션발급 전 **변경 화면(changePage)** 유도 + `action=change` 처리(member_set_password 호출→성공 시 쿠키 발급). README 라우팅·강제변경 문서화. 괄호균형·라우팅 정합 확인(로컬 Deno 없어 실행검증은 미실시).

- **2026-07-27** 2단계(가) Supabase Auth 배선 + 배치도 버그 2건:
  ① **Supabase Auth 로그인**: 로그인 폼 → `/auth/v1/token?grant_type=password`(email/pw)→access_token 세션 보관, `window.supaFetch(path)`(토큰 Bearer) 헬퍼, init은 supaReady 시 로그인 요구. **config-gated**(window.SUPA_URL/ANON 미설정 시 기존 동작 유지).
  ② **재실인데 공실 표시 수정**: 재실(X)은 패턴(dbar)로 그려지나 점유판정이 이름저장소만 봐서 이름 전개 멈춘 날이 공실로 오표시 → `rsBarOccAt()`(dbar 기준 재실 판정) 추가, 툴팁·셀팝업이 이름 없어도 '재실(이름 미상)'으로 처리.
  ③ **룰러 기본 ON**: `__xhRuler` 로드 시 set(true)(안내배너는 숨김).
  Playwright 검증: 룰러 기본ON·재실판정(막대내 true/밖 false)·콘솔에러0.

- **2026-07-29** **Vercel 배포 완료 — 로그인 라이브** (smeag-bay.vercel.app):
  ① 실 배포 구조 확인: 사이트는 Vercel 프로젝트 `smeag-bay`(정적 `deploy/index.html` + `deploy/api/*` 서버리스). 로그인은 Supabase Edge Function 대신 **동일 도메인 Vercel 함수**로 감(쿠키 정상 작동). service_role 키 미보유 → 함수가 **pg(pooler) 직접 접속**해 RPC 호출(키 불필요, PG_* env만).
  ② `deploy/api/auth.js`(Node 서버리스, 의존성 pg): app.member_authenticate/member_set_password 호출, HS256 httpOnly·Secure 쿠키 세션, 로그인/관리자강제변경/로그아웃/`?me`. `deploy/vercel.json` 에 `/login→/api/auth` 리라이트. `deploy/package.json` pg 의존성.
  ③ Vercel env(production) 설정: PG_HOST/PORT/DB/USER/PASS + AUTH_SESSION_SECRET(openssl rand -hex 32). `vercel deploy --prod` 배포(READY) 후 `smeag-bay.vercel.app` 별칭을 신배포로 재지정.
  ④ **실 배포 검증(라이브 DB)**: 유학원 fss_gn/1234→303+httpOnly세션쿠키 / 관리자 cebusme00/1234→강제변경화면 / 오답→401. `smeag-bay.vercel.app/login` 200. (초기 404는 CDN 캐시, 재지정 후 정상)
  ⚠ 홈(`index.html`)의 기존 프로토타입 로그인 게이트는 아직 `/api/auth` 미연결 — 작동 로그인은 `/login`(=`/api/auth`). 홈 게이트 연결은 후속.

- **2026-07-29** 배치도 그룹을 **별도 첫 컬럼(Group)** 으로 분리 + 같은 그룹 시각적 셀 병합:
  · 좌측 고정 컬럼 c0(Group) 신설(sticky left:0, c1/c2/c3 오프셋 96/182/240으로 이동), 헤더 'Group' 추가.
  · 그룹의 **첫 방에만 그룹명 표시**, 이후 방은 빈칸 + 그룹칸 위 경계선 제거 → **한 칸으로 병합돼 보임**(rowspan은 tbody 못 넘으므로 방1개=tbody·드래그방막기 구조 유지하면서 시각적 병합).
  · 그룹 첫 방은 상단 accent 경계선(그룹 구분). **방번호 컬럼에서 그룹 접두어(.bldg) 제거 → 번호만**. 기존 grp-head 밴드 제거(검색필터·셀/방 판정 영향 없음 확인).
  Playwright 검증: Group 헤더·첫방 그룹명·후속방 빈칸(병합)·방번호 번호만·콘솔에러0.

- **2026-07-29** **홈 로그인 게이트 → /api/auth 연결** (smeag-bay.vercel.app 첫 화면부터 실계정 로그인):
  ① `deploy/api/auth.js` JSON 모드 추가: Accept:application/json 요청 시 HTML 리다이렉트 대신 JSON({ok,must_change,mb_id,mb_name,mb_level,message}) 반환 + Set-Cookie 유지(폼 POST용 HTML 흐름과 병행). ② `deploy/index.html` 게이트 재배선: 클라이언트 폴백(weakHash)·5계정 화이트리스트 제거 → `authApi()`가 `/api/auth`(same-origin, 쿠키 include) 호출. 로그인/강제변경/로그아웃/init 모두 서버 세션 기준. init 은 `GET /api/auth?me`로 httpOnly 세션 확인→있으면 진입/없으면 로그인 오버레이(자동진입 폐지). enter()가 mb_name·레벨 표시. 강제변경 최소 8자로 상향, 힌트문구 갱신.
  ③ 배포 후 실사이트 전 사이클 검증: 유학원 JSON 로그인 ok+쿠키 / ?me 세션조회 / logout / 관리자 must_change→변경(Set-Cookie member_set)→새비번 로그인(admin_users)→**원복(app.admin_users 삭제)**→다시 must_change. 홈 `/`에 게이트 오버레이·`/api/auth` 배선 확인. smeag-bay.vercel.app 별칭 신배포 재지정.
  ⚠ 이제 홈 접속 시 로그인 필수(기존 자동진입 제거). 운영콘솔 등 기존 스크립트는 로그인 후 session() 존재하므로 정상.

- **2026-07-29** **로그인 화면 지점(세부/딸락) 선택 추가** `deploy/index.html`:
  ① 로그인 카드 왼쪽(aa-left)에 세부(CEBU)/딸락(TALAK) 세그먼트 버튼 추가(기본 세부 활성). ② 선택값 sessionStorage(smeBranch) 저장, `applyBranch()`가 로그인 후 상단 메뉴 타이틀(.top .brand)을 지점명으로 교체 — 화면·기능은 동일, 타이틀만 세부/딸락. enter() 및 세션복원 시 반영. ③ Playwright 실검증(smeag-bay.vercel.app): 기본 cebu→딸락 클릭 talak 활성→fss_gn 로그인→메뉴 타이틀 "S 딸락 ADMIN · 신규" 확인(PASS). 테스트 로그 정리. 배포·별칭 재지정 완료.

- **2026-07-29** 세로(버티컬)·좁은 뷰포트에서 배치도 방셀이 어긋나 보이던 문제 수정: 원인은 `.app` 그리드가 `1fr`이라 넓은 배치도 표가 트랙을 밀어 `.main`이 뷰포트를 초과(내부 스크롤이 아니라 페이지째 가로 넘침, twW 1651>vw). `.app{grid-template-columns:minmax(0,1fr)}` + `.main{min-width:0}` 로 트랙 축소 허용 → 래퍼가 뷰포트 내(852≤900)로 잡혀 표 내부 스크롤 복원. Playwright(900 세로) 검증: twW 1651→852. (모든 넓은 표에 공통 개선)

- **2026-07-30** **신시스템(배포본 `deploy/index.html`)에도 배치도 '구분' 컬럼 적용** — 프로토타입에만 있던 첫 컬럼을 라이브 화면으로 이관:
  · 좌측 고정 c0(구분/Group) 컬럼 신설(sticky left:0, c1/c2/c3 오프셋 96/182/240), 헤더 `${T('구분','Group')}`. `INFOW=GRPW(96)+86+58+nameW` 로 정정(프로토타입도 동일 수정 — 표 폭·선택월 센터링 오차 제거).
  · 그룹의 첫 방(tbody `.grp-first`)만 라벨 표시, 나머지는 `.grpname{visibility:hidden}` + 그룹칸 상단 경계 제거 → **한 칸으로 병합돼 보임**. 방번호 컬럼에서 그룹 접두어(.bldg) 제거, 기존 grp-head 밴드 제거.
  · 검색 시 첫 방이 걸러져 그룹명이 사라지는 문제 대비: 검색 중 `table.gantt.rs-filtering` → 남은 모든 행에 구분 라벨 표시(프로토타입에도 동일 적용).
  · Playwright 검증(deploy/index.html, CAPITAL·MALE·전체그룹): 헤더 `Group|Room Number|Room Type|Name`, 첫방 grp-first+CAPITAL1, 후속방 병합표시, 방번호 번호만, '301' 검색 시 2행 각각 구분 라벨 표시, 콘솔에러 0(로컬 file:// 의 /api/auth 제외).
