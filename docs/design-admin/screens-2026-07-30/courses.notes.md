# COURSE LIST (`course_list.php`) — 전용 렌더러 `R.courses` 구현 노트

산출물: `courses.render.js` · `courses.api.js` (둘 다 `node --check` 통과 확인)

---

## 1. 실측 데이터 (Supabase, 읽기 전용 select 만 실행)

| 항목 | 실측값 |
|---|---|
| `legacy.course_info` | **71행** |
| `legacy.course_category` | **14행** |
| `i_state` 분포 | `Y` 37 · `N` 34 (null 없음) |
| `s_campus` 분포 | `C` 56 · `S` 10 · `A` 5 (**`E` 는 0건**) |
| `g_type`(course_info) 분포 | `C` 71 (단일값 → 화면에서 미사용) |
| **`g_idx` 분포** | **`5`(ESL) 71 — 즉 모든 코스가 한 카테고리에 몰려 있음** |
| `i_limit`(정원) | **전 행 0** (정원 관리가 사실상 안 되고 있음) |
| `c_order` | 0~980, distinct 66 (동순위 5쌍 있음 → 2차키 `i_idx` 로 확정 정렬) |
| `i_info` 비어있지 않은 행 | 4행 (i_idx 70/90 = 페소 안내문, 168='0', 169='205' → 사실상 잡값) |
| 카테고리 고아행(`g_idx` 미존재) | 0건 |
| loader 응답 크기 | **9,613 bytes** (cats+rows JSON) — 상한 걱정 없음 |

카테고리 14개(`g_order` 순): ESL(5) · IELTS 코스(7) · TOEIC(15) · Cambridge(17) · EAP 코스(11) ·
AQF 코스(13) · 조기프로그램(14) · GAC(16) · TOEFL(18) · Business(19) · Kingdergarten(20) ·
Family course(21) · Intensive IELTS(Vietnam)(22) · Working holiday(Encanto)(23) — 전부 `g_display='Y'`.

> ⚠ **레거시 실상**: 카테고리 테이블은 14개인데 코스는 전부 `g_idx=5`. 따라서 그룹 렌더링은
> "ESL #5 · 71개 코스" 헤더 1줄만 나온다. 이건 버그가 아니라 원본 데이터 상태이며,
> 렌더러는 카테고리가 실제로 분화되면 자동으로 여러 그룹으로 갈라지게 작성했다.
> 카테고리 필터 셀렉트에는 14개 전부를 `(코스수)` 와 함께 노출한다(0개인 카테고리도 보이게 —
> 데이터 상태를 감추지 않는 편이 운영에 유용).

### 국가별 가격 통화 단위 (실데이터로 확인)
같은 코스(`i_idx=14 ESL(CAPITAL)`)의 값: `i_pay=210,000` / `cn=210` / `jp=27,000` / `tw=210` /
`vt=ru=sa=mgl=etc=205`.
→ **`i_pay`=KRW, `i_pay_jp`=JPY, 나머지 국가 컬럼=USD** 로 판정(자릿수 근거).
헤더에 단위를 병기하고 배너에도 명시했다. 합산/평균 같은 파생계산은 하지 않는다(통화 혼재).

### 금액 플레이스홀더(가짜 금액) — N/A 처리
| 값 | 등장 예 |
|---|---|
| `2147483647` (int4 max) | i_idx 69 · 149 `Thai camp` — 9개 가격 컬럼 대부분 |
| `99999999` | i_idx 70 · 90 `CEBU RESIDENT TOEFL SPECIAL CLASS` |
| `999999` | i_idx 66 `Thai english camp`, 100 `ENCANTO Thai camp`, 164, 101, 93/94/97/99/171 의 `jp` |
| `1000000` | i_idx 33 `ESL russia group` — cn/jp/tw/vt/sa/mgl |

렌더러는 이 값들을 **금액이 아니라 미설정**으로 보고 주황 `N/A`(원값은 `title` 툴팁)로 그린다.
단 **KRW(BASE) 컬럼의 `999,999`·`1,000,000` 은 실금액일 수 있어 그대로 표시**하고,
`99,999,999`·`2,147,483,647` 만 N/A 로 본다(`coIsSentinel(v, unit)`).
`0` 은 "해당 국가 판매 안 함"으로 보아 회색 `—`.

