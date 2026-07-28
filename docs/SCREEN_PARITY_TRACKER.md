# 화면 100% 일치(T4) 진행 트래커 — 레거시 ↔ 신시스템

> 목표: 레거시 캡처(스크린샷)와 **화면 100% 동일** 재현. 착수 순서 **A→B→C 순서대로 전체**(사용자 확정 2026-07-26).
> 방법(화면 1개당): ① `LEGACY_ALLMENU_2026-07-23.html`에서 해당 화면 스크린샷 확인 → ② 렌더러 재현(레이아웃·필터·버튼·컬럼·매트릭스) → ③ Playwright 검증 → ④ 커밋.
> 상태: ⬜ 대기 · 🔧 진행 · ✅ 완료

## 확정 결정 (2026-07-26)
- 추가 메뉴: **5종 유지**(Record·COMMISSION RULES·유학원포털·TUITION FEE·Scheduler), **유학원방문(uhak_day_info) 숨김**(적용 완료).
- 착수 순서: **A→B→C 순서대로 전체**.
- ⚠ 미결정(선행 권장): 메뉴 라벨 **언어/번호**(레거시 한글+번호 vs 기존 영어 정책) — 화면 내부 문구에도 영향.

---

## Tier A · 단순 목록/표 (15)
| # | 화면 | 레거시 파일 | 상태 |
|---|---|---|---|
| A1 | 회원관리 | member_list.php | ⬜ |
| A2 | 포인트관리 | point_list.php | ⬜ |
| A3 | 접속자현황 | visit_list.php | ⬜ |
| A4 | COURSE LIST | course_list.php | ⬜ |
| A5 | TUITION FEE | tution_fee.php | ⬜ |
| A6 | DORM LIST | room_list.php | ⬜ |
| A7 | Group Students | student_group_payment.php | ⬜ |
| A8 | Pre-paid Info | student_payment-2.php | ⬜ |
| A9 | Deposit(test) | student_payment-2.php | ⬜ |
| A10 | FARM & GYM | student_farm.php | ⬜ |
| A11 | GYM 리포트 | student_gym.php | ⬜ |
| A12 | FARM 리포트 | student_farm2.php | ⬜ |
| A13 | GAC BOARD | bbs/board.php?bo_table=office_GAC | ⬜ |
| A14 | Campus Holding | bbs/board.php?bo_table=office_holding | ⬜ |
| A15 | SME_BOARD | bbs/board.php?bo_table=office_share | ⬜ |

## Tier B · 필터+목록/리포트 (11)
| # | 화면 | 레거시 파일 | 상태 |
|---|---|---|---|
| B1 | 멀티수강관리 | student_list3.php | ⬜ |
| B2 | MC Report 1 | student_list3_en1.php | ⬜ |
| B3 | Graduate | student_list3_en3.php | ⬜ |
| B4 | APPLY LIST | student_list2.php | ⬜ |
| B5 | HISTORY | student_history.php | ⬜ |
| B6 | 수금관리 | student_list_pay.php | ⬜ |
| B7 | CHG-REF-HOLD | student_list_change-back.php | ⬜ |
| B8 | REGISTER STATS | student_register.php | ⬜ |
| B9 | ELEC & WATER | room_elec.php | ⬜ |
| B10 | DAY IN&OUT | room_use_count_list2.php | ⬜ |
| B11 | VISIT(detail) | uhak_agency_visit.php | ⬜ |

## Tier C · 매트릭스·통계·캘린더·워크플로 (11)
| # | 화면 | 레거시 파일 | 상태 |
|---|---|---|---|
| C1 | COMMISSION | uhak_agency_commission.php | ⬜ |
| C2 | MC Report 2 (코스×주차) | student_list3_en2.php | ⬜ |
| C3 | POPULATION | student_population.php | ⬜ |
| C4 | POPULATION2 | student_population2.php | ⬜ |
| C5 | STDNT STATUS | student_present2.php | ⬜ |
| C6 | STDNT Fullsize/Encanto/Classic/Capital | student_present2-*.php | ⬜ |
| C7 | VISIT(calendar) | uhak_agency_schedule_list.php | ⬜ |
| C8 | DAYOFF/Scheduler | scheduler_index(-all).php | ⬜ |
| C9 | 변경환불홀딩(인보이스) | student_list_change.php | ⬜ |

> (참고) Tier C 11개 중 STDNT 4종을 C6에 묶어 표기. 실제 착수 시 개별 처리.

---

## 진행 로그
- 2026-07-26: 트래커 생성. 유학원방문 숨김 적용. Tier A 착수 시작.
