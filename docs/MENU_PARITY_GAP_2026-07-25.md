# 레거시 ↔ 신시스템 메뉴·화면 100% 일치 — 격차 점검 보고

> 목표: 레거시(smeadmin.com)와 신시스템의 **메뉴 및 화면을 100% 동일**하게.
> 본 문서는 **현황 점검·수정량 산정만**(코딩 X). 작성 2026-07-25.
> 근거: 레거시 전메뉴 캡처(`LEGACY_ALLMENU_2026-07-23.html`, 8카테고리·66항목) ↔ 신시스템 `prototype.html` MENU(7카테고리·61항목).

---

## 0. 한눈 요약

| 구분 | 레거시 | 신시스템 | 격차 |
|---|---|---|---|
| 카테고리 | **8** (Setting·Member's·Board·Agency·Student's·Dormitory·Financial·Cash) | **7** (Record·Member's·Agency·Student's·Dormitory·Financial·Cash) | Board 분리 없음, Setting→Record 교체 |
| 메뉴 항목 | **66** | **61** | **누락 9** / 추가 6 |
| 화면 구현 | 57개 캡처 | 전용 렌더러 **24** + 표 폴백 **37** | 표 폴백 37개는 근사(레거시와 레이아웃·필터·버튼 불일치) |

**결론**: **메뉴 정합**은 며칠 내 가능(구조·누락·라벨). 그러나 **화면 100% 동일**은 표 폴백 37개를 레거시와 픽셀·동작까지 맞추는 대공사(수 주 규모). 아래 티어로 분리 권장.

---

## 1. 메뉴 격차 (구조)

### 1-1. 카테고리 구조 차이
- 레거시 **Board(3)** 를 신시스템은 별도 카테고리로 두지 않고 Student's/Dormitory 안에 흡수(GAC·Campus Holding→Student's, SME_BOARD→Dormitory).
- 레거시 **Setting(2)** (세션삭제·phpMyAdmin) 없음 → 신시스템은 대신 **Record**(대시보드·권한설정) 신설.
- **순서**: 레거시 Setting→Member's→**Board**→Agency→… vs 신 Record→Member's→Agency→… (Board 없음).
- ⇒ 100% 동일 목표면 **카테고리 8개·순서·명칭**을 레거시대로 재편할지 결정 필요.

### 1-2. 누락 메뉴 (레거시엔 있으나 신시스템에 없음) — **9개**
| 카테고리 | 항목 | 레거시 파일 | 성격 |
|---|---|---|---|
| Member's | 회원메일발송 | mail_list.php | CMS |
| Member's | 투표관리 | poll_list.php | CMS |
| Member's | 게시판관리 | board_list.php | CMS |
| Member's | 게시판그룹관리 | boardgroup_list.php | CMS |
| Agency | AGENCY ADDR | uhak_agency_list2.php | 업무 |
| Agency | AGENCY OUT | uhak_agency_exit_list.php | 업무 |
| Dormitory | Update Rooms(new) | room_list-rey.php | 업무 |
| Setting | 세션 삭제 | session_delete.php | 시스템 |
| Setting | phpMyAdmin | (외부) | 시스템 |

→ 업무성 3(AGENCY ADDR/OUT, Update Rooms) + CMS 4(메일·투표·게시판·게시판그룹) + 시스템 2.

### 1-3. 신시스템 추가분 (레거시엔 없음) — 6개 (유지/숨김 결정 필요)
Record(대시보드·권한설정), COMMISSION RULES(수수료 규칙), AGENCY PAGE(유학원 포털), TUITION FEE, DAYOFF/Scheduler, 유학원방문(uhak_day_info).
→ 100% 동일이 "레거시에 없는 건 숨김"까지 의미하면 이들 노출 정책 결정 필요.