기타 특이사항: `i_idx 69` 와 `149` 는 이름·가격이 완전히 동일한 **중복 코스행**(둘 다 `i_state='N'`),
`i_name_en` 에 한글이 섞인 행 있음(`Family course(parents)예전것1차`).

---

## 2. 컬럼 매핑표 (신전산 표 ← course_info)

| 표 컬럼 | 소스 | 렌더 |
|---|---|---|
| `#` | `i_idx` | mono — **student_info.course_info 가 참조하는 코드값**(아래 3장) |
| `코스명 / COURSE (KO)` | `i_name` | 텍스트 |
| `COURSE (EN)` | `i_name_en` (없으면 `i_name`) | 굵게 |
| `정원 / LIMIT` | `i_limit` | 0 이면 `—` (실측 전 행 0) |
| `BASE (KRW)` | `i_pay` | mono, `toLocaleString` |
| `CN/JP/TW/VT/RU/SA/MGL/ETC` | `i_pay_cn/jp/tw/vt/ru/sa/mgl/etc` | mono, 단위 헤더 병기, sentinel→N/A |
| `캠퍼스` | `s_campus` | `S→ENCANTO`, `C→CAPITAL`, `A→ALL`(중립 배지), `E→CLASSIC`(추정·데이터 0건), 미지의 값은 원문 회색 |
| `상태` | `i_state` | `Y`→`pill good` ACTIVE / 그외→`pill warn` STOPPED |
| `순서` | `c_order` | 정렬 근거 확인용(레거시 배열순서) |
| `비고` | `i_info` | 4행만 값 있음 |
| (그룹헤더) | `course_category.g_name` + `g_idx` + 코스수 | `<tr class="grp">` |

정렬: **`cc.g_order` → `ci.c_order` → `ci.i_idx`** (서버에서 확정, 클라이언트는 그 순서를 신뢰).
`tr.grp` 클래스를 쓰므로 기존 `makeSortable` 이 헤더 클릭 정렬 시 그룹헤더를 자동 제거하고,
`exportGridXls` 도 그룹행을 제외한다(기존 구현이 이미 `.grp` 를 인식 — 확인함).

기능 범위: 필터(카테고리/캠퍼스/상태/검색) · 통계칩(전체·사용중·중지·카테고리수·표시수) ·
가로스크롤 `twrap` · 헤더 정렬 · `data-tblexcel="COURSE_LIST"` 엑셀. 레거시에 없는 편집/추가는 넣지 않음.

---

## 3. ★ 코스 마스터 캐시 통합 제안 (다른 화면들이 이 데이터를 참조)

**현재 상태 (확인함)**: `deploy/index.html` 의 `_buildCourseCache()` 는
`REAL.tables['course_list.php']` 를 읽는데, **배포본 `REAL` 스냅샷에 그 키가 아예 없다**
(`grep` 결과 `course_list.php` 언급 3곳 = 메뉴 정의·주석·이 함수뿐, 데이터 없음).
따라서 지금은 `courseNameOf(code)` 가 **항상 코드 그대로 반환**하고 `courseActiveOf()` 는 항상 false,
`courseInMaster()` 는 항상 false → 수강등록/멀티수강 화면의 COURSE 필터에 `14`, `56`, `46` 같은
**숫자 코드가 그대로** 노출되고 `·off` 배지도 절대 안 붙는다. 이 화면이 라이브로 붙으면 그게 다 고쳐진다.

`student_info.course_info` 실측 상위값: `14`(29,333) `56`(15,505) `46`(8,965) `17`(7,184) `18`(3,759) …
→ **저장값 = `course_info.i_idx` 문자열** 이 확실하다(매핑 근거).

제안 패치(오케스트레이터 몫):

```js
function _buildCourseCache(){_courseNameCache={};_courseActiveCache={};
  const cs=REAL&&REAL.courses&&REAL.courses.rows;            // ① 라이브 코스 마스터 우선
  if(cs&&cs.length){cs.forEach(r=>{const c=(''+r.idx).trim();if(!c)return;
    _courseNameCache[c]=(r.en||r.ko||c);_courseActiveCache[c]=((r.state||'')==='Y');});return;}
  const t=REAL&&REAL.tables&&REAL.tables['course_list.php']; // ② 기존 스냅샷 폴백(그대로 유지)
  if(t&&t.cols){ …현행 코드 그대로… }}
```

