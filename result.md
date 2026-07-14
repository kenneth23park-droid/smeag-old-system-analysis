# SMEAG 운영 관리자(smeadmin.com) 화면 탐구 — 진행/결과 보고서

> 방법: **Playwright(Node) 로그인 + 병렬 크롤 + 오케스트레이션**, 진행상태 TodoWrite 추적
> 대상: `http://www.smeadmin.com/gnuboard4/adm/` (그누보드4 관리자), 계정 kenneth
> 일자: 2026-07-14
> 원칙: **화면 구조·코드값만 수집. 실제 학생 개인정보(이름/생일/여권 등) 값은 미수집·미기록.**
> 산출물: 본 문서 + [docs/design-admin/화면설계서.md](docs/design-admin/화면설계서.md)
> 관련: [진행사항_화면캡쳐_메뉴설명_정리.md](진행사항_화면캡쳐_메뉴설명_정리.md)(기존 수동 분석) 대비 **자동 검증·확장·정정**

---

## 0. 요약 (Executive Summary)

- **45개 관리자 화면을 자동 로그인 후 병렬 크롤**하여 100% 성공(45/45). 각 화면의 제목·검색폼 필드·**셀렉트 옵션(=코드 사전)**·데이터그리드 컬럼·건수를 수집.
- 기존 수동 분석 문서를 **실측으로 검증**했고, 아래 **정정·확장 사항**을 발견:
  - `pay_status` **X = 분납(INSTALL)** — 기존 문서의 "예외(EXCEPTION)"는 **오류**. 실제값 X=분납/Y=완납/N=미납/R=반환.
  - 캠퍼스 코드가 **3중이 아니라 4중** 표기(`sparta/classic/capital`, `1/4/5`, `S/C/E`, `SP/C/E`).
  - 국적 **12종**(문서 6종 → tha/rus/sa/mgl/om 추가), 단 **`sa=SA[러시아]` 라벨 오류**(사우디여야 함) 발견.
  - 코스 마스터 **71개**, 유학원(agency) **111개**, 기숙사 구역(zone) **31개**, 그룹코드 36개(2501~2712) 전량 확보.
- 신규 요구사항 반영: **저장·인보이스 발행 중복실행 방지("이미 실행중" 가드 / idempotency)** → 레거시 중복레코드 병폐의 UI 원천 차단.

---

## 1. 진행 과정 (Process)

### 1-1. 환경 구성
- Node v22.22.3 / Playwright 1.61.1. chromium headless-shell 설치(93.5MB).
- 작업 폴더 `exploration/` 생성. 로컬 산출물(스크린샷·세션·수집 JSON)은 **.gitignore 처리**(PII·대용량 커밋 방지).

### 1-2. 로그인 자동화 — 시행착오와 해결
그누보드4 로그인은 단순 폼입력으로 실패. 3단계 디버깅으로 원인 규명:
| 시도 | 증상 | 원인 |
|---|---|---|
| ① `input[name=mb_id]` 채움 | "검색어는 두글자 이상" alert | 페이지에 폼 3개(`fsearchbox`검색/`fhead`헤더/`flogin`본문). 첫 매치=검색폼을 건드림 |
| ② `flogin` 지정 후 `form.submit()` | 로그인폼 재노출(실패) | `onsubmit=flogin_submit()`를 우회 → action이 안 바뀜 |
| ③ **제출버튼 클릭** | **성공** | `flogin_submit()`가 `action`을 `login_check.php`로 교체하고 제출버튼이 `<input type=image>`. 버튼 클릭으로 onsubmit 실행 |
- 해결 후 `adm/student.php` 로그인 리다이렉트 없이 진입 확인 → 세션을 `state.json`으로 저장해 이후 병렬 크롤이 재로그인 없이 재사용.
- 참고: `adm/index.php`(그누보드 최고관리자 전용)는 kenneth로 접근 불가하나, 커스텀 관리페이지(`adm/*.php`)는 정상 접근.