### 1-4. 라벨·번호·언어 차이 (가장 많음)
- 레거시는 **번호+한글**(예: `1.수강등록관리`, `1.1.멀티수강관리`, `2.변경환불홀딩`, `3.수금관리`, `4.DEPOSIT`), 신시스템은 **영문·무번호**.
- 영향: Student's/Dormitory 등 **약 40개 항목**의 라벨 문자열·번호 체계 상이.
- ⚠ **정책 충돌**: 기존 확정 정책은 "기본 언어 **영어**"([[feedback_default_english]]). "메뉴 100% 동일=레거시 한글·번호"와 정면 충돌 → **결정 필수**(아래 §4).

---

## 2. 화면 격차 (레이아웃·동작)

- 레거시 캡처 화면 **57개** 중, 신시스템은 **전용 렌더러 24개** + **표 폴백 37개**.
- **표 폴백 37개**: 지정 컬럼으로 표는 그리나 레거시의 정확한 **레이아웃·필터바·버튼·집계/매트릭스**와 다름 → "화면 100% 동일" 기준 미달.
- 전용 렌더러 24개도 근사 재현이라 레거시 대비 **항목별 QA**(필터 항목·컬럼순서·버튼·계산) 필요.
- 특히 매트릭스/통계형(POPULATION·STDNT STATUS·MC Report2·통계 3종·입퇴실 매트릭스)과 결제/인보이스 계열은 화면 로직이 커서 개별 공수 큼.

전용 렌더러 24종: roomstat·pickup·roommove·dailyio·changelog·admission·stdlist·enroll·agency·deposit·cashmng·financial·agencylist·agencystat·commrules·perms·dash 등.

---

## 3. 수정량 산정 (티어별)

| 티어 | 내용 | 대상 | 개략 공수 |
|---|---|---|---|
| **T1 메뉴 구조 정합** | 카테고리 8개·순서·명칭 레거시화, Board 분리, Setting 처리 | 카테고리 재편 | **0.5~1일** |
| **T2 누락 메뉴 추가** | 업무 3(AGENCY ADDR/OUT·Update Rooms) + CMS 4 + 시스템 2 | 9개 | 표폴백 빠르게 **2~3일** / 완전구현 **5~9일** |
| **T3 라벨·번호·언어 정합** | 레거시 번호+한글 라벨로 통일(또는 영/한 토글 확장) | ~40개 | **0.5~1일**(정책 확정 시) |
| **T4 화면 100% 동일** | 표 폴백 37개를 레거시 레이아웃·필터·동작까지 재현 | 37개 | **20~50일** (핵심) |
| **T5 전용화면 QA 정합** | 전용 24개 레거시 대비 필터·컬럼·버튼 검수·보정 | 24개 | **5~10일** |

- **메뉴만 100% 동일**(T1~T3): **약 3~5일**(정책 확정 전제).
- **화면까지 100% 동일**(T4~T5): **약 4~8주**. 우선순위 상위 화면부터 단계화 권장.

---

## 4. 진행 전 결정 필요 (3가지)

1. **언어/라벨 정책** — 메뉴를 레거시대로 **한글+번호**로 갈지, 아니면 **영/한 토글 유지 + 한글 라벨을 레거시와 1:1 매칭**할지. (기존 "기본 영어" 정책과 충돌 → 명시 확정 필요)
2. **추가 메뉴 처리** — 신시스템 신규 6개(Record·COMMISSION RULES·포털·TUITION FEE·Scheduler·유학원방문)를 **유지**할지 **숨김**할지(=레거시에 없는 건 노출 안 함).
3. **CMS/시스템 메뉴 범위** — Member's의 메일/투표/게시판/게시판그룹 4종과 Setting 2종(세션삭제·phpMyAdmin)을 **이관 대상에 포함**할지(그누보드 CMS·시스템 기능이라 신시스템 성격과 다름).

> 위 3개가 정해지면 T1~T3(메뉴)부터 착수하고, T4(화면)는 우선순위 화면 리스트를 받아 단계 진행하겠습니다.

---

*작성 2026-07-25 · 근거 LEGACY_ALLMENU_2026-07-23 · prototype.html MENU · 코딩 미실시(점검 보고)*