- `liveInvalidate()` 가 이미 `_courseNameCache=null;_courseActiveCache=null` 로 리셋하므로 추가 작업 없음.
- 코스명을 쓰는 화면들(`stdlist`/`enroll`/`spec`(멀티수강)/`financial`)은 `LIVE_PARTS` 에 `'courses'` 를
  추가해야 첫 진입에서도 이름이 나온다. 예: `stdlist:['students','courses']`, `enroll:['students','courses']`,
  `spec:['students','courses']`, `financial:['students','courses']`. courses 는 9.6KB뿐이라 비용이 사실상 0.
- **주의**: 학생 데이터에는 마스터에 **없는 코스코드 14개**(`24,30,74,75,76,77,78,79,80,81,82,83,84,85`)가
  쓰인다(`78`은 1,697건, `81`은 497건). 삭제된 코스다. `courseNameOf` 는 코드 그대로 반환하고
  `courseInMaster()=false` 가 되어 `·off` 배지도 안 붙는 게 **의도된 동작**(`courseAllCodes()` 가
  마스터 ∪ 학생데이터 합집합을 쓰므로 필터 옵션에서 사라지지는 않는다).

---

## 4. 배선 체크리스트 (오케스트레이터)

1. `deploy/index.html`
   - 메뉴 정의 728행: `{k:'spec',t:'COURSE LIST',u:'course_list.php',cols:[…]}` → **`k:'courses'`** 로 교체
     (`cols` 는 이제 렌더러가 직접 그리므로 남겨도 무해).
   - `LIVE_PARTS` 에 `courses:['courses']` 추가 + 위 3장의 다른 화면 parts 보강.
   - `liveHave()` 에 한 줄: `if(p==='courses')return !!(REAL.courses&&REAL.courses.rows&&REAL.courses.rows.length);`
   - `liveSync()` 응답 반영에 한 줄: `if(j.courses)REAL.courses=j.courses;`
   - `courses.render.js` 내용을 `R.commrules` 근처(렌더러 구역)에 붙이고,
     `renderMain()` 이 `R.<key>__init` 을 호출하도록 배선.
     **QA 정정**: `R.commrules__init` 은 "특수 배선" 된 것이 아니라 **정의만 있고 호출되는 곳이 전혀 없다**
     (`grep -n commrules__init deploy/index.html` → 2642행 정의 1건뿐). 따라서 일반화는 권장이 아니라 **필수**.
     `renderMain()` 의 `makeSortable(m);`(2850행) 바로 뒤에 다음 2줄을 넣으면 `courses` 와 `commrules` 가 함께 살아난다:
     ```js
     const _ini=R[curKey+'__init'];            // 전용 렌더러 후처리(필터·이벤트) 일반 배선
     if(typeof _ini==='function'){try{_ini(curMenu);}catch(e){}}
     ```
   - `_buildCourseCache()` 패치(3장).
2. `deploy/api/data.js`
   - `ALL_PARTS` 에 `"courses"` 추가, `MAX_COURSES=500` 상수, `loadCourses` 함수,
     `if (parts.includes("courses")) out.courses = await loadCourses(q, scope);`
   - `loadStamp` 에 아래 한 줄 추가(**QA 확정안** — 실측 0.143s, `max(i_idx)` 안은 가격 수정을 못 잡아 폐기):
     ```sql
     coalesce((select md5(string_agg(i_idx||'|'||coalesce(i_state,'')||'|'||coalesce(i_pay::text,'')
              ||'|'||coalesce(i_name,''), ',' order by i_idx)) from legacy.course_info),'') ci_h
     ```
     `loadStamp` 의 return 객체에도 `ci_h: r.ci_h` 를 추가해야 `stampVersion()` 해시에 반영된다.
3. 렌더러 전역 `courseFilter` / `CO_*` / `co*()` 헬퍼가 기존 식별자와 충돌하지 않음(확인함: `co` 접두 미사용).

## 5. 권한·스코프 판단 근거
`scope.agency`(유학원 계정)에도 **코스 마스터 전량을 그대로 반환**한다. 근거:
(1) PII 가 전혀 없다, (2) 레거시 유학원 포털 `agency_page.php` 의 학생 등록신청 폼이
`course_info1` 셀렉트(= 이 마스터)를 그대로 쓰므로 유학원이 이미 보는 데이터다,
(3) 국가별 가격은 유학원 견적의 기준가로 원래 공유된다.
다만 국가별 가격은 대외 민감도가 0 은 아니므로, 추후 유학원 계정에는 `pay`(KRW 원가)만 숨기고
자국 통화 컬럼만 남기는 옵션을 두는 것도 가능하다(현재 레거시는 구분하지 않으므로 미구현).

