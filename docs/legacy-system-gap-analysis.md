# 신전산 Gap Analysis — 회의 요구사항서 vs 현재 코드베이스

> 작성 2026-08-06 · **코드 변경 없음(조사·대조만)**
> 대상: 신전산 `deploy/`(Vercel 정적 + 서버리스) · Supabase(Postgres, `legacy`/`cms`/`app`/`public` 스키마) · 레거시 덤프 `sql/`(읽기전용)
> 근거 표기: `파일:라인` · DB는 `스키마.테이블` · API는 `/api/*` 엔드포인트와 함수명

---

## 0. 한눈 요약

| 구간 | 요구 | 완료 | 부분 | 미구현 | 오류위험 |
|---|---:|---:|---:|---:|---:|
| 권한(§3) | 7 | 1 | 3 | 3 | 1 |
| 수강등록(§4) | 6 | 4 | 1 | 1 | 0 |
| 픽업(§5) | 3 | 1 | 1 | 1 | 0 |
| 멀티수강(§6) | 1 | 0 | 1 | 0 | 1 |
| MC Report(§7) | 2 | 0 | 1 | 1 | 1 |
| 변경환불홀딩(§8) | 4 | 2 | 2 | 0 | 0 |
| 인보이스(§9) | 3 | 2 | 0 | 1 | 1 |
| 코스 마스터(§10) | 3 | 0 | 1 | 2 | 0 |
| 통계(§11) | 3 | 0 | 1 | 2 | 1 |
| 기숙사 현황(§12) | 8 | 6 | 2 | 0 | 0 |
| 객실 생성·수정(§13) | 4 | 0 | 0 | 4 | 0 |
| 캠퍼스 생성(§14) | 1 | 0 | 0 | 1 | 1 |
| 기숙사 이동(§15) | 2 | 0 | 1 | 1 | 0 |
| 입퇴실 중복(§16) | 4 | 1 | 2 | 1 | 1 |
| 일별 입퇴실(§18) | 1 | 0 | 1 | 0 | 1 |
| 전기·수도(§19) | 6 | 1 | 1 | 4 | 1 |
| 감사로그(§20) | 3 | 1 | 1 | 1 | 0 |
| Admission Date(§21) | 2 | 0 | 0 | 2 | 1 |
| 가격 일괄수정(§23) | 4 | 0 | 0 | 4 | 0 |

**핵심 결론 5줄**

