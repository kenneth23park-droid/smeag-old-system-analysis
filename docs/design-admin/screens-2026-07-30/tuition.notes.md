# TUITION FEE (`tution_fee.php`) — 전용 렌더러 `R.tuition` 구현 노트

## 1. 레거시 원본 구조 (실측)

`sql/tution_fee.sql` (phpMyAdmin 덤프) DDL 원문:

```sql
CREATE TABLE IF NOT EXISTS `tution_fee` (
  `idx`        int(4) unsigned NOT NULL AUTO_INCREMENT,
  `course`     int(4) NOT NULL COMMENT 'Refer the course_info table',
  `agency_jp`  int(4) NOT NULL DEFAULT '0' COMMENT 'YEN',
  `student_jp` int(4) NOT NULL DEFAULT '0' COMMENT 'YEN',
  `week`       int(4) NOT NULL,
  PRIMARY KEY (`idx`)
) ENGINE=MyISAM AUTO_INCREMENT=101;
```

→ 컬럼 주석이 **YEN** 을 명시. 일본시장 전용 주차별 요금표임이 원본에서 확인됨.
Supabase `legacy.tution_fee` 컬럼 타입: `idx bigint, course integer, agency_jp integer, student_jp integer, week integer`.

## 2. 실쿼리 실측 (읽기 전용, 전부 실행 확인)

| 항목 | 값 |
|---|---|
| `select count(*) from legacy.tution_fee` | **100** |
| distinct `week` | **1, 2, 3, 4** — 각각 정확히 25행 |
| distinct `course` | **25종** (14,16,17,18,22,25,26,27,31,32,42,43,44,45,46,47,48,49,50,51,52,53,54,55,57) — 각 4행 |
| `(course, week)` 중복 | **0건** (`group by course,week having count(*)>1` → 빈 결과) |
| 고아행 (`course` 가 `course_info.i_idx` 에 없음) | **0건** (`where not exists(...)` → 0) |
| `agency_jp` 범위 | 30,600 ~ 106,000 |
| `student_jp` 범위 | 32,100 ~ 111,300 |
| `student_jp < agency_jp` 인 행 | **0건** (마진은 항상 ≥ 0) |
| 0원 행 (`agency_jp=0 or student_jp=0`) | **0건** |
| loader 쿼리 실행 결과 | 100행, JSON payload ≈ **8.4 KB** |

즉 **25코스 × 4주차 = 100 = 완전격자(빈칸 없음)**. 매트릭스 뷰가 손실 없이 원본 전량을 표현한다.

샘플(loader 쿼리 그대로, 첫/끝):
```
(1,  '14', 'ESL(CAPITAL)',      'ESL(CAPITAL)',      'Y', 'C',   0, 1, 30600,  32100)
(24, '54', 'Business master 3', 'Business master 3', 'N', 'C', 301, 4, 96000, 100800)
```