## 6. 한계 / 재현 불가
- `i_limit`(정원)이 전 행 0 이라 화면에 의미 있는 값이 안 나온다 — 레거시도 동일. 컬럼은 유지.
- 코스 **편집/추가/삭제**(레거시 course_list.php 의 등록 폼)는 읽기 전용 규약상 미구현.
  향후 구현 시 `i_idx` 유니크·`c_order` 중복(현재 5쌍) 정리와 idempotency 가드가 선행 필요.
- 주차별 실제 청구금액은 이 화면이 아니라 `tution_fee`(TUITION FEE, 100행) 담당 — 배너로 안내.

---

## QA 결과 (독립 리뷰어, 2026-07-30) — **PASS (코드 수정 4건 + 문서 정정 2건 반영 후)**

### 1. 문법 — PASS
`node --check courses.render.js` / `courses.api.js` 모두 통과(수정 후 재확인). 템플릿 리터럴 미사용(전부 문자열 결합)이라 중첩 깨짐 없음.

### 2. SQL 실사 — PASS (전 쿼리 실제 실행)
| 쿼리 | 결과 | 소요 |
|---|---|---|
| `loadCourses` cats (course_category) | **14행** — 첫행 `(5,'ESL','Y',1,'C')` | **0.172s** |
| `loadCourses` rows (course_info ⋈ category, `limit 500`) | **71행** — 첫행 `(14,5,'ESL(CAPITAL)','ESL(CAPITAL)',0,0,210000,210,27000,210,205,205,205,205,205,'','Y','C')` | **0.080s** |
| 제안 stamp `md5(string_agg(...))` (아래 §QA-5) | `fcb95106…` | **0.143s** |
분포 재확인: `g_idx` = `5`×71(단일), `i_limit<>0` **0행**, `s_campus` A5/C56/S10, `i_state` Y37/N34.
전부 상한(500) 안, **2초 초과 쿼리 없음**. select 만 실행(DDL/DML 없음).
`i_pay` 컬럼에 sentinel 값이 들어간 행 **7행** 존재 → KRW 정책(§1 참조) 검증 필요했고 정상 동작 확인.

### 3. 규약 준수 — PASS
- 사용자 문구 전부 `T(ko,en)`. 하드코딩 영어는 컬럼코드(`COURSE (EN)`, `CN/JP/…`, `BASE/KRW/USD/JPY`) 뿐 — 번역 대상 아님.
- 사용 클래스: `ph/sub/url/actions/btn/chips/chip/chip on/filters/field/field grow/twrap/table.grid/mono/card pad/banner/pill good/pill warn/cch cap/tr.grp` —
  **모두 `deploy/index.html` 에 이미 존재**(확인: `.chip.on` 168행, `table.grid tr.grp td` 187행, `.pill.good/.warn` 218/219행, `.cch.cap` 224행, `.filters .grow` 148행). **새 CSS 요구 없음.**
- CSS 변수 `--dim/--faint/--good/--warn/--neutral/--surface-2` 전부 존재(23·26행).
- `makeSortable` 은 `renderMain()` 2850행에서 `#main` 전체에 이미 걸리므로 렌더러가 따로 부를 필요 없음.
  `.grp` 행은 `makeSortable`(1326행)·`exportGridXls`(필터 `!r.classList.contains('grp')`)가 이미 제외 처리 — 확인함.

### 4. 무데이터 안전성 — PASS (node 스모크 실제 실행)
`esc/T/campusChipName` 만 스텁하고 렌더러를 `eval` 로 떼어 호출:
- `REAL=null` → 예외 없이 안내 카드 폴백 ✅
- `REAL={}` (조각 없음) → 폴백 ✅
- `REAL.courses={cats:[],rows:[]}` → 폴백 ✅
- `R.courses__init()` 도 `REAL=null`/DOM 없음 상태에서 예외 없이 즉시 return ✅
- 데이터 주입 후 필터 3종 + Clear 까지 예외 없이 동작(상태 Y → 그룹헤더 1 + 행 1, 조건 불일치 → "No courses match" 행) ✅

