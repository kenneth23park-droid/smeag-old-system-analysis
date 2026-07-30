# COMMISSION (`uhak_agency_commission.php`) — 렌더러 키 `commission`

소스: `legacy.uhak_agency_com` (4,004행) ⨝ `cms.g4_member` (`mb_id` 기준, 유학원명)
산출물: `commission.render.js` / `commission.api.js` / 본 문서
`node --check` 두 파일 모두 통과. SQL 은 실 DB 에서 실행 검증(아래 수치는 전부 실측).

---

## 1. 실측 (읽기 전용 쿼리 결과)

### 행수·분포
| 항목 | 실측 |
|---|---|
| 전체 행수 | **4,004** |
| distinct `mb_id` (유학원 계정) | **1,725** |
| `nowYN='Y'` (현재 유효계약) | **1,734** |
| `com_category` | `amount` **2,305** / `percent` **1,699** |
| `state` | `E` **2,266** / `N` **1,738** |
| `agree` | `Y` **3,999** / `N` **5** |
| `nowYN` | `N` **2,270** / `Y` **1,734** |
| `payYN` | `N` **4,004** (전량 동일 → 무의미) |
| `check_date` (등록일) | 4,004/4,004 이 `YYYY-MM-DD` 형식. 범위 **2011-08-10 ~ 2026-07-10** |
| `confirm_date` (확인일) | 값 있음 2,006 / 그중 형식정상 1,998 (나머지는 `''`) · 범위 2011-09-02 ~ 2026-07-10 |
| `content`(사유) | 비어있음 3,400 (85%) |
| `g4_member` 조인 성공 | 3,994 / 4,004 행 (유학원 계정 **9개**가 g4_member 에 없음 → `mb_id` 로 폴백 표시) |
| 연도별 등록 | 2011:220, 2012:662, 2013:361, 2014:208, 2015:323, 2016:409, 2017:471, 2018:246, 2019:302, 2020:54, **2021:0**, 2022:128, 2023:168, 2024:206, 2025:160, 2026:86 |

### ⚠ 전량 미사용 컬럼 (화면·API 에서 제외한 근거)
| 컬럼 | 실측 |
|---|---|
| `uhak_idx` | distinct **1** — 전부 `''` |
| `percent` | `''` **4,004/4,004** (정율값이 여기 없음!) |
| `before_percent` | `'0'` **4,004/4,004** (변경 전 값 추적 불가) |
| `end_date` | `null` **4,004** |
| `student` | `null` **4,004** (메뉴 정의의 '학생' 컬럼은 데이터가 없음) |
| `payYN` | `'N'` **4,004** |

→ **계약값은 `com_amt` 한 칸에만 있다.** `com_category='percent'` 면 그 값이 %(예 `30`),
`com_category='amount'` 면 금액(예 `500000`). 화면에서 `%`/`금액` 두 칸으로 분리해 표시한다.

값 범위(숫자만 남겨 캐스팅):
- `amount`: min 0 / max **560,000** / avg 336,773
- `percent`: min 0 / max **3,000,000** ← 이상치. 정율칸에 금액이 잘못 입력된 행 존재(레거시 입력오류, 원본 불가침이라 보정하지 않고 그대로 표시)

`com_amt` varchar 잡값 **3건**: `'26%'`, `'300,000'` 형태 → `regexp_replace(...,'[^0-9.]','','g')` 로
숫자 칸을 만들고, 원문은 `AMOUNT_RAW`(인덱스 14)로 함께 실어 화면이 캐스팅 실패 시 원문을 노출한다.

### 코드값 의미표
| 컬럼 | 값 | 의미 | 근거 |
|---|---|---|---|
| `com_category` | `percent` | 정율 계약 (학비의 %) | `com_amt` 값이 25/30 등 소수 |
| | `amount` | 정액 계약 (건당 금액, 원화 추정) | `com_amt` 값이 200000/500000 등 |
| `state` | `N` | **신규 체결** | `content` 에 `'커미션인상'` 이 붙는 비율이 낮고(94건), 유학원 이력의 첫 행에 주로 나타남 |
| | `E` | **변경/인상** | `content='커미션인상'` **310건**, `'최초적용'`,`'for new price'`,`'동반유학원 체결'` 등 변경사유가 몰려 있음 |
| `agree` | `Y` | 유학원 동의 완료 (3,999) | |
| | `N` | 미동의 (5건, 전부 `testuhak*` 테스트 계정) | |
| `nowYN` | `Y` | **현재 유효 계약** — 이 화면 상단 요약표의 필터 | |
| | `N` | 과거(대체된) 계약 | |
| `payYN` | `N` | 전량 동일 → 의미 없음 (미사용 플래그) | |