### 코스별 요금(1주/4주 발췌 — 검증용)
| # | 코스(KO) | 코스(EN) | state | 1wk A/S | 4wk A/S |
|---|---|---|---|---|---|
|14|ESL(CAPITAL)|ESL(CAPITAL)|Y|30,600 / 32,100|68,000 / 71,400|
|46|ESL 2(CAPITAL)|ESL 2(CAPITAL)|Y|37,800 / 39,700|84,000 / 88,200|
|16|IELTS 입문반|Pre-IELTS|Y|37,800 / 39,700|84,000 / 88,200|
|17|IELTS 5.5|IELTS 5.5|Y|42,300 / 44,400|94,000 / 98,700|
|18|IELTS 6.0|IELTS 6.0|Y|44,100 / 46,300|98,000 / 102,900|
|31|IELTS 6.5|IELTS 6.5|Y|47,700 / 50,100|106,000 / 111,300|
|32|IELTS 7.0|IELTS 7.0|Y|47,700 / 50,100|106,000 / 111,300|
|42|TOEIC 입문반|Pre-TOEIC|Y|35,100 / 36,900|78,000 / 81,900|
|25|TOEIC 600|TOEIC 600|Y|36,900 / 38,800|82,000 / 86,100|
|26|TOEIC 700|TOEIC 700|Y|40,500 / 42,500|90,000 / 94,500|
|27|TOEIC 800|TOEIC 800|Y|42,300 / 44,400|94,000 / 98,700|
|47|TOEIC 900|TOEIC 900|Y|44,100 / 46,300|98,000 / 102,900|
|48|Pre-TOEFL|Pre-TOEFL|Y|37,800 / 39,700|84,000 / 88,200|
|49|TOEFL 3.5(60)|TOEFL 3.5(60)|Y|42,300 / 44,400|94,000 / 98,700|
|50|TOEFL 4.0(80)|TOEFL 4.0(80)|Y|44,100 / 46,300|98,000 / 102,900|
|51|TOEFL 4.5(90)|TOEFL 4.5(90)|Y|47,700 / 50,100|106,000 / 111,300|
|57|TOEFL 5.0(100)|TOEFL 5.0(100)|Y|47,700 / 50,100|106,000 / 111,300|
|52|Business|Business|Y|30,600 / 32,100|68,000 / 71,400|
|55|4th campus intensive ielts|(동일)|**N**|40,800 / 42,900|96,000 / 100,800|
|43|PTE 입문반|Pre-PTE|**N**|36,900 / 38,700|82,000 / 86,100|
|44|PTE 50|PTE 50|**N**|40,500 / 42,500|90,000 / 94,500|
|45|PTE 57|PTE 57|**N**|44,100 / 46,300|98,000 / 102,900|
|22|PTE 64|PTE 64|**N**|39,600 / 41,600|88,000 / 92,400|
|53|Business master 2|Business master 2|**N**|37,800 / 39,700|84,000 / 88,200|
|54|Business master 3|Business master 3|**N**|40,800 / 42,900|96,000 / 100,800|

→ 25코스 중 **운영중(i_state='Y') 18 / 중단(N) 7**. 중단 코스도 요금행은 남아 있으므로
화면에서 지우지 않고 `STATE` 컬럼에 Y/N 으로 표시(회색)한다. (레거시도 필터 없이 전량 표시)

## 3. 컬럼 매핑

| 신전산 컬럼 | 소스 | 비고 |
|---|---|---|
| `#` | 화면 순번 | 원본 `idx` 는 삽입순(1..100)이라 의미 없음 → 표시하지 않고 순번 사용 |
| `COURSE` | `course_info.i_name_en` (EN) / `i_name` (KO) + `#course` 코드 | 언어토글(`LANG`)에 따라 주표시 전환, 반대쪽 이름은 작게 병기 |
| `WEEK` | `tution_fee.week` | 1~4 |
| `AGENCY(JP)` | `tution_fee.agency_jp` | YEN, 유학원 매입가 |
| `STUDENT(JP)` | `tution_fee.student_jp` | YEN, 학생 판매가 |
| `MARGIN` (추가) | `student_jp - agency_jp` | 계산식. 항상 ≥ 0 (실측 확인). 명백한 개선이므로 토글 체크박스로 on/off |
| `CAMPUS` (매트릭스만) | `course_info.s_campus` | **단문자 코드**. distinct = `A / C / S`. 요금표 25코스는 **전부 `C`** |
| `STATE` (매트릭스만) | `course_info.i_state` | Y=운영 / N=중단 |

### `s_campus` 코드 매핑 — 주의
`course_info.s_campus` 는 `student_info.s_campus`(`SPARTA`/`CLASSIC`/`CAPITAL` 문자열)와 **다른 체계**로,
단문자 `A/C/S` 다. 렌더러의 `tfCampus()` 는 `C→CAPITAL, S→ENCANTO, A→CLASSIC` 으로 매핑했다.
`C→CAPITAL` 은 코스명 자체가 `ESL(CAPITAL)`, `4th campus...` 인 것으로 교차확인되지만
**`A`/`S` 매핑은 추정**이다(요금표 데이터에는 등장하지 않으므로 이 화면에서는 영향 없음).
COURSE LIST(`courses`) 담당자와 매핑을 통일하는 것이 좋다.

## 4. 고아행(orphan) 처리 방침
- **실측 0건.** `legacy.tution_fee.course` 100건 전부 `legacy.course_info.i_idx` 에 매칭됨.
- 그래도 방어적으로: loader 는 `left join` 을 쓰고 `orphans` 배열(코스코드 distinct)을 응답에 함께 실어보낸다.
- 렌더러는 이름이 비면 `#<코스코드>` 로 표시하고 행을 **버리지 않는다**(금액 정보 손실 방지).
  매트릭스에서는 `c_order` 가 없으므로 `999999` 로 채워 맨 뒤에 정렬된다.
