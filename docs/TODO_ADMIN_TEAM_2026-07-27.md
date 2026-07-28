# 행정팀 요구사항 — 작업 투두 (Working TODO)

> 원본 분석: [ADMIN_TEAM_REQUESTS_2026-07-27.md](ADMIN_TEAM_REQUESTS_2026-07-27.md)
> 생성 2026-07-27 · **현재 전 항목 미착수(코딩 전)**
> 규칙: 상태는 `☐ 대기 / ▶ 진행 / ✅ 완료 / ⛔ 차단(선행 미해결)` 로 표기. 완료 시 날짜 기입.

---

## 0. 대시보드

| ID | 작업 | 상태 | 선행 | 예상공수 |
|---|---|---|---|---|
| **Q** | 행정팀 확인 7건 회신 | ☐ | — | 회의 1회 |
| **D** | 재이관 3테이블 포함 확정·실행 | ⛔ | Q-1, PG_PASS | 1~2일 |
| **A3** | 센터수납 현장결제 입력칸 | ☐ | 없음 | 0.5일 |
| **A5** | 학비 완납 여부 체크 | ⛔ | D(인보이스) | 1.5일 |
| **A1** | 커미션 % 선택란 | ⛔ | Q-1, D | 2일 |
| **A4** | 변경환불 체크 목록 | ⛔ | D(student_change) | 2일 |
| **A2** | 변경환불 서류 폼 | ⛔ | A4 | 4일+ |

**지금 당장 가능한 것: `Q`(질문 회신 받기) 와 `A3`(단독 착수 가능) 둘뿐.** 나머지는 재이관(D) 대기.

---

## Q. 행정팀 확인 대기 7건 — *가장 먼저 처리*

- ☐ **Q-1** 커미션 산출 기준: 유학원 계약(`uhak_agency_com`) 단독 / 신전산 국적·코스·빌딩 규칙과 병행? → **A1·D 둘 다 막고 있음**
- ☐ **Q-2** 커미션 계약 회차 변경 시 **기발행 인보이스 소급** 처리 방식
- ☐ **Q-3** "완납" 판정 범위: 학비만 / 현지비용(`student_payment` 45항목) 포함
- ☐ **Q-4** 센터수납 분할 납부: 1행 덮어쓰기 유지 / **이력 누적**으로 개선(권장)
- ☐ **Q-5** 변경환불 슬롯: 코스5·기숙사8 고정 / **가변 행 추가**로 개선(권장)
- ☐ **Q-6** 변경환불 승인 단계: 접수→확정 1단계 / 검토승인 포함 2단계
- ☐ **Q-7** 차액 계산 규칙(일할/주할) + 환율 적용 시점(접수일/확정일)

> 회신 받는 즉시 이 파일에 답을 적고 해당 작업의 ⛔ 를 ☐ 로 내림.

---

## D. 선행 — 데이터 재이관 (P0, 미팅 11건과 공유하는 임계경로)

- ☐ **D-1** 재이관 범위 **(B)안 확정** — 전체 90,524 + 전필드
  - 근거: (A)안으로는 행정팀 5건 중 4건 구현 불가
- ☐ **D-2** 이관 대상에 **3테이블 추가** 확인
  - ☐ `uhak_agency_com` (4,004행) — 커미션 계약 이력 → A1
  - ☐ `student_change` (26,857행, 60+컬럼) → A2·A4
  - ☐ `student_info_invoice` (128,580행) — 인보이스 회차 이력 → A5
- ☐ **D-3** `student_info` 확장 컬럼 누락 없이 이관
  - `com_no` · `pay_status` · `pay_amount` · `refund_date` · `publish_date`
  - `exchange_date` · `exchange_rate` · `center_pay_amount/unit/date/memo`
  - `finance_tuition` · `finance_com` · `finance_tot`
- ☐ **D-4** `migrate_all.py --execute` 실행 (PG_PASS 필요) + 100% 검증 리포트
- ☐ **D-5** Supabase **anon 키 배선** — 쓰기 경로 활성화(현재 전 저장기능 공통 병목)