### 5. XSS — PASS (1건 수정)
DB 유래 문자열 전부 `esc()` 경유(`ko/en/info/campus 미지값/cat name/cat gid`). `<camp>&` 입력이 `&lt;camp&gt;&amp;` 로 나오는 것 확인.
숫자 컬럼은 `+v` 강제 후 `toLocaleString()` → 주입 불가. `title` 속성값도 숫자만.
**수정**: 검색 input 의 `value="…esc(courseFilter.q)…"` — 기존 `esc()` 는 `"` 를 변환하지 않아 속성 탈출 여지가 있었다(self-XSS 급).
`esc(q).replace(/"/g,'&quot;')` 로 보강(공용 `esc()` 는 건드리지 않음 — 기존 화면과의 호환 유지).

### 6. PII — PASS
`information_schema` 로 두 테이블 컬럼 전량 확인: `g_idx,g_name,g_display,g_order,g_type` /
`i_idx,g_idx,i_name,i_name_en,i_limit,c_order,i_pay,i_pay_{cn,jp,tw,vt,ru,sa,mgl,etc},i_info,i_state,g_type,s_campus`.
**비밀번호·주민번호·연락처 등 개인정보 컬럼이 애초에 없음.** 학생/회원 테이블 join 도 없음 → `scope.agency` 무제한 허용 판단 타당.

### 7. 중복(헬퍼 재구현) — PASS
`esc/T/campusChipName/makeSortable/exportGridXls/paintPaged/renderMain` 재구현 없음. 71행이라 `paintPaged` 불필요(전량 렌더가 맞음).
`courseNameOf/courseActiveOf/courseInMaster/courseAllCodes`(2700~2703행)도 재구현하지 않음.
식별자 충돌 재검증: `courseFilter/CO_*/co*()/MAX_COURSES/R.courses` 를 `deploy/index.html`·`deploy/api/data.js` 에 grep → **0건**.

### QA 수정 내역 (4건)
1. **[치명] `colspan` 불일치** — `coBody()` 가 그룹헤더·"결과 없음" 행에 `colspan=5+9=14` 를 썼지만
   실제 컬럼은 **17개**(`# KO EN LIMIT` 4 + 가격 9 + `캠퍼스 상태 순서 비고` 4). 표가 어긋나 렌더링이 깨졌다.
   → 상수 `CO_SPAN = 8 + CO_PAY.length` 를 도입해 두 곳 모두 교체. 스모크로 `th=17`, 모든 `colspan=17` 확인.
2. **엑셀 헤더 깨짐** — 가격 헤더가 `BASE<br><span>KRW</span>` 라 `exportGridXls` 의 `textContent` 가 `BASEKRW` 로 붙었다.
   → 라벨 뒤 공백 1칸 추가(`BASE <br>…`) → `BASE KRW`.
3. **속성 이스케이프**(§5) — 검색 input `value` 에 `&quot;` 처리 추가.
4. **loader 스타일 정합 + O(n²) 제거** —
   - `courses.api.js` 가 `cats.rows` / `rows.rows` 로 result 객체를 그대로 들고 다녔다 → 기존 loader 관례대로
     `const { rows: catRows } = await q(...)` / `const { rows: courseRows } = await q(...)` 로 구조분해.
   - `coBody()` 가 그룹별 개수를 행마다 `rows.filter(...)` 로 재계산했다(O(n²)) → 1패스 `cnt{}` 집계로 교체.
   - `d.cats` 가 없어도 안전하도록 `(d.cats||[]).forEach`.
5. **문서 정정 2건** —
   - `R.commrules__init` 은 "특수 배선"이 아니라 **아무 데서도 호출되지 않음** → `__init` 일반화는 **필수**(§4-1에 실제 삽입 코드 명시).
   - `loadStamp` 권고를 확정안으로 교체: `max(i_idx)` 는 가격 수정을 못 잡으므로 **`md5(string_agg(i_idx|i_state|i_pay|i_name order by i_idx))` 채택**(실측 0.143s).

### 미수정(의도된 동작으로 확인)
- `campOpts` 에 실데이터 0건인 `E`(CLASSIC)를 남김 — 코드사전 전체 노출이 레거시/운영 관점에서 유용.
- `i_limit` 전 행 0 → `—` 표시. 레거시와 동일하므로 컬럼 유지.
- 정렬 후 필터 리페인트하면 정렬 화살표가 남는다(그룹헤더는 복원됨) — 기존 화면들과 동일한 수준의 한계.
- `pill`/`cch` 배지에 인라인 `background:var(--neutral)`(ALL 캠퍼스) — 새 CSS 클래스를 만들지 않기 위한 의도적 인라인.