- `inner join` 을 쓰지 않은 이유: 원본 불가침 원칙상 FK 를 만들 수 없고, 향후 코스 삭제 시
  요금행이 화면에서 조용히 사라지면 안 되기 때문.

## 5. 화면 구성 (`tuition.render.js`)
- 기본 뷰 = **매트릭스**: 행=코스(25), 열=주차(1~4), 각 주차마다 `AGENCY | STUDENT | MARGIN` 3칸
  (2줄 헤더 + `colspan`). 마진 토글 off 시 2칸.
- 토글 뷰 = **원본 목록**: 레거시 컬럼 순서 그대로 `# / COURSE / WEEK / AGENCY(JP) / STUDENT(JP)` (+MARGIN),
  `makeSortable(box)` 로 컬럼 정렬. 매트릭스에는 정렬을 걸지 않음(2줄 헤더라 `makeSortable` 의 단일 헤더행 가정과 충돌).
- 필터: `보기(View)` / `COURSE`(코스 셀렉트, off 코스는 `·off` 표시) / `WEEK` / `코스명 검색`(KO+EN+코드 부분일치) / `마진 표시`.
  필터 상태는 모듈 전역 `tfState` 에 유지 → 언어토글·재렌더 후에도 보존.
- 통계칩: 코스수(운영중 n) · 주차범위 `1~4 (4)` · 요금행수 · 통화 `YEN (¥)`.
- 엑셀: `data-tblexcel="tution_fee.php"` → 기존 `exportGridXls` 자동배선(index.html 2849행).
- 데이터 없음(`REAL.tuition` 미로딩/비로그인) → 안내 카드 폴백, 헤더는 그대로 유지.
- 모든 문구 `T(ko,en)` 래핑, 숫자 셀 `class="mono"`, 색상은 `--good/--dim/--faint` 만 사용.

## 6. API (`tuition.api.js`)
- `loadTuition(q, scope)` → `{ rows:[{idx,course,name,name_en,state,campus,order,week,agency,student}], weeks:[1,2,3,4], courseCount:25, total:100, orphans:[], currency:'JPY', truncated:false }`
  (`truncated` 는 QA 에서 추가 — 상한 절단 감지용)
- 상한 `MAX_TUITION = 500` (실제 100행, payload ≈ 8.4 KB — 전량 반환 안전).
- 정렬은 서버에서 `c_order → course → week`. 클라이언트도 같은 키로 재정렬하므로 순서 의존성 없음.
- **`scope.agency` 제한 없음.** 근거: 요금표는 개인정보가 아니라 전사 공통 가격 마스터이고,
  레거시 `tution_fee.php` 도 유학원별 분기가 없다. 다만 `agency_jp`(유학원 매입가)는 상업적으로
  민감하므로, 향후 유학원 포털에 이 메뉴를 노출한다면 그때 `agency_jp` 컬럼만 마스킹하면 된다
  (현재 신전산에서 이 메뉴는 `financial` 카테고리 = 재무부/원장 권한).

## 7. 오케스트레이터 배선 체크리스트
1. `deploy/index.html` MENU `financial` 배열의
   `{k:'spec',t:'TUITION FEE',u:'tution_fee.php',cols:['#','COURSE','WEEK','AGENCY(JP)','STUDENT(JP)']}`
   → **`k:'tuition'`** 으로 교체(`u`, `cols` 는 유지해도 무해).
2. `LIVE_PARTS` 에 `tuition:['tuition']` 추가. (학생 데이터 불필요 → `['students']` 기본값을 타면
   167만행급은 아니지만 불필요한 학생 전량 조회가 붙으므로 **반드시 명시**할 것.)
