# 5개 화면 전용 렌더러 — 병합 계획 (보류 중)

작성 2026-07-30 · 상태 **통합 대기**(다른 세션이 `deploy/api/data.js` · `deploy/index.html` 을
동시 편집 중이라 사용자 지시로 병합 보류. **그 세션 종료 확인 후 진행**)

대상 화면 5종 — 지금은 `{k:'spec'}` 표 폴백(레거시와 레이아웃·필터·계산 불일치)
| 키 | 메뉴 | 레거시 | 소스(Supabase, 읽기전용) |
|---|---|---|---|
| `members` | 회원관리 | member_list.php | `cms.g4_member` 2,053 |
| `commission` | COMMISSION | uhak_agency_commission.php | `legacy.uhak_agency_com` 4,004 + g4_member |
| `courses` | COURSE LIST | course_list.php | `legacy.course_info` 71 + `course_category` 14 |
| `tuition` | TUITION FEE | tution_fee.php | `legacy.tution_fee` 100 + course_info |
| `elec` | ELEC & WATER | room_elec.php | `legacy.room_elec` 1,670,841 + room_info 1,127 |

산출물: 이 디렉터리의 `<키>.render.js` / `<키>.api.js` / `<키>.notes.md` (10개 JS 전부 `node --check` 통과).
공용 규약: `CONVENTIONS.md`.

---

## 0. ⚠ 선행 — 동시 편집 충돌 해소

병합 보류 시점(2026-07-30 13:41)에 **다른 세션**이 아래를 작업 중이었다.

| 파일 | 그 세션의 변경 | 내 5화면과의 관계 |
|---|---|---|
| `deploy/api/data.js` (+381) | 명세화면 라이브 로더 12종 — `out.tables["<레거시URL>"]={cols,rows}` 500행 상한 | **직접 충돌** |
| `deploy/index.html` (+341) | `PART_TABLES` 로 조각↔URL 역매핑, spec 화면 라이브화 | **직접 충돌** |
| `deploy/api/blocks.js` (신규) | 방막기 공유 원장 | 무관 |
| `deploy/m/index.html` (+101) | 모바일 세션만료 처리 | 무관 |

### 충돌 지점 (정확히)
1. **함수명 동일**: 그쪽 `loadMembers` / `loadCommission` / `loadCourses` / `loadTuition` / `loadElec`
   ↔ 내 초안 `loadMembers` / `loadCommission` / `loadCourses` / `loadTuition` / `loadElecMeter`.
   → **4개 정면 충돌**(elec 만 이름이 다름).
2. **조각(part) 이름 동일**: `members` `commission` `courses` `tuition` `elec` 를 양쪽이 쓴다.
   그쪽은 `out.tables[url]`, 내 쪽은 `out.<part>` 로 응답 키가 달라 **응답은 안 겹치지만
   `ALL_PARTS`·`TABLE_LOADERS`·`PART_TABLES` 등록은 겹친다.**
3. **화면 경로 이중화**: 그쪽은 `k:'spec'` 유지 + `specData(url)` 가 `REAL.tables[url]` 을 읽는 경로,
   내 쪽은 `k:'members'` 등 전용 렌더러 경로. 둘 다 살아 있으면 **같은 화면에 데이터 경로가 2개**가 된다.

### 권장 병합안 (A) — 전용 렌더러가 5화면을 대체
- 그 세션의 표 로더 12종 중 **이 5개(members·commission·courses·tuition·elec)만 제거**하고
  나머지 7종(points·visits·farmgym·boards·agencyvisit·dayoff 등)은 그대로 둔다.
- 근거: 500행 상한 spec 표는 애초 "레거시와 다르다"는 문제를 그대로 안고 있고,
  특히 **ELEC 은 167만 행 중 500행** 이라 화면으로서 의미가 없다(내 초안은 방 단위 집계 836행 반환).
- 제거 대상: `data.js` 의 해당 loader 5개 + `TABLE_LOADERS` 5줄, `index.html` 의 `PART_TABLES` 5줄.
- **삭제는 다른 세션 담당자(=사용자) 확인 후 실행.**

