# 행정팀 요구사항 분석 (2026-07-27) — 기획 전용

> 출처: 행정팀 제출 자료 2장(레거시 화면 캡처 + 지적사항 5건)
> 대상: 신전산 `docs/design-admin/prototype.html` (배포 smeag-bay.vercel.app)
> 상태: **분석·기획 단계 — 코드 변경 없음**
> 관련: `docs/improvement-plan-meeting-2026-07.md`(미팅 요청 11건), `docs/SCREEN_PARITY_TRACKER.md`

---

## 0. 한 줄 요약

이번 5건은 미팅 11건과 성격이 다릅니다. 11건은 "**새 기능을 만들어달라**"였고,
이번 5건은 전부 "**구전산에 있던 것이 신전산에 없다**" — 즉 **패리티(누락) 이슈**입니다.

그리고 5건 중 4건이 **하나의 뿌리**에서 나옵니다: 신전산 학생 상세폼(STUDENT MANAGEMENT
INFORMATION)의 **PAY / COMMISSION 영역이 표시 전용 요약으로 축약**되어 있고,
**변경환불(student_change) 업무 축 자체가 미구현**이라는 점입니다.

| # | 요청 | 성격 | 레거시 근거 | 신전산 현재 | 난이도 |
|---|---|---|---|---|---|
| 1 | 수강등록 커미션 % 선택란 없음 | 필드 누락 | `uhak_agency_com`(4,004행) | 계산값만 표시, 선택 불가 | 중 |
| 2 | 변경환불 서류를 만들 수 없음 | **화면 전체 누락** | `student_change`(26,857행, 60+컬럼) | 없음(목록 골격만) | 상 |
| 3 | 센터수납 현장결제 입력칸 없음 | 필드 누락 | `student_info.center_pay_*` | 채널 선택만, 금액·환율칸 없음 | 하 |
| 4 | 변경환불 서류 체크란 | 목록 실동작 누락 | `student_change.info_*` | 컬럼 정의만(더미) | 중 |
| 5 | 학비 완납 여부 체크 | 필드 누락 | `student_info.pay_status` 등 | 3값 셀렉트만, 분납/환불 없음 | 중하 |

**권장 순서: ③ → ⑤ → ① → ④ → ②** (2·4는 같은 데이터축이라 ④를 ②의 선행 단계로 둠)

---

## 1. 수강등록과정에서 커미션 퍼센테이지 선택란이 없음

### 요청 내용(캡처 해석)
레거시 학생 상세 `COMMISSION INFO` 에는 **드롭다운**이 있고, 항목이
`1회 (종료) / 30% / 2019-09-23 / 담당자 : Joon(cebusme)`,
`2회 (현재) / 35% / 2019-11-15 / 담당자 : Joon(cebusme)` 형태입니다.
즉 **유학원별 커미션 계약 이력(회차)** 중 이 학생에 적용할 계약을 **사람이 고르는** 구조입니다.
옆에는 `COMMISSION[EXCLUDE APPLY FEE]` (등록비 제외 커미션 실액), 아래에 `ETC COMMISSION`.

### 레거시 데이터 근거
- `uhak_agency_com` (4,004행) — 유학원별 커미션 계약 원장
  - `no`(회차 PK) · `uhak_idx`/`mb_id`(유학원) · `com_category`(`percent`/`amount`)
  - `percent` 또는 `com_amt` · `check_date`/`confirm_date`(적용일) · `manager`(담당자)
  - `nowYN`(현재 적용 계약) · `state` · `end_date`(종료)
- `student_info.com_no` — **학생이 어느 계약 회차를 쓰는지 가리키는 참조값**
- `student_info.com_info` / `com_amount` / `fee_com1` / `com_etc1`(ETC COMMISSION)

즉 레거시 커미션은 **"유학원 계약 이력에서 회차를 선택 → 그 %/정액을 적용"** 모델입니다.