---

## A3. 센터수납 현장결제 입력칸 — **1순위, 단독 착수 가능**

레거시 근거: `student_info.exchange_date / exchange_rate / center_pay_amount / center_pay_unit / center_pay_date / center_pay_memo`
대상: [prototype.html:3258-3261](design-admin/prototype.html#L3258-L3261) PAY INFORMATION 섹션

- ☐ **A3-1** `CENTER PAY INFO` 블록 추가 — 환율적용일 · 환율($→₱) · 센터납부일 · 납부금액 · 단위(peso/won/usd) · MEMO
- ☐ **A3-2** `pay_channel = CENTER` 일 때만 활성화 (계좌수금이면 비활성 — 오입력 차단)
- ☐ **A3-3** 자동 검산: `달러금액 × 환율 = 페소금액` 자동 채움 + 수기 덮어쓰기 허용, 불일치 시 경고
- ☐ **A3-4** MEMO 자동 초안 버튼 — `MM-DD {캠퍼스} {학생명} 그로스가 ${amt}을 페소 {peso}p 납부($1={rate}p)`
- ☐ **A3-5** `[[CENTER_RECEIPT]]` 영수증 출력 (기존 인보이스 PDF 파이프라인 재사용)
- ☐ **A3-6** (Q-4 = 이력 누적일 경우) 센터납부 이력 테이블 설계 — 현재 1행 구조라 STAFF COMMENT에 수기 누적 중
- ☐ **A3-7** Playwright 검증 + 배포

---

## A5. 학비 완납 여부 체크

레거시 근거: `pay_status`(N 미납/Y 완납/X 분납/**R 반환**) · `pay_amount` · `refund_date` · `student_info_invoice`
대상: [prototype.html:3259](design-admin/prototype.html#L3259), [:3268-3271](design-admin/prototype.html#L3268-L3271)

- ☐ **A5-1** `pay_status` **4값 전부** 지원 (현재 반환(R) 누락)
- ☐ **A5-2** 상태별 필수입력 가드 — 분납→분납금액, 반환→환불일자·환불금액
- ☐ **A5-3** 인보이스 회차 이력 실연결 (`student_info_invoice`) — 현재 `1th` 1행 하드코딩
- ☐ **A5-4** FINANCIAL 합계를 `finance_tuition/com/tot` 와 연동
- ☐ **A5-5** **완납 자동판정** — `인보이스 총액합 − 납부금액합 = 잔액`, 0이면 완납 제안 + 수기상태 불일치 경고 *(요구사항 핵심)*
- ☐ **A5-6** 기타서류(입학허가서 LOA / 영수증) 발행상태 + 발행일 관리 + PDF
- ☐ **A5-7** 목록 레벨 — STUDENT LIST/FINANCIAL 에 잔액·완납여부 컬럼 + **미납자 필터 + 엑셀**
- ☐ **A5-8** (Q-3 결과 반영) 완납 판정 범위 확정 적용
- ☐ **A5-9** Playwright 검증 + 배포

---

## A1. 수강등록 커미션 % 선택란

레거시 근거: `uhak_agency_com`(회차 `no` · `percent`/`com_amt` · `confirm_date` · `manager` · `nowYN`) ← `student_info.com_no`
대상: [prototype.html:3262-3267](design-admin/prototype.html#L3262-L3267) COMMISSION INFO

- ☐ **A1-0** **Q-1 정책 확정** — 계약 단독인지 규칙 병행인지 (이게 안 정해지면 착수 불가)
- ☐ **A1-1** 유학원별 계약 이력 조회 계층 (`uhak_agency_com`)
- ☐ **A1-2** 계약 선택 드롭다운 — `N회 (현재/종료) / {percent}% or {com_amt} / {confirm_date} / 담당자: {manager}`
  - 기본 = `nowYN='Y'`, 과거 계약도 선택 가능(소급 케이스)
- ☐ **A1-3** 선택 시 커미션 즉시 재계산 + 산식 근거 표시
- ☐ **A1-4** `COMMISSION[EXCLUDE APPLY FEE]` 별도 표기 (등록비 제외 기준)
- ☐ **A1-5** `percent`형 / `amount`형 혼재 처리 + 통화 환산 규칙 (원화 정액 다수)
- ☐ **A1-6** 기존 `calcComm()` 규칙 엔진의 위치 재정의 (폴백으로 격하 or 병행)
- ☐ **A1-7** 저장 시 `student_info.com_no` 기록 (감사 추적)
- ☐ **A1-8** (Q-2 결과) 소급 정책 반영
- ☐ **A1-9** Playwright 검증 + 배포

---

## A4. 변경환불 서류 체크 목록

레거시 근거: `student_change.info_process / info_result / info_complete_date / info_due_date / apply_*`
`info_result` 값은 신전산 DICT `pay_result`에 이미 정의됨 ([prototype.html:712](design-admin/prototype.html#L712))
대상: [prototype.html:667](design-admin/prototype.html#L667) — 현재 컬럼 정의만 존재

- ☐ **A4-1** `student_changes` 기반 실 목록 렌더 (현재 더미 골격)
- ☐ **A4-2** 필터 — 기간 · 캠퍼스 · 유형(CHANGE/ADD COURSE/ETC FEE/REFUND/HOLDING) · RESULT + 페이지네이션
- ☐ **A4-3** 체크박스 일괄 처리 — 일괄 확정 / 일괄 인보이스 발행 / **엑셀 export**
- ☐ **A4-4** RESULT 상태 배지 + **상태 전이 가드** (확정대기중 → 수금완료/환급완료/홀딩확정, 역전이 차단)
- ☐ **A4-5** `MODIFY` → A2 서류 폼 열기 (수정 이력 기록), `DELETE` → 소프트 삭제 + 감사로그
- ☐ **A4-6** `INVOICE` → 기존 멱등 발행 경로 재사용 (중복방지 이미 구현됨)
- ☐ **A4-7** `info_due_date` 초과 건 **경과일 빨강 경고** (누락 방지 즉효)
- ☐ **A4-8** (Q-6 결과) 승인 단계 반영 + RBAC 권한 연결
- ☐ **A4-9** Playwright 검증 + 배포

---

## A2. 변경환불 서류 폼 — 최대 규모

레거시 근거: `student_change` 60+컬럼 (change / refund / other refund / add course / golf / holding)

- ☐ **A2-1** 폼 설계 확정 (Q-5 슬롯 고정 vs 가변, Q-7 차액·환율 규칙)
- ☐ **A2-2** 좌측 현재정보 자동 프리필 — 코스·기숙사·기간 (학생 상세에서 진입)
- ☐ **A2-3** 우측 변경정보 — 코스 5슬롯 / 기숙사 8슬롯 × 인실 × 주수
- ☐ **A2-4** 차액 자동계산 — 코스차액 + 기숙사차액 = 변경차액, `Extra Rate($→₱)` 적용해 PESO 병기
- ☐ **A2-5** 유형 탭 — CHANGE · REFUND · OTHER REFUND · ADD COURSE · GOLF · HOLDING
- ☐ **A2-6** 저장 = write-layer RPC + **멱등키**(중복 접수 방지, 인보이스 4중 방어 패턴 재사용)
- ☐ **A2-7** 서류 인쇄/PDF (`openPdf` 재사용)
- ☐ **A2-8** 확정 시 연동 — 학생 `now_status` · 기숙사 예약 · 인보이스 반영
- ☐ **A2-9** Playwright 검증 + 배포

---

## 진행 로그

| 날짜 | 내용 |
|---|---|
| 2026-07-27 | 요구사항 5건 분석 완료, 본 투두 파일 생성. 전 항목 미착수. |