`state` 의 N/E 는 레거시 PHP 소스가 저장소에 없어 **데이터 정황 기반 추정**이다.
화면 라벨은 `N · NEW`, `E · CHANGE` 로 코드값을 항상 함께 노출해 오해를 막았다.

### `nowYN` 의 성질 (중요)
- `nowYN='Y'` 는 **최신 `no` 가 아니다.** 예: `mb_id='bonbon'` 6건 중 `no=4020` 만 `Y`,
  더 큰 `no`(4021~4025)는 모두 `N`.
- `nowYN='Y'` 행의 **1,696/1,734 가 `confirm_date` 를 가짐**(`nowYN='N'` 은 310/2,270).
  → 실무상 "확인(승인)된 계약이 현재계약" 으로 굳는 흐름. 다만 완전 일치는 아니므로
  화면은 **`nowYN` 만을 현재계약 판정 기준**으로 쓴다(파생 재계산 금지).
- 유학원별 `nowYN='Y'` 개수: 1건 **1,695곳**, 2건 **18곳**, 3건 **1곳**.
  현재계약이 없는 유학원 **11곳**.
  → 임의로 하나만 고르지 않고 전부 표시하며, 상단 칩에 `▲ 현재계약 중복 유학원 19` 경고만 띄운다.

### g4_member 레벨 분포(참고, distinct mb_id 기준)
`mb_level=5` 1,438곳 · `3` 259곳 · `1` 18곳 · `7` 1곳 · g4_member 미존재 9곳.
→ 유학원 계정은 대부분 Lv5 이하 = `data.js` 의 `scope.agency` 판정(Lv8 미만) 대상.

---

## 2. 컬럼 매핑 (메뉴 정의 → 렌더링)

메뉴 정의: `['NO','UHAK','구분','%','금액','담당','확인일','상태','학생']`

| 메뉴 컬럼 | 소스 | 화면 처리 |
|---|---|---|
| NO | `uhak_agency_com.no` | 그대로(mono) |
| UHAK | `g4_member.mb_name` (없으면 `mb_nick`, 없으면 `mb_id`) | 별도 `ID` 컬럼으로 `mb_id` 도 노출 |
| 구분 | `com_category` | `PERCENT (%)` / `AMOUNT` |
| % | `com_amt` (단, `com_category='percent'` 인 행만) | `30%` |
| 금액 | `com_amt` (단, `com_category='amount'` 인 행만) | `500,000` 천단위 |
| 담당 | `manager` | 실측 상위: Joon(cebusme) 2,108 / Owen(cebusme) 541 / 이진환 403 … (동일인 표기 난립, 정규화 안 함) |
| 확인일 | `confirm_date` | 형식검증(`D()`) 후 `YYYY-MM-DD`, 없으면 `—` |
| 상태 | `state` | `N · NEW` / `E · CHANGE` |
| 학생 | `student` | **전량 null → 화면에서 제외**(빈 컬럼 대신 배너로 사유 명시) |
| (추가) 등록일 | `check_date` | 기간 필터 기준 컬럼 |
| (추가) 유효 | `nowYN` | 상단 요약표 필터 + 이력표 컬럼 |
| (추가) 동의 | `agree` | Y/N |
| (추가) 사유 | `content` | 인상/변경 사유(85% 비어있음) |

행 배열 인덱스(`CM_I`, render/api 1:1):
`0 NO · 1 AGENCY_ID · 2 AGENCY · 3 CATEGORY · 4 PERCENT · 5 AMOUNT · 6 MANAGER · 7 CONFIRM ·
8 STATE · 9 STUDENT · 10 REG · 11 NOW · 12 AGREE · 13 MEMO · 14 AMOUNT_RAW`

---

## 3. 화면 구성

