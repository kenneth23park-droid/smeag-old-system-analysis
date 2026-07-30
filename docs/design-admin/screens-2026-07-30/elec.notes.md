# elec — ELEC & WATER (room_elec.php) 구현 노트

산출물: `elec.render.js` (R.elec / R.elec__init), `elec.api.js` (loadElecMeter + 배선 지침), 이 파일.
`node --check` 두 파일 모두 통과.

## 1. 레거시 화면 재현 근거 (exploration/shots/room_elec.php.png)

레거시는 **폼만 있고 결과가 없는 3섹션 안내 화면**이다("FIRST! SELECT DATE and SEARCH BUTTON CLICK!" ×3).
폼(`fsearch`, GET)과 신전산 대응:

| 레거시 입력 | 값 | 신전산 |
|---|---|---|
| `s_date`,`e_date` (PERIOD) | YYYY-MM-DD | `#elFrom`/`#elTo` + 프리셋(데이터 최신월/지난달/최근3개월) → API `elecFrom`,`elecTo` |
| `search_condition` (CONDITION) | `''`=ALL DORM, `S`=ENCANTO, `C`=CLASSIC, `E`=CAPITAL | `#elCampus` — **값이 그대로 `room_info.bldg_type`/`room_category.bldg_type`** (실측 확인) |
| `search_condition2` | `''`=ALL, `S`=STUDYING, `G`=GRADUATING | **미구현(의도적)**. 학생 재학상태 필터인데 `room_elec` 에 학생키가 없다 → 대신 의미 있는 `#elSt` **검침상태**(ALL/METERED/MISSING/CHECK) 로 대체. 학생단위 청구는 §5 참조 |
| `s_gdate`,`e_gdate` | 졸업일 범위 | 미구현(같은 이유) |
| `stx` (NAME) | 학생명 | `#elQ` — **방번호·방구분·입력자** 검색으로 대체(학생명은 이 테이블에 없음) |
| `search_mode=Y` | — | `#elSearch` 버튼 |

3섹션 매핑:
- ① "ELEC GAGE LIST CHECK and INSERT(일자별 계량기 측정 조회 및 입력)" → **방별 검침 표**(메인 그리드) + 행 클릭 시 **일자별 검침 추이**(막대+표). 입력(INSERT)은 쓰기라 이번 단계 제외 — 원본 불가침 규약.
- ② "STUDENT ELEC and WATER BILL(월별 학생 기숙사 이용 현황 및 수도/전기요금 정산)" → **방구분별 정산 롤업**(방수/검침방/사용량/점유비중/평균인원/1인당/요금합계).
- ③ "SEARCH STUDENT ELEC and WATER BILL" → 위 검색·필터 바(같은 표를 좁혀 보여주는 구조).

## 2. 컬럼 매핑

`legacy.room_elec` (실측 컬럼: re_idx int, i_idx int, re_date varchar, re_gage int, p_count int, charge_gage float8, re_state varchar, id_updater varchar, update_timestamp timestamptz)

| 화면 컬럼 | 산출식 |
|---|---|
| ROOM / CATEGORY / CENTER / LIMIT | `room_info.i_name` / `room_category.g_name` / `bldg_type`→캠퍼스 / `i_limit` |
| READINGS | `count(*)` (기간 내 행수) `/ 기간일수` |
| FROM·TO | `min/max(re_date)` (re_gage>0 인 행 기준) |
| GAGE FROM·TO | 첫/마지막 **양수** `re_gage` |
| **USE (kWh)** | `sum(clamp(delta, 0..2000))`, `delta = re_gage - lag(re_gage) over (i_idx, re_date, re_idx)` |
| /DAY | USE / (검침일수-1) — 클라이언트 계산 |
| AVG P | `round(avg(nullif(p_count,0)),2)` |
| PER P | USE / AVG P — 클라이언트 계산 |
| CHARGE | `round(sum(charge_gage),2)` |
| LAST BY / AT | `update_timestamp` 최신행의 `id_updater` / `max(update_timestamp)::date` |
| CHECK 배지 | delta > 2000 또는 delta < 0 건수 > 0 |