### 대안 (B) — 양쪽 공존 (사용자가 표 경로 보존을 원할 때)
- 내 loader 를 `loadMembersPage` / `loadCommissionRows` / `loadCoursesMaster` / `loadTuitionMatrix` /
  `loadElecMeter` 로 리네임, 조각명은 `members2` … 처럼 접미. 코드가 늘고 DB 조회가 2배가 되므로 비권장.

---

## 1. `deploy/api/data.js` 배선

각 `<키>.api.js` 의 loader 본문 + 상수를 그대로 삽입하고:
- `ALL_PARTS` 에 `"members","commission","courses","tuition","elec"` 등록(안 A 기준: 그쪽 등록분을 재사용).
- handler parts 분기:
  ```js
  if (parts.includes("members"))    out.members    = await loadMembers(q, scope);
  if (parts.includes("commission")) out.commission = await loadCommission(q, scope);
  if (parts.includes("courses"))    out.courses    = await loadCourses(q, scope);
  if (parts.includes("tuition"))    out.tuition    = await loadTuition(q, scope);
  if (parts.includes("elec")) { /* elec.api.js 주석 블록 그대로 — from/to 클램프 + latest */ }
  ```
- `elec` 은 쿼리파라미터 `efrom`/`eto`/`eroom` 을 캐시키(`version`)에 반드시 포함(그 파일 주석 참조).
- `loadStamp` 보강(변경감지):
  - `max(no) from legacy.uhak_agency_com` → `ac_max` (**반환 객체에도 넣어야 stampVersion 에 반영됨**)
  - `md5(string_agg(...)) from legacy.course_info` → `ci_h` (가격 UPDATE 감지, AUTO_INCREMENT 로는 불가)
  - `max(mb_no) from cms.g4_member` → `mb_max`
  - ❌ **`max(mb_today_login)` 은 넣지 말 것** — 전역 ETag 라 회원 로그인 한 번에
    students·roomstat 캐시까지 전부 무효화된다(QA 지적).

### 성능 실측 (전부 실제 실행)
| 조각 | 행수 | 시간 |
|---|---|---|
| members | 2,053 | 761 ms(cold) / 248 ms(warm) |
| commission | 4,004 (0.62 MB) | 0.65 s |
| courses | 71 (+cats 14) | 0.08 s / 0.17 s |
| tuition | 100 (7.4 KB) | 0.14 s |
| elec | 836방 집계 | **1,985 ms** |

**elec 만 무겁다.** `legacy.room_elec` 의 인덱스는 `room_elec_pkey` 뿐이라 기간 필터가 Parallel Seq Scan
(≈222 MB read). 전기간 집계는 **18.5 s** 로 `statement_timeout: 20000` 에 근접 → 초안이
`MAX_ELEC_SPAN_DAYS = 400` 으로 서버에서 기간을 클램프한다. **이 상한 유지 필수.**

인덱스 제안 (DDL 미실행 — Supabase 이관본에만, 원본 MySQL 불가침):
```sql
CREATE INDEX CONCURRENTLY room_elec_date_idx  ON legacy.room_elec (re_date);
CREATE INDEX CONCURRENTLY room_elec_room_date ON legacy.room_elec (i_idx, re_date);
-- 예상 1.4 s → 수십 ms, +약 50 MB. re_date 는 varchar(10) 이지만 'YYYY-MM-DD' 고정폭(형식오류 0행 실측)
-- 이라 문자열 범위비교가 날짜순서와 일치 → 캐스팅 없이 인덱스가 그대로 쓰인다.
```

---

## 2. `deploy/index.html` 배선

1. **메뉴 키 교체** (`u`·`cols` 는 남겨도 무해)
   - 710행 `{k:'spec',t:'회원관리',u:'member_list.php',…}` → `k:'members'`
   - 716행 `COMMISSION` → `k:'commission'`
   - 728행 `COURSE LIST` → `k:'courses'`
   - 729행 `TUITION FEE` → `k:'tuition'`
   - 765행 `ELEC & WATER` → `k:'elec'`