1. **읽기(조회) 계층은 거의 완성**, **쓰기(마스터 관리) 계층이 통째로 비어 있다.** 캠퍼스·코스·객실·가격을 관리자 화면에서 만들거나 고칠 수 있는 기능이 하나도 없다(§10·§13·§14·§23 = 전부 미구현).
2. **통계 3종(MC Report 2 · POPULATION · STDNT STATUS)은 요구된 축이 아니다.** 요구는 *코스 × 날짜(15일)* 인데 현재는 *캠퍼스 × 주차구간* 매트릭스다 → 화면을 새로 만들어야 한다([index.html:1481-1489](deploy/index.html#L1481-L1489)).
3. **캠퍼스가 코드 57곳에 문자열로 박혀 있고, 코드 체계가 원천마다 다르다.** DB 실측 결과 `bldg_type`(room_category·room_info·room_list 공통)은 **C=CLASSIC · E=CAPITAL · S=ENCANTO · F=SPARTA · P=SPARTA PREMIUM** 이며 ELEC 화면([5173](deploy/index.html#L5173))이 옳다. 반면 `CO_CAMPUS`([4784](deploy/index.html#L4784))의 `C=CAPITAL·E=CLASSIC` 은 **근거 없는 매핑**이다 — `course_info.s_campus` 는 아예 다른 코드공간이고 `C` 는 캠퍼스가 아니다(§2-§14 상세).
4. **전기·수도는 "레거시 값 재집계"까지만 됐다.** 단가 마스터·학생별 분담·수도세·직원 단가가 전부 없다([api/data.js:1090](deploy/api/data.js#L1090)).
5. **인보이스 중복발행 방지는 4중으로 이미 되어 있다**(요구 §9-2 충족). 다만 **가격 스냅샷(§9-3)** 은 금액만 저장하고 단가 근거를 남기지 않는다([write_layer.sql:514](migration/schema/write_layer.sql#L514)).

---

## 1. 현재 시스템 구조 (요구사항 대조의 전제)

| 층 | 실체 | 비고 |
|---|---|---|
| 화면 | `deploy/index.html` (8,347줄 단일 파일) · `deploy/m/index.html`(모바일 2,125줄) | 메뉴 9카테고리·76항목([index.html:890](deploy/index.html#L890)). 화면 렌더러 = `R.<key>` 함수, 전용 렌더러가 없는 항목은 `k:'spec'` = **표 폴백** |
| 조회 API | `deploy/api/data.js` (1,428줄) | 조각(parts) 단위 읽기전용. `loadStudents`·`loadRoomstat`·`loadElecMeter` 등 20여 개 |
| 쓰기 API | `deploy/api/edit.js`(331) · `deploy/api/blocks.js`(225) | op = `chgref` · `centerpay` · `member` · 방막기 set/release **뿐** |
| 인증 | `deploy/api/auth.js` · `deploy/middleware.js` | HS256 httpOnly 쿠키 + Edge 게이트. 삭제작업은 비밀번호 재확인 토큰 필수 |
| DB(정본 아님) | `legacy.*` 54테이블 = MySQL 충실 미러(**불가침**) | `student_info` 90,524 · `room_reserve` 627,174 · `room_elec` 1,670,841 · `student_change` 26,857 · `student_info_invoice` 128,580 |
| DB(신전산 소유) | `app.*` | `write_audit` · `invoice_issue` · `room_blocks` · `member_edits` · `member_level_override` · `change_log` · `db_error_log` |
| DB(파생) | `public.dorm_reservations` 69,326 등 | 예약 원장 파생(구간모델). 배치도는 이걸 안 쓰고 `legacy.room_reserve` 를 쓴다 |

> **중요 전제**: 신전산은 레거시 원본을 고치지 않는다. 모든 수정은 `app.*` **오버레이 테이블 + 읽기 시 덮어쓰기** 방식이다(회원·유학원 수정이 이미 이 패턴). 아래 "미구현" 항목들도 같은 패턴으로 설계해야 한다.

---

## 2. 요구사항별 격차 (근거 포함)

### §3 권한 관리

| 요구 | 상태 | 근거 / 격차 |
|---|---|---|
| 역할별 메뉴·데이터 접근 제한 | **부분** | 서버측 `PART_ACCESS`(internal/business/master 3등급 × 레벨)는 있음 [api/data.js:1240](deploy/api/data.js#L1240). 화면측 부서권한(`DEPTS`/`PERMS`)은 **localStorage 저장** [index.html:5456-5463](deploy/index.html#L5456-L5463) → 브라우저마다 다르고 서버가 강제하지 않음 |
| 캠퍼스 담당자 = 자기 캠퍼스만 | **미구현** | 스코프는 `유학원(uhak_id)` 한 축만 존재 [api/data.js:1310-1330](deploy/api/data.js#L1310-L1330). 캠퍼스 스코프 없음 |
| 객실 생성·수정·비활성 = 제한된 관리자 | **미구현** | 객실 생성·수정 기능 자체가 없음(§13) |
| 감사로그 = 관리자만 | **완료** | `changelog` 조각이 internal(Lv8+) [api/data.js:1240](deploy/api/data.js#L1240) |
| Financial = 별도 고급권한 | **부분** | financial 화면은 students 조각 기반 → business 등급. 별도 등급 없음 |
| 기간 제한 노출 | **미구현** | 없음 |
| 코드 수정 없이 관리자 화면에서 권한 변경 | **부분** | `R.perms` 화면은 있으나 저장처가 localStorage [index.html:2890](deploy/index.html#L2890) |
| ⚠ 오류위험 | | 레거시 실무자 24명이 Lv7 인데 업무조각은 Lv8+ → 개별 오버라이드(`app.member_level_override`)로 1명(kenneth)만 열어둔 상태. **나머지 23명 정책 미결** |

### §4 수강 등록 관리

| 요구 | 상태 | 근거 |
|---|---|---|
| 검색기준(출발/등록/특정일 재학/시작·종료) | **부분** | `fSearchBy` = 등록/출발/시작/종료 4종 [index.html:1577](deploy/index.html#L1577), 필터 로직 [index.html:1368-1375](deploy/index.html#L1368-L1375). **"특정 날짜의 재학생" 기준 없음**(구간 포함 판정 미구현) |
| 캠퍼스·국적·상태·성별·나이·유학원·담당자·이름·ID | **완료(담당자 제외)** | [index.html:1379-1388](deploy/index.html#L1379-L1388). 담당자(매니저) 필터는 없음 |
| 진행 상태(정상/연장/관리/취소) | **완료** | `DICT.now_status` 드롭다운. 관리용(checking/waiting) 코드 존재 |
| 목/금~수 프리셋 | **완료** | `preset=pickup` 목→다음주 수 [index.html:1576](deploy/index.html#L1576) |
| **멀티 코스 선택(개수 제한 없음)** | **완료** | 검색 가능 체크박스 멀티셀렉트 [index.html:1589-1597](deploy/index.html#L1589-L1597), 필터 [index.html:1386](deploy/index.html#L1386) |
| 결과 컬럼·페이지당 표시수 | **완료** | 21열 레거시 정합 [index.html:1424](deploy/index.html#L1424), 페이지당 선택 `ppPer` [index.html:1561](deploy/index.html#L1561) |
| **미처리 학생 경고 목록** | **미구현** | `fNoRoom`(기숙사 미배정) 체크박스 한 개뿐 [index.html:1376](deploy/index.html#L1376). 인보이스 미발행·픽업 미등록·경과일·누락항목 패널 없음 |

### §5 픽업 스케줄

- **완료**: 픽업 조각(`loadPickup`)이 편명·도착시각 파싱 + 신입(In) 판정 + 날짜그룹 정렬 [api/data.js:265](deploy/api/data.js#L265).
- **부분**: 항공편 입력 UI는 학생 상세폼·AGENCY 포털에 있으나 **도착시간 자유형식 파싱 입력기(§5-1 AM/PM)** 는 미완.
- **미구현**: **가족 그룹 일괄 적용·가족별 PDF·유학원 입력 승인 플로우**. `legacy.student_group_info`(12행)는 결제 그룹이지 가족 그룹이 아님.

### §6 멀티 수강 관리 — ⚠ 오류위험

- 현재 `1.1.멀티수강관리` 는 `studentsFull` 을 **1:1 투영한 표**다 [index.html:1458](deploy/index.html#L1458) `STUPROJ['student_list3.php']`.
- 즉 **"여러 코스를 순차 수강하는 학생"을 추출하지 않는다.** 전체 학생이 그대로 나온다(태그 8,308은 크롤 스냅샷 수치).
- 다음 코스·변경예정일·교사 재배정 여부 컬럼 없음. `student_info` 의 멀티코스 필드(상세폼 `MULTI COURSE`)와 미연결.

### §7 MC Report — ⚠ 오류위험

| | 요구 | 현재 |
|---|---|---|
| 축 | **코스 × 날짜(기본 15일, 시작일 선택)** | **캠퍼스 × 주차구간(1-2/3-4/5-8/9-12/13+)** |
| 근거 | — | [index.html:1481-1489](deploy/index.html#L1481-L1489) `_courseWeekMatrix` |
| 코스 자동반영 | 신규 코스 = 행 자동 추가 | 캠퍼스 4개(`ENCANTO/CLASSIC/CAPITAL/기타`)가 **함수 안에 배열로 하드코딩** [index.html:1483](deploy/index.html#L1483) |
| 헤더 고정·엑셀 | 필요 | 표 폴백(`R.spec`)이라 전용 고정헤더 없음 |

→ **MC Report 2 는 사실상 신규 개발**이다. MC Report 1 은 `student_list3_en1.php` 투영표로 존재하나 사용여부 확인 필요(§7-1).

### §8 변경·환불·홀딩 및 수금

- **완료**: 전용화면 `R.chgref` + 조각 `chgref`(`legacy.student_change` ⨝ `student_info`, 2025+ 2,247건) [api/data.js:372](deploy/api/data.js#L372). DUE 입력·일괄 확정 쓰기(`app.student_change_set`) [migration/schema/admin_edits.sql](migration/schema/admin_edits.sql).
- **완료**: 센터수납(현장결제) + 분할납부 원장 `app.center_pay_split`.
- **부분**: 변경유형 10종 중 화면이 다루는 축은 접수·결과·기한 위주. **금액 계산기(기존액/변경액/차액/환율/수수료/최종액)** 는 학생 상세폼 DETAIL COST 재계산만 있고 변경건 단위 계산이 없다.
- **부분**: 상태 7단계(승인대기→…→환불완료) 중 `pay_result` 매핑만 사용. 첨부파일 없음.

### §9 인보이스

- **완료(§9-2 중복발행 방지)**: UI 잠금 + 멱등키 + `app.invoice_issue` UNIQUE(idem_key / target_key,seq) + 중복 시 기존 발행건 반환 [migration/schema/write_layer.sql:514-561](migration/schema/write_layer.sql#L514-L561).
- **완료**: 유학원용/학생용 문서 출력(레거시 서식 이식).
- **미구현(§9-3 가격 스냅샷)**: `invoice_issue` 는 `amount`·`detail(jsonb)` 만 저장 → **적용 단가(코스 주단가·객실 주단가·커미션율)의 근거 스냅샷이 없다.** 가격 마스터가 바뀌면 재계산 시 값이 달라진다.
- ⚠ **오류위험(계산 근거)**: 커미션 규칙이 **코드 상수 + localStorage** 다 [index.html:5505-5514](deploy/index.html#L5505-L5514). 실제 계약은 `legacy.uhak_agency_com` 4,004행(유학원×회차)에 있는데 **미연결** → 화면 커미션과 실제 계약금액이 다를 수 있다(2026-07-27 분석 A1과 동일 건).
- ⚠ **미결**: 통화 단위 — 레거시 인보이스는 `원`, 신전산 모달은 `$`. NET 정의도 2종(총액−커미션 vs 총액−입학금−커미션).

### §10 코스 마스터

- **부분**: 조회는 라이브 `loadCourses`(`legacy.course_info` 71행 ⨝ `course_category`, 국가별 가격 9열) [api/data.js:948](deploy/api/data.js#L948). 화면 `R.courses`.
- **미구현**: **코스 생성·수정·비활성·정렬순서 편집 UI/API 전무.**
- **부분(자동연동)**: 수강등록 코스 드롭다운·코스명 표시는 이미 라이브 마스터(`REAL.courses`)를 쓴다(`_buildCourseCache`). 그러나 **MC Report 2·통계는 마스터를 안 본다**(위 §7).
- 데이터 관찰: `course_info` 71개가 전부 `g_idx=5(ESL)` → `course_category` 14개 중 1개만 실사용.

### §11 학생 상태 및 통계 — ⚠ 오류위험

- 현재 3화면 전부 `_crossNationCampus` **국적 × 캠퍼스 교차표** 다 [index.html:1471-1480](deploy/index.html#L1471-L1480).
  - POPULATION = 활성상태만 / POPULATION2 = 전체 / STDNT STATUS = 재실상태 — **차이는 상태집합뿐**.
- 요구 §11-2 의 **15일 보기 · 월 전체 · 날짜별 · 월평균 · 수용률 · 연간 월별**은 전부 없다.
- 국적 10종·캠퍼스 4종이 **함수 안 배열로 하드코딩** [index.html:1472-1473](deploy/index.html#L1472-L1473).
- **STDNT Fullsize/Encanto/Classic/Capital 4개 메뉴는 레거시에서 홈 리다이렉트**로 확인됨(메뉴 note) → 실제 사용화면인지 담당자 확인 필요.
- ⚠ **일별 재학생 수 단일 산출원 없음**: 학생 목록은 `student_info` 슬라이스, 배치도는 `room_reserve`, 일별 입퇴실은 크롤 스냅샷 표 → **같은 날짜에 화면마다 숫자가 다를 수 있다**(요구 §11-3 정면 위반).

### §12 기숙사 현황 (배치도)

| 요구 | 상태 | 근거 |
|---|---|---|
| 센터/성별/카테고리/객실/침대 계층 | **완료** | `loadRoomstat` 30그룹·418실·1,024베드 [api/data.js:195](deploy/api/data.js#L195) |
| 전체 보기 | **완료** | 그룹 `ALL` 옵션(단, 조회 게이트가 center+gender+group 3선택 필수) |
| sort_order 정렬 | **완료** | `room_category.g_order` 순서 사용 |
| 섹션(구분) 표시·헤더 고정 | **완료** | 좌측 고정 `c0(Group)` + 라벨 sticky |
| **조회 기간 내 모든 학생 표시** | **완료** | 침대별 세그먼트 전량 렌더 + 이름·기간 오버레이 |
| 선택 월이 왼쪽 기준 | **부분** | 13개월(±6) 창의 **중앙**이 선택월. 요구는 "선택월 1일이 시작점" → 스크롤 초기위치 정책 차이 |
| 한국어 화면 = 한국어 이름 | **완료** | `korDisp()` KOR 우선 [index.html:5500](deploy/index.html#L5500) |
| 객실 최대 인원 표시 | **완료** | `room_info.i_limit` → `N-person` 칩 |
| ⚠ 남은 것 | | **침대 `r_idx` 가 프론트로 안 내려온다** → 이동 대상 침대 식별 불가(방이동 개발의 0번 작업, 기획서 §선행과제) |

### §13 객실 생성 및 수정 — **전부 미구현**

- 객실 생성/수정/비활성/중복검증 화면·API 없음. `Update Rooms(new)`(`room_list-rey.php`)는 메뉴만 있고 `k:'spec'` 표 폴백 [index.html:967](deploy/index.html#L967).
- DORM LIST 도 조회 전용. 유일한 객실 쓰기는 **방막기(Block)** `app.room_blocks` 뿐.
- 요구 §13-2(학생 이력 있는 객실 구조변경 제한)·§13-4(동일 카테고리 내 방번호 중복 검증)를 걸 대상 테이블이 신전산 소유로 존재하지 않는다 → `app.room_master_overlay` 신설 필요.

### §14 캠퍼스 생성 및 수정 — **미구현 + ⚠ 오류위험**

- 캠퍼스 생성 UI 없음. 캠퍼스는 **코드 문자열**로만 존재: `index.html` 에서 `ENCANTO|CLASSIC|CAPITAL` 문자열이 **59개 라인**에 등장(방구분 압축표 1줄 제외).
- 대표 지점:
  - `_campNorm()` 정규화 [index.html:1466-1469](deploy/index.html#L1466-L1469)
  - 학생 필터 캠퍼스 셀렉트 [index.html:1588](deploy/index.html#L1588)
  - 통계 캠퍼스 배열 [index.html:1472-1473](deploy/index.html#L1472-L1473) · [index.html:1483](deploy/index.html#L1483) · [index.html:3960](deploy/index.html#L3960)
  - 코스 캠퍼스 코드맵 `CO_CAMPUS = {S:ENCANTO, C:CAPITAL, E:CLASSIC}` [index.html:4784](deploy/index.html#L4784)
  - ELEC 캠퍼스 코드맵 `S=ENCANTO, C=CLASSIC, E=CAPITAL` [index.html:5173](deploy/index.html#L5173)
  - 커미션 빌딩 정액 `{ENCANTO,CLASSIC,CAPITAL,ETC}` [index.html:5509](deploy/index.html#L5509)
  - 배치도 방구분 압축표 `LEGACY_CATS`(30그룹 전체가 문자열) [index.html:1847](deploy/index.html#L1847)
  - 등록폼 캠퍼스 셀렉트 [index.html:2615](deploy/index.html#L2615) · 상세폼 CAMPUS CHOICE [index.html:6954](deploy/index.html#L6954)
  - Admission Date 캠퍼스 행 [index.html:2050](deploy/index.html#L2050)
- ⚠ **코드 체계가 원천마다 다르다 (2026-08-06 DB 실측으로 확정)**

  | 원천 | 코드값 | 실제 의미 | 근거 |
  |---|---|---|---|
  | `room_category`·`room_info`·`room_list`.`bldg_type` | C / E / S / F / P | CLASSIC / **CAPITAL** / ENCANTO / SPARTA / SPARTA PREMIUM | g_name 그룹 분포(42/30/17/7/10) + 배방학생 `r_campus` 일치율 94.6·97.0·90.2·81.2% |
  | `course_info.s_campus` | C 56 · S 10 · A 5 · E 0 | **C 는 캠퍼스가 아님**(공통/기본값) · S=ENCANTO · A=ALL | C 코스 수강생이 CAPITAL 40,318·SPARTA 20,917·CLASSIC 19,451·PREMIUM 2,218 로 전 캠퍼스 분산 |
  | `student_info.s_campus` | 코드 아님, **문자열** | CAPITAL 40,547 · SPARTA 27,414 · CLASSIC 19,469 · SPARTA PREMIUM 2,218 | distinct 집계 |

  → ELEC 화면([5173](deploy/index.html#L5173))과 배치도 주석([1845](deploy/index.html#L1845))은 **옳다**. 틀린 것은 `CO_CAMPUS`([4784](deploy/index.html#L4784))의 `C:'CAPITAL', E:'CLASSIC'` 하나다(근거 없음). 다만 세 코드공간이 서로 다르므로 **마스터를 하나의 코드표로 만들면 오히려 오류가 번진다** — `campus_code_map(원천테이블, 원천컬럼, 코드값 → campus_id)` 처럼 원천별 매핑이어야 한다.

- ⚠⚠ **실사용 버그(신규 발견)**: `student_info.s_campus` 에 **ENCANTO 가 0건**이다(실값은 SPARTA 27,414 + SPARTA PREMIUM 2,218 = 32.7%).
  - 학생 목록 CAMPUS 필터의 `ENCANTO` 옵션([1588](deploy/index.html#L1588))은 **항상 0건**이고, SPARTA 학생 29,632명은 어떤 옵션으로도 걸러지지 않는다.
  - 학생 상세폼 CAMPUS CHOICE([6954](deploy/index.html#L6954))는 선택지가 `CAPITAL/ENCANTO/CLASSIC` 뿐이라 **SPARTA 학생을 저장하면 캠퍼스가 조용히 바뀐다.**
  - 커미션 빌딩 정액([5509](deploy/index.html#L5509))도 SPARTA 를 모르고 `ETC→0` 으로 처리한다.
  - → REQ-107(캠퍼스 마스터)의 우선순위를 올려야 하는 실질적 이유다.

### §15 기숙사 이동 관리

- **부분**: `R.roommove` 화면 존재. 그러나 **필터가 장식이다** — CAMPUS·DORM CONDITION·STDNT CONDITION·AGENCY·NAME·SEARCH 에 `id`도 핸들러도 없다 [index.html:1729-1738](deploy/index.html#L1729-L1738). 데이터도 라이브 DB가 아니라 크롤 스냅샷 `REAL.tables[m.u]`.
- **미구현**: 이동 사건 모델(상태·사유·담당자·예정/실제시각·청소필요) — 2026-08-06 기획서(`docs/기획_방이동관리_2026-08-06.md`)에 설계만 되어 있고 **코딩 미착수**.
- 한/영 버전 통합은 이미 하나의 렌더러(`R.roommove`)가 두 메뉴를 처리하므로 기능차 없음(요구 §15-2 충족).

### §16 입실·퇴실·이동 중복 처리 — ⚠ 오류위험

- **완료**: 같은 날 퇴실+입실을 배치도에서 **대각선 분할(`boutin`)** 로 렌더 → 셀 1칸 1명 제약은 이미 없음.
- **부분**: 데이터 모델. `legacy.room_reserve` 가 *침대 × 날짜* 라 점유는 정확하지만 **이벤트(check_in/out/move_in/out)가 타입으로만 존재**(rr_type S/I/E/R)하고 **시각·사유·담당자가 없다**.
- **부분**: `public.dorm_reservations` 에 계획/실제 퇴실 이원화(`actual_check_in/out`)는 있음 [migration/schema/actual_checkout.sql](migration/schema/actual_checkout.sql).
- **미구현**: 요구 §16-2 의 `room_assignments`/`room_events` 분리 — 기획서에만 존재.
- ⚠ **일별 재학생 수 = 셀 개수 계산 위험**: 현재 `R.dailyio` 는 크롤 스냅샷 표를 그대로 합산한다 [index.html:1749](deploy/index.html#L1749) → 관리용 가상학생 제외·이동 중복제거가 보장되지 않는다.

### §18 일별 입실·퇴실 현황 — ⚠ 오류위험

- 화면은 있으나 **데이터가 라이브가 아니다**(`REAL.tables['room_use_count_list.php']` = 레거시 크롤 스냅샷). CAMPUS 필터도 미배선 [index.html:1756](deploy/index.html#L1756).
- 요구 6지표(신규입실/퇴실/이동입실/이동퇴실/연장/현재재학) 중 스냅샷 컬럼에 있는 것만 표시.

### §19 전기세·수도세 — 대부분 미구현

| 요구 | 상태 | 근거 |
|---|---|---|
| 방별 검침·사용량 집계 | **완료** | `loadElecMeter` 일자별 delta 합(0~2000 클램프), 방 단위 서버집계 [api/data.js:1090](deploy/api/data.js#L1090) |
| 단가 마스터(학생 20₱ / 직원 14₱ / 수도 10₱·일) | **미구현** | 단가 테이블 없음. 화면 `charge` = 레거시 `charge_gage` 합계 그대로 |
| 거주 학생별 분담 계산 | **미구현** | 방↔학생 조인 없음(`p_count` 만 참조) |
| 직원 여부 명시 필드 | **미구현** | 레거시는 이름 접두 `STAFF_` 관행 — 필드 없음 |
| 수도세 | **미구현** | 컬럼·화면 모두 없음 |
| 개인별 조회·수정이력·OCR | **미구현** | — |
| ⚠ 성능 | | `room_elec` 인덱스가 PK뿐 → 기간 400일 클램프로 회피 중. 인덱스 DDL 제안만 존재(미실행) |

### §20 감사 로그

- **완료(조회)**: BACK-UP LOG = `legacy.room_change_log` 최근 300건 [api/data.js:345](deploy/api/data.js#L345).
- **부분**: **검색이 동작하지 않는다** — 매니저·학생ID·이름·기간 입력에 핸들러가 없다 [index.html:2029-2035](deploy/index.html#L2029-L2035). 매니저 목록도 5명 하드코딩 [index.html:2019](deploy/index.html#L2019). 2019년 등 과거 이력 조회 불가(300건 상한).
- **미구현(신전산 행위 기록의 화면 노출)**: `app.write_audit`·`app.change_log`·`app.admin_activity_log` 에 기록은 남지만 **관리자 화면에서 볼 수 없다.** 요구 §20-1 의 객실 생성/비활성/가격변경은 기능 자체가 없어 기록 대상도 없음.

### §21 Admission Date 및 홈페이지 연동 — ⚠ 오류위험

- **전부 가짜 데이터**: `seed` 기반 난수로 "7/2X 대기 / 즉시" 를 그린다 [index.html:2041-2052](deploy/index.html#L2041-L2052). 캠퍼스 4개·인실 4종도 배열 하드코딩.
- 저장 테이블·API·홈페이지 연동 없음.

### §22 홈페이지 HTTPS

- 본 리포 범위 밖(인프라). 신전산은 Vercel HTTPS 로 정상.

### §23 객실·코스 가격 일괄 업데이트 — **전부 미구현**

- 국가별 가격 데이터는 이미 있다: 코스 9열(`pay/cn/jp/tw/vt/ru/sa/mgl/etc`) [index.html:4786-4790](deploy/index.html#L4786-L4790), 객실 국가별 컬럼(DORM LIST `KOR/CHI/JAP/TWA/VTN/ETC`).
- 그러나 **편집·미리보기·일괄적용·트랜잭션·변경로그가 전무.** 조회 전용.
- 요구 §23-4(기존 인보이스 보호)는 §9-3 스냅샷과 한 몸 — 스냅샷이 없으므로 현재 구조에서는 보장 불가.

### §24 학생·교사 매칭 / §25 미사용 메뉴 정리

- §24: 신전산에 없음(P2). §25: 미사용 후보 메뉴는 **레거시 정합을 위해 오히려 전부 복원해 둔 상태**(9카테고리 76항목). 사용로그 기반 정리는 미착수.

### §26 UI / §27 이관 검수

- §26 고정영역·스크롤·디자인 일관성: **대부분 완료**(고정헤더·좌측 고정열·폭 드래그·가상화). 성능은 학생 12,389·객실 418실 기준 검증됨(요구 기준 2,000명·수백실 상회).
- §27 이관 검수: **행수 대조는 완료**(51~54테이블 원본=적재 100% 일치, 2026-07-16·07-30 실증). **미구현**: 요구 §27-6 의 **객실 차이 보고서**(레거시엔 있고 신전산엔 없는 객실 등 8종 리포트).

---

## 3. 하드코딩 인벤토리 (마스터 데이터로 교체 대상)

| # | 대상 | 위치 | 교체 방향 |
|---|---|---|---|
| H1 | 캠퍼스명 문자열 **57곳**(index.html 56 + data.js 1) — 실측 분류: 치환대상 57 / 주석·데모 12 / 레거시 의도 11 / CSS토큰 13 | `deploy/index.html` 전역(§14 목록 참조) | `app.campus_master(campus_id, name, name_en, order, capacity, active)` + 화면은 ID 참조 |
| H2 | `CO_CAMPUS` 오매핑 1곳(근거 없음) | [index.html:4784](deploy/index.html#L4784) | 원천별 `campus_code_map` 으로 대체. ELEC(5173)은 정상이므로 **건드리지 말 것** |
| H2b | **SPARTA 캠퍼스 미인지**(학생 32.7%) | [1588](deploy/index.html#L1588) · [2615](deploy/index.html#L2615) · [5509](deploy/index.html#L5509) · [6954](deploy/index.html#L6954) | 마스터에 SPARTA·SPARTA PREMIUM 추가 후 셀렉트를 마스터 기반으로 |
| H3 | 방구분 30그룹 압축표 `LEGACY_CATS` | [index.html:1847](deploy/index.html#L1847) | `legacy.room_category` 라이브(이미 API 존재) 전용으로, 목데이터 폴백 삭제 |
| H4 | 통계 국적 10종 | [index.html:1472](deploy/index.html#L1472) · [index.html:6908](deploy/index.html#L6908) | `app.nation_master`(라벨오류 `sa=러시아` 교정 포함) |
| H5 | 통계 캠퍼스 배열 | [index.html:1473](deploy/index.html#L1473) · [1483](deploy/index.html#L1483) · [3960](deploy/index.html#L3960) | H1 참조 |
| H6 | 커미션 규칙(나라%·코스액·빌딩액) | [index.html:5505-5514](deploy/index.html#L5505-L5514) + localStorage | `legacy.uhak_agency_com` + `app.commission_rules` |
| H7 | 감사로그 매니저 목록 5명 | [index.html:2019](deploy/index.html#L2019) | `cms.g4_member` Lv8+ 라이브 |
| H8 | Admission Date 캠퍼스·인실·가용일 | [index.html:2042-2050](deploy/index.html#L2042-L2050) | `app.admission_date` 신설 |
| H9 | 부서·권한 매트릭스 | [index.html:5456](deploy/index.html#L5456) + localStorage | `app.role_master` / `app.role_permission` |
| H10 | 학생 슬라이스 기준일 `SLICE_FROM='2025-01-01'` | [api/data.js:31](deploy/api/data.js#L31) | 파라미터화(요구 §4 "특정 날짜 재학생" 검색의 전제) |
| H11 | 전기 기간 상한 400일 | [api/data.js:1051](deploy/api/data.js#L1051) | 인덱스 적용 후 완화 |

---

## 4. DB 스키마 변경 필요 목록 (신전산 소유 `app.*` 만, 레거시 불가침)

| 신설/변경 | 목적 | 요구 | 비고 |
|---|---|---|---|
| `app.campus_master` + `app.campus_code_map` | 캠퍼스 CRUD·코드 단일화 | §14 | 표시명 변경해도 ID 불변 |
| `app.room_master_overlay` | 객실 생성·수정·비활성·정렬 | §13 | `legacy.room_info/room_list` 위 오버레이 |
| `app.room_category_overlay` | 카테고리 생성·정렬 | §12·§14 | |
| `app.course_master_overlay` | 코스 생성·수정·비활성 | §10 | `legacy.course_info` 오버레이 |
| `app.price_room` / `app.price_course`(+`valid_from`) | 국가별·기간별 가격 이력 | §23 | 일괄수정 트랜잭션 대상 |
| `app.invoice_issue.price_snapshot jsonb` | 발행시점 단가 고정 | §9-3 | 기존 테이블 컬럼 추가 |
| `app.room_assignments` / `app.room_events` | 이동사건·입퇴실 시각 | §15·§16 | 기획서 설계 그대로 |
| `app.student_stay_facts` | 졸업일·실제퇴실·도착시각 | §16·§17 | 기획서 확정분 |
| `app.utility_rate`(전기 학생/직원·수도 일액, 적용기간) | 단가 마스터 | §19-3 | |
| `app.utility_charge`(방·기간·학생별 분담) | 분담 계산 결과 | §19-4 | |
| `app.person_kind`(학생/직원/매니저) | 직원 단가 판정 | §19-3 | 이름 접두 의존 제거 |
| `app.admission_date` | 입학가능일 | §21 | 홈페이지 공개 뷰 포함 |
| `app.role_master`/`app.role_permission`/`app.user_scope(campus)` | 서버측 RBAC + 캠퍼스 스코프 | §3 | localStorage 대체 |
| `app.pickup_family_group` | 가족 픽업 묶음 | §5-2 | |
| 인덱스 `room_elec(re_date)`, `room_elec(i_idx,re_date)` | 전기 조회 성능 | §19 | 제안됨·미실행(+50MB) |

---

## 5. API 변경 목록

| 엔드포인트 | 변경 | 요구 |
|---|---|---|
| `/api/data` parts 추가 | `mcreport2`(코스×날짜) · `population`(날짜별) · `enrollstatus`(미처리 학생) · `dailyio`(라이브) · `roommove`(라이브) · `changelog`(검색·페이징) · `admission` · `utility` | §7·§11·§4-6·§18·§15·§20·§21·§19 |
| `/api/data` 공통 | `asof` 날짜 기준 재학생 판정 · 캠퍼스 스코프 · `SLICE_FROM` 파라미터화 | §4·§3 |
| `/api/edit` op 추가 | `campus` · `room` · `roomcat` · `course` · `price_bulk` · `admission` · `utility_rate` | §10·§13·§14·§19·§21·§23 |
| `/api/moves` (신설) | 이동 사건 CRUD + 승인(Lv10) | §15·§16 |
| 공통 | 모든 쓰기에 멱등키·need_confirm·감사로그 필수(기존 패턴 계승), 삭제는 비밀번호 재확인 토큰 | §28 |

---

## 6. 화면 변경 목록 (우선순위 표기)

| 화면 | 작업 | 우선 |
|---|---|---|
| 수강등록관리 | 미처리 학생 경고 패널(탭/하단) · 특정일 재학 검색 · 담당자 필터 | P0 |
| MC Report 2 | **신규**: 코스 × 날짜 15일 매트릭스, 시작일 선택, 헤더 고정, 엑셀 | P0 |
| 기숙사현황 | 선택월 1일 기준 스크롤 · 침대 `r_idx` 노출 | P0 |
| 캠퍼스/객실/카테고리 관리 | **신규 3화면**(생성·수정·비활성·정렬) | P0 |
| BACK-UP LOG | 검색·페이징 실동작 + 신전산 감사로그 통합 | P0 |
| 가격 일괄수정 | **신규 2화면**(객실·코스, 미리보기·적용·로그) | P0 |
| 멀티수강관리 | 멀티코스 실추출로 교체 | P1 |
| 기숙사이동관리 | 필터 배선 + 라이브 데이터 + 이동사건 | P1 |
| 일별 입실·퇴실 | 라이브 집계(단일 산출원) | P1 |
| STDNT STATUS / POPULATION | 날짜별·월별·수용률 재설계, 통합 | P1 |
| ELEC & WATER | 단가·분담·수도세·개인조회 | P1 |
| Admission Date | 실데이터 + 홈페이지 노출 | P1 |
| 픽업 | 가족 그룹·스마트 시간입력·PDF | P1 |

---

## 7. 진행 전 결정이 필요한 사항 (7건)

1. **인보이스 통화** — `원`인가 `$`인가(레거시 문서 vs 신전산 모달 1000배 차이).
2. **NET 정의** — 총액−커미션 / 총액−입학금−커미션 중 정본.
3. **커미션 산출 모델** — 계약회차(`uhak_agency_com`) 선택식 vs 현재 규칙 자동계산식. 소급 적용 여부.
4. **Lv7 실무자 23명 권한** — STAFF_LEVEL 하향 / 조각별 분리 / 개별 오버라이드 중 택1.
5. **MC Report 1 사용 여부** — 아카데믹 확인 후 유지/숨김.
6. **STDNT Fullsize·Encanto·Classic·Capital 4메뉴** — 레거시에서 홈 리다이렉트인데 실제 쓰는 화면인지.
7. **전기 검침 `re_gage=0`(2026년 약 40%)** — 미검침인지 실제 0인지. 요금 계산의 전제.

---

*근거 수집: 코드 읽기 전용 · DB 조회 없음(기존 실측치 인용) · 코드 변경 0건*