### 사용량 계산을 "끝검침 − 시작검침" 으로 하지 않은 이유 (중요)
브리프는 `사용량 = 끝-시작` 이지만 실측에 **계량기 교체/오타 값**이 있다.
예: i_idx=397(방 508), 2026-01~07 → 시작 10,569 / 끝 **112,042** → 끝-시작 = 101,473 kWh (물리적으로 불가).
같은 방의 최대 일증가분이 100,010 → 단일 오타행 때문. 2026-01~07 전체 34,816개 delta 중
`delta>2000` 이 **2건**, `delta<0` 1건, 정상 delta 최대값은 **227**(Dinning 공용 계량기).
→ delta 합산 + 상한 2000 클램프가 훨씬 안전하고, 정상 방에서는 끝-시작과 동일하다.
`g0/g1`(시작·종료검침)은 그대로 함께 반환하므로 오케스트레이터가 원하면 화면에서 끝-시작을 다시 계산 가능.

### 캠퍼스 매핑
`migration/build_roomstat_real.py` 에는 `campusOf` 가 없다(그 이름의 로직은 `deploy/index.html:1499` 의
`campusOf`). 다만 이 화면은 **문자열 휴리스틱이 필요 없다** — 레거시 `search_condition` 값이 곧 `bldg_type`
이므로 `E→CAPITAL, S→ENCANTO, C→CLASSIC, 기타→ETC`(`elecCampus`)로 직접 매핑했다.
표시는 기존 `campusChipName()` 재사용. 참고: index.html 의 `campusOf` 는 `CASABLU→ENCANTO` 같은
예외를 이름으로 처리하는데, bldg_type 은 그런 예외 없이 정확하다.
실측: 2026-07 검침 대상 433방 = bldg_type `E` 345방 + `S` 88방 (CLASSIC/SPARTA 방은 현재 검침 없음).

## 3. 실측 수치 (전부 실제 쿼리 실행)

```
legacy.room_elec           1,670,841행, 268 MB, re_date '2006-06-22' ~ '2026-07-13'
re_date 형식오류(비-YYYY-MM-DD) 0행  · re_state 전량 ''(빈값, 필터 무의미)
legacy.room_info           1,127행 (i_state='Y' 836 / 'N' 291)
   bldg_type: Y-E 346, Y-F 205, Y-C 197, Y-S 88 / N-E 139, N-F 54, N-C 53, N-S 32, N-P 13
legacy.room_category       g_display='Y' 그룹만 화면 기본노출 대상
월별 행수(2026): 01 8,889 / 02 8,162 / 03 9,137 / 04 8,750 / 05 9,347 / 06 9,177 / 07 3,778(13일까지)
   distinct 방수 403~433
id_updater(2026-06 이후): capital1 10,007 · encanto1 2,948  (계정 2개)
연도별 재검: 2026 57,240행 중 re_gage>0 34,816 / charge_gage≠0 30,615 / p_count>0 33,895
   → 검침값 0 인 행이 상당수(약 40%) 존재. 그래서 g0/g1·delta 는 re_gage>0 행만 사용.
```

**loadElecMeter 실행 결과 (2026-07-01 ~ 2026-07-31, 파일의 SQL 그대로 실행)**
```
반환 836행 · 1,985 ms
1위 행: idx=1200 room='Dinning' grp='CAPITAL(O)_M' bldg=E days=13/31 d0=2026-07-01 d1=2026-07-13
        g0=60559 g1=61694 used=1135 spikes=0 avgP=null charge=0.00 lastBy=capital1 lastAt=2026-07-13
꼬리 행: idx=581 room='Z-000' grp='SPARTA(O)_M' bldg=F days=0 (검침 누락)
합계: used 19,792 kWh · charge 8,038.20 · 검침누락 403방 · CHECK 0방
```
**일자별 조각 (elecRoom=331, 방 '319')**: 13행 · 1,208 ms
`[('2026-07-01',23774,4,8.0,'capital1'),('2026-07-02',23804,4,7.5,...),...]`

**최신 검침일 조회**: `max(re_date)` 직접 = 1,082 ms → `pkey 역순 5,000행 서브쿼리 안의 max` = **179 ms**, 값 동일(`2026-07-13`). 후자를 채택(`elecLatestDate`).

## 4. 성능 · 인덱스 (EXPLAIN ANALYZE 확인)

- **room_elec 의 인덱스는 `room_elec_pkey(re_idx)` 뿐.** `re_date` 인덱스 없음, `(i_idx,re_date)` 인덱스 없음
  (`pg_indexes` 조회 결과: room_elec_pkey / room_info_pkey / room_category_pkey — 그게 전부).