3. `LIVE.ttls` 에 `tuition:600000` (10분) 추가 — 사실상 정적 마스터.
4. `liveHave(p)` 에 `if(p==='tuition')return !!(REAL.tuition&&REAL.tuition.rows&&REAL.tuition.rows.length);` 추가.
5. `liveSync` 의 응답 반영부에 `if(j.tuition)REAL.tuition=j.tuition;` 추가.
6. `data.js`: `MAX_TUITION` 상수 + `loadTuition` 함수 + `ALL_PARTS` 에 `"tuition"` +
   handler parts 분기 `if (parts.includes("tuition")) out.tuition = await loadTuition(q, scope);`
   (api.js 파일 안에 주석으로 표시해 둠 — `node --check` 통과를 위해 그 한 줄만 주석 처리했으니
   붙여넣을 때 주석을 벗길 것).
7. `renderMain` 은 **이미** `R[curKey+'__init']` 을 자동 호출한다(`deploy/index.html:2924`
   `if(typeof R[curKey+'__init']==='function')…`). → **추가 배선 불필요**(QA 에서 확인·정정).
8. `liveInvalidate()` 는 `_specCache` 등만 비운다. `tuition` 은 파생 캐시가 없으므로 추가 작업 없음.

## 8. 제약 / 미해결
- `loadStamp` 는 `tution_fee` 를 감지하지 않으므로, 요금표만 바뀌면 ETag 가 안 변해 최대 TTL(10분)
  동안 구값이 보일 수 있다. 정밀 감지가 필요하면 `loadStamp` 에
  `coalesce((select max(idx) from legacy.tution_fee)::text,'') tf_max` 한 줄 추가(주석으로 안내해 둠).
  단 `idx` 는 AUTO_INCREMENT 라 **금액 UPDATE 는 감지 못한다** — 정확히 하려면
  `sum(agency_jp+student_jp)` 같은 체크섬을 써야 한다(현재는 과잉이라 판단해 미적용).
- 통화 환산(YEN→USD/PHP) 없음. 레거시에 없는 기능이므로 추가하지 않았다.
- 5주차 이상 요금은 원본에 없다. 실무에서 5주 이상 등록 시 어떤 규칙(4주 요금 × 배수? 별도 견적?)을
  쓰는지는 이 테이블에서 알 수 없다 → 업무 확인 필요 항목.

## QA 결과 — PASS (수정 3건 반영)

검증자: QA 리뷰어. 대상 파일 3개를 직접 수정했다.

### 1. 문법
- `node --check tuition.render.js` 통과. `tuition.api.js` → `.mjs` 사본으로 `node --check` 통과.
  템플릿 리터럴 중첩·따옴표 깨짐 없음.

### 2. SQL 실사 (읽기 전용, 실제 실행)
| 쿼리 | 결과 | 시간 |
|---|---|---|
| `loadTuition` 본문(`limit 500`) 그대로 | **100행** (상한 500 이내) | **0.143 s** (2초 이내, 느린 쿼리 없음) |
| `count(*)/count(distinct course)/min,max(week)` | 100 / 25 / 1 / 4 | <0.1 s |
| `distinct upper(s_campus)` (course_info) | `A, C, S` — 개발자 실측 재확인 | <0.1 s |
| JSON payload 실측 | **7.4 KB** (개발자 보고 8.4 KB 와 동급, 안전) | — |
- 첫/끝 행: `(1,'14','ESL(CAPITAL)','ESL(CAPITAL)','Y','C',0,1,30600,32100)` /
  `(24,'54','Business master 3','Business master 3','N','C',301,4,96000,100800)` — 보고서와 일치.
- 인덱스 불필요(100행 seq scan). `statement_timeout 20s` 여유 충분.

### 3. 규약 준수
- 사용자 문구 전부 `T(ko,en)` 래핑 확인(`COURSE/WEEK/AGENCY(JP)/STUDENT(JP)/YEN` 등 고유명사·컬럼코드는 예외).
- 사용 클래스: `ph/sub/url/actions/btn/chips/chip/filters/field/field grow/dl-chk/twrap/grid/mono/card pad/banner`
  — **전부 index.html 에 이미 존재**(`.filters .grow`=148행, `.dl-chk`=150행). **새 CSS 요구 없음.**
- 색상은 `--good/--dim/--faint/--warn` CSS 변수만 사용.
- 재사용 헬퍼: `esc / T / campusChipName / makeSortable / exportGridXls(data-tblexcel)` — 재구현 없음.
  숫자 포맷은 기존 코드 관행과 동일하게 `toLocaleString()` 직접 사용(전용 포맷 헬퍼는 index.html 에 없음).

