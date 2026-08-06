# 데이터 이관 계획 (신전산 P0 대응판)

> 작성 2026-08-06 · 전제: **정방향 이관은 이미 완료**되어 있다. 본 문서는 (a) 완료분 재확인 (b) P0 마스터 신설에 필요한 **시드 이관** (c) 검증·롤백 절차를 정한다.
> 대원칙: `sql/*.sql`(MySQL 덤프)와 Supabase `legacy.*`·`cms.*` 는 **읽기 전용**. 신규 데이터는 `app.*` 에만 쓴다.

---

## 1. 현재 이관 상태 (실측 기준선)

| 구분 | 내용 | 상태 |
|---|---|---|
| 스키마 | `legacy.*` 54테이블 + `cms.*`(그누보드 25) + `public.*`(파생) + `app.*`(신전산) | ✅ |
| 행수 대조 | 51~54테이블 원본=적재 **100% 일치**(2026-07-16·07-30 2회 실증) | ✅ |
| 주요 볼륨 | `student_info` 90,524 · `room_reserve` 627,174 · `room_elec` 1,670,841 · `room_change_log` 552,118 · `student_change` 26,857 · `student_info_invoice` 128,580 · `uhak_agency_com` 4,004 · `reserve_info` 69,350 | ✅ |
| 파생 정본 | `public.dorm_reservations` 69,326(= reserve_info − 격리32 − uq중복) + `actual_check_in/out` 이원화 | ✅ |
| 미이관(의도적) | `room_reserve_old` 2.8M 등 백업/테스트 테이블 ≈3.53M행 | ✅ 제외 |
| 오케스트레이터 | `migration/migrate_all.py`(원샷 + 100% 대조 + 리포트), 기본 DRY-RUN | ✅ |
| 역방향 동기화 | `export_daily_changes.py` → `legacy_writeback.py`(UPDATE 전용·화이트리스트·before-image·DRY-RUN 기본) | 🟡 코드만, 미실행 |

> **자주 나오는 오해 정정**: "학생 12,150(12,389)건만 이관됐다"는 사실이 아니다. DB 에는 90,524행 전량이 있고, 12,389 는 앱 조회 슬라이스(`data.js SLICE_FROM='2025-01-01'`)다.

---

## 2. P0 마스터 시드 이관 (신규 작업)

각 마스터는 **레거시에서 값을 읽어 `app.*` 에 1회 시드**한 뒤, 이후 편집은 신전산에서만 한다. 레거시는 그대로 둔다.

### M1. 캠퍼스 마스터 (REQ-107)
- **원천**: `legacy.room_category.bldg_type`(E/S/F/P 등) · `legacy.course_info.s_campus`(S/C/E/A) · `legacy.student_info` 캠퍼스 문자열 · `legacy.room_elec` bldg_type · 크롤 실측 코드(sparta/1/4/5/SP).
- **작업**: `app.campus_master(campus_id, code, name, name_en, sort_order, capacity, active, show_on_web)` 시드 + `app.campus_code_map(source_table, source_code, campus_id)`.
- ⚠ **필수 선행**: 화면별 상충 매핑(코스 `C=CAPITAL·E=CLASSIC` vs 전기 `C=CLASSIC·E=CAPITAL`)의 **어느 쪽이 옳은지 데이터로 확정**한다.
  - 검증법: `room_category`(g_display='Y') 그룹명 ↔ bldg_type 분포와, `course_info` 코스명에 포함된 캠퍼스 문자열(`ESL 2(CAPITAL)` 등) ↔ `s_campus` 분포를 각각 교차집계해 다수결·이름일치로 판정. 결과를 매핑표 주석에 근거와 함께 남긴다.
- **검증**: 매핑 적용 후 캠퍼스별 학생수·객실수가 레거시 화면 수치와 일치.

### M2. 기숙사 카테고리 (REQ-108)
- **원천**: `legacy.room_category`(g_display='Y' 30그룹, `g_order`).
- **작업**: `app.room_category_overlay(g_idx PK, campus_id, name, gender, sort_order, active)` 시드.
- **부수**: 화면의 압축표 `LEGACY_CATS`(index.html:1847) 폐기.

### M3. 객실 마스터 (REQ-109/§13)
- **원천**: `legacy.room_info`(418실) ⨝ `legacy.room_list`(1,024베드, `r_state='Y'`, `r_limit`).
- **작업**: `app.room_master_overlay(i_idx PK, g_idx, room_no, capacity, gender, sort_order, active, memo)`.
- **동시 산출**: **중복 객실 리포트**(같은 캠퍼스·카테고리 내 동일 방번호) — 기존 데이터에 중복이 있을 수 있으므로 차단이 아니라 보고.

### M4. 코스 마스터 (REQ-106/§10)
- **원천**: `legacy.course_info` 71 ⨝ `legacy.course_category` 14.
- **작업**: `app.course_master_overlay(i_idx PK, category_id, campus_id, name, name_en, level, sort_order, active, prices jsonb)`.
- **관찰**: 71개가 전부 `g_idx=5` → 카테고리 재분류 필요 여부를 아카데믹에 확인.

### M5. 가격 이력 (REQ-111)
- **원천**: 코스 = `course_info` 국가별 9열(`pay/cn/jp/tw/vt/ru/sa/mgl/etc`) + `tution_fee`(코스×주차 1~4주). 객실 = DORM LIST 국가별 컬럼.
- **작업**: `app.price_course(course_id, country, week, amount numeric, currency, valid_from, valid_to)` / `app.price_room(room_type, campus_id, country, amount, currency, valid_from, valid_to)`.
- ⚠ **미결**: `tution_fee` 에 **5주차 이상 규칙이 없다** → 업무 확인 필요.