- 그래서 기간 필터는 **Parallel Seq Scan**: `Buffers: shared hit=1312 read=28400` (약 222 MB 읽음), 886 ms~1.4 s.
- 기간 폭과 무관하게 seq scan 비용이 지배적 → 1개월/7개월 모두 1.3~2.0 s.
- **전기간(2006~2026) 집계는 18,575 ms** → data.js 의 `statement_timeout: 20000` 에 걸릴 위험.
  그래서 `MAX_ELEC_SPAN_DAYS = 400` 으로 서버에서 기간을 클램프한다(to 기준 역산). 이 상한은 지키는 게 좋다.
- 단일 방 일자별 조회도 seq scan(1.2 s) → **메인 집계와 같은 요청에 묶어** 왕복을 1회로 유지(loadElecMeter 이 daily 를 함께 반환).

**인덱스 제안 (DDL 실행하지 않음 — 제안만)**
```sql
-- 이 화면의 모든 쿼리를 index range scan 으로 바꾼다. 예상 효과 1.4s → 수십 ms.
CREATE INDEX CONCURRENTLY room_elec_date_idx  ON legacy.room_elec (re_date);
CREATE INDEX CONCURRENTLY room_elec_room_date ON legacy.room_elec (i_idx, re_date);
-- 커버링까지 원하면:
-- CREATE INDEX CONCURRENTLY room_elec_date_cov ON legacy.room_elec (re_date) INCLUDE (i_idx, re_gage, p_count, charge_gage);
```
인덱스 2개 추가 시 대략 +50 MB. `re_date` 가 varchar(10) 이지만 'YYYY-MM-DD' 고정폭이라 문자열 범위비교가 날짜 순서와 일치(형식오류 0행 실측) → 캐스팅 없이 그대로 인덱스가 쓰인다.

## 5. 상한 · 제약

| 항목 | 값 | 근거 |
|---|---|---|
| 메인 응답 행수 | ≤ 1,127 (실측 836) | `room_info` 전체가 상한. `where a.i_idx is not null or ri.i_state='Y'` |
| 기간 상한 | 400일 | 전기간 집계 18.5s > statement_timeout 20s |
| 일자별 추이 | 800행 | `ELEC_DAILY_MAX` |
| delta 상한 | 2,000 | 정상 최대 관측 227, 오타는 10,000 이상 |
| 응답 크기 | 약 250 KB (836행 × 21필드) | 원본 대비 1/2000 |

- **학생 단위 청구(레거시 §2·§3 원래 의도)는 이번 단계에서 방 단위까지만.** `room_elec` 에 `s_idx`
  컬럼이 없어서(실측 9컬럼 전량 확인) 학생별 전기·수도료는 `room_reserve`(방×침대×일자 점유) 와
  일자 단위로 조인해 `charge_gage` 를 인원 분배해야 한다. 그건 배치도(roomstat)와 같은 무거운 조각을
  또 끌어야 하므로 2단계로 분리했고, 화면 §2 카드에 그 사실을 문구로 명시했다.
- `re_state` 는 전량 빈 문자열 → 상태 필터로 쓸 수 없음(확인 후 배제).

## 6. 유학원 계정 스코프(scope.agency) 판단

**적용하지 않는다.** 근거: (1) `room_elec` 은 방 계량기 검침값·인원수만 있고 학생 식별정보가 전혀 없다
(s_idx/이름 컬럼 부재) → PII 아님. (2) 레거시에서도 Dormitory 카테고리 메뉴이며 유학원 포털
(`student_present2*`)에는 존재하지 않는다. 대신 **부하가 큰 조각**이므로 DEPTS 기준
`dorm_dept`/`director` 만 접근하도록 메뉴 카테고리를 `dorm` 으로 두는 것으로 통제한다.

## 7. 오케스트레이터 배선 체크리스트

1. **메뉴**: `MENU.dorm` 의 `{k:'spec',t:'ELEC&WATER',u:'room_elec.php',...}` → `{k:'elec', t:'ELEC&WATER', u:'room_elec.php'}`
   (레거시 사이드바 라벨은 `ELEC&WATER`).
2. **LIVE_PARTS**: `elec:['elec']` 추가. 학생 데이터는 필요 없다(무겁게 만들지 말 것).
   `LIVE_PARTS_URL['room_elec.php']=['elec']` 도 함께 넣으면 spec 폴백 경유 시에도 안전.
