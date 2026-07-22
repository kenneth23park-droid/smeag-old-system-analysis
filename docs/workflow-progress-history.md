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