### M6. 전기·수도 단가 (REQ-205)
- **원천**: 회의 진술(학생 20₱/kWh · 직원 14₱/kWh · 수도 10₱/일) — **DB 근거 없음**.
- **작업**: `app.utility_rate(kind, person_kind, amount, unit, valid_from, valid_to)` 를 위 값으로 시드하되 **관리자 편집 가능**. 과거분 재계산은 하지 않는다(적용일 이후만).
- **직원 판정**: 이름 접두 `STAFF_` 의존 폐기 → `app.person_kind(s_idx, kind)` 를 이름 규칙으로 1회 시드한 뒤 수기 교정.

### M7. 감사 로그 통합 뷰 (REQ-109)
- `legacy.room_change_log` 552,118 + `app.write_audit` + `app.change_log` 를 **하나의 읽기 뷰**로 union(원본 이동 없음).
- 인덱스: `room_change_log(s_idx)`, `(change_date)`, `app.write_audit(created_at)`.

---

## 3. 성능 준비 (조회 인덱스, 이관본에만)

| 인덱스 | 대상 | 근거 |
|---|---|---|
| `room_elec(re_date)` · `room_elec(i_idx, re_date)` | 전기 집계 1.4s → 수십 ms(+약 50MB) | 제안됨·미실행 |
| `room_change_log(s_idx)` · `(change_date)` | 감사로그 검색·과거조회 | REQ-109 |
| `student_change(info_date)` · `(s_idx)` | 변경환불 목록 | REQ-204 |
| 기존 9개(student_info 날짜·uhak_id·e_name, student_payment, room_reserve) | 이미 적용 | ✅ |

> 인덱스는 **Supabase 이관본에만** 만든다. 원본 MySQL 무변경.

---

## 4. 실행 절차

1. **백업**: 적용 전 `pg_dump`(app 스키마) + 대상 테이블 스냅샷. 롤백 지점 기록.
2. **DDL 적용**: `migration/schema/*.sql` 는 전부 **멱등**(create if not exists / or replace). 실패 시 부분적용 금지 — 트랜잭션 1개.
3. **시드**: M1~M6 각각 `insert … on conflict do nothing` + 시드 건수 로그.
4. **검증**: §5 대조 수행. 불일치 1건이라도 있으면 종료코드 1(자동 중단).
5. **화면 배선**: 하드코딩 치환(T2)은 **마스터 시드 검증 통과 후에만** 착수.
6. **리포트**: `migration/reports/*.md|json` 자동 생성(기존 포맷 재사용).

---

## 5. 검증 대조표 (§27)

| 축 | 대조 방법 | 합격 기준 |
|---|---|---|
| 학생 | 건수·이름·국적·성별·생년월일·코스·기간·상태·유학원·담당자 | 전건 일치(생년월일은 `jumin` 유효범위 1930~올해 판정분만) |
| 객실 | 캠퍼스·카테고리·방번호·성별·최대인원·활성·가격·정렬 | 차이 리포트 8종 모두 0건 또는 사유 기재 |
| 배정 | 학생별 객실·시작·종료·이동이력·침대번호 | 샘플 30건 전건 일치 |
| 인보이스 | 총액·통화·커미션·코스비·객실비·발행일·최종버전 | 샘플 20건 일치(통화 정책 확정 후) |
| 통계 | 샘플 날짜 5일 × (캠퍼스별 재학생·국가별·코스별·입실·퇴실·점유·전기수도) | 신·구 수치 일치 |
| 마스터 | 캠퍼스·카테고리·객실·코스 건수 | 레거시 활성 건수와 일치(30그룹·418실·71코스) |

---

## 6. 롤백

| 대상 | 롤백 방법 | 영향 |
|---|---|---|
| 마스터 시드(M1~M6) | `app.*` 신규 테이블 drop 또는 `active=false` | 레거시 무영향 |
| 화면 하드코딩 치환(T2) | 이전 커밋으로 `deploy/index.html` 되돌리고 재배포 + `vercel alias set` | 즉시 |
| 인덱스 | `drop index` | 조회 성능만 |
| 쓰기 RPC | `create or replace` 로 이전 정의 재적용 | 데이터 유지 |
| 잘못 저장된 오버레이 값 | `app.*_edits` 행 삭제 → 읽기 경로가 레거시 원값으로 복귀 | 원본이 정본이라 안전 |

> **레거시 원본은 어떤 시나리오에서도 롤백 대상이 아니다** — 쓰지 않기 때문이다. 이것이 오버레이 방식을 택한 이유다.

---

## 7. 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| 캠퍼스 코드 매핑 오판 | 전 통계 오류 | M1 선행 검증 + 매핑표에 근거 주석 + 통계 5일 샘플 대조 |
| 역방향 동기화(구전산으로 되쓰기) | 단방향 원칙 위배 | 현재 미실행. 실행 시 정책 재확인 + DRY-RUN 필수 |
| 라이브 검증 중 실데이터 변경 | 운영 데이터 오염 | 2026-07-30 실제 발생·복원함. **전용 테스트 학생/객실 도입**, 검증 전 원본값 확보·종료 시 복원 |
| `room_elec` 인덱스 생성 부하 | 일시 지연 | 저부하 시간대 `create index concurrently` |
| 동시 세션 편집 충돌 | 배포본 덮어쓰기 | 통합 스크립트의 sha256 재확인(기존 `integrate.py` 패턴) 준수 |