3. **liveHave**: `if(p==='elec')return !!(REAL.elec&&REAL.elec.rows);` 추가.
4. **liveSync 의 qs 조립에 한 줄** (기간/방 파라미터를 elecState 에서 읽어 붙인다 — `roomstat` 의 month 처리와 동일 패턴):
   ```js
   if(need.includes('elec')){qs.set('elecFrom',elecState.from||'');qs.set('elecTo',elecState.to||'');
                             if(elecState.room)qs.set('elecRoom',elecState.room);}
   ```
   그리고 응답 반영: `if(j.elec)REAL.elec=j.elec;`
   ⚠️ `liveSync` 의 `need` 계산은 TTL 기준이라 기간만 바꿨을 때 재조회가 안 될 수 있어
   `R.elec__init` 은 항상 `liveSync({parts:['elec'],force:true})` 로 호출한다. 그대로 두면 된다.
   (원하면 `LIVE.ttls.elec=0` 로 두어도 됨.)
5. **liveInvalidate**: elec 은 파생 캐시를 만들지 않으므로 손댈 것 없음.
6. **data.js**: `elec.api.js` 의 상수 4개 + `elecCampus`/`elecRange`/`elecLatestDate`/`loadElecMeter` 를 붙이고,
   파일 하단 주석의 5단계(ALL_PARTS·파라미터 파싱·version 캐시키·parts 분기·스코프)를 그대로 적용.
   `elecRange` 는 data.js 의 기존 `ymd()` 헬퍼를 쓴다(이미 있음).
   `export const maxDuration = 30;` 은 그대로 충분(최악 2s + latest 0.2s).
7. **엑셀**: 메인 그리드가 `#main` 의 첫 `table.grid` 라서 기존 `exportGridXls` 가 그대로 동작한다
   (`data-tblexcel="ELEC_WATER"`). 롤업/일자별 표를 따로 내보내려면 별도 버튼이 필요.
8. **CSS**: 새 클래스·새 CSS 규칙 **추가 불필요**. 재사용한 것만 씀 — `ph/sub/url/actions/chips/chip/filters/field/grow/dl-chk/twrap/grid/mono/card pad/h3/banner/pill return/cch(campusChipName)`.
   `.grow`(148행)·`dl-chk`(150행)·`.pill.return`(221행) 존재 확인함. 선택행 강조는 전용 클래스가 없어
   인라인 스타일(`var(--surface-2)`+`var(--accent-ink)`)로 처리했다. 막대그래프도 인라인 SVG 없이 div 폭으로만 구현(외부 라이브러리 0).

---

## QA 결과 (리뷰어 검증 · 2026-07-30)

**판정: PASS** (아래 7건 직접 수정 후). 프로젝트 파일은 하나도 건드리지 않았다
(`git status` = 착수 시점과 동일: `M deploy/index.html`, `M docs/design-admin/prototype.html`, `?? exploration/_v6~8.js`).
DB 는 select 만 실행했다(DDL/DML 0건).

### 1) 문법 — OK
`node --check elec.render.js` / `node --check elec.api.js` 모두 통과. 템플릿 리터럴 미사용(전부 문자열 연결)이라 중첩/따옴표 깨짐 없음.

### 2) SQL 실사 — 전부 실제 실행, 에러 0, 상한 내
| 쿼리 | 파라미터 | 시간 | 행수 |
|---|---|---|---|
| `elecLatestDate` (pkey 역순 5,000행 서브쿼리) | — | **237ms** | 1 (`2026-07-13`) |
| `loadElecMeter` main (방 단위 집계) | `2026-07-01~31`, spike 2000 | **1,579ms** | **836** |
| `loadElecMeter` main (400일 클램프 최악값) | `2025-06-27~2026-07-31` | **1,681ms** | **836** |
| `loadElecMeter` daily (방 i_idx=397) | 2026-07 | **940ms** | 13 |
| 형식오류 `re_date !~ '^\d{4}-\d{2}-\d{2}$'` | — | 2,547ms | **0행** |
| 고아 `i_idx`(room_info 미존재, 최근 400일) | — | 1,034ms | **0행** |

- 한 요청 최악 = latest(0.24s) + main(1.7s) + daily(0.94s) ≈ **2.9s** < `statement_timeout` 20s, `maxDuration` 30s. **> 2초 쿼리는 없음**(개별 기준).
- 반환 상한 재확인: 방 단위 836행(최대 1,127) / daily ≤ 800행. 167만 행 원본은 전송되지 않음.
- **인덱스 없음 확인**(`room_elec_pkey` 유일) → 모든 조회가 Parallel Seq Scan. notes §인덱스 제안(2건)은 DDL 미실행 상태 유지가 맞다.