2. `LIVE_PARTS` 에 `members:['members'], commission:['commission'], courses:['courses'],
   tuition:['tuition'], elec:['elec'],` 추가.
   ※ 명시하지 않으면 기본값 `['students']` 를 타서 **불필요한 학생 전량 조회**가 붙는다.
3. `LIVE.ttls` 에 `members:300000, commission:600000, courses:600000, tuition:600000, elec:300000`.
4. `liveHave(p)` 에 5줄 추가(각 notes 의 판정식 그대로 — 반환형이 화면마다 다르다:
   members=배열, commission/courses/tuition=`{rows}`, elec=`{rows,…}`).
5. `liveSync` 응답 반영부(`if(j.changelog)…` 옆)에 `if(j.members)REAL.members=j.members;` 등 5줄.
6. 각 `<키>.render.js` 전문을 `R.commrules`(≈2615행) 앞뒤 렌더러 영역에 삽입.
7. **`__init` 추가 배선 불필요** — `deploy/index.html:2924` 의
   `if(typeof R[curKey+'__init']==='function')try{R[curKey+'__init'](m);}catch(e){…}` 가 이미 자동 호출한다.
   (courses QA 가 "호출되는 곳이 전무 → renderMain 에 2줄 추가 필요" 라고 적었는데 **사실이 아니다**.
   2924행에서 확인했고, `prototype.html:2782` 에도 동일 훅이 있다. 그 2줄을 넣으면 **__init 이 2회 호출**된다.)
8. `_buildCourseCache()`(≈2696행) 패치 — `REAL.courses.rows` 우선 + 기존
   `REAL.tables['course_list.php']` 스냅샷 폴백(`courses.notes.md` §3 코드).
   수강등록·멀티수강 화면의 **코스 숫자코드 노출**과 `·off` 배지 누락이 함께 해결된다.
   ⚠ 안 (A)로 그쪽 `courses` 표 로더를 제거하면 폴백은 정적 스냅샷만 남는다 — 정상.

## 3. `docs/design-admin/prototype.html`
동일 렌더러·메뉴키를 미러링. 단 prototype 에는 라이브 데이터 계층(`LIVE_PARTS`/`goMenu`)이 없으므로
5화면 모두 **무데이터 안내 카드로 폴백**된다(설계 의도대로. QA 스모크로 예외 없음 확인).

---

## 4. 검증 계획
- `exploration/live-data/e2e.mjs` 를 본떠 `e2e5.mjs` 작성 —
  로컬 정적서버 + 실 `/api/data` 핸들러 + 위조 세션 쿠키로 5개 메뉴 순회.
- 확인 항목: 조각 요청이 매핑대로 1회씩 발사 · 표 행수(members 2,053 / commission 4,004 / courses 71 /
  tuition 25코스×4주 / elec 836방) · 필터·페이지네이션 동작 · **pageerror 0** ·
  전체 60개 화면 스윕에서 `undefined`/`NaN`/`[object Object]` 0건.
- elec 은 응답 1.9 s 이므로 대기 타임아웃을 넉넉히(≥30 s).

## 5. 배포
`vercel deploy --prod` → **`vercel alias set` 로 `smeag-bay.vercel.app` 별칭 재지정**
(별칭이 자동 이동하지 않아 구버전이 보인 전례 있음) → 라이브 Playwright 재검증 → 진행이력 갱신.

---

## 6. 남은 업무 확인 사항
- TUITION FEE: **5주차 이상 요금 규칙이 원본에 없다**(tution_fee 는 week 1~4 뿐). 4주 요금 배수인지
  별도 견적인지 행정팀 확인 필요.
- ELEC & WATER: `re_state` 가 전량 빈값이라 레거시 폼의 `search_condition2`(STUDYING/GRADUATING)
  필터 근거를 이 테이블만으로는 재현할 수 없다. 학생 재실정보와의 조인 규칙 확인 필요.
- 2026년 검침행의 약 40%가 `re_gage=0` — 초안은 `re_gage>0` 행만으로 시작·종료검침을 잡는다.
  0 이 "미검침"인지 "실제 0"인지 업무 확인 필요.