1. `ph` 헤더 — 제목 / 부제 / `uhak_agency_commission.php` / 엑셀 버튼 2개(현재계약·이력)
2. **구분 배너**(필수 요구사항) — 이 화면은 *레거시 실계약 데이터*, `COMMISSION RULES`(`R.commrules`)는
   *브라우저 저장 계산규칙*. 배너 안 `→ COMMISSION RULES` 버튼은 `MENU.agency` 에서 `k==='commrules'`
   항목을 찾아 `curCat/curKey/curMenu` 세팅 후 `goMenu()` 호출 — **단순 이동 링크뿐, 로직·데이터 통합 없음.**
3. 칩: 전체 이력 / 유학원 수 / 현재 유효계약 / 정율·정액 건수 / 현재계약 중복 경고
4. **상단 요약표: 유학원별 현재 계약** (`nowYN='Y'`) — 유학원명·ID·구분·현재 금액/%·담당·확인일·상태·등록일·NO
   자체 검색(유학원명/ID/담당) + 구분 필터 + `paintPaged(…, 'commissionCur')`
5. **하단 전체 이력표** — 필터: 유학원 select(데이터에서 생성, 이름순) · 구분 · 상태 · 유효(Y/N) ·
   등록일 FROM/TO · 통합검색(유학원·담당·사유·NO) · 필터초기화 · 건수칩 · `paintPaged(…, 'commissionHist')`
6. 하단 배너 — 미사용 컬럼 실측 사실 명시

- 문구 전부 `T(ko,en)`. `esc()` 는 `paintPaged` 가 내부에서 처리(그래서 셀은 평문 텍스트만).
- 데이터 없음(`REAL.commission` 미로딩/비로그인)이면 헤더+배너+안내카드로 폴백(깨지지 않음).
- 엑셀: 전역 `exportGridXls` 는 `#main` 의 **첫 번째** `table.grid` 만 잡아서 이 화면(표 2개)엔 부적합 →
  `__init` 안에서 `toXls(heads, rows, fname, [])` 를 표별로 직접 호출. `toXls` 없으면 `exportGridXls` 폴백.
  (그래서 `data-tblexcel` 속성을 쓰지 않는다 — 오케스트레이터가 속성으로 바꾸면 잘못된 표가 나간다.)
- 필터 상태는 모듈 스코프 `cmState` 에 보관 → 라이브 재렌더(`liveSync`→`renderMain`) 후에도 유지.

## 4. API

`commission.api.js` = `loadCommission(q, scope)` + 상수 2개(`MAX_COMMISSION`, `COMMISSION_COLS`).
반환 `{ cols, rows }` (loadStudents 와 동일한 칸배열 형태).

실행 검증:
- 전체: **4,004행 / 약 0.4~0.5초 / JSON 약 0.60 MB** (상한 5,000 안에서 전량 반환 OK)
- 스코프(`scope.agency='bonbon'`): **6행** 정상

`data.js` 의 기존 헬퍼 `D(col)`(varchar 날짜 형식검증)을 그대로 재사용한다 — 이미 파일에 있음.

### 유학원 스코프 판단 근거
커미션 조건은 **유학원별 영업기밀**(옆 유학원 %/금액이 보이면 안 됨)이므로
`scope.agency` 가 있으면 `lower(a.mb_id)=lower($n)` 로 **자기 유학원 계약만** 반환한다.
회원·학생 PII 와 동급으로 취급.

---

## 5. 오케스트레이터 배선 체크리스트

1. `deploy/index.html` 의 `MENU.agency` 에서
   `{k:'spec',t:'COMMISSION',u:'uhak_agency_commission.php',cols:[…]}` → **`k:'commission'`** 으로 교체
   (`u`,`cols` 는 유지해도 무해).
2. `R.commission` / `R.commission__init` 을 `R.commrules` 근처(약 2615행 앞)에 삽입.
   **`__init` 훅 추가 배선은 불필요** — `renderMain` 안 `deploy/index.html:2924`
   `if(typeof R[curKey+'__init']==='function')try{R[curKey+'__init'](m);}...` 가 이미 자동 호출한다(QA 확인).
3. `LIVE_PARTS` 에 `commission:['commission']` 추가.
   현재 `LIVE_PARTS_URL['uhak_agency_commission.php']` 는 없으므로 `LIVE_PARTS` 만으로 충분.