### 3) 규약 준수 — OK (수정 없음)
- 사용자 문구 전량 `T('한글','English')`. 예외는 고유명사·단위·컬럼명뿐(`kWh`, `CHECK`, `charge_gage`, `ENCANTO/CLASSIC/CAPITAL`, `📊 EXCEL`).
- 마크업: `ph/sub/url/actions/chips/chip/filters/field/grow/dl-chk/twrap/grid/mono/card pad/h3/banner/pill return` — **전부 deploy/index.html 에 이미 존재**(`.grow` 148행, `.dl-chk` 150행, `.h3` 236행, `.pill.return` 221행). **새 CSS 요구 0건.**
- 헬퍼 재사용 확인: `esc` / `T` / `campusChipName`(959행) / `makeSortable`(1316행) / `liveSync` / `renderMain` / `i18nApply` / `exportGridXls`(1348행, `data-tblexcel` 자동배선 2849행). 중복 재구현 없음 — `mmShift`/`mmRange` 는 index.html 에 대응 헬퍼가 없어(월 연산은 `roomCenter` 인라인 처리뿐) 신규 정의가 맞다.
- `data-tblname` 속성은 `exportGridXls` 가 쓰지 않지만(첫 `table.grid` 만 대상) 무해해 유지.

### 4) 무데이터 안전성 — OK (node 스모크 11케이스 전부 무예외)
`REAL` 미정의 / `REAL=null` / `REAL={}` / `REAL.elec={}` / `rows:[]` / `rows:[] + window 없음` / 값이 전부 null 인 1행 / 상세패널 로딩중 / 상세패널 데이터 / `__init` 에 `#main` 없음 → **전부 정상 반환**, 앞 4케이스는 안내 카드(401자)로 폴백.

### 5) XSS — OK
DB 유래 문자열(`room/grp/lastBy/lastAt/d0/d1/date/by/o.grp`) 전부 `esc()` 경유. `<img src=x onerror=…>` / `"><script>` / `'--><svg onload=1>` 를 주입한 스모크 케이스에서 원본 HTML 유출 **0건**. 숫자 필드는 loader 에서 `Number()` 로 강제. `campusChipName` 인자는 서버 고정 상수맵 값만 들어간다.

### 6) PII — OK
`room_elec` 컬럼 9종 실측(`re_idx,i_idx,re_date,re_gage,p_count,charge_gage,re_state,id_updater,update_timestamp`) — 비밀번호·주민번호·여권·학생키 없음. `room_info`/`room_category` 에서도 `i_pay*`(요금표) 같은 비민감 컬럼만 선택. 응답에 나가는 유일한 인적 식별자는 `id_updater`(직원 계정 ID, 관리자 전용 화면) → 허용. `scope.agency` 미적용 판단(§6) 유지.

### 7) 중복 — 없음 (§3 참고)

---

### 리뷰어가 직접 고친 7건