### 4. 무데이터 안전성 (실제 node 스모크 테스트 수행)
`R`/`esc`/`T`/`campusChipName`/`makeSortable` 을 스텁으로 넣고 렌더 함수만 eval 해 호출:
- `REAL=null` → 예외 없이 안내 카드 폴백 ✔
- `REAL={}` → 폴백 ✔
- `REAL={tuition:{rows:[],weeks:[]}}` → 폴백 ✔
- `REAL.tuition` 이 **배열**(loader 반환형이 바뀐 경우)이어도 렌더 성공 ✔ (`t.rows||t` 경로)
- 필터가 아무 것도 못 잡을 때 → "No fees match the filter." 카드 ✔
- 매트릭스/원본목록 두 뷰 모두 가짜 DOM 으로 렌더 성공, 고아행(코스명 없음)은 `#99` 로 표시되고 버려지지 않음 ✔

### 5. XSS — **취약점 1건 발견·수정**
- `tfCampus()` 가 미지의 `s_campus` 코드를 그대로 반환하고 `campusChipName()` 은 미지의 값을
  `esc` 없이 HTML 로 내보낸다 → `s_campus='<img src=x onerror=…>'` 시 스크립트 실행.
  실측 데이터는 `A/C/S` 뿐이지만 **DB 유래 문자열 무이스케이프 경로**이므로 수정:
  `return {C:'CAPITAL',S:'ENCANTO',A:'CLASSIC'}[k]||(k?esc(k):'—');`
  스모크 테스트로 `&lt;IMG SRC=X ONERROR=…&gt;` 로 이스케이프됨을 확인.
- 코스명·코스코드·고아행 목록은 모두 `esc()` 경유 확인.
- **속성 주입 수정**: 검색 input 의 `value="${esc(tfState.q)}"` 제거.
  프로젝트의 `esc()` 는 `&<>` 만 치환하고 **따옴표를 escape 하지 않는다** → 검색어에 `"` 가 들어가면
  속성이 깨진다. 값은 `__init` 에서 `qf.value=tfState.q` 로 복원하도록 변경(자체 XSS 경로 제거).

### 6. PII
- 응답 컬럼: `idx, course, name, name_en, state, campus, order, week, agency_jp, student_jp` —
  개인정보 없음(코스 가격 마스터). 비밀번호/주민번호/연락처 계열 컬럼 미포함 ✔
- `scope.agency` 무시 방침 유지에 동의: 레거시 `tution_fee.php` 도 유학원 분기가 없고,
  이 메뉴는 `financial` 카테고리(재무부/원장)로만 노출된다. 단 `agency_jp`(유학원 매입가)는 상업적으로
  민감하므로 **유학원 포털에 이 메뉴를 노출하는 순간 `agency_jp` 마스킹이 필요**하다(미래 과제로 유지).

### 7. 중복 구현
- 기존 헬퍼 재구현 없음. `tfYen`(1줄 포맷터)·`tfCampus`·`tfData`·`tfCourses` 는 이 화면 고유 로직.

### 8. 추가 개선(QA 반영)
- loader 응답에 `truncated: out.length >= MAX_TUITION` 추가, 렌더러가 상한 절단 시 `--warn` 배너 표시
  → 코스/주차가 늘어 100행을 넘겨도 **조용히 잘리지 않는다**.
- 고아행이 생기면 `--warn` 배너에 코스코드 목록 표시(현재 실측 0건).

### 9. 정정 사항
- 배선 체크리스트 7번(“`renderMain` 에 `R.tuition__init` 호출 추가 필요”)은 **오류**였다.
  `deploy/index.html:2924` 가 이미 `R[curKey+'__init']` 을 자동 호출한다 → 추가 배선 불필요. 본문 정정 완료.

### 10. 미해결(승인 필요 없음, 알고 있어야 함)
- `loadStamp` 가 `tution_fee` 를 보지 않아 요금표만 바뀌면 최대 TTL(10분) 동안 구값 표시 가능(8절 참조).
  개발자 판단(미적용)에 동의 — 요금표는 연 단위로 바뀌는 정적 마스터.
- `s_campus` 의 `A`/`S` 매핑은 여전히 추정. 이 화면 데이터는 전부 `C` 라 영향 없음.
  COURSE LIST(`courses`) 담당과 통일 필요.