4. `liveHave(p)` 에 `if(p==='commission')return !!(REAL.commission&&REAL.commission.rows&&REAL.commission.rows.length);`
5. `liveSync` 의 응답 반영부에 `if(j.commission)REAL.commission=j.commission;`
6. `LIVE.ttls` 에 `commission:600000` (연 200건 수준 변경 → 10분 캐시 충분).
7. `data.js`: `ALL_PARTS` 에 `"commission"` 추가 · handler 분기 1줄 추가 ·
   `loadStamp` 에 `max(no) from legacy.uhak_agency_com` 추가(변경감지).
8. 전역 이름 충돌 확인 필요: `CM_I`, `cmData`, `cmNum`, `cmFmt`, `cmValue`, `cmCatLabel`,
   `cmStateLabel`, `cmYN`, `cmState`. 기존 `index.html` 에 `cm*` 접두 식별자는 없었으나
   병합 시 재확인 권장. `pgState` 키는 `commissionCur`/`commissionHist` (신규).

## 6. 제약 / 하지 않은 것
- **읽기 전용**: DDL/DML 실행 없음. 기존 `deploy/**`,`docs/**`,`migration/**` 무수정.
- `before_percent` 가 전량 `'0'` 이라 **"변경 전 → 변경 후" 차이 표시는 불가**. 이력을 `no` 순으로
  나열해 사용자가 추이를 보게 하는 것이 한계이며, 인접행 차이를 임의로 계산해 "인상폭"을
  만들어내지 않았다(근거 없는 파생 금지).
- `manager` 표기 난립(`이진환` / `이진환과장` / `이진환 과장님` / `이진환(cebusme8)` 등)은
  원본 그대로 표시. 정규화하면 레거시 화면과 값이 달라진다.
- `student` 컬럼은 데이터가 없어 표에서 뺐다(메뉴 정의의 9번째 컬럼). 필요하면 빈 컬럼으로
  되살릴 수 있으나 사용자에게 무의미.

---

## QA 결과 (리뷰어 검증·수정 내역)

판정: **PASS** (수정 4건 적용 — 그중 2건은 이 화면이 아예 동작하지 않는 치명 결함이었다)

### 고친 것 (`commission.render.js`)

1. **[치명] `window.REAL` → 항상 `undefined`.**
   `deploy/index.html:829` 는 `let REAL=…` (스크립트 스코프)이므로 **`window.REAL` 이 존재하지 않는다.**
   초안의 `cmData = () => (window.REAL && REAL.commission …)` 는 데이터가 정상 로딩돼도 항상 `null` 을
   반환해 화면이 영구히 "데이터 미로딩" 안내카드만 그렸다.
   → `typeof REAL !== 'undefined' && REAL && REAL.commission && REAL.commission.rows` 로 교체.
2. **[치명] `window.MENU` → 항상 `undefined`** (`deploy/index.html:706` 은 `const MENU={…}`).
   `→ COMMISSION RULES` 버튼이 절대 이동하지 못하고 매번 toast 폴백으로 빠졌다.
   → `typeof MENU !== 'undefined' && MENU.agency` 로 교체.
3. **엑셀이 "현재 페이지 50행"만 내보냄.** `paintPaged` 는 한 페이지만 DOM 에 그리므로 DOM 스크레이핑
   방식은 4,004행 화면에서 사실상 쓸모가 없었다. → 기존 헬퍼 `toXls(headers,rows,fname,redCols)` 를
   그대로 재사용하되 **필터 적용된 전체 행**(`curRows()` / `histRows()`)을 넘기도록 변경
   (`data-specexcel` 경로와 동일한 사용자 기대치). 0행이면 toast 로 알리고 중단.
   `data-tblexcel` 은 계속 쓰지 않는다(전역 `exportGridXls` 는 `#main` 첫 `table.grid` 고정 → 요약표만 나감).
4. **`AMOUNT_RAW`(인덱스 14) 가 실제로는 어디에도 안 쓰였다** (api 주석은 "원문 폴백" 이라 적혀 있었음).
   → `CM_I.raw=14` 추가 + `cmValue()` 가 숫자칸이 비었을 때 원문을 노출하도록 수정.
   (`'26%'`→`26`, `'300,000'`→`300,000` 처럼 숫자칸이 비지 않는 잡값은 종전대로 정규화값 표시)
