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

- **2026-07-30** **배치도 방구분(카테고리) 파리티 — 구시스템 24개 확인 후 신시스템 반영**:
  · 근거(원본 읽기전용): `sql/room_category.sql` `g_display='Y'` = **30그룹**, `bldg_type='E'`(CAPITAL 센터) **24개** / `bldg_type='S'`(ENCANTO 센터) **6개**. `sql/room_list.sql`(r_state='Y') 조인 = **416방/1016베드**. 레거시 `room_stat2.php` 드롭다운 30개 목록과 일치(크롤 `exploration/crawl_results.json` 대조).
  · 원인: 신시스템 배치도는 `REAL.roomstat` 미주입 시 **목데이터 4그룹(TEMPORARY·CAPITAL1/M·CAPITAL2/F·S hotel(H))** 만 생성 → 방구분 드롭다운이 3개로 보였음(구시스템 24개 대비 부족).
  · 조치: 목데이터를 레거시 실구성 압축표(`LEGACY_CATS`, `g_name|성별|센터|방번호*침대수`)로 교체 → **30그룹/416방/1016베드**, g_order 순서까지 레거시와 동일. `deploy/index.html` + `docs/design-admin/prototype.html` 동시 적용.
  · `campusOf` 정정: `TEMPORARY`→CAPITAL(bldg E), `Casablu`→**ENCANTO**(bldg S, 기존엔 CAPITAL로 오분류).
  · 용어 정리: 레거시 `room_gubun`=방구분=**카테고리** → 그룹 셀렉트 라벨을 `방구분(카테고리)/Room category`, 인실 셀렉트는 `인실(정원)/Beds per room`(신시스템 추가필터)로 명확화.
  · Playwright 검증: CAPITAL+전체성별 → 방구분 **24개**(TEMPORARY … Canberry(Cb)_Family, 레거시 순서 동일), ENCANTO → **6개**(Casablu·ENCANTO2·3·4·VIP·O), 전체선택 렌더 **335방/713베드**(=bldg E 실측치), 인실=3 필터 85방·전부 3-person, Amethyst(AM)_F 단일선택 19방, 페이지에러 0.