### 1-3. 메뉴 구조 자동 발견
- 진입점(`adm/`, `student.php`)의 사이드바 링크를 파싱 → **adm/*.php·board 링크 40종** 자동 수집(문서 사이트맵과 일치).
- 진입점상 안 잡힌 Cash Cards 사이드바·Scheduler는 문서 기준 URL을 병합 → **최종 45개 대상** 확정.

### 1-4. 병렬 크롤 + 오케스트레이션
- 저장된 세션으로 **동시성 4 워커 풀** 병렬 크롤. 45화면 **83초**.
- 페이지 내부 추출기(개인정보 미수집):
  - 폼: 필드명 + **셀렉트 옵션(value=label)** — 코드 사전의 원천.
  - 데이터그리드: 그누보드 **레이아웃 테이블 배제** 로직(데이터행 최빈 컬럼수 기준) + **헤더행만**(숫자/날짜 포함 행은 PII로 간주해 제외).
  - 건수 텍스트(`총 N명/건/실`), 페이지네이션 마지막 페이지.
- 1차 크롤은 레이아웃 테이블을 오인(모든 화면 49컬럼)·4화면 타임아웃 → **추출기 수정 + 재시도 로직**으로 2차에서 45/45 정상.

### 1-5. 정규화·검증
- 45화면의 셀렉트 옵션을 필드명 기준으로 병합 → **코드 사전** 산출. 화면별 컬럼 대조.

### 진행상태(TodoWrite) 최종
1. ✅ chromium 설치·로그인 검증 → 2. ✅ 메뉴 발견 → 3. ✅ 45화면 병렬 크롤 → 4. ✅ 정규화·검증 → 5. ✅ (본)보고서.

---

## 2. 결과 — 화면 인벤토리 (45)

> 데이터그리드 컬럼은 **구조(헤더)만**. 통계/매트릭스·배치도·캘린더 화면은 표준 테이블이 아니라 별도 표기.

### 2-1. Student's (24화면)
| 화면 | URL | 컬럼(구조) / 특징 |
|---|---|---|
| STUDENT LIST | student.php | AGENCY·NAT·NAME·KOR·AGE·SEX·APPLY·DEPA·PICKUP·END·PERI·COND·COURSE·DORM |
| 수강등록관리 | student_list.php | 위 + 상담이력·진단서·동의서·성적표 열 / **90,533명** |
| 멀티수강관리 | student_list3.php | + 코스시작일 / **8,308명** |
| MC Report 1 | student_list3_en1.php | Num·Campus·Course·Start·End·Week·Info·ID |
| MC Report 2 | student_list3_en2.php | 코스×주차 매트릭스 |
| Graduate | student_list3_en3.php | Num·Campus·Name·Gender·Nation·Start·End·Week·Info·ID |
| APPLY LIST | student_list2.php | + BIRTH·BEGIN·COUNSEL·HEALTH·PA·O.S. |
| HISTORY | student_history.php | + Pickup·Make ID·Make Date |
| 변경환불홀딩 | student_list_change.php | AGENCY·NAME·STUDENT·APPLY·CENTER·**CHANGE·ADD COURSE·ETC FEE·REFUND·HOLDING·MODIFY·INVOICE·RESULT·COMPLETE·DELETE** |
| CHG-REF-HOLD | student_list_change-back.php | 위 변형 |
| 수금관리 | student_list_pay.php | 유학원·국적·이름·나이·성별·수금방법·상태·기간 / **90,533명** |
| DEPOSIT | student_payment.php | NO·NAT·NAME·BEGIN·END·**STATUS·DEPOSIT·UNIT·DATE** |
| Deposit(test) | student_payment-2.php | Deposit#·NAT·eNAME·CAMPUS·STATUS·DEPOSIT·UNIT·DATE |
| FARM & GYM | student_farm.php | NAT·NAME·GYM START·GYM PERIOD·FARM ARRIVAL·FARM FLIGHT·COMMENTS·COMMISSION·APPLY |
| GYM 리포트 | student_gym.php | + GYM FEE·CAMPUS |
| FARM 리포트 | student_farm2.php | NAT·NAME·FARM ARRIVAL·PAID·FARM FEE·COMMISSION·APPLY·CAMPUS |
| POPULATION / 2 | student_population(2).php | 국적×캠퍼스(ENCANTO/CLASSIC/CAPITAL/TOTAL) 교차표 |
| STDNT STATUS | student_present2.php | 센터×국적×일자 매트릭스(인원·%) |
| STDNT Fullsize/Encanto/Classic/Capital | student_present2-*.php | **홈(/)으로 리다이렉트 = 외부 에이전시 포털 링크**(관리기능 아님) |
| REGISTER STATS | student_register.php | 신규등록 통계(fsearch) |
| GAC BOARD / Holding | bbs/board.php | 게시판(NO·TITLE·WRITER·DATE·VIEW) |

### 2-2. Dormitory (16화면)
| 화면 | URL | 컬럼(구조) / 특징 |
|---|---|---|
| DORM SEARCH | room_search2.php | GROUP·ROOM NUMBER·BED NUMBER·PER/ROOM(인실)·SEX·CENTER |
| 기숙사현황 | room_stat3.php | **방배치도**(폼 sf) — 표준 테이블 아님 |
| DORM STATUS | room_stat2.php | 배치도 영문판 |
| 기숙사이동관리 | room_move_list.php | 유학원·국적·이름·나이·성별·출발일·픽업·기간·**변경전객실·처리일·변경될객실·상태·상황·상태변경** |
| ROOM M-LIST | room_move_list2.php | CAMPUS·AGENCY·…·**BEFORE·D-DAY·S-DAY·AFTER**·COND·ORDER·CHANGE |
| 일별 입실&퇴실 | room_use_count_list.php | 처리일자·신규입실·연장입실·홀딩사용입실·일반퇴실·환불퇴실·퇴교퇴실·홀딩퇴실 |
| DAY IN&OUT | room_use_count_list2.php | 위 영문 매트릭스 |
| ELEC & WATER | room_elec.php | 전기·수도 요금 계산(fsearch) |
| VISIT(detail) | uhak_agency_visit.php | No·AGENCY·VISIT DATE·VISIT TIME·VISITER·**PHONE·REQUIREMENT·RESULT** |
| VISIT(calenda) | uhak_agency_schedule_list.php | 월 캘린더(SUN~SAT) |
| DORM LIST | room_list.php | NO·CATEGORY·R-NO·CAPACITY·SEX·**KOR·CHI·JAP·TWA·VTN·ETC**(국적별 재실)·CENTER·CHECK / 1,127실 |
| BACK-UP LOG | room_change_log.php | AGENCY·ID#·STUDENT·CHANGE TIME·STUDY PERIOD·PRE-DORM·CHANGE-DORM·MANAGER / 552K audit |
| DAYOFF / Scheduler | scheduler_index(-all).php | 매니저 휴무 월/주/일 캘린더 |
| Admission Date | smeag_admissiondate.php | 캠퍼스×성별×인실 입학가능일 그리드 |

### 2-3. Cash Cards (3화면)
| 화면 | URL | 컬럼 |
|---|---|---|
| Manage Cash | student_cash_payment.php | #·Name·Country·Balance·Cash-in·Cash-out·Created·Action |
| Group Students | student_group_payment.php | #·Group Name·Country·#of Students·Status·Added by·Created·Action |
| Pre-paid Info | student_payment-2.php | Deposit#·NAT·eNAME·CAMPUS·STATUS·DEPOSIT·UNIT·DATE |

---

## 3. 코드 사전 (실측 — 신규 시스템 마스터데이터 원천)

### 3-1. 핵심 코드
| 필드 | 값 = 라벨 |
|---|---|
| **pay_status** | `X`=분납(INSTALL) · `Y`=완납(PAID) · `N`=미납(UNPAID) · `R`=RETURN ⚠️문서의 X=예외는 **정정** |
| **condition / now_status** (14) | normal·extend·refund·exchange·cancel·paycancel·out·holding·holdinguse·graduated·waiting·checking·etc (+NORMAL 정상…) |
| **nation** (12) | kor·chi·jap·twa·vtn·**tha**·**rus**·**sa**·**mgl**·**om**·etc ⚠️`sa=SA[러시아]` 라벨오류(사우디) |
| **gender** | M=Male · F=Female · **C=Family** (기숙사는 M/F/Family) |
| **check_name**(예약상태) | S=입실 · M=이동 · E=퇴실 · G=GRADUATE |
| **slt / r_limit**(인실) | 1~5 bed / per-room |
| **sgroup**(그룹) | 2501~2712 (YYMM) 36개 |

### 3-2. ★ 캠퍼스 코드 4중 표기 (신규 통합 최우선)
| 화면/필드 | ENCANTO | CLASSIC | CAPITAL |
|---|---|---|---|
| campus (DEPOSIT) | `sparta`(엔칸토) | `classic` | `capital` |
| campus_condition / s_campus / search_campus | `SPARTA` | `CLASSIC` | `CAPITAL` |
| search_condition (수강·전기) | `1` / `S` / `SP` | `4` / `C` | `5` / `E` |
| center_gubun | `sparta` | `classic` | `capital` |

→ 신규는 **`campus_id`(1/4/5) 단일 + code_map**로 통일(설계서 P1).

### 3-3. 대용량 마스터(전량 확보, 상세는 `exploration/dict_options.json`)
- **course_info**(71): ESL/ESL2/ESL-CAE/Pre-IELTS/IELTS 5.5~7.0/Pre-TOEIC/TOEIC 600~900/Pre-TOEFL/TOEFL 60~100/Business 등 (ID 부여).
- **uhak**(111 agency): doa/amahn/ames/blueocean/OEA/bridgeblue/catta/EBVN … (베트남계 다수, `(1)` 프리픽스 표기).
- **room_gubun**(31 zone): TEMPORARY/FAMILY, CAPITAL1~4(MALE/FEMALE), S hotel(H), CAPITAL(O), Citadines hotel, Commercial_Shop 등 — 건물×성별 구역.
- **sfl**(게시판 검색): mb_id=Agency ID, mb_name=Agency NAME, d_date=DATE, wr_subject/wr_content 등.
- 변경/환불/홀딩 워크플로 코드: `info_process`(normal/cancel/waiting) · `info_result`(center/account/collection/refund/holding/cancel) · `info_amount`(refund/holding) · `pay_channel`(center/account).

---

## 4. 기존 문서 대비 정정·확장 (검증 결과)

| 구분 | 기존 문서 | 실측(정정/확장) |
|---|---|---|
| pay_status X | 예외(EXCEPTION) | **분납(INSTALL)** ← 정정 |
| 캠퍼스 코드 | 3중(sparta/1/S) | **4중**(+`SP/C/E`, `SPARTA/CLASSIC/CAPITAL`) |
| 국적 | 6종 | **12종**(tha/rus/sa/mgl/om 추가), `sa` 라벨오류 |
| 코스 | 미상 | **71개 카탈로그**(ID 포함) |
| 유학원 | "수십 종" | **111개** |
| 방구역 | 미상 | **31개**(건물×성별) |
| 변경환불홀딩 | CHANGE유형만 | **INVOICE·MODIFY·RESULT·COMPLETE·DELETE 등 상세 워크플로 열** 확인 |
| DORM LIST | 1,127실 | + **국적별 재실(KOR/CHI/JAP/TWA/VTN/ETC) 열** |
| STDNT 캠퍼스뷰 4종 | "포털 연결(Classic만)" | **4종 모두 홈 리다이렉트**(외부 포털) 실증 |

---

## 5. 신규 요구사항 — 중복 실행 방지 (Idempotency)

> "파일 저장 및 인보이스 발행 시 한 번 실행했으면, 중복 시 '이미 실행중' 메시지로 **중복 레코드 발생 방지**."

레거시의 최대 병폐(예약 88쌍 완전중복·유령행, `room_reserve` 280만 비대화)를 **UI/서버 양쪽에서 원천 차단**하는 요구. 신규 설계 반영:

1. **더블서밋 가드(클라이언트)**: 저장/발행 버튼 클릭 즉시 비활성화 + "처리 중…" 스피너. 재클릭 시 `이미 실행 중입니다` 토스트, 재전송 차단.
2. **멱등키(서버)**: 저장/발행 요청에 `idempotency_key`(폼 진입 시 발급 UUID) 첨부. 동일 키 재수신 시 **신규 INSERT 없이 최초 결과 반환**.
3. **DB 유니크 제약**: 인보이스는 `UNIQUE(invoice_no)` 또는 `UNIQUE(student_id, period, type)`; 예약은 기적용 `uq_res_no_dup` 계열. 경합 시 409/"이미 발행됨".
4. **진행상태 락**: 장기작업(엑셀 발행 등)은 `processing` 상태 플래그로 중복 트리거 차단, 완료/실패 시 해제.

→ 상세 인터랙션은 [화면설계서 §4 화면 상태 규칙](docs/design-admin/화면설계서.md)에 반영.

---

## 6. 산출물 & 재현 방법

```
exploration/
  lib_login.js       # 로그인 헬퍼(flogin 버튼클릭 → login_check.php)
  02_discover_menu.js# 메뉴 링크 발견
  03_crawl.js        # 병렬 크롤(동시성4) — 구조 메타만
  04_summarize.js    # 코드사전·컬럼 정규화
  crawl_results.json # 45화면 구조(로컬, gitignore)
  dict_options.json  # 코드사전(로컬, gitignore)
  shots/             # 스크린샷(로컬 전용, gitignore — PII 보호)
```
재현: `cd exploration && node lib_login.js && node 02_discover_menu.js && node 03_crawl.js && node 04_summarize.js`

## 7. 개인정보 보호 조치
- result.md·화면설계서에는 **화면 구조·코드값만** 기록. 학생 이름/생년월일/여권/연락처 등 **실제 값은 미기록**.
- 헤더 추출기에 **숫자/날짜 포함 행 제외** 로직 → 데이터행 오수집 방지.
- 스크린샷·수집 JSON·세션은 **.gitignore**로 커밋/푸시 제외(로컬 전용).

## 8. 다음 단계(제안)
- [ ] `sa=러시아` 등 라벨오류 신규 마스터에서 교정(SA=사우디).
- [ ] 캠퍼스 4중코드 → `campus_id` 매핑 테이블 확정.
- [ ] course/agency/zone 마스터를 신규 DB 시드로 이관.
- [ ] 중복방지(멱등키+유니크제약) 설계를 저장/발행 API 표준으로 채택.