| # | 파일 | 문제 | 조치 |
|---|---|---|---|
| 1 | `elec.api.js` | `elecCampus` 가 `bldg_type` 실측 5종 중 **F(SPARTA)·P(PREMIUM)** 를 몰라 `ETC` 로 표시. `i_state='Y'` 836방 중 **F 가 205방**(C 197 / E 346 / S 88) → 활성 방의 24%가 센터 미상. | `ELEC_CAMPUS` 에 `F:"SPARTA", P:"PREMIUM"` 추가 |
| 2 | `elec.render.js` | 같은 이유로 CONDITION 셀렉트(레거시 `search_condition` 4옵션 그대로)로는 SPARTA 205방을 걸러낼 수 없음 | `F(SPARTA)`·`P(PREMIUM)` 옵션 2개 추가 (레거시 대비 **의도적 확장** — 크롤 결과 `crawl_results.json/results[31]` 로 레거시 옵션이 ''/S/C/E 4개뿐임을 확인한 뒤 결정) |
| 3 | `elec.api.js` | `elecRange(from,to)` 가 비YMD/빈 문자열 입력을 검증하지 않아 `Date.parse`→`NaN`→클램프 무력화 | data.js 기존 `isYmd`/`ymd` 로 정규화 + 한쪽만 있을 때 보정. `('','')→오늘`, `('xx','yy')→오늘`, 역순 입력 자동 교정, `2006~2026 → 2025-06-27~2026-07-31` 클램프 동작 확인 |
| 4 | `elec.render.js` | **기간 클램프 피드백 누락** — 사용자가 전기간을 넣으면 서버는 400일로 줄여 집계하는데 화면 입력칸은 원래 기간을 계속 보여줘 실제 조회구간과 어긋남 | `elecState.from/to` 를 항상 서버가 돌려준 `E.window` 로 스냅 |
| 5 | `elec.render.js` | `E.window` 가 없을 때 `days` 가 `NaN` → 검침일수 셀이 `13 / NaN` | `spanD` 유한성 검사 + `days` 0 이면 분모 표기 생략. 스모크로 `NaN` 미출력 확인 |
| 6 | `elec.render.js` | 사용량 셀 안에 `CHECK` 배지가 있어 `makeSortable` 이 `"345 CHECK"` 를 문자열로 판정 → **사용량 컬럼 숫자정렬 파괴**(핵심 컬럼) | `CHECK` 배지를 방번호 셀로 이동. 사용량 셀 textContent 는 순수 숫자 |
| 7 | `elec.render.js` / `elec.api.js` | (a) 검색 필터가 `r.room+' '+r.grp+' '+r.lastBy` 로 null 을 `"null"` 문자열화 (b) `elecDetailHtml(E, rows)` 의 미사용 인자 (c) 배선 주석이 `elecLatestDate` 를 요청당 2번 호출 | (a) `||''` 널가드 (b) 인자 제거 (c) `const last = await elecLatestDate(q)` 1회 호출 후 재사용하도록 주석 수정 |

### 남은 알려진 제약(수정 안 함 — 의도된 것)
- **페이지네이션 없음**: 836행 × 17컬럼을 한 번에 그린다. `paintPaged` 를 쓰면 `exportGridXls` 가 렌더된 tbody 만 읽으므로 EXCEL 이 현재 페이지만 나간다 → 전체 내보내기를 지키려고 단일 그리드 유지. (회원·커미션과 달리 elec 은 규약상 페이지네이션 필수 목록이 아님.)
- **행 클릭 1회당 ~2.6s**: main 재집계 + daily 가 같은 요청에 묶여 있어서다. `re_date` / `(i_idx,re_date)` 인덱스가 생기면 사라지는 비용 → notes 의 `CREATE INDEX CONCURRENTLY` 2건은 DBA 승인 후 별도 반영 권장.
- **학생 단위 청구 미구현**(§5) 및 `search_condition2`/`s_gdate`/`stx` 미구현 — 2단계.

### ⚠️ 통합 차단 이슈 (QA 중 발견 — 오케스트레이터 필독)
리뷰 도중 `deploy/api/data.js` 가 **다른 작업분에 의해 병렬로 수정**되어(`git status`: `M deploy/api/data.js`,
`M deploy/m/index.html`, `?? deploy/api/blocks.js` 가 새로 생김) 다음 충돌이 생겼다:

- data.js 682행 `TABLE_LOADERS = { …, elec: loadElec, … }` / 701행 `ALL_PARTS` 에 `"elec"` / 그리고
  **`async function loadElec(q)` 가 이미 정의되어 있다**(room_elec 원본 최근 `MAX_TABLE_ROWS=500`행을
  `out.tables["room_elec.php"]` 로 내리는 spec 폴백 블록, `ELEC_COLS` 10컬럼).
- 우리 loader 를 그대로 붙이면 **top-level 함수 이름 중복 → ESM SyntaxError → `/api/data` 전체가 500**.
- 조치: 이 조각의 loader 이름을 `loadElec` → **`loadElecMeter`** 로 변경했다(파일 상단에 경고 블록 추가).
- 통합 시 택1:
  - **A(권장)** `ELEC_COLS`·기존 `loadElec`·`TABLE_LOADERS.elec` 3개를 삭제하고 part `"elec"` 을
    `out.elec = await loadElecMeter(...)` 로 넘긴다. 전용 렌더러가 spec 폴백을 완전히 대체하므로
    원본 500행 블록은 어차피 죽은 코드가 된다. → 위 체크리스트 1~7 그대로 적용 가능.
  - **B** 둘 다 유지하려면 part 이름을 `"elecmeter"` 로 바꾸고 `R.elec__init` 의
    `liveSync({parts:['elec'],force:true})` · `LIVE_PARTS.elec` · `liveHave` · `qs` 분기 4곳을 전부 맞춰야 한다.