- **2026-07-30** **배치도 방셀 "클릭 안 됨 · 정보 안 보임" 수정 (배포본 누락 이관 + 인실칸 잘림)**:
  · 원인1(핵심): 2026-07-29 프로토타입에만 적용했던 좁은/일반 뷰포트 가로넘침 수정이 **배포본 `deploy/index.html`에 미이관**. `.app{grid-template-columns:1fr}` + `.main{overflow-x:hidden}`(min-width 없음) → 넓은 배치도 표가 그리드 트랙을 밀어 래퍼가 뷰포트 초과(1280 화면에서 twW **1651**), 표 내부 가로스크롤 대신 페이지째 넘쳐 화면 밖 방셀은 보이지도·클릭되지도 않음. → `.app{grid-template-columns:minmax(0,1fr)}` + `.main{...;min-width:0}` 이관(twW 1280→**1232**, 1024→**976**).
  · 원인2: 상단 필터 셀렉트 줄(inline flex)이 `flex-wrap` 없어 폭 1375px로 넘침 → 1280 화면에서 검색창이 화면 밖. → `flex-wrap:wrap` 추가(2줄 배치).
  · 원인3: 인실(Room Type) 칸 58px < `3-person` 칩 폭 → 이름열(sticky) 아래로 잘려 "3-perso"로 보임. → 컬럼 80px, `.c3` sticky offset 240→**262px**, `INFOW=GRPW(96)+86+80+nameW`. `deploy/index.html` + `docs/design-admin/prototype.html` 동일 적용.
  · Playwright 검증(1600/1280/1024/820): 방번호셀 클릭→ROOM REPLACEMENT 모달, 일자레인 클릭→셀액션 팝업(#cellpop), 이름 클릭→학생정보 모달 모두 정상, 인실칩 전체 표시, 페이지에러 0.

- **2026-07-30** **배치도 이름 클릭 → 학생정보 + 그 학생의 방 셀(점유구간) 동시 강조** (`deploy/index.html`):
  · 기존: 이름 클릭 시 STUDENT INFORMATION 모달만 열림(방 셀에서 그 학생이 어느 날짜·어느 방을 쓰는지 눈으로 못 찾음).
  · 추가: `rsHighlight(name, scroll)` — `window._rsOcc`(침대별 점유 세그먼트)에서 그 이름의 세그먼트를 배치도 전 범위에서 찾아 `.dlanein` 위에 `.rs-hl` 오버레이(accent 테두리+반투명 배경)를 올리고, 이름칸 행(`tr.rs-hl-row`)·방번호 셀(`tbody.rs-hl-block`)·클릭한 이름칩(`.rs-nameseg.on`)을 함께 강조. 방을 옮긴 학생은 **여러 방 행이 동시에** 강조된다.
  · 강조구간이 가시창 밖이면 그 날짜로 가로 스크롤(첫 세그먼트 -2일 위치, smooth).
  · 세그먼트 정보가 없는 샘플데이터(REAL 미주입) 폴백: 이름이 일치하는 침대의 재실 막대(.dbar) 전체 강조.
  · 유지/해제: 모달을 닫아도 강조 유지(배치도에서 계속 추적) · **Esc** 로 해제(`rsClearHl`) · 다른 이름 클릭 시 자동 교체. 스크롤로 이름칸이 재렌더돼도(`rsUpdateNames`) 강조 칩 복원. 모달 상단에 안내 note 추가(EN/한).
  · Playwright 검증(file://, CAPITAL1/Male): 이름칩 클릭 → `.rs-hl` 생성 + `tr.rs-hl-row` 1행 + STUDENT INFORMATION 모달, Esc → 강조 0개, 페이지에러 0. 모바일(`deploy/m/index.html`)에는 배치도 이름칩이 없어 대상 아님.
  · **라이브 배포 완료**: `smeag-eil3qdwxk-jitnet-7048s-projects.vercel.app` → 별칭 `smeag-bay.vercel.app` 재지정. 라이브 Playwright 검증: 이름칩 클릭 → `.rs-hl` 강조 + 행/방번호 강조 + STUDENT INFORMATION 모달(안내 note), Esc → 해제, 페이지에러 0. (이후 화면 변경은 **항상 배포까지** 진행)

- **2026-07-30** **배치도 실데이터 주입 빌드 + 라이브 반영** (구시스템과 내용이 달랐던 근본 원인 해소):
  · 원인: 배포본 `deploy/index.html` 은 `let REAL=null` 상태로 나가서 **목데이터(fakeName 랜덤 이름·랜덤 입퇴실)** 로 렌더 → 방 골격만 맞고 셀 내용이 레거시와 전부 달랐음. (`/api/data` 라이브 경로는 로그인 세션 필요)
  · `migration/build_roomstat_real.py` 신설 — sql 덤프(읽기전용) 조인: `room_category(g_display='Y')` 30그룹 × `room_list(r_state='Y')` 416방/1016베드 × `room_reserve`(2025-01-01~2027-12-31 창) → 침대슬롯별 연속구간 세그먼트 **12,887건**, `student_info` 로 표시이름·홀딩플래그. 값 파서는 escape(`\'`,`''`)·콤마 포함 문자열·멀티라인 text 연속행 방어.
  · seg.h(홀딩) 대상에 `checking`/`waiting` 포함 — 'Tammy for …' 등 담당자 임시선점이 실학생 뒤 이름칸에 끼는 문제 제거(레거시 규칙 재현).
  · `migration/inject_realdata.py` 신설 — `let REAL=null; /*__REALDATA__*/` 자리를 `JSON.parse('…')` 로 교체(멱등). 세션 없이도 실데이터 표시, 로그인 시 `/api/data` 응답이 덮어씀. index.html 367KB → 1.5MB.
  · **버그 수정**: `genderOf` 가 `'CAPITAL3 / FEMALE'`(슬래시 뒤 공백)을 못 읽어 **성별=FEMALE/FAMILY 선택 시 방구분 드롭다운이 비활성**됐음 → `/\/\s*FEMALE/` 등으로 수정(FEMALE·FAMILY 를 MALE 보다 먼저 판정). deploy·prototype 동일 적용.
  · 검증(Playwright): 301-1 `준블락_single use` · 301-2 `staff_준매니저` · 519호 4침대 `Margarita Rodikova-XU WEI / RINKA MIYASHITA-LIN CHUN CHIEN-TASHIRO KAON / Sofia Ryzhmanova-HSU JIA JIE / Sofia Kiseleva` = 레거시 대조값 일치. 방구분 CAPITAL 24개(남8·여8·공용8)/ENCANTO 6개, 전체 조회 335방·713베드 렌더 405ms, 이름 누락 0건, 페이지에러 0.
  · 배포: `vercel deploy --prod` + **`vercel alias set` 로 `smeag-bay.vercel.app` 별칭 재지정**(직전 배포는 별칭이 이동하지 않아 구버전이 보이고 있었음) → dpl_CyvMFZPLmYxJCLkAWawoiUViWbSs.

- **2026-07-30** **메뉴를 고르면 DB를 먼저 최신화하고 그 값으로 화면을 그린다 (라이브 조회 `/api/data` 신설)**:
  · 요구: "메뉴 선택 시 데이터베이스를 갱신하고 최신 정보를 보여줄 것". 기존은 빌드시 주입 스냅샷(`inject_realdata.py`)이라 화면이 배포시점 값에 고정.
  · `deploy/api/data.js` 신설 — Vercel 서버리스 → Supabase Postgres **읽기 전용**(select 만, 레거시 MySQL 무접속). 인증은 `/api/auth` 가 발급한 httpOnly 쿠키 세션(`sme_session`) 필수, 없으면 401. **유학원 계정(Lv8 미만 + 아이디가 실제 uhak_id)은 자기 유학원 학생만** 조회(PII 최소노출, 검증 `blued` → 1,297건).
  · 조각(parts) 단위 조회 — `students`(legacy.student_info 2025년 이후 슬라이스 **12,389건**, 화면 18칸 배열) · `roomstat`(선택월 ±6개월 창: room_category 30그룹 × room_info 418방 × room_list 1,024베드 × room_reserve 일자행을 예약단위로 압축한 **6,351구간**) · `pickup`(주간 목→다음주 수, 편명·도착시각 파싱 + 신입(In) 판정) · `groups`(student_group_info 12) · `deposits`(student_payment ⨝ student_info, 상한 3,000건) · `changelog`(room_change_log 최근 300).
  · 생년월일은 `app.jumin_to_birth(s_jumin)` 결과가 **1930~올해 범위일 때만** 채택(외국인은 주민칸이 여권번호 등 잡값이라 1820년대 같은 오연도가 나옴) → 나머지는 기존 화면 로직대로 저장나이 근사(≈) 표시.
  · 클라이언트(`deploy/index.html`): 메뉴 클릭·해시이동 → `goMenu()` = **DB 최신화 → 렌더**. 조각별 TTL 캐시(학생 60초·배치도 5분·그룹 10분) + ETag 304 + 동일요청 중복발사 차단(inflight). 이미 데이터가 있으면(주입 스냅샷 포함) 즉시 그린 뒤 새 값 도착 시 교체, 없으면 "불러오는 중" 후 렌더. 상단에 **상태배지**(`DB 최신 HH:MM:SS` / 갱신중 / 오류·캐시표시 / 로그인 필요)와 **수동 ⟳ 버튼**(현재 화면 강제 재조회). 배치도 월 이동은 즉시 표시 + 백그라운드로 해당 창 보강. 로그인 게이트 `enter()` 직후 자동 최신화. 실패 시 이전 데이터 유지 + 토스트.
  · 모바일(`deploy/m/index.html`): 탭·전체메뉴·스위처 이동을 `navRender()`(최신화 → 렌더)로 통일, 앱바 ⟳ 버튼 = 상태표시 겸 수동 재조회.
  · **부하 대책**(질문 반영): ① 조회 인덱스 9개 추가(`legacy.student_info` s_departure/s_sdate/s_edate/s_regdate/lower(uhak_id)/e_name/timestamp, `student_payment.deposit_day`, `room_reserve(rr_date,r_idx)`) — 인덱스는 **Supabase 이관본에만**, 원본 MySQL 불가침. ② warm 인스턴스 커넥션 재사용 ③ 버전스탬프(=변경 흔적 해시) 기반 서버 메모리 캐시 90초 ④ 픽업 신입판정 쿼리를 전체 90k 그룹핑 → 대상자 한정 CTE로 축소(2,418ms → **576ms**).
  · 측정(실 DB): 학생 cold **1,451ms/2,191KB** → 메모리캐시 **134ms** → 304 **134ms/0KB**, 배치도 cold **1,423ms/573KB** → 캐시 137ms, 버전스탬프 136ms, 픽업 576ms, 입금 639ms, 변경이력 290ms.
  · 검증(Playwright, 로컬서버+실 핸들러): 부팅 1회 조회 → 배지 `DB 최신`, 수강등록관리 **12,389건** 실데이터, 배치도 30그룹·"실데이터(MySQL) 2026-01-01~2027-01-31", 같은 메뉴 재진입 **추가호출 0**, ⟳ → 재조회, 주간픽업 65행(날짜그룹 헤더 포함), BACK-UP LOG 300행, Group Students 12행(`?parts=groups`), DEPOSIT 3,000행(`?parts=deposits`), Deposit(test) 캐시재사용 0회, 모바일 탭 이동(홈 students+roomstat / 픽업 62행) 정상, 페이지에러 0.
  · 검증 하네스: `exploration/live-data/`(perf·probe·e2e·e2e2·e2e_m + README).
  · 남은 제약: `REAL.tables`(레거시 크롤 표 16종)는 DB 파생이 아니라 그대로 스냅샷 사용 · DEPOSIT 3,000건 상한(전체 12,336건 중 최신순) · 로그인 세션이 없으면(게이트 폴백 로그인) 라이브 조회 대신 스냅샷/샘플 표시.

- **2026-07-30** 배치도 구분 컬럼 **같은 그룹 셀병합 + 라벨 그룹내 고정(sticky)**:
  · 셀병합: `rowspan` 은 tbody 를 넘을 수 없고 배치도는 '방1개=tbody1개'(드래그 방막기·content-visibility 가상화 단위)라, **구분칸의 그룹 내부 가로선 제거**(`td.c0{border-bottom:0}`) + **그룹 마지막 방(`grp-last`)에만 accent 아래경계** → 실제 병합셀과 동일한 모양.
  · 라벨 고정: `rsPinGrpLabels(tw)` 신설(가로/세로 스크롤 rAF 핸들러 + 초기 1회). 라벨을 `position:absolute` 로 바꾸고, **고정헤더 바로 아래 지점을 `elementFromPoint` 로 찍어** 그 시점 '헤더에 걸린 방'(`grp-pin`)의 구분칸 안에서 라벨 top 을 헤더 밑으로 이동(칸 밖으로는 안 나가게 clamp). 그룹 원위치 라벨은 `grp-mute` 로 숨겨 중복 방지.
  · ⚠ 화면 밖 tbody 는 `content-visibility:auto` 로 렌더 스킵되어 `getBoundingClientRect`/`offsetTop` 이 부정확 → 전체 tbody 순회 방식은 폐기하고 elementFromPoint(O(1)) 로 확정. 또 thead 자체 rect 은 sticky 가 아니라 th 셀만 sticky → 기준선은 `래퍼 top + thead 높이` 로 계산.
  · Playwright 검증(CAPITAL·MALE·전체그룹 147방/8그룹): 스크롤 0/700/1600/4000 에서 **그룹당 라벨 정확히 1개**, 현재 그룹 라벨이 헤더 바로 아래 유지, 다음 그룹은 시작 위치에 표시. 그룹 중간 방 구분칸 아래테두리 0px·grp-last 만 2px. 검색('321') 1건 필터 시 남은 행 라벨 표시. 콘솔에러 0. (셀 클릭 팝업 동작은 변경 전/후 동일 — 본 변경과 무관)
  · **구분 표기 구분자 변경**: 방구분 드롭다운 라벨을 `CAPITAL1/Male` → **`CAPITAL1 - Male`** (`grpLabel` 반환부). deploy·prototype 동일 적용, 24개 목록·콘솔에러0 재검증 후 배포+별칭 재지정.

- **2026-07-30** 배치도 하단 배지 `Real MySQL reservations (undefined~undefined)` 정리:
  원인 — `/api/data` 응답은 `roomstat.from/to` 키를 주지만 정적 주입본(`inject_realdata.py`)은 `roomstat.meta.window` 만 담고 있어, 세션 없이 초기 로드하면 `from/to` 가 undefined.
  · 화면: 표시범위 라벨을 `from/to` → 없으면 `meta.window` → 둘 다 없으면 **라벨 자체 생략** 으로 폴백(`rsRange`). deploy/index.html · prototype.html 동일.
  · 생성기: `build_roomstat_real.py` 가 `roomstat.from/to` 를 함께 출력, `inject_realdata.py` 는 구버전 JSON 도 `meta.window` 로 from/to 를 채워 주입(재실행 시 자동 보정).
  · 검증: 배치도 배지 `(2025-01-01~2027-12-31)` 정상 표시. 전체 60개 화면 순회 스윕에서 `undefined`/`NaN`/`[object Object]` 0건, 콘솔에러 0.

- **2026-07-30** **배치도 방 셀 이름·기간 오버레이(반투명) + 투명도 조절 — 룰러 아래 컨트롤**:
  · 구간막대마다 `<span class="dlab">학생명 · MM/DD~MM/DD</span>` 를 렌더 시 심고(점유 세그먼트 = `occStore`(bed.occ) 의 창클램프 목록 재사용), 표시는 **테이블 클래스 `rs-dlab` + CSS 변수 `--dlabop`** 로만 제어 → 토글·투명도 변경에 **재렌더 없음**.
  · 컨트롤: 룰러 버튼 **바로 아래**(`.rs-lblstack` 세로 스택) 에 `🏷 이름·기간` 토글 + **range 슬라이더(10~100%, 기본 50%)** + 현재값 표시. 슬라이더를 움직이면 자동 ON. 상태는 localStorage(`smeag-dlab`,`smeag-dlabop`) 유지, 재렌더 후 `__xhDlab.apply()` 로 복원.
  · z-index 미지정(DOM 순서상 막대·X캡 위, 좌측 고정열 z-index:1 아래) → **라벨이 구분/방번호/인실/이름 고정열을 덮지 않음**. X 무늬 위 가독성용 얇은 후광(text-shadow).
  · 검증(Playwright): 기본 OFF·라벨 273개 심김, 토글 ON→`display:block`, 10/25/50/90% 전환 시 `--dlabop`·표시값 동기화, 그룹 변경 재렌더 후 상태 유지, 페이지에러 0. 캡처 `exploration/shots/new_roomstat_dlab.png`.
  · 배포 + `smeag-bay.vercel.app` 별칭 재지정 완료.

- **2026-07-30** 방막기(Block) **제약 2건 해소 — 공유 저장 + 기간 차단**:
  ① **서버 원장 신설** `migration/schema/room_blocks.sql`(멱등) — `app.room_blocks`(room_key='BX|그룹|방번호' · bed_no 0=방전체 · from/to NULL=무기한 · reason MAINT/CLEAN/HOLD/ETC · created_by/verified · released_at/by 소프트해제로 이력보존) + RPC 3종(`room_block_list/_set/_release`). 중복 방지 3중(활성블록 UNIQUE 부분인덱스 · idem_key UNIQUE · ON CONFLICT). Supabase 실적용 후 12케이스 검증(기간차단/재전송replay/같은구간/다른구간/무기한/역순범위거부/잘못된사유보정/겹침조회/해제/재해제멱등) 통과.
  ② **`/api/blocks` 서버리스**(deploy/api/blocks.js) — pg 풀러 직결(anon 키 불필요, /api/data 와 동일 패턴). GET 목록 · POST block/release. actor 는 JWT 세션쿠키 우선, 없으면 `X-SME-User` 헤더(verified=false 로 정직 표기) → 로그인 게이트가 꺼져 있는 현 상태에서도 동작하고, /api/auth 로그인을 켜면 무수정으로 승격.
  ③ **프런트(배치도·DORM LIST, deploy/index.html + prototype.html 동기)** — localStorage 전용 저장을 서버 공유로 전환(`BLK` 캐시 + 오프라인 폴백 + 기존 localStorage 차단분 1회 자동 승격). **날짜축 가로 드래그 → 그 기간만 Block**(사유 선택·메모·2인실 이상은 침대/방전체 범위 선택), 간트에 사유별 색 빗금 막대 렌더, 막대 클릭 → 등록자·시각 표시 후 해제. 좌측 고정열 세로 드래그(방 전체 무기한)는 기존대로 유지.
  ④ 부수 수정: DORM LIST 키를 `RL|<NO>` → 배치도와 같은 `BX|<그룹>|<방번호>`로 통일(두 화면 차단상태가 서로 안 보이던 문제) · 기간 막대 클릭이 ROOM REPLACEMENT 를 동시에 열던 문제 · 드래그 직후 click 이 해제 모달을 여는 문제.
  ⑤ 검증: 로컬(dev server)·**라이브 모두 Playwright 통과** — 새 브라우저 프로필(localStorage 비어있음)에서 타인이 만든 블록이 보임(=공유 성립), 침대범위 선택, 같은 구간 재등록 시 막대 증가 없음(멱등), 막대 클릭 해제 후 제3 프로필에서도 해제 반영, 콘솔에러 0(잔여 401 은 기존 /api/data 세션 미연결 건).
  ⑥ 배포 이슈 발견·해결: `smeag-bay.vercel.app` 별칭이 15분 전 배포(dpl c77sk1dfy)에 **고정**돼 있어 `vercel deploy --prod` 를 해도 라이브가 갱신되지 않았음 → `vercel alias set` 으로 최신 배포에 재지정. 이후 라이브 = 로컬 바이트 동일(1,561,081).
  ⚠ 남은 것: 모바일 `/m/` 미반영 · 막힌 방에 배정 시 실제 차단(프리플라이트 연동) 미구현 · actor 가 로그인 게이트 비활성으로 'anonymous'(로그인 켜면 자동 해소).

- **2026-07-30** 인보이스 커미션 정책 명시 — **PRE PAY(선불금)는 커미션에 반영하지 않음**:
  · 현황 확인: 커미션 산정은 SMI 모달 1곳(`calcComm(nat,course,campus,tuition)`)에서만 수행 · 기준값이 `tuition`(=주차×주단가, prePay 차감 전)이라 **금액상 이미 prepay 제외** 상태였고 `grand`(=regist+tuition+dorm+etc−prePay)는 TOTAL/NET 표기에만 사용. 등록금·인보이스(financial) 화면·PDF 는 커미션 항목이 없어 영향 없음.
  · 조치: 커미션 기준학비를 별도 상수 `commBase=tuition` 로 분리 + "PRE PAY 는 커미션에 반영하지 않는다 / grand 사용 금지" 주석 명시(향후 `grand` 로 잘못 바뀌는 회귀 차단). COMMISSION INFO 행에 `(PRE PAY 450$ 커미션 미반영)` 근거 표기 추가. COMMISSION RULES 화면 배너에도 정책 문장 추가(KO/EN).
  · 적용 파일: `deploy/index.html`, `docs/design-admin/prototype.html`(동기).
  · 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app` 재지정 → 라이브 = 로컬 바이트 동일(1,567,945), 라이브 문구 확인(`커미션 미반영`, `PRE PAY is excluded from commission`).

- **2026-07-30** 수강등록관리(Course Registration) 표 표기 정리 — PERI 주단위 · COURSE 레거시식 코스명 · 이름 클릭 비활성:
  · **PERI**: `s_period`(주 단위 정수)를 그대로 숫자만 찍던 것을 `periW()` 헬퍼로 **`16w` / `2w`** 형태 표기(0·빈값은 `—`). 엑셀 내보내기도 동일 표기.
  · **COURSE**: 학생행의 `course_info` 는 코스 **코드**(46·94·14 …)라 숫자가 그대로 노출되던 것을 `courseNameOf()`(course_list.php 마스터 캐시, 필터 드롭다운이 이미 쓰던 매핑)로 **레거시와 같은 코스명**으로 표시. 원 코드값은 셀 title 로 유지, 마스터에 없는 코드는 코드 그대로 폴백. 엑셀도 코스명.
  · **이름 클릭 → 상세정보 비활성화**(요청): `#stdBody` 위임 핸들러에서 `.std-name` 분기 제거 + 링크형 CSS(밑줄·포인터·강조색) 해제. 상세 진입은 ACTION 의 `Edit` 버튼으로 일원화. 프로토타입(prototype.html)은 이미 비활성 상태여서 표기 2건만 동기.
  · 적용 파일: `deploy/index.html`, `docs/design-admin/prototype.html`(동기).
  · 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app` → 라이브 = 로컬 바이트 동일(1,568,149).

- **2026-07-30** 배치도(기숙사현황) **좌측 고정열 폭 드래그 조절** — 이름칸 좌/우 양쪽 경계:
  · 요청: "name column left and right side can adjust cell" — 이름 컬럼을 프리셋(4단계 셀렉트)이 아니라 셀 경계 드래그로 직접 조절.
  · 구현: 좌측 고정 4열 폭을 `roomFilter.colW=[구분,방번호,인실,이름]` 배열로 통합(`localStorage 'smeag-colW'`, 구버전 `'smeag-nameW'` 자동 승계). 표 머리글에 드래그 핸들 `.rs-rz` 4개 — 구분·방번호는 우측 경계, **이름칸은 좌·우 양쪽**. 이름 **우측** = 이름폭 자체(표 전체폭 증가), 이름 **좌측** = 인실↔이름 경계 이동(둘이 폭을 주고받아 좌측 고정폭 총합 유지). 각 핸들 **더블클릭 = 기본폭 복원**. 최소폭 `[48,44,40,90]`·최대 900px.
  · 고정열 `left` 오프셋이 96/182/262px 하드코딩이라 폭 변경 시 어긋나던 문제 → 테이블 CSS 변수 `--w0~--w3` + `calc()` 로 전환. 드래그 중에는 재렌더 없이 `rsApplyColW()` 가 CSS 변수·`<colgroup>`·표 전체폭·스크롤 계산용 `data-infow` 만 갱신(13개월 표 재생성 비용 회피).
  · 기존 `#rsNameW` 셀렉트는 유지 — 드래그로 만든 임의 폭은 `이름 사용자 지정 (405px)` 옵션으로 반영(`rsSyncNameWSel`). 방막기 드래그와 충돌하지 않도록 핸들에서 `pointerdown` stopPropagation.
  · 적용 파일: `deploy/index.html`, `docs/design-admin/prototype.html`(동기).
  · 검증: 로컬·**라이브 Playwright 통과** — 이름 우측 +150px→`--w3 380px`·`data-infow 642`, 이름 좌측 −25px→인실 55px/이름 405px(총합 유지), 더블클릭 초기화, 리로드·재렌더 후 유지(localStorage), 고정열 `left` 재계산 정상, 콘솔에러 0.
  · 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app` → 라이브 = 로컬 바이트 동일(1,568,149).

- **2026-07-30** 배치도 학생정보 모달의 **DORMITORY RESERVED INFORMATION = 레거시 `student_room.php` 와 동일한 방 패턴**:
  · 레거시 원본 확인(Playwright, 읽기전용): 배치도 이름 클릭 → `open_student(s_idx)` → `adm/student_room.php?s_idx=…` 팝업. 그 표는 **예약행(room_reserve 예약단위) 1건 = 1행** 으로 `ROOM NUMBER / CAPACITY(‘4bed’ 처럼 침대수) / PERIOD` 를 나열. 실측: s_idx 98597 → `311 · 3bed · 2026-05-17~06-13`, 연장분 s_idx 100134 → `337 · 4bed · 06-14~06-20`, `337 · 4bed · 06-21~06-27`.
  · 신전산 문제: 이 표가 항상 **1행 고정**이었고 값도 클릭한 방(`room`)·`s_period`(→ `2wk`)를 그대로 찍어 **방번호·정원 모두 레거시와 불일치**(예: 337 구간인데 `311 / 2wk` 표시).
  · 조치 ①(API) `/api/data` roomstat 세그먼트에 **`si`(예약주체 s_idx)** 추가 — 동명이인·연장(별도 s_idx) 예약이 섞이지 않게.
  · 조치 ②(화면) 모달에서 `_rsv`(예약행 단위, 병합 없음)를 만들어 표를 **행 반복 렌더** — 방번호는 방 그대로, CAPACITY 는 `room_info.i_limit` 에서 뽑은 **`N bed`**, PERIOD 는 각 예약행 구간. `si` 매칭 0건이면 이름 매칭으로 폴백. 기존 **ROOM MOVE PATH** 는 이 `_rsv` 를 같은 방 연속구간으로 병합해 그대로 유지(레거시에 없는 부가 정보).
  · 적용 파일: `deploy/api/data.js`, `deploy/index.html`, `docs/design-admin/prototype.html`(동기).
  · 검증: 로컬 Playwright(실 DB) — SHANG BOWEN 모달이 `337 / 4bed / 06-14~06-20`, `337 / 4bed / 06-21~06-27` 로 **레거시 캡처와 행·값 일치**, 콘솔에러 0.
  · 배포: `vercel deploy --prod` → 라이브(`smeag-bay`) = 로컬 바이트 동일(1,568,149).
  · ⚠ 남은 것: 레거시는 **클릭한 예약의 s_idx** 로 팝업을 열지만, 신전산은 이름칸이 침대 단위 합성문자열이라 학생 s_idx 를 **이름 매칭**으로 정한다 — 원본/연장처럼 같은 이름의 s_idx 가 여러 개면 그중 하나(먼저 매칭된 레코드) 기준으로 표가 그려진다.
  · **후속(같은 날)**: 핸들을 `mousedown/mousemove` → **Pointer Events**(`pointerdown` + `setPointerCapture` + `pointermove/up/cancel`)로 교체 — 마우스뿐 아니라 **터치·펜(태블릿)** 에서도 조절 가능. 핸들에 `touch-action:none` 을 줘서 터치 드래그가 표 가로스크롤로 새지 않게 하고, 포인터 캡처로 커서가 핸들 밖(세로 300px 이탈)으로 나가도 추적 유지. 방막기 모드 ON 상태에서 핸들 드래그 시 **폭만 변경·블록 미생성** 회귀 확인. 모바일 `/m/` 은 카드 리스트(간트표·이름컬럼 없음)라 대상 아님.
  · 검증: 로컬·라이브 Playwright — 마우스 +140px→`--w3 370px`(이탈 추적 OK), 터치 +120px→`350px`(`scrollTop` 0 유지), 좌측 pair 핸들·더블클릭 초기화 정상, 콘솔에러 0. 라이브 = 로컬 바이트 동일(1,571,471).

- **2026-07-30** **실데이터 페이지 서버측 보호 (Edge Middleware 게이트)** `deploy/middleware.js` 신규:
  · 문제: 배포본 `index.html` 에 실 MySQL 데이터(학생 실명·기숙사 배정)가 임베드되는데 로그인 오버레이는 **클라이언트측**이라, 미로그인 상태의 공개 URL(`https://smeag-bay.vercel.app/`)에서 **HTML 소스에 실명이 그대로 내려갔다**(1.5MB, 실명 검색 hit).
  · 조치: Vercel Edge Middleware 로 정적 페이지 자체를 게이트. `/api/auth` 가 발급한 HS256 세션쿠키(`sme_session`)를 **Web Crypto 로 서명·만료 검증**, 실패 시 `302 /login?next=…`. 제외: `/api/*`(각 함수 자체 인증) · `/login` · favicon/robots · `_vercel`. `AUTH_SESSION_SECRET` 미설정이면 로그인 자체가 불가하므로 통과(fail-open, 사이트 잠금 방지).
  · 검증(라이브): 쿠키 없음 `/` → **302 /login?next=%2F** (응답 15바이트, 실명 **0건**) · 위조 쿠키 → 302 · `/m/`(모바일) → 302 · `/login` → 200 · `/api/data` → 401(기존 유지). 서명 호환성은 `auth.js signSession` ↔ `middleware verifySession` 로컬 교차검증(정상/위조/만료/한글 payload) PASS.
  · 되돌리기: `deploy/middleware.js` 삭제 후 재배포. 배포 `smeag-m32t2xpj7-…` → 별칭 `smeag-bay.vercel.app`.

- **2026-07-30** ROOM REPLACEMENT(방변경) 학생정보 표 — **레거시 reserve_move.php 패턴 그대로**(요청: "room replacement pattern view same like legacy"):
  · 기존: 라벨·값 1쌍씩 세로로 쌓인 2칸 표(NAME→KOR→AGE→SEX…) + 코멘트칸은 빈 textarea(rows=2).
  · 변경: 레거시와 같은 **4칸 페어 레이아웃**(한 줄에 라벨·값 두 쌍) — `NAME|KOR` / `AGE|SEX` / `DEPARTURE|FLIGHT` / `COURSE|DORM` / `NATIONALITY|CONDITION`, 그 아래 `STAFF COMMENT` · `AGENTS COMMENT` 는 라벨 + 값 3칸 병합 큰 코멘트칸(rows=5). `table-layout:fixed` 로 값 2칸 폭을 동일하게(레거시 좌우 대칭), 라벨칸 136px(=`AGENTS COMMENT` 한 줄).
  · 제목도 레거시식으로 `※ STUDENT INFORMATION : <s_idx>` (기존 코드의 `stu.__idx` 는 어디서도 세팅되지 않아 항상 안 나오던 죽은 참조였음).
  · **/api/data studentsFull 5칸 추가**(18~22): `18 SID(s_idx)` `19 COURSE_TXT(fee_class2)` `20 DORM_TXT(fee_dorm2)` `21 AGENT_CMT(s_info)` `22 STAFF_CMT(comment)`. COURSE/DORM 은 그동안 파생값(`4주 · 코스 17`, 방번호)을 보여줬는데 레거시는 원문구(`6 weeks-IELTS 6.0`, `6 Weeks- 3 Persons/room-CAPITAL ,`)를 쓰므로 원값 우선 + 기존 파생값 폴백. 코멘트 2칸은 text 라 `left(...,400)` 으로 잘라 페이로드 방어. `comment` 는 PG 키워드라 큰따옴표 인용.
  · 적용 파일: `deploy/api/data.js`, `deploy/index.html`, `docs/design-admin/prototype.html`(동기).
  · 검증(로컬 Playwright + 실 DB): 12,389행 중 s_idx 12,389 · COURSE_TXT 12,164 · DORM_TXT 9,451 · AGENTS 4,904 · STAFF 2,268 유입 확인. 배치도 점유셀 클릭 → 모달 헤더 `※ STUDENT INFORMATION : 79091`, 페어 5행 + 코멘트 2행 렌더, 콘솔에러 0(잔여 404 는 favicon).
  · 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app` → 라이브 1,577,855바이트, `rp-info pair`/`th{width:136px}` 확인.
  ⚠ 이 배포는 **15:26 시점 스냅샷**(같은 시각 다른 세션이 index.html·blocks.js 를 계속 편집 중이라 그 이후 변경분은 미포함) · 그 세션의 미완성 `deploy/middleware.js`(전체 페이지 로그인 게이트)는 의도적으로 제외하고 배포함.
  · **후속(같은 날)**: 정책이 화면에서 실제로 검증되도록 DETAIL COST·COMMISSION **라이브 재계산** 구현 — `ETC FEE`/`PRE PAY`/`ETC COMMISSION` 입력에 id 부여 + `input` 이벤트 재계산: `TOTAL = REGIST+TUITION+DORM+ETC FEE−PRE PAY`, `COMMISSION = 규칙합(commBase 기준)+ETC COMMISSION`, `NET = TOTAL−COM` → TOTAL·COMMISSION·FINANCIAL 행·INVOICE 행·PRE PAY 근거표기 동시 갱신. **PRE PAY·ETC FEE 는 COMMISSION 에 절대 반영되지 않음**(입력 바꿔도 COM 불변). 인보이스 발행 금액도 고정 상수 대신 재계산값(`curGrand`) 전달 — 중복차단은 target 기준 멱등키라 금액 변경과 무관.
  · 검증(Playwright + 로컬 하네스 `deploy/api/data.js` 직결, 합성 학생 row 6주/KOR/ESL/CAPITAL): ① PRE PAY 450→1000→0 시 COM 225 불변 ② TOTAL 차이 정확히 1,000 ③ 근거표기 동기화 ④ ETC FEE +500 → TOTAL만 +500·COM 불변 ⑤ ETC COMMISSION 77 → COM 302 ⑥ NET=TOTAL−COM ⑦ INVOICE 행=FINANCIAL 행 — **7/7 PASS, pageerror 0**.
  · 배포: prod 재배포 + `smeag-bay.vercel.app` 별칭 재지정. 라이브는 Edge middleware 로그인 게이트가 걸려 있어 `POST /login`(fss_gn) 세션쿠키로 받아 비교 → **라이브 = 로컬 바이트 동일(1,656,164)**, `smiPrePay/smiEtcCom/commBase/커미션 미반영` 문구 개수 일치.

- **2026-07-30** **전용화면 5종 완성 — 회원관리 · COMMISSION · COURSE LIST · TUITION FEE · ELEC & WATER** (`{k:'spec'}` 표 폴백 → 전용 렌더러):
  · 진행 방식(요청: 병렬·오케스트레이션): 공용 규약(`docs/design-admin/screens-2026-07-30/CONVENTIONS.md`) 배포 → **화면 5개 × [구현 → QA] 2단 파이프라인 = 에이전트 10개 병렬**. 산출물은 리포 밖(스크래치패드)에 먼저 쓰게 해 기존 파일을 건드리지 않았고, 통합은 오케스트레이터가 단독 수행.
  · QA 가 잡은 치명 결함: **`window.REAL`·`window.MENU` 미존재**(`index.html` 은 `let REAL`/`const MENU` = 스크립트 스코프) → commission 화면이 데이터가 와도 영구 '미로딩' 폴백 · **colspan 14 vs 실제 17**(courses 표 어긋남) · **2페이지부터 pill 이 HTML 문자로 노출**(`paintPaged` 가 페이저 클릭마다 재-paint 하는데 1회성 복원이라) · elec 7건.
  · 오케스트레이터 정정: courses QA 가 "`R.*__init` 은 호출되는 곳이 전무 → `renderMain` 에 2줄 추가 필요"라고 지시했으나 **사실이 아님** — `deploy/index.html` 의 `if(typeof R[curKey+'__init']==='function')…` 훅이 이미 자동 호출한다(prototype.html 도 동일). 그대로 넣었으면 `__init` 이 2회 호출됐다.
  · **동시 편집 충돌 처리**: 같은 시각 다른 세션이 `deploy/api/data.js`·`index.html` 을 계속 저장 중이었고, 그 세션이 이미 같은 이름(`loadMembers`/`loadCommission`/`loadCourses`/`loadTuition`/`loadElec`)·같은 조각명으로 **명세화면 표 폴백 라이브 로더**를 넣어둔 상태였다. → 사용자 승인 하에 **병합안 A**: 이 5개는 전용 렌더러(응답 `out.<part>`)가 대체하므로 표 로더 5종과 `TABLE_LOADERS`·`PART_TABLES` 등록을 제거하고, 나머지 7종(points·visits·farmgym·boards·agencyvisit·dayoff)은 그대로 보존. 특히 ELEC 은 **167만 행 중 500행** 표라 화면으로 성립하지 않았다.
  · 통합은 `docs/design-admin/screens-2026-07-30/integrate.py` 로 **원자적 1회 적용** — 파일마다 [읽기 → 메모리 변환 → **sha256 재확인** → 한 번에 쓰기], 읽은 뒤 다른 세션이 저장했으면 아무것도 쓰지 않고 전체 중단(부분 적용 방지) · 마커(`SMEAG-5SCREENS-2026-07-30`)로 멱등.
  · **API**(`deploy/api/data.js`): `loadMembers`(g4_member ⨝ 학생수·커미션건수, PII 컬럼 미조회) · `loadCommission`(uhak_agency_com ⨝ g4_member, com_amt varchar 잡값 3건 방어 + 원문 동봉, **유학원 계정은 자기 계약만** — 타사 %/금액은 영업기밀) · `loadCourses`(course_info ⨝ course_category, 국가별 가격 9종) · `loadTuition`(tution_fee ⨝ course_info, 코스×주차 매트릭스용) · `loadElecMeter`(**방 단위 서버 집계**). elec 전용 쿼리파라미터 `elecFrom`/`elecTo`/`elecRoom` 신설 + 캐시키(version)에 포함.
  · **ELEC 성능**: `legacy.room_elec` 인덱스가 `pkey` 뿐이라 기간 필터가 Parallel Seq Scan(≈222MB read). 전기간(2006~2026) 집계는 **18.5s** 로 `statement_timeout(20s)` 위험 → 서버에서 `MAX_ELEC_SPAN_DAYS=400` 클램프. `max(re_date)` 직접조회 1,082ms → pkey 역순 5,000행 서브쿼리 **179ms**(같은 값). 사용량은 `끝-시작` 이 아니라 **일자별 delta 합**(0~2000 클램프, 계량기 교체·오타 제외), 검침 0 인 행(2026년 약 40%)은 시작·종료검침 산정에서 제외. **인덱스 제안(DDL 미실행)**: `room_elec(re_date)`, `room_elec(i_idx,re_date)` → 1.4s → 수십 ms 예상, +약 50MB.
  · **화면**: members(레벨·구분(ADMIN/AGENCY/STAFF)·상태 필터 + 검색 + 페이지네이션) · commission(유학원별 **현재 계약** 요약표 + 전체 이력표 2단, COMMISSION RULES 화면과 성격 구분 배너) · courses(카테고리 그룹 + 국가별 가격 9열 + 상태 pill) · tuition(**코스×주차 매트릭스** + 원본 목록 토글, 마진 표시) · elec(레거시 3섹션 재현 — 방별 검침표 + 방구분별 정산 롤업 + 검색/기간/캠퍼스 필터, 방 클릭 → 일자별 추이).
  · `_buildCourseCache()` 를 **라이브 코스 마스터(`REAL.courses`) 우선**으로 전환(기존 스냅샷은 폴백) → 수강등록·멀티수강의 코스 숫자코드 노출·`·off` 배지 누락 동시 해소.
  · **검증**(`exploration/live-data/e2e5.mjs` 신설 — 로컬 정적서버 + **실 `/api/data` 핸들러 + 실 Supabase**): 5화면 순회 전부 전용 렌더러로 진입(curKey=members/commission/courses/tuition/elec), 조각 요청이 매핑대로 1건씩만 발사, **폴백 0 · `undefined`/`NaN`/`[object Object]` 0건 · pageerror 0**, 재진입 추가호출 **0**(TTL 캐시). 실측 — members **2,053행 206ms** · commission **4,004행 165ms** · courses **71행 161ms** · tuition **100행(25코스×4주) 182ms** · elec **836방 162ms**(2026-07-01~31, 검침 433방/미검침 403방, 사용량 19,792kWh, 요금 8,038.2, latest 2026-07-13). `prototype.html` 은 라이브 계층이 없어 5화면 모두 안내카드 폴백 + 콘솔에러 0(설계대로).
  · 데이터 관찰: `course_info` 71개가 **전부 g_idx=5(ESL)** — `course_category` 14개 중 1개만 실제 사용 중(화면 칩 `Categories 1/14` 는 버그가 아니라 실측값).
  · 배포: `vercel deploy --prod` → `vercel alias set smeag-bay.vercel.app` 재지정 완료(dpl smeag-bgiqbob4g). ⚠ **라이브 클릭검증 미완** — 같은 날 다른 세션이 켠 Edge middleware 로그인 게이트(`/` → 302 `/login`)로 인해 이 세션에 계정이 없어 화면 순회를 못 했다(`/login` 200 · 무세션 `/api/data` 401 = 게이트 정상). 로컬은 실 DB·실 핸들러로 전 항목 통과.
  · 업무 확인 필요: ① TUITION FEE **5주차 이상 요금 규칙**이 원본에 없음(tution_fee 는 week 1~4) ② ELEC 의 `re_state` 가 전량 빈값이라 레거시 `search_condition2`(STUDYING/GRADUATING) 필터를 이 테이블만으로는 재현 불가 ③ 2026년 검침행 약 40%의 `re_gage=0` 이 미검침인지 실제 0인지.

- **2026-07-30** **라이브 조회 후속 3건 완료 + 자체 QA 결함 수정(인가·무인증쓰기·마스킹·스탬프)**:
  · **① 명세화면 15종 라이브화(11 조각)** — 조사 6갈래 병렬로 테이블·컬럼을 실 DB 로 확정한 뒤 구현. `members`(cms.g4_member 2,053) `points`(g4_point 146,387) `visits`(g4_visit_sum 5,431 — 상세 g4_visit 은 IP·UA 때문에 미사용) `commission`(uhak_agency_com 4,004) `courses`(course_info 71) `tuition`(tution_fee 100) `farmgym`(student_payment⨝student_info 65/47/20) `boards`(g4_write_office_GAC 37·holding 13·share 3) `elec`(room_elec 1,670,841) `agencyvisit`(uhak_day_info 158) `dayoff`(smeag_dayoff+sched_info 115). 조각당 **217~453ms**, 11개 동시 1,214ms/261KB.
  · 조사에서 잡은 함정: `cms."g4_write_office_GAC"` 대문자 인용 필수 · timestamptz 는 **`at time zone 'UTC'`** 로 포맷해야 하루 밀리지 않음 · `course_list` 의 `#`=`i_idx`·`상태`=대문자 Y/N 이어야 코스명 캐시(`_buildCourseCache`)가 안 깨짐 · commission 의 `percent`/`uhak_idx` 는 전 행 빈값이라 `com_amt`+`com_category` 로 분기.
  · **② 모바일 로그인 게이트 복원** — 로컬 폴백 로그인(초기 비번=아이디, localStorage 해시) 제거, `/api/auth` 서버 인증만 허용. 세션 유/무 7항목 E2E PASS.
  · **③ 세션 만료 안내** — 데스크톱 1회성 모달(포커스·Esc·reduced-motion), 모바일 토스트 1회 후 게이트 복귀.
  · **자체 QA 11건 적발 → 수정**(2차 워크플로가 API 529 로 전멸해 직접 수정):
    - **S1(Critical) `/api/blocks` 무인증 쓰기** — 세션 없이 POST 가 통과하고 actor 를 `X-SME-User` 헤더로 위조 가능(외부인이 전 객실 차단 가능)했음. → GET·POST 모두 세션 필수(401), **Lv8+ 만 허용(403)**, actor 는 세션 mb_id 만 사용(헤더 폴백 삭제). 기존 `actorOf` 가 세션 클레임을 `s.id/s.username` 으로 잘못 읽어 실제로는 항상 헤더 경로였던 버그도 함께 수정.
    - **S2(High) 인가 부재** — 레거시 로그인은 회원 전체(2,053, 레벨 무관)를 통과시키는데 `/api/data` 는 레벨을 안 봤음(Lv1 학생·학부모가 회원명부·직원휴무·커미션·전 학생 PII 취득 가능). → `PART_ACCESS` 도입: internal(members·points·visits·boards·dayoff·elec·commission·changelog)=Lv8+, business(students·roomstat·pickup·deposits·farmgym·agencyvisit…)=Lv8+ 또는 **유학원 확정 계정**, master(courses·tuition)=로그인. 거부 조각은 `out.denied` 로 알리고 전부 거부면 403. **유학원 판정 실패 시 deny 기본값**.
    - **S4 자유입력 마스킹** — `MASKFREE()` 신설(이메일·전화패턴·9자리+ 숫자런). 방문요청사항·휴무사유·FARM 코멘트·게시글 제목에 적용, 비밀글은 제목을 `[secret]` 로만 노출(기존 `[secret] 실제제목`).
    - **S5 스탬프 고착** — stamp 가 student_info/room_reserve/change_log/payment 만 봐서 게시판 새 글이 올라와도 ETag 불변 → 304 로 옛 데이터 고착. `PART_STAMP` 로 요청 조각의 PK 최대값을 스탬프에 포함(전 조각 계산 **189ms**). `smeag_dayoff` PK 는 `idx` 가 아니라 `id` 임을 실측으로 정정.
    - **S6 500행 상한 미표시** — `LIVE.truncated` 를 URL 단위로 관리하고 화면 상단 경고칩 + 엑셀 내보내기 토스트에 "최신 500행만" 명시(전용 렌더러 화면에도 renderMain 에서 공통 주입).
    - **S7 조각 매핑 누락** — FARM 리포트(`student_farm2.php`)·VISIT 캘린더(`uhak_agency_schedule_list.php`) 가 매핑에 없어 콜드 진입 시 빈 표였음 → PART_TABLES 보완(E2E 재확인: 20행/50행 표시).
    - **S8 모바일 tables 미병합** — `j.tables` 병합 + URL→조각 매핑(MVPARTS_URL) + truncated 보관 추가.
    - **S9 오류 원문 노출** — 500 응답의 `detail`(스키마 정찰 재료) 제거, 서버 콘솔로만.
    - **S11 `esc` 섀도잉** — 만료 모달의 지역 `esc` 를 `onEscKey` 로 분리(전역 HTML 이스케이퍼 가림 방지).
  · **인가 매트릭스 실측**(주체 5 × 조각 9): 비로그인 전부 401 / Lv1 전부 403(courses 만 허용) / Lv3 유학원 확정 = 학생 1,297건(자기 유학원)·내부조각 403 / Lv3 미확정 전부 403 / Lv9 정상. `/api/blocks` 는 비로그인 401, Lv1·Lv3 는 GET·POST 모두 403, Lv9 만 200.
  · 검증 하네스 추가: `exploration/live-data/authz.mjs`(인가 매트릭스·마스킹·스탬프 확인).
  · **미결/주의**: ⑴ 회원관리 전용 렌더러(다른 세션 작업)가 이메일·전화·로그인IP·메모를 마스킹 없이 2,053행 반환 — Lv8+ 전용이라 외부 노출은 없으나 노출 범위 재검토 필요. ⑵ `loadStudents` 는 여전히 무상한(SLICE_FROM 고정)이라 해가 갈수록 응답이 커짐. ⑶ `student_farm2.php` 의 PAID 는 `deposit_pay` 추정 매핑(레거시 원본 부재) — 실화면 대조 필요. ⑷ 같은 워킹트리를 다른 세션이 동시 편집 중이라(커밋 fc7c38e 에 본 작업분이 함께 포함됨) 배포 전 최종 diff 확인 필요.

- **2026-07-30** **학생정보 모달 문서출력 실동작화 — 레거시 문서 4종 서식 그대로 이식**:
  · **문제**: STUDENT MANAGEMENT INFORMATION 모달의 `ETC DOC · View` 의 `[LOA]` `[RECEIPT]`, INVOICE 행의 `AGENCY` `STUDENT` 가 모두 `<a href="#" onclick="return false">` 죽은 링크였고, `NEW INVOICE PUBLISH` 는 발행만 하고 문서를 내보내지 않았다. 즉 인보이스 발행·ETC DOC·PDF 가 화면에 **기능으로 존재하지 않았음**.
  · **레거시 원본 확보(읽기전용)**: `exploration/tmp_docs_fetch.js` — `/adm/` 경로는 404, **루트 경로**가 실경로였다(`www.smeadmin.com/admission_letter.html?s_no=` · `receipt_fee.html?s_no=` · `invoice_agency2.html?invoice_no=` · `invoice_student2.html?invoice_no=`). 4종 HTML 원문 + `css/style.css`(`.tblue #5569AA` `.t13` `.t15blur #8A91AD`) 확보. 안내문(입금계좌·현지납부비용·환불규정)은 **레거시 원문을 그대로 옮김**(임의 작성 금지).
  · **자산 임베드**: `exploration/tmp_docs_assets.js` — 레터헤드(`loa-logo.png`)·서명(`admis_sign.gif`)·수납도장(`receipt-stamp.png`)·인보이스 배너(`invoice1_top.jpg`/`_top2.jpg`)·섹션타이틀(`tit01~03`)·박스 상하단·불릿·프린트 아이콘 **13종 → base64 data URI(77KB)**. 외부 요청 0(팝업창은 CSP·오프라인에서도 동일하게 렌더).
  · **구현**: `openLegacyDoc()`(690px 고정폭 + 우하단 PRINT OUT) · `docHead()` · `docInfoBox()` · `docLoa()` · `docReceipt()` · `docInvoice(d,kind)`. 모달측은 `smiDocData(invNo)` 하나로 값 조립 → 6개 진입점 배선(`#smiLoa` `#smiRcpt` `#smiInvAg` `#smiInvSt` + INVOICE PUBLISH 행의 `📄 INVOICE (AGENCY)/(STUDENT)` 버튼).
  · **유학원용/학생용 구분(레거시와 동일)**: agency = 배너 `invoice1_top` + `에이전시` 행 + **입금계좌번호 안내** 섹션 + **입학금·커미션 차감 후 합계**. student = 배너 `_top2`, 위 3요소 전부 제외.
  · **레거시 원값 우선**: 수업료 상세=`row[19]`(fee_class2), 기숙사비 상세=`row[20]`(fee_dorm2), `s_no`=`row[18]`(s_idx). 없을 때만 주차·인실로 합성. `납부기간 = 출국일 − 15일`(레거시 샘플 2건에서 역산 확인: 09-06→08-22, 04-25→04-10).
  · **발행 연동**: `publishInvoice()` 가 결과(`invoice_no`)를 **반환**하도록 고쳐 SUBMIT 시 발행 확정분만 유학원용 인보이스를 즉시 출력(중복 발행분은 출력하지 않음 — 멱등 가드 유지).
  · **레거시 대조로 잡은 결함 6건 수정**: ⑴ 번호 연도 하드코딩 `2026` → 등록연도, 미발행은 `(미발행)` ⑵ 수업료 상세 `4 weeks-4 weeks-…` 중복 ⑶ 여권칸 기본값 `0` 이 문서에 `Passport Number: 0` 으로 찍힘 → 공백 ⑷ 유학원 합계가 입학금 미차감(1,833) → 레거시식 차감(1,733) ⑸ 문서폭·정보박스 테두리 gif 우측 흰여백 ⑹ `width:100%` 가 불릿(`acad_dot.gif`)까지 늘려 초록블록화 → 테두리 전용 `.iedge` 로 한정.
  · **의도적 레거시 이탈 1건**: `PAYMENT RECEIVED` 도장을 레거시는 **무조건** 찍는데(미납·총액 0 영수증에도) → **완납(PAID)일 때만** 찍도록 조건화. 미납 학생 영수증에 수납완료 도장이 찍히는 금전사고 방지. 되돌리려면 `d.paid?…` 조건만 제거.
  · **작업 중 사고 1건(복구완료)**: 삽입 스크립트에서 `String.replace(a, b)` 의 `b` 안에 `'$'` 가 있어 **`$'`(match 이후 전체) 치환**이 발동 → 양쪽 파일에 tail 이 2회 중복 삽입됨(+113KB). 3중 tail 동일성 검증 후 정확 복원하고 함수형 `replace(a, () => b)` 로 재적용. 이후 script 블록 파싱 결과가 HEAD 와 동일함을 확인.
  · **검증**: 로컬(스텁서버 8799) + **라이브** 각각 6개 진입점 전부 열림 — 창제목 `ADMISSION LETTER` / `Receipt of Tuition Fee` / `INVOICE (유학원용)` / `INVOICE (학생용)`, 이미지 3·11·15·13 전량 로드, **JS 에러 0**. 도장 조건부 동작 확인(미납 10장 / 완납 11장). 배포: `vercel deploy --prod` → `vercel alias set smeag-bay.vercel.app`.
  · **미결/주의**: ⑴ **통화 단위 불일치** — 레거시 인보이스는 `원`(같은 학생 1,970,000원)인데 신전산 모달 DETAIL COST 는 `$`(1,970). 문서는 모달 값을 그대로 `$` 로 찍으므로 **정책 확정 필요**(1000배 KRW 인지, 실제 USD 인지). ⑵ **NET 정의 2종** — 모달 FINANCIAL 은 `총액−커미션`, 레거시 유학원 인보이스는 `총액−입학금−커미션`. 문서는 레거시를 따랐으므로 모달 표시와 값이 다름 → 어느 쪽을 정본으로 할지 확정 필요. ⑶ 라이브 `/api/data?parts=students` 가 **Lv7 kenneth 에게 403**(다른 세션의 `PART_ACCESS` = internal/business 조각 Lv8+ 규칙). 실데이터 대조는 Lv8+ 계정 또는 유학원 확정 계정으로 재확인 필요.

- **2026-07-30** 행정팀 5건 중 **A3·A4 구현·배포 + 전제 재검증**:
  ① **재이관(D) 이미 완료 실증** — Supabase 읽기전용 접속 대조: uhak_agency_com 4,004 / student_change 26,857 / student_info_invoice 128,580 / student_info 90,524 **전부 원본=적재 100% 일치**, 확장컬럼(com_no·pay_status·exchange_*·center_pay_*·finance_*·s_regdate·s_jumin) 전부 존재 → 논의 중이던 (B)안이 이미 반영. "12,150 부분집합"은 DB가 아니라 앱 API 슬라이스(`data.js` SLICE_FROM='2025-01-01' → 12,389명) 때문이었음.
  ② **anon 키 병목 해소 확인** — 앱이 deploy/api/*.js 에서 pg 직접접속(PG_* env)으로 조회, 쓰기도 app.room_block_set/_release RPC로 실증됨(키 불필요). auth.js 주석에 명시.
  ③ **A3 센터수납 현장결제**: data.js loadStudents 에 8칸 추가(23~30 PAY_STATUS/PAY_CHANNEL/EX_DATE/EX_RATE/CPAY_AMT/CPAY_UNIT/CPAY_DATE/CPAY_MEMO) + 학생상세폼에 `CNETER PAY INFO` 블록(레거시 라벨 그대로). pay_channel=CENTER 일 때만 활성(계좌수금 잠금), **단위별 환산 실의미 반영**(peso=납부액÷환율=그로스 / dollor=달러 그로스, 페소환산은 참고), 화면 TOTAL 은 추정치라 '참고(ref)'로만 병기(경고 아님), MEMO 자동작성(레거시 문장형식·미지원 단위는 생성 차단), CENTER_RECEIPT 인쇄. 실데이터 검증: 12,505₱÷61=$205 → 레거시 메모($205를 페소12,505로)와 정확히 일치.
  ④ **A4 변경환불 체크목록**: API 신규 조각 `chgref`(student_change⨝student_info, 2025+ **2,247건**) + 전용화면 R.chgref(기존 spec 더미표 대체) — 기간·CENTER·유형·RESULT·검색 필터, RESULT 상태배지(pay_result 매핑), 기한초과 빨강+경과일, 체크박스 일괄(엑셀 20컬럼·멱등 인보이스), 읽기전용 상세모달. **확정·삭제는 student_change 쓰기 RPC 미존재로 비활성(툴팁 명시) → A2에서 배선**. 라이브 실측 INTAKE 2,247·PENDING 152·REFUND 554.
  ⑤ 검증·배포: 로컬+라이브 Playwright 콘솔오류 0. ⚠ **smeag-bay.vercel.app 별칭이 구배포를 가리키고 있어 재지정**(프로젝트 프로덕션 URL은 smeag-bay-orpin). 동일 세션에 **다른 작업자가 같은 파일(deploy/index.html) 편집·배포 중**이어서 충돌 회피: LOA/영수증 생성부가 읽는 q('smiPayStat') 문구값을 깨지 않도록 셀렉트 value=레거시 표시문구 유지.
  ⑥ 신규 미결정: **Q-8 약속기한(info_due_date) 실입력 43/26,857·2025+ 0건** → 기한관리 방식 결정 필요(입력 시작 / 접수일+N일 SLA 자동 / 미사용), **Q-9 dollor 건의 달러+페소 분할납부(1,367건)를 구조화 입력할지 MEMO 유지할지**.

- **2026-07-30** 배치도(room_stat3) **룰러·방셀 클릭 → 이름칸 동일이름 강조**:
  · **요청**: 방 셀을 클릭/룰러가 지나갈 때, 그 날짜 점유자와 **같은 이름을 왼쪽 이름칸에서 표시**해달라(어느 학생 행인지 눈으로 못 찾는 문제).
  · **구현(deploy/index.html)**: ⑴ 룰러 `move()` 안에 `hovName(tr,name)` 추가 — `rsOccAt(tr,i)` 로 얻은 그 날짜 점유자와 `data-name` 이 일치하는 `.rs-nameseg` 에만 `.hov` 부여(+행 `.rs-hov-row` 연한 배경). 키(행+이름) 비교로 같은 셀 안에서는 DOM 조작 스킵 → 마우스무브 비용 0에 가깝게 유지. 룰러 OFF·셀 밖으로 나가면 자동 해제. ⑵ 방 셀 클릭 시 `rsHighlight(occ,false)` 호출 — 이름 클릭과 **동일한 강조**(이름칸 `.on` + 그 학생 점유구간 오버레이 `.rs-hl` + 행/방블록 강조)를 방셀 클릭에서도. 스크롤은 이동시키지 않음(`scroll=false`), 빈 날 클릭은 `rsClearHl()`.
  · **CSS 신규 2종**: `.rs-nameseg.hov`(연한 강조 — 클릭 강조 `.on` 과 구분), `tr.rs-hov-row td.c3`.
  · **검증**: Playwright E2E(로컬 정적서버+실 /api/data) — CAPITAL/MALE 배치도에서 점유 셀 좌표 계산 후 hover → `.rs-nameseg.hov=["준블락_single use"]`, 툴팁 `📅 2026-06-16 · 🏠 301-1 · 👤 준블락_single use`, 클릭 → `.on` 1건 + `.rs-hl` 1건, **JS 에러 0**. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`(별칭 재지정 필수 — 이번에도 필요했음).

- **2026-07-30** 행정팀 **Q-8·Q-9 회신 반영 — 쓰기(저장) 계층 신설 + UI 구현·배포**:
  ① **Q-8 "약속기한 앞으로 입력한다"** → A4 목록 맨 오른쪽 **DUE 입력칸**(변경 즉시 저장) + **선택 일괄 확정**(처리결과 지정 + 완료일=오늘, 이미 종결된 건은 한 번 더 확인받고 force). 기한 경과 시 빨강+경과일 자동 표시(라이브 검증: DUE 2026-07-25 저장 → `+5d`·OVERDUE=1).
  ② **Q-9 "2칸 구조화 + 추가 버튼"** → 센터수납에 **분할납부 입력행**(기본 달러·페소 2칸, `➕ 입력칸 추가`로 동적 생성·상한 20, 행 삭제, 비고). **합계검증**(Σ달러 + Σ페소÷환율 = 납부금액 달러환산, 불일치 시 차액 표시) + **MEMO 자동조합**(레거시 문장형식 "그로스가 $1,880을 달러$1,800과 페소4,880(=$80) 납부($1=61p)") + 저장.
  ③ **DB**: `migration/schema/admin_edits.sql` 신설·적용 — `app.student_change_set`(화이트리스트 4컬럼·날짜형식·RESULT코드 검증·**종결→종결 전이 need_confirm 가드**·멱등·감사·log_change), `app.center_pay_set`(화이트리스트 8컬럼·단위검증·분할내역 전량교체), `app.center_pay_split`(분할 원장, 레거시 스키마 불변), `app.center_pay_split_list`. 저장 시 `app.log_change` 기록 → 기존 역방향 일일동기화가 그대로 집어감.
  ④ **API**: `deploy/api/edit.js` 신설 — 세션 필수·**Lv8+ 쓰기**·멱등키 필수·화이트리스트 1차 검증·need_confirm 중계. pg 직접접속(키 불필요).
  ⑤ **부수 버그 3건 수정**: (a) `change_log.sql` 의 `((changed_at::date))` 인덱스가 IMMUTABLE 아니어서 **여태 적용 자체가 실패**하던 것 → `((changed_at at time zone 'UTC')::date)` 로 수정 후 적용(app.change_log 이제 실존). (b) `/api/data` 캐시 스탬프가 max(PK)만 보므로 **기존 행의 칸만 바뀌는 행정팀 수정을 감지 못해** 저장 후 새로고침 시 옛 값 표시 → 스탬프에 `max(app.write_audit.audit_id)` 추가. (c) 센터수납 저장이 **전 8필드를 통째로 전송**해 손대지 않은 값까지 덮어쓰던 문제 → **변경분만 전송(diff)** 으로 수정. 추가로 게이트가 채널 미지정까지 잠가 신규입력이 불가했던 점 → **ACCOUNT 일 때만 잠금**, 그리고 **저장·행추가 버튼을 게이트에 포함**(빠져 있어 잠긴 화면에서 저장이 나갔음).
  ⑥ ⚠ **검증 중 라이브 데이터 3건 변경 → 원본 덤프(sql/student_info.sql)에서 전 컬럼 대조 복원 완료**(#100108 메모·#100711·#101304, 3건 모두 `원본일치: True` 확인). test 흔적(app.change_log·center_pay_split·write_audit) 정리. **교훈: 라이브 화면 검증은 실행 전 대상 행의 원본값을 확보하고 종료 시 반드시 복원할 것**(전용 테스트 학생 도입 검토).

- **2026-07-30** **메뉴 100% 레거시 정합**(요청: "make new system with same legacy menu"):
  · **근거**: `exploration/discovered_links.json`(레거시 드롭다운 DOM 실측 라벨·순서) + `docs/LEGACY_ALLMENU_2026-07-23.html`(9카테고리·66항목 목차) + 레거시 상단바 캡처.
  · **카테고리 7→9·순서 레거시화**: Setting · Member's · **Board(신설)** · Agency · **Record** · Student's · Dormitory · Financial · Cash Cards (레거시 상단바 순서 그대로). `SIDE_TITLE`·RBAC(DEPTS)·`.cats{flex-wrap}` 동반 수정.
  · **라벨·번호 레거시 원문 채택**: `1.수강등록관리`·`1.1.멀티수강관리`·`1.2 MC Report 1`·`2.변경환불홀딩`·`4.1.Deposit(test)`·`5.1.GYM 리포트`·`1.기숙사현황`·`3.일별 입실&퇴실` 등. **기본 영어 정책은 유지** — `MENU_EN` 에 번호를 포함한 영문 매핑을 추가해 EN 에서도 `1.Course Registration` 처럼 번호가 그대로 보인다(모바일은 항목별 `en` 필드 + `titleFor`).
  · **누락 9개 추가**: 회원메일발송·투표관리·게시판관리·게시판그룹관리(Member's) / AGENCY ADDR·AGENCY OUT(Agency) / DORM SEARCH·Update Rooms(new)(Dormitory) / 세션 삭제·phpMyAdmin(Setting). 전용 렌더러 없는 항목은 기존 `R.spec`(명세·표 폴백)으로 표시.
  · **분리 복원**: 하나로 합쳐 두었던 `STDNT Fullsize/Encanto/Classic/Capital` → 레거시대로 **4개 항목**(각 `student_present2-rey/-sparta/-classic/-capital.php`). 레거시가 드롭다운에 중복 노출하는 게시판(GAC BOARD·Campus Holding Info→Student's, SME_BOARD→Dormitory)도 **중복 그대로** 재현.
  · **신전산 추가분은 남기되 표시**: `ext:1` → 드롭다운에 `＋` 배지(대시보드·권한설정·AGENCY PAGE·COMMISSION RULES·TUITION FEE·DAYOFF/Scheduler·주간 픽업 리스트). 결과: 9카테고리 / 76항목 = 레거시 66 + 드롭다운 중복 3 + 신전산 추가 7.
  · **검증**: 로컬 정적서버 Playwright — 데스크톱 9카테고리 전 항목 **76개 클릭 순회, JS 에러 0**(h1 없는 6건은 에이전시 포털 재현 화면으로 기존과 동일), 한/영 토글 라벨 확인. 모바일(`deploy/m/index.html`) 전체메뉴 시트도 **9그룹·76항목 동일**, 에러 0. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`. ⚠ 라이브 클릭검증은 이 세션에 로그인 계정이 없어 미실시(Edge 게이트 `/`→302 `/login` 정상 동작 확인).

- **2026-07-31** **수강등록관리 화면 원복(da4217e 이전) + ACTION 열 잘림 수정**:
  · **요청**: "학생수강등록 화면은 이 작업 이전으로 돌려놔"(선택: 어제 커밋 `da4217e` 이전) + "수정·신청 등 학생리스트 오른쪽 아이콘이 안 보인다".
  · **원복 4곳**(deploy/index.html, 같은 커밋의 배치도 열드래그·COMMISSION RULES 문구는 **건드리지 않음**): ⑴ `td.std-name` 링크 스타일(밑줄·포인터·hover) 복구, ⑵ 이름 클릭 → 상세정보(openStudentEdit) 핸들러 복구, ⑶ 표 **PERI = 원래 정수 표기**(`2w` 되돌림)·**COURSE = 원래 코드값**(코스명 매핑 되돌림), ⑷ 엑셀 내보내기도 동일하게 원값(r[10]·r[12]). `periW()`·`courseNameOf()` 함수 자체는 COURSE 필터 등 다른 화면이 쓰므로 존치.
  · **아이콘 안 보이던 원인**: ACTION(수정/변경/연장/상담/약식) 열이 표 오른쪽 끝(표 폭 1,505px)이라 **뷰포트 1,366px 미만에서 잘려** 가로 스크롤을 해야만 보였음(실측: 1100·1280 = 잘림, 1366↑ = 정상). 커밋과 무관한 레이아웃 문제.
  · **수정**: `td.std-act`/`th.th-act` **오른쪽 sticky 고정**(그림자 경계·hover 배경 동기화) → 가로 스크롤 없이 항상 우측에 보이고, 끝까지 스크롤하면 원래 자리에 놓임. 실측 재검증: 1100·1280·1366·1440·1680 **전부 잘림 없음**. (CONSULT LOG/MEDICAL/CONSENT/REPORT 4열은 종전대로 1,680px 미만에서 가로 스크롤 필요 — 별건.)
  · **검증**: 로컬 정적서버+실 `/api/data`(Playwright, 1280×900) — ACTION 5버튼 노출·이름 클릭 시 상세 모달(`modal smi`) 열림·PERI `16`·COURSE `46`(원값) 확인, **JS 에러 0**. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`.

- **2026-07-31** **"수정·변경·연장·상담·약식 아이콘이 안 보이고 데이터도 다 안 나온다" 원인규명 + 폴백 제거**:
  · **원인**: 화면에 보인 12행은 **실데이터가 아니라 샘플(가상) 폴백**이었다. `paintStd()` 는 `stdFiltered()` 가 null(=`REAL.studentsFull` 없음)이면 `rowsStudents(12)` 로 **가짜 12행**을 그렸고, 이 폴백 행은 컬럼이 10칸뿐이라 ACTION·CONSULT LOG·MEDICAL·CONSENT·REPORT 칸이 **비어 버린다**(스크린샷의 칩 `0 persons`·`Real data(MySQL)` 배지 없음·CLASSIC/ENCANTO 배지가 DEPA/BEGIN 열에 어긋나 찍힌 것이 증거). 즉 아이콘이 사라진 게 아니라 **실데이터가 안 실린 화면**이었다.
  · **실데이터가 안 실리는 경우**: ⑴ 세션 만료(8시간, `/api/data` 401) ⑵ 조각 권한 없음(403 — Lv8 미만·유학원 미확정 계정) ⑶ 조회 실패·타임아웃 ⑷ 아직 로딩 중.
  · **수정**: 학생 목록 화면에서 **샘플 폴백을 완전히 제거**. 대신 상태 패널을 표시 — 🔒 세션없음(다시 로그인 버튼·`/login?next=`) / ⏳ 불러오는 중 / ⚠ 조회 실패(사유 + 다시 시도 → `liveSync({parts:['students'],force:true})`) / 📭 미로드(불러오기). "이 화면은 실데이터 전용이라 샘플 행을 표시하지 않습니다" 문구 병기.
  · **검증**: 스텁 500 응답 — 가짜행 **0개**, `⚠ DB read failed (HTTP 500) · Retry` 패널 노출, JS 에러 0. 실 `/api/data` 정상 경로도 재확인(ACTION 5버튼·이름클릭 상세모달·PERI/COURSE 원값). 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`.
  · ⚠ **남은 확인**: 사용자 계정이 위 ⑴~⑷ 중 무엇이었는지는 화면의 우상단 라이브 배지(`● Live` / `○ 샘플(로그인 필요)` / `▲ DB 오류`)로 즉시 구분 가능 — 이번 배포부터는 표 대신 사유가 뜬다.

- **2026-07-31** **kenneth 403(데이터 안 보임) 원인규명 + 권한 오버라이드 도입(Lv10)**:
  · **원인**: `/api/data?parts=students` → **403 forbidden**. `data.js` 인가규칙은 `STAFF_LEVEL=8` 이상만 업무조각(students·roomstat·pickup·deposits·chgref…) 허용인데, DB 실측 **kenneth = Lv7**(cms.g4_member) 이고 유학원 계정도 아님(`student_info.uhak_id='kenneth'` 0건) → 전면 차단. 레거시 실무자 대부분이 Lv7(24명)이라 kenneth 만의 문제가 아니었다(Lv10 5 · Lv9 1 · Lv8 1 · **Lv7 24** · Lv6 1).
  · **조치(요청: kenneth Lv10)** — 레거시 미러 `cms.g4_member` 는 **손대지 않았다**(원본 불가침 + 다음 동기화 시 원복 + 역방향 동기화 위험). 대신 신전산 소유 테이블 신설: `migration/schema/member_level_override.sql` → `app.member_level_override(mb_id, mb_level, active, memo, updated_by, updated_at)` + `app.member_level_of(mb_id)`. **유효권한 = max(세션레벨, 오버라이드)** 규칙을 `/api/data`·`/api/edit`·`/api/auth`(세션 발급) 세 곳에 배선. 테이블 부재 환경에서도 죽지 않게 try/catch 폴백.
  · **적용**: kenneth → **Lv10**(memo에 사유·일자 기록). g4_member.mb_level 은 7 그대로 확인.
  · **검증**: 실 DB로 핸들러 직접 호출 — `kenneth(Lv7 세션 쿠키 그대로)` → **HTTP 200 · studentsFull 12,389행**(재로그인 불필요, 기존 세션도 즉시 적용), `doris(Lv7·오버라이드 없음)` → **403 denied=students**(무분별 승격 아님 확인). 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`(무세션 `/api/data` 401 정상).
  · **되돌리기**: `delete from app.member_level_override where mb_id='kenneth'` (또는 `active=false`) → 즉시 Lv7 로 복귀.
  · **남은 결정**: 나머지 Lv7 실무자 23명 처리 — ⑴ `STAFF_LEVEL=7` 로 하향 ⑵ 업무조각만 Lv7 허용·내부(members·changelog·commission)는 Lv8 유지 ⑶ 필요한 계정만 오버라이드 추가. 현재는 ⑶ 로 kenneth 만 열려 있음.

- **2026-07-31** **학생 목록 표를 레거시 화면(student.php) 표기로 정합 + BIRTH 유지**:
  · **요청**: "신시스템은 레거시 화면에 맞춰서 보여줘, birth는 포함"(레거시 STUDENT LIST 캡처 제공).
  · **헤더**: `NAME(EN)→NAME` · `STATUS→COND` · `ROOM→DORM` (레거시 라벨), **PICKUP 항상 표시**(레거시와 동일), BIRTH 는 요청대로 AGE 앞에 유지. 최종 = AGENCY·NAT·NAME·KOR·**BIRTH**·AGE·SEX·APPLY·DEPA·BEGIN·PICKUP·END·PERI·COND·COURSE·DORM(+ACTION·문서4).
  · **값 표기 레거시화**: ⑴ 날짜 **연도 4자리 전체**(`2026-07-31`) — 기존 2자리 축약(d8) 대신 `dL()` 신설. ⑵ **PERI = `16w`**(주 단위 표기). ⑶ **COURSE = 코스명**(`ESL 2(CAPITAL)`, 코드값은 title 툴팁). ⑷ **COND = 레거시 축약코드**(`normal→NORM` … `condLegacy()`, 미확인 코드는 앞 4자 규칙). ⑸ **DORM = `ENCANTO3 / E318`** 슬래시 표기(`dormLegacy()`). ⑹ **KOR 은 EN 과 같아도 그대로 표기**(레거시가 중복 표기함 — 기존 `—` 처리 폐지). ⑺ SEX 는 레거시대로 `M/F`. ⑻ BIRTH 전용 컬럼이 생겼으므로 **AGE 칸의 생년월일 겹침 표기 제거**(`manAgeCell(row,hideDob)`).
  · ⚠ **이전 원복과 상충 → 재적용**: 오전에 되돌렸던 `PERI 주단위(2w)`·`COURSE 코스명` 두 가지는 **레거시 화면이 실제로 그렇게 표시**하므로(제공 캡처: `4w`/`6 weeks-Pre-TOEIC`) 이번 요청 기준으로 다시 적용했다. 이름 클릭 → 상세정보는 원복 상태 그대로 유지.
  · **엑셀도 화면과 동일 표기**(BIRTH 컬럼 추가·PERI/COURSE/DORM/COND 레거시식).
  · **검증**: 실 `/api/data`(Playwright 1600×950, kenneth Lv7 세션+오버라이드) — 헤더 21열 순서 일치, 값 `2024-12-26 / 16w / NORM / ESL 2(CAPITAL)`, 12,389건·248페이지, ACTION 5버튼+문서4 노출, **JS 에러 0**. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`.

- **2026-08-01** **ROOM REPLACEMENT 후보표 → 매칭(MATCHING) 결과표**:
  · **요청**: "CHANGE PERIOD 옆에 MATCHING 버튼 · 방타입/기간/코스 필터로 검색된 것은 카테고리 앞에 매칭색으로, 나머지는 아래로" + "기존 것도 반영하기에 **상단에 매칭버튼**".
  · **문제**: 기존 오른쪽 후보표는 `roomstat` 전 객실을 순서 없이 나열(수백 행)하고 **그 기간에 그 방이 비었는지 판정이 없는데도 모든 행에 MOVE 가 활성** → 겹침 배정 위험.
  · **구현**(`deploy/index.html`): 버튼 **OFF = 레거시 전체 목록 그대로**(기존 동작 보존), **ON = 3등급 매칭**. ⑴ 등급 = 🟢전기간 가능 / 🟡부분 가능(가능 구간 표기) / ⬜불가(접힘 + **MOVE 비활성**) — 2색 대신 3등급으로 둔 이유는 "이 방은 5/2까지만 가능"이 부분이동 판단의 핵심이기 때문. ⑵ 하드필터 = FROM/TO(기본 CHANGE PERIOD, 수정 가능)·SEX(기본 학생 성별, FAMILY 는 양쪽 허용)·CATEGORY·CAPA. ⑶ **코스·국적은 방의 속성이 아니라 재실자의 속성**이라 필터가 아닌 **정렬 가산점**(같은 코스 룸메 우선 / 같은 국적 선호·회피)으로 배선. ⑷ 정렬 = 등급 → 가능일수 → 가산점 → **빈자리 적은 방 먼저**(방 파편화 최소화) → 같은 카테고리 → 방번호. ⑸ 집계바(전기간/부분/불가 건수)·매칭 사유(`빈자리 2/3 · 같은 코스 룸메`) 표기. ⑹ 판정 입력 = `beds[].segs[]` + `blockedRooms()`(무기한) + `BLK.list` 기간블록, **본인 예약 구간은 비우는 자리로 처리**. 서버 왕복·새 테이블 없음.
  · **검증 중 잡은 실제 버그 2건**: ⑴ **날짜 off-by-one** — `new Date(d+'T00:00:00')`(로컬 KST)를 `toISOString()` 하면 하루가 밀려 가능구간이 `05-02`→`05-01` 로 표기됐다 → **UTC 파싱(`T00:00:00Z`·`setUTCDate`)로 수정**. ⑵ **방막기 원장 도착 전 렌더** — `blkLoad()` 완료 전에 그려서 **막아둔 방이 초록(전기간 가능)으로 표시**됐다 → 로드 완료 후 렌더(로딩 중 안내) 로 수정.
  · **검증**: 합성 roomstat 주입 + Playwright 결정론 테스트 8케이스 — 본인자리/전빈방/부분(점유 05-03 → 가능 04-19~05-02)/전침대점유/기간블록(04-25~ → 가능 04-19~04-24)/무기한블록/성별 하드필터/CAPA 필터/코스 가산점 정렬/기간축소/TO<FROM 방어/초기화/OFF 복귀 **전부 기대값 일치, JS 에러 0**. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`.
  · **실데이터 E2E 완료(2026-08-03)**: 앞서 "로컬 `/api/data?parts=roomstat` 응답이 비었다"고 적은 것은 **오판 — 콜드 커넥션 지연**이었다(웜 상태 roomstat 4.4s·students 1.1s, 콜드 120s+). 실 응답을 캐시해 서빙하고 재검증: **30그룹·418실·학생 12,389** 로드 → 배치도(센터·성별·그룹 3선택 필수) → 재실 방 클릭 → ROOM REPLACEMENT. 대상 `UWANISHI RYO`(CAPITAL1 302, 2026-05-10~07-04, 56일): **전기간 141 · 부분 118 · 불가 27**, 매칭 렌더 **85ms**(418행), 등급 정렬 단조 증가, 불가 27건 전부 **접힘 + MOVE 비활성**, 전기간/부분은 전부 활성, 버튼 OFF 시 **레거시 418행 그대로 복귀**, JS 에러 0.
  · **교차검증**: 화면 결과 286행을 원본 `beds[].segs[]` 로 독립 재계산 → **불일치 0**(단 1건 `CAPITAL1 302` 는 검증 스크립트가 본인 구간을 모달 헤더 문자열(`UWANISHI RYO / NAKASHIO YUTA`, 2인 합성 라벨)로 비교한 탓이며, 원본 확인 결과 침대1 = `si 97169 UWANISHI RYO 05-10~07-04` 로 **앱의 s_idx 기준 본인구간 제외가 정확**했다).
  · ⚠ **라이브(smeag-bay) 클릭검증만 미실시** — Edge 세션 게이트(`/`→302 `/login`)가 정상 동작 중이고 이 세션에 로그인 계정이 없다.
  · **결정(2026-08-01, 확정)**: 국적 정책 = **무관**. 매칭 정렬에 국적을 반영하지 않는다(기본값 `무관` 그대로 유지). 선호/회피 선택지는 담당자가 필요할 때만 쓰는 수동 옵션으로 남겨두고, 어떤 경우에도 자동 적용하지 않는다.

- **2026-08-01** **DORM SEARCH(room_search2.php) 실화면 구현 — 레거시 그대로 + CLASSIC 필터 제외**:
  · **요청**: "legacy 대로 만들어 줘, 근데 **classic 은 필터에서 빼줘**" (기존에는 명세 골격(k:'spec')만 뜨던 화면).
  · **레거시 근거**: 크롤 실측(`exploration/crawl_results.json`, title `USABLE DORMITORY SEARCH!`) — form `lesson_form`(GET): `s_date`·`e_date`(사용기간), `s_period`(주), `r_limit`(1~5 per/room), `s_gender`(M/F), `search_condition`(1=ENCANTO·4=CLASSIC·5=CAPITAL). 결과표 6열 `GROUP · ROOM NUMBER · BED NUMBER · PER/ROOM(인실) · SEX · CENTER`.
  · **구현**(`deploy/index.html`): 메뉴키 `spec`→**`dsearch`** 신설(`LIVE_PARTS.dsearch=['roomstat']`). 폼·결과 컬럼을 레거시 그대로 재현하되 **CENTER 선택지는 ENCANTO/CAPITAL 만**(CLASSIC=레거시 4번 센터 제외, 결과에서도 제외). PERIOD(주) 입력 시 TO 자동계산(`FROM+7w-1`), TO 직접수정 시 주수 역산. 판정은 배치도와 **같은 실데이터**(`REAL.roomstat` 예약 세그먼트) + 방막기 원장(`blockedRooms()` 무기한 + `BLK.list` 기간블록)으로 **선택 기간 전체가 빈 침대만** 출력(레거시 "USABLE"), 서버 왕복·새 API 없음. FAMILY(공용) 그룹은 성별과 무관하게 노출. EXCEL 내보내기·정렬·조회로그(`dorm_search`) 배선. 검색기간이 배치도 데이터창(선택월 ±6개월) 밖이면 그 달로 옮겨 자동 재조회.
  · **검증**(`exploration/live-data/e2e_dsearch.mjs`, 로컬 정적서버+실 `/api/data`, Playwright 1600×950): 폼 6필드·CENTER 옵션 `['','ENCANTO','CAPITAL']`(**CLASSIC 없음**)·헤더 6열 레거시 일치, `2026-08-06 +4주` → 빈 침대 **232 / 방 111**, `ENCANTO+4인실+FEMALE` → 8행(센터·인실 필터 정확), **교차검증 결과행 중 해당 기간 점유 침대 0건**, 기간 역전(TO<FROM) 방어 문구, **JS 에러 0**. 배포: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`(라이브는 Edge 세션 게이트로 무세션 클릭검증 불가 — `/`→302 `/login` 정상).

- **2026-08-03** **회원관리(member_list.php) 레거시 화면 그대로 + ✎ → 회원정보 수정(member_form.php) 프레임**:
  · **요청**: "회원관리 레거시 화면대로 만들어줘" (레거시/신전산 캡처 2장 제공) → 이어서 "**수정 아이콘 필요, 누르면 레거시 프레임처럼 보여야 함**"(레거시 `adm/member_form.php` 캡처 제공).
  · **문제**: 기존 신전산 회원관리는 21열 확장표(KIND·AGENCY·COMM·STUDENTS…)라 레거시와 칸·순서·조작부가 전혀 달랐다.
  · **목록 구현**(`deploy/index.html` `R.members`/`memLegacyInit`): 레거시 칸 순서 그대로 — `☐ · 회원아이디 · 이름 · 별명 · 권한(select) · 포인트 · 최종접속 · 수신 · 공개 · 인증 · 차단(checkbox) · 그룹 · ⊞(✎✉⧉)`. 상단 `처음 (총회원수 : 2,053, 차단 : 125, 탈퇴 : 16)` + 우측 검색(회원아이디/이름/별명/이메일 + SEARCH), 하단 `선택수정·선택삭제` + 레거시식 숫자 페이지(10개 단위 · 다음 · 맨끝) + 삭제 안내 각주. **한 페이지 15행**(레거시와 동일). 최종접속은 레거시 표기 `26-07-13`, 미접속은 `00-00-00`.
  · **읽기 전용 원칙**: 권한 select·차단 checkbox·선택수정/삭제·폼의 확인/삭제는 **전부 disabled**(원본 `cms.g4_member` 불가침 [[feedback_migration_readonly]]). 기존 확장표는 없애지 않고 헤더의 `LEGACY ↔ DETAIL` 토글로 유지.
  · **수정 폼**(`openMemberForm`/`memFormHtml` + `/api/data?member=<id>`): 레거시 `member_form.php` 칸 배치 그대로 2열 — 아이디/패스워드(비노출)·이름/별명·권한/포인트·E-mail/홈페이지·전화/핸드폰·주소/아이콘·생년월일/남녀·메일수신/SMS·정보공개·서명/자기소개·메모·가입일/최근접속·IP·탈퇴일자/접근차단일자·**여분필드 1~10**(각 칸에 실측 의미 라벨: 사업자번호·담당자·계약일·은행·계좌·유선·유학원명·커미션방식·커미션값·유학원코드). 단건 API 는 **Lv8+ 또는 본인**만 허용(그 외 403), `mb_password·mb_jumin·mb_password_q/a·mb_lost_certify` 는 여전히 미노출. 목록 응답은 그대로 두고 상세는 **한 명씩만** 나가도록 분리했다.
  · **API 확장**(`deploy/api/data.js loadMembers`): 레거시 칸에 필요한 `point·mailling·open·certify·intercept·groups(g4_group_member)·leave_date` 추가. 실행검증 **2,053행 · 3.4s**(웜), 차단 125·탈퇴 16 = 레거시 헤더 수치와 일치.
  · ⚠ **부수적으로 발견·수정한 실제 버그**: 메인 스타일시트 723행 `color-mix(in srgb,var(--accent） 6%,…)` 의 **전각 괄호 `）`** 때문에 CSS 파서가 그 지점에서 중단 → **그 뒤 92개 규칙(financial·live-tag·agency-list 등)이 통째로 미적용** 상태였다(CSSOM 534 → 수정 후 626 규칙). 전각괄호를 `)` 로 교정.
  · **검증**(`exploration/live-data/e2e_members_legacy.mjs`, 로컬 정적서버+실 `/api/data`+실 Supabase, Playwright 1600×1000): 헤더 13열 순서 일치, 15행/페이지, 페이저 `1..10 Next Last`(137페이지·2,053건), 2페이지 이동, 검색 `kenneth` 1건, 권한 select·차단 checkbox **disabled 확인**, ✎ → 폼 로드(라벨 36개·입력 전부 readonly·확인/삭제 disabled·이상문자열 0), **JS 에러 0**. 스크린샷 `shots/members_legacy_list.png`·`members_legacy_form.png`.
  · **배포**: `vercel deploy --prod` + `vercel alias set smeag-bay.vercel.app`(dpl_5goTT1uzMrm3oaGWzQAM4QHzSpar). 라이브 클릭검증은 Edge 세션 게이트(`/`→302 `/login`)로 이 세션에서 불가 — 무세션 접근 차단은 정상 동작 확인.
  · **(같은 날 후속) "수정이 안 된다 · 내용을 적을 수 없다" → 입력·저장 가능하게**: 폼 전 칸 입력 + [확 인] 저장, 목록은 권한 select·차단 체크 변경 시 그 행이 자동 선택되고 [선택수정]으로 일괄 저장(행마다 멱등키·순차 전송). 저장 경로는 **레거시 원본이 아니라 신전산 오버레이** — 신규 `migration/schema/member_edits.sql`(`app.member_edits` + RPC `app.member_edit_set`, 화이트리스트 31칸·0/1·YYYY-MM-DD·4000자 검증·멱등키), 권한은 기존 `app.member_level_override` 로 분기, 변경분은 `app.log_change('g4_member',…)` 로 `app.change_log` 에 적재(화이트리스트에 g4_member 추가). 읽기 경로(`loadMembers`·`loadMemberForm`)가 레거시 값 위에 patch 를 덮어 보여주고 수정된 칸은 ● 로 표시. `POST /api/edit {op:'member'}` 는 Lv8+ 필수. 삭제(선택삭제·삭 제)는 계속 비활성 — 신전산은 회원을 지우지 않는다.
  · **쓰기 검증**(`exploration/live-data/e2e_member_edit.mjs`, 실 DB 쓰기 후 원상복구): 저장 성공 → `app.member_edits.patch={mb_nick,mb_memo}` 기록, **원본 `cms.g4_member` 불변 확인**, `change_log` 1건(`target_pk={"mb_id":"test77"}`), 재조회 시 덮인 값 반환(`edited:['memo','nick']`), **같은 멱등키 재요청 → 최초 결과 재생(두 번째 patch 미적용)**, 목록 [선택수정] → `member_level_override=6`·차단일자 기록·원본 레벨 불변, JS 에러 0. 배포 + `vercel alias set smeag-bay.vercel.app`.