### 신전산 현재 상태
[prototype.html:3262-3267](docs/design-admin/prototype.html#L3262-L3267) — COMMISSION INFO 섹션은
`calcComm()`([:3220-3221](docs/design-admin/prototype.html#L3220-L3221))이 **자동 계산한 결과만 텍스트로** 보여줍니다.
규칙은 `나라 정율% + 코스 정액 + 빌딩 정액`([:2364-2409](docs/design-admin/prototype.html#L2364-L2409)의 COMMISSION RULES 화면에서 편집, localStorage 저장).

**갭의 본질 = 계산 모델 불일치**
- 신전산: *국적 기반* 규칙 엔진(국적%·코스액·빌딩액) — 유학원 계약 개념 없음
- 레거시: *유학원 계약 회차* 기반 선택 — 계약이 유학원마다 다르고 시점마다 바뀜

행정팀이 원하는 것은 후자입니다. 즉 **드롭다운 하나 추가로 끝나지 않고, 커미션 산출 근거를
유학원 계약(`uhak_agency_com`)으로 바꾸는 일**입니다.

### 개선안
1. `uhak_agency_com` 이관 → 유학원별 계약 이력 조회 가능하게(현재 AGENCY COMMISSION 화면은 집계만 사용).
2. 학생 상세 COMMISSION INFO 에 **계약 선택 드롭다운**:
   `N회 (현재/종료) / {percent}% 또는 {com_amt} / {confirm_date} / 담당자: {manager}`
   - 기본 선택 = `nowYN='Y'` (현재 계약), 과거 계약도 선택 가능(소급 케이스)
   - 선택 시 커미션 금액 **즉시 재계산 + 산식 근거 표시**
3. `COMMISSION[EXCLUDE APPLY FEE]` 별도 표기 — 등록비(REGIST FEE) 제외 기준 금액.
4. 기존 규칙 엔진(국적/코스/빌딩)은 **계약이 없는 학생의 폴백**으로 격하하거나, "규칙 vs 계약" 중 무엇이 우선인지 정책 확정.
5. 저장 시 `student_info.com_no` 에 선택한 회차 기록(감사 가능).

### 미결정(행정팀 확인 필요)
- **커미션 산출의 진짜 기준**: 유학원 계약(`uhak_agency_com`) 단독인가, 신전산의 국적/코스/빌딩 규칙과 병행인가?
- `percent`형·`amount`형 혼재 시 통화 기준(원화 정액 `260000` 류가 다수) — $ 환산 규칙.
- 계약 변경 시 **기존 학생 소급 여부**(회차를 바꾸면 이미 발행된 인보이스는?)

---

## 2. 변경환불 서류를 만들 수가 없음 — **가장 큰 누락**

### 요청 내용(캡처 해석)
레거시에는 **변경·환불 신청서(change / refund / other refund / add courses / Golf / holding)**
라는 전용 서류 폼이 있습니다. 구성:
- 머리: Agents · Added Date · Student's Name · SEX · Student Account · Current Training Period · Agent Comments
- 본문 좌우 대조: **Current Training Information ↔ Change Training Information**
  - Current Course(현재 코스/주수) → 변경 코스 최대 5개 슬롯(`::2-COURSE::` ~ `::5-COURSE::`)
  - Dormitory(현재: `424:4bed:CAPITAL(4)_FAMILY=2weeks`) → 변경 기숙사 최대 8개 슬롯(`::2-DORM::` ~ `::8-DORM::`) × 인실 × 주수
  - Fee(ONLY PESO) / Extra Rate(`dollar → peso` 환율 입력)

### 레거시 데이터 근거
`student_change` — **26,857행 · 60+컬럼**. 이 화면 하나를 위한 전용 테이블입니다.
- 변경: `info_course_old_*` / `info_course_new_*`, `info_dorm_old_*` / `info_dorm_new_*`
- 차액: `change_gap_price` · `course_gap_price` · `dorm_gap_price` · `exchange_rate`(변경차액계산용)
- 추가: `info_add_cate/detail/price/period`, 기타: `info_etc_title/price/note`
- 환불: `info_refund_course_*` · `info_refund_dorm_*` · `info_refund_amount` · `info_refund_date` · `info_refund_note`
- 홀딩: `info_holding_course_*` · `info_holding_dorm_*` · `info_holding_amount` · `info_holding_date`
- 처리: `info_process`(진행상태) · `info_due_date`(약속 기한) · `info_result`(비용처리결과) · `info_complete_date`
- 접수: `apply_date` · `apply_sme_campus` · `apply_sme_manager(_id)`

### 신전산 현재 상태
**없음.** 메뉴 정의에만 존재:
- [prototype.html:653](docs/design-admin/prototype.html#L653) `financial` — 변경환불홀딩 관리(`student_tution_fee_list_change.php`)
- [prototype.html:667](docs/design-admin/prototype.html#L667) `spec` — 변경환불홀딩(`student_list_change.php`), 컬럼 15개 정의
- [prototype.html:932-933](docs/design-admin/prototype.html#L932-L933) 두 URL 케이스 핸들링
- 현재 `change` 필터([:2201](docs/design-admin/prototype.html#L2201))는 학생 `now_status` 가
  exchange/refund/holding/… 인 학생을 **거르는 것**일 뿐, 변경 건(트랜잭션) 자체가 없습니다.

즉 신전산은 **"상태가 환불인 학생"은 알지만 "무엇을 어떻게 환불했는지"는 모릅니다.**
`student_change` 26,857건이 통째로 빠져 있는 상태입니다.

### 개선안 (3단계)
1. **데이터**: `student_change` 이관 → `public.student_changes`(충실 리프트) + 코스/기숙사 마스터 조인.
2. **서류 폼(신규 화면)** `CHANGE / REFUND APPLICATION`
   - 좌: 현재 정보 자동 로드(학생 상세에서 진입 시 코스·기숙사·기간 프리필)
   - 우: 변경 정보 — **코스 5슬롯 / 기숙사 8슬롯**(레거시 동일) 동적 행 추가 방식으로 재설계 권장
   - 차액 자동계산: 코스차액 + 기숙사차액 = 변경차액, `Extra Rate($→₱)` 적용해 PESO 병기
   - 유형 탭: CHANGE · REFUND · OTHER REFUND · ADD COURSE · GOLF · HOLDING
   - **인쇄/PDF 출력**(현 인보이스 `openPdf` 방식 재사용 — 외부 라이브러리 없음)
   - 저장은 write-layer RPC + **멱등키**(중복 접수 방지 — 기존 인보이스 4중 방어 패턴 재사용)
3. **연동**: 접수 → ④ 체크 목록에 즉시 반영 → 확정 시 학생 `now_status`·예약(기숙사)·인보이스에 반영.

### 미결정
- 슬롯 고정(코스5/기숙사8)을 그대로 갈지, **가변 행 추가**로 개선할지(행정팀 실무 선호 확인).
- 차액 계산 규칙(일할 계산? 주 단위 절상?)과 환율 적용 시점(접수일/확정일).
- 승인 단계 필요 여부(접수 → 검토 → 확정 2단계인지).

---

## 3. 센터수납 — 현장결제 시 입력하는 칸이 없음

### 요청 내용(캡처 해석)
레거시 PAY INFORMATION 영역:
- `PAY CHECK` = `PAY(완납)` + `CENTER(센터수금)`
- **`CNETER PAY INFO`(센터납부대상정보)** 블록 — 요청의 핵심
  - `EXCHANGE RATE DATE : 2026-07-23` · `EXCHANGE RATE : 61 ($→₱)`
  - `CENTER PAY DATE : 2026-07-23` · `CENTER PAY AMOUNT : 43920 peso` · `[[CENTER_RECEIPT]]`
  - `MEMO : 07-23 캐피탈 … 그로스가 $720을 페소 43,920p 납부($1=61p)`
- 그 아래 `STUDENT CONDITION`(EXTEND 등) · `AMOUNT(REFUND & CANCEL)` · `STAFF COMMENT[ONLY ENGLISH!]`
- 우측 `ETC DOC` + `[LOA]` `[RECEIPT]`

### 레거시 데이터 근거 (컬럼이 이미 다 있음)
`student_info`: `pay_status` · `pay_channel`(계좌/현지) · `exchange_date`(환율적용일)
· `exchange_rate`(센터납부금적용환률) · `center_pay_amount`(페소) · `center_pay_unit`(기본 peso)
· `center_pay_date` · `center_pay_memo` · `comment`

### 신전산 현재 상태
[prototype.html:3258-3261](docs/design-admin/prototype.html#L3258-L3261) —
`PAY CHECK` 셀렉트 2개(미납/완납/분납 × 계좌/센터)와 `ETC DOC`(날짜+LOA/RECEIPT 링크),
`STUDENT CONDITION`, `AMOUNT(REFUND & CANCEL)`, `STAFF COMMENT` 는 있으나
**센터납부 5필드(환율일·환율·납부일·페소금액·메모)가 통째로 없습니다.**

### 개선안 — **5건 중 가장 저공수(반나절 규모)**
1. PAY INFORMATION 에 `CENTER PAY INFO` 행 추가 — 위 5필드 + 단위 셀렉트(peso/won/usd).
2. `pay_channel = CENTER` 선택 시에만 **활성화**(계좌수금이면 비활성 — 오입력 차단).
3. **자동 계산 보조**: `달러금액 × 환율 = 페소금액` 자동 채움 + 수기 덮어쓰기 허용,
   불일치 시 경고(레거시 메모의 `$720 × 61 = 43,920` 패턴을 그대로 검산).
4. `MEMO` 자동 초안 생성: `MM-DD {캠퍼스} {학생명} 그로스가 ${amt}을 페소 {peso}p 납부($1={rate}p)`
   → 행정팀이 매번 수기로 쓰던 문장을 버튼 한 번으로.
5. `[[CENTER_RECEIPT]]` 영수증 출력(인보이스 PDF 파이프라인 재사용).

### 미결정
- 환율 소스: 수기 입력 유지 vs 일별 환율 마스터 도입.
- 분할 납부(여러 번 센터수납) 시 1행 덮어쓰기인지 **이력 누적**인지 — 레거시는 1행 구조라 STAFF COMMENT에 수기 누적 중(캡처의 07-01, 07-23 두 건). **이력 테이블 권장.**

---

## 4. 변경환불 서류 체크란

### 요청 내용(캡처 해석)
변경환불 **접수 목록** 화면. 컬럼:
`체크박스 · AGENCY · NAME · STUDENT · APPLY DATE · CENTER · CHANGE · ADD COURSE · ETC FEE ·
REFUND · HOLDING · MODIFY · INVOICE · RESULT · COMPLETE DATE · DELETE`
- 유형 칸(CHANGE/ADD COURSE/ETC FEE/REFUND/HOLDING)에 해당 항목만 값 표시
  (예: `visa maintenance`, `course change f`, `Family Visitor`, `REFUND`)
- `MODIFY` = `정상 MODIFY` 버튼, `RESULT` = `확정대기중` / `환급완료` 배지
- 즉 **접수 → 확인/수정 → 확정** 워크플로의 작업 대기열입니다.

### 레거시 데이터 근거
`student_change`의 `info_process`(진행상태) · `info_result`(비용처리결과) · `info_complete_date`
· `apply_date` · `apply_sme_campus` · `apply_sme_manager`.
`info_result` 값은 신전산 DICT `pay_result`에 이미 정의돼 있음([prototype.html:712](docs/design-admin/prototype.html#L712)):
`센터수납미처리 / 계좌수납미처리 / 수금완료 / 환급완료 / 홀딩확정 / 취소`.

### 신전산 현재 상태
[prototype.html:667](docs/design-admin/prototype.html#L667)에 **컬럼 정의만** 있고
(`AGENCY…DELETE` 15컬럼, `inv:true`), 실제 데이터·버튼·상태 전이는 없습니다. 표는 일반 spec 골격으로 렌더됩니다.

### 개선안
1. `student_changes` 기반 실 목록 — 기간·캠퍼스·유형·RESULT 필터 + 페이지네이션.
2. **체크박스 = 일괄 처리**: 선택 건 일괄 확정 / 일괄 인보이스 발행 / 엑셀 export.
3. `RESULT` 상태 배지 + **상태 전이 가드**(확정대기중 → 수금완료/환급완료/홀딩확정, 역전이 차단).
4. `MODIFY` → ②의 서류 폼 열기(수정 이력 남김), `DELETE` → 소프트 삭제 + 감사로그.
5. `INVOICE` → 기존 멱등 발행 경로 재사용(중복 발행 차단 이미 구현됨).
6. 미완료 건 **경과일 경고**(`info_due_date` 초과 시 빨강) — 행정팀 누락 방지에 즉효.

### 미결정
- 확정 권한(누가 RESULT를 바꿀 수 있는가) — 기존 부서별 RBAC 매트릭스와 연결.
- 삭제 정책: 소프트 삭제 고정으로 갈지.

---

## 5. 학비 완납 여부 체크

### 요청 내용(캡처 해석)
- 인보이스 이력(1th/2th/3th …)과 `FINANCIAL(재무관리)` 합계: `총액 / 커미션 / 납부금액`
- **`학비 지불현황`** 블록:
  - `납부현황` 드롭다운 = `납부체크 / 미납 / 분납 / 완납`
  - `분납금액` (won($)) · `환불일자` · `환불금액`
  - `기타서류` `[[입학허가서]] [[영수증]]` + `발행` 체크 + `납부일(발행일)`
  - `현재상태` = `NOMAL(정상)`

### 레거시 데이터 근거
`student_info`: `pay_status`(코드 실측 `N`=미납 / `Y`=완납 / `X`=분납 / `R`=반환)
· `pay_amount`(납부금액) · `refund_date`(환불일자) · `etc_pay` · `publish_date`(발행일)
· `finance_tuition`(재무관리수업료) · `finance_com`(커미션) · `finance_tot`(총액)
`student_info_invoice`(128,580행) — 인보이스 회차별 총액/커미션/납부금액 이력.

### 신전산 현재 상태
- [prototype.html:3259](docs/design-admin/prototype.html#L3259) `PAY CHECK` 셀렉트에
  `NOT(미납)/PAID(완납)/INSTALL(분납)` 3값만 — **반환(R) 누락, 분납금액 입력칸 없음, 환불일자 없음.**
- [prototype.html:3268-3271](docs/design-admin/prototype.html#L3268-L3271) INVOICE 이력은
  **1행 하드코딩 데모**(`1th` 한 줄) — 실제 회차 이력(`student_info_invoice`) 미연결.
- `FINANCIAL` 합계는 화면 내 계산값이며 `finance_*` 컬럼과 미연동.
- 기타서류(입학허가서/영수증) 발행 여부·발행일 관리 없음(링크만 존재).

### 개선안
1. `pay_status` **4값 전부**(미납/분납/완납/반환) + 상태별 필수입력 가드
   (분납 → 분납금액 필수, 반환 → 환불일자·환불금액 필수).
2. **완납 판정 자동화**: `인보이스 총액 합계 − 납부금액 합계 = 잔액`. 잔액 0이면 완납 후보로
   자동 제안(수기 상태와 불일치 시 경고). 행정팀의 "완납 여부 체크" 요구의 핵심.
3. 인보이스 회차 이력 실연결(`student_info_invoice`) — 회차별 총액·커미션·납부금액 표 + FINANCIAL 합계.
4. 기타서류(입학허가서 LOA / 영수증) **발행 상태 + 발행일** 관리, 발행 시 PDF.
5. 목록 레벨: STUDENT LIST / FINANCIAL 에 **잔액·완납여부 컬럼 + 미납자 필터**(엑셀 export).

### 미결정
- "완납" 판정 기준: 학비만인지, 등록비·기타비용·현지비용(`student_payment` 45종 항목) 포함인지.
- 통화 혼재(원화/달러/페소) 기준 통화와 환산 시점.

---

## 6. 공통 진단 — 왜 이 5건이 한꺼번에 나왔나

1. **신전산 학생 상세폼은 "표시용 재현"에서 멈춰 있음.** 레이아웃·섹션은 레거시를 충실히 따랐지만
   PAY/COMMISSION 은 계산된 값을 보여주는 수준이라, 실제 **입력 필드가 빠진 자리**가 그대로 요청이 됐습니다(①③⑤).
2. **`student_change` 업무축이 통째로 미구현**(②④). 26,857건 규모의 실무 축이며, 미팅 요청 ④(가족 인보이스 조정)·②(방 쪼개기)와도 데이터가 겹칩니다.
3. **임계경로는 동일**: 구전산 재이관 + Supabase 쓰기 배선(anon 키). 이번 5건 중 ①②④⑤는
   전부 재이관 대상 테이블(`uhak_agency_com`·`student_change`·`student_info_invoice`·`student_info` 확장 컬럼)에 의존합니다.
   → 미팅 기획서의 **P0(재이관)** 범위에 이 3개 테이블을 반드시 포함해야 합니다.
   특히 재이관 범위 논의의 (A)안(12,150 + 3필드)으로는 **이번 5건 중 4건을 못 만듭니다.** → **(B)안(전체 + 전필드) 권장**.

---

## 7. 우선순위 제안

| 순위 | 항목 | 근거 | 선행조건 |
|---|---|---|---|
| **1** | ③ 센터수납 입력칸 | 컬럼 이미 존재 · 화면 한 블록 추가 · 즉시 실무 효과 | 없음(단독 가능) |
| **2** | ⑤ 학비 완납 체크 | 미납 관리 리스크 직결 · 자동 잔액판정으로 실수↓ | 인보이스 이력 이관 |
| **3** | ① 커미션 % 선택 | 정산 정확도 뿌리 · 단 산출모델 정책 결정 필요 | `uhak_agency_com` 이관 + 정책 확정 |
| **4** | ④ 변경환불 체크 목록 | ②의 앞단 · 목록만 먼저 살려도 현황 파악 가능 | `student_change` 이관 |
| **5** | ② 변경환불 서류 폼 | 가장 큰 신규 화면 · ④ 위에 얹는 것이 안전 | ④ 완료 |

미팅 11건과의 관계: **③⑤는 11건과 독립**하여 바로 착수 가능, **①②④는 P0(재이관)에 종속**입니다.

---

## 8. 행정팀에 확인이 필요한 사항 (7개)

1. **커미션 산출 기준** — 유학원 계약(회차) 단독? 신전산 국적/코스/빌딩 규칙과 병행?
2. **커미션 계약 소급** — 계약 회차 변경 시 기발행 인보이스 처리 방식은?
3. **완납 판정 범위** — 학비만? 현지비용(SSP·비자·교재 등 `student_payment` 항목) 포함?
4. **센터수납 이력** — 여러 번 나눠 낼 때 1행 덮어쓰기 유지? 이력 누적으로 개선?
5. **변경환불 슬롯** — 코스5·기숙사8 고정 유지? 가변 행 추가로 개선?
6. **변경환불 승인 단계** — 접수→확정 1단계? 검토자 승인 포함 2단계?
7. **차액 계산 규칙** — 일할/주할, 환율 적용 시점(접수일/확정일).

> 본 문서는 기획 단계이며 코드 변경은 없습니다. 위 7개가 확정되면 ③부터 순차 착수 가능합니다.