5. **무데이터 폴백에 "조회결과 0행" 분기 추가.** 유학원 스코프로 계약이 0건인 계정은 이전엔
   빈 표 + 0 칩만 봤다 → `!d || !d.rows.length` 일 때 안내카드(문구 2종 분기)로 폴백,
   `__init` 도 같은 조건에서 조기 반환.
6. 미사용 헬퍼 `cmFmt` 삭제(전역 이름 1개 감소).

### 검증한 것 (수정 불필요)

- **문법**: `node --check` 두 파일 통과. 템플릿 리터럴 중첩/따옴표 정상.
- **SQL 실사** (읽기 전용, 실 DB):
  | 쿼리 | 결과 | 시간 |
  |---|---|---|
  | `loadCommission` 전체(limit 5000) | **4,004행** · JSON **0.62 MB** | **0.65 s** |
  | `loadCommission` scope=`bonbon` | **6행** | **0.15 s** |
  | `loadStamp` 추가분 `max(no)` | `4027` | < 0.01 s |
  모두 2초 이내 · 상한(5,000) 안. `D()` 헬퍼는 `deploy/api/data.js:125` 에 실제로 존재하며
  `check_date`/`confirm_date` 는 둘 다 `character varying` 이라 `~` 정규식 적용 가능(타입 확인 완료).
  `cms.g4_member.mb_id` 는 **중복 0건**(2,053행) → left join 이 행을 불리지 않음(4,004 유지, 확인).
  `com_amt` 잡값 실측 재확인: `'26%'`(amount) 1건, `'300,000'`(amount) 2건. 정규화 후 빈 값 **0건**.
- **규약**: 사용 클래스 `ph/sub/url/actions/btn(.primary)/banner/card pad/chips/chip(.on)/filters/field(.grow)/mono/twrap/grid/pager`
  **전부 기존 CSS 에 존재** → **추가 CSS 요구 없음**. (`.grow` 는 `.filters .grow{flex:1}` 이라
  `.field grow` 가 `.filters` 직계여야 하는데 조건 충족.) 사용자 문구 `T(ko,en)` 46곳, 미포장 한글 없음.
- **무데이터 안전성**: 렌더 함수를 노드에서 스텁 전역(`esc/T/paintPaged/toXls/toast/pgState`)과 함께 실제 호출.
  `REAL=null` / `REAL={}` / `rows=[]` / 실 DB 4,004행 / 한국어(LANG=ko) / XSS 페이로드 행 —
  **6케이스 모두 예외 없음**, 미해결 `${` 나 `undefined` 문자열 노출 없음.
  실데이터 케이스에서 `paintPaged` 호출 확인: `commissionCur` 9열 **1,734행**, `commissionHist` 13열 **4,004행**.
- **XSS**: DB 유래 문자열은 ① 표 셀 → `paintPaged` 내부 `esc()` (`deploy/index.html:1185`),
  ② 유학원 select `<option>` → 렌더에서 명시 `esc()`. `<img src=x onerror=…>`, `"><svg/onload=1>`,
  `<script>` 를 유학원명·담당·사유에 넣어 렌더한 결과 **원시 태그 유출 0** (확인). 실측상 `content`/`manager` 에
  `<` 포함 행은 0건이지만 방어는 유지.
- **PII**: 응답 컬럼은 `no/mb_id/mb_name/mb_nick(이름 폴백)/com_category/com_amt/manager/confirm_date/
  state/student/check_date/nowYN/agree/content` 뿐 — `mb_password`·주민번호·연락처·이메일 **미포함**.
  `scope.agency` 시 `lower(a.mb_id)=lower($n)` 로 자기 유학원만(영업기밀). 스코프 해제 금지 유지.
- **중복 구현 없음**: `esc/T/toast/paintPaged/makeSortable/toXls/pgState/goMenu` 전부 기존 헬퍼 재사용.
  신규 전역 `CM_I·cmData·cmNum·cmValue·cmCatLabel·cmStateLabel·cmYN·cmState` 와
  `MAX_COMMISSION·COMMISSION_COLS·loadCommission`, `pgState` 키 `commissionCur/commissionHist` 는
  `deploy/index.html`·`deploy/api/data.js` 에 **전건 0회 등장 → 충돌 없음**(grep 확인).
