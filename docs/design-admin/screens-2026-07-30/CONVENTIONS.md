# SMEAG 신전산 — 5개 화면 전용 렌더러 구현 공용 규약 (필독)

프로젝트 루트: `/Users/kwangseobpark/smeag-old-system-analysis`
산출물 디렉터리(당신이 파일을 쓸 곳): `/private/tmp/claude-501/-Users-kwangseobpark-smeag-old-system-analysis/87d575a6-46c2-41e8-a404-1b6e1e54a69a/scratchpad/screens/`

## 목표
레거시 PHP 관리자 화면 5종을 신전산(정적 HTML + Vercel 서버리스 + Supabase Postgres)에서
**전용 렌더러**로 완성한다. 현재는 `{k:'spec'}` 표 폴백(근사)이라 레거시와 다르다.

| 담당키 | 메뉴 | 레거시 URL | Supabase 소스 |
|---|---|---|---|
| `members`   | 회원관리        | member_list.php             | `cms.g4_member` (2,053행) |
| `commission`| COMMISSION      | uhak_agency_commission.php  | `legacy.uhak_agency_com` (4,004행) + `cms.g4_member` |
| `courses`   | COURSE LIST     | course_list.php             | `legacy.course_info`(71) + `legacy.course_category`(14) |
| `tuition`   | TUITION FEE     | tution_fee.php              | `legacy.tution_fee`(100) + `legacy.course_info` |
| `elec`      | ELEC & WATER    | room_elec.php               | `legacy.room_elec`(**1,670,841행**) + `legacy.room_info`(1,127) + `legacy.room_category` |

## 절대 규칙
1. **원본 MySQL 불가침** — 읽기만. Supabase 도 **select 만**(DDL/DML 금지).
2. **PHP 금지** — 서버 로직은 Vercel 서버리스(Node, ESM) 뿐.
3. **기존 파일을 직접 수정하지 마라.** 당신은 아래 산출물 파일만 쓴다. 통합은 오케스트레이터가 한다.
4. 코드 스타일은 기존 코드와 동일하게 — 한국어 주석, 압축된 표현, 외부 라이브러리 없음(바닐라 JS).

## 반드시 먼저 읽을 것 (기존 코드 규약 파악)
- `deploy/index.html`
  - 메뉴 정의 `const MENU=` 부근 (약 699~780행)
  - 라이브 데이터 계층 `LIVE`, `LIVE_PARTS`, `liveHave`, `liveSync`, `goMenu` (약 830~960행)
  - 전용 렌더러 예시: `R.commrules` / `R.commrules__init` (약 2615~2680행) ← **가장 좋은 참고**
  - `R.spec` (약 1707행), `paintPaged` (약 1181행), `renderMain` (약 2840행)
- `deploy/api/data.js` 전체 (430행) — 특히 `loadGroups`, `loadDeposits`, `loadChangelog`, `handler` 의 parts 분기.

## 화면(렌더러) 규약
- `R.<key>=function(m){ ... return HTML문자열 }` — DOM 조작 금지, 문자열 반환.
- 이벤트/후처리가 필요하면 `R.<key>__init=function(m){ ... }` 를 함께 제공(renderMain 이 자동 호출되도록
  오케스트레이터가 배선한다. 초안에서는 `__init` 함수를 그냥 정의만 해두면 된다).
- 사용 가능한 헬퍼(이미 존재): `esc(s)` HTML 이스케이프, `T(ko,en)` 언어전환(기본 EN), `mlabel(m)`,
  `toast(title,msg,ok)`, `paintPaged(box,cols,rows,name,opts)`, `makeSortable(scope)`,
  `exportGridXls(fname)`(버튼에 `data-tblexcel="이름"` 속성 주면 자동배선), `campusChipName(n)`.
- 표준 레이아웃 마크업:
  ```html
  <div class="ph"><h1>제목</h1><span class="sub">부제</span><span class="url">레거시.php</span>
    <span class="actions" style="margin-left:auto"><button class="btn" data-tblexcel="NAME">📊 EXCEL</button></span></div>
  <div class="chips" style="margin-bottom:10px"><span class="chip">전체 <b>1,234</b>건</span></div>
  <div class="filters"> ... <div class="field"><label>라벨</label><select id="..."></select></div> ... </div>
  <div class="twrap"><table class="grid"><thead>…</thead><tbody>…</tbody></table></div>
  <div class="banner">설명</div>
  <div class="card pad">…</div>
  ```
  숫자 셀은 `<td class="mono">`. 사용 가능한 CSS 변수: `--accent-ink,--dim,--faint,--good,--warn,--border,--surface-2`.
- **모든 사용자 문구는 `T('한글','English')`** 로 감쌀 것(기본 언어 영어).
- 데이터가 없을 때(`REAL` 미로딩/비로그인)도 **깨지지 않아야** 한다 → 안내 카드로 폴백.
- 페이지네이션이 필요한 목록(회원·커미션)은 `paintPaged` 를 `__init` 안에서 사용
  (`R.commrules__init` 및 `R.spec` 의 `#specBody` 사용 예 참고).

## 데이터(API) 규약
`deploy/api/data.js` 에 붙일 **loader 함수 1개**를 초안으로 제출한다.
```js
// 시그니처: q = 파라미터 바인딩 쿼리 함수 (기존 코드의 q 사용법을 그대로 따를 것),
//           scope = { agency: '유학원id'|null }  (유학원 계정 PII 제한)
async function loadMembers(q, scope) { ... return { cols:[...], rows:[[...]] } 또는 배열 }
```
- 기존 loader 들의 반환 형태를 확인하고 **가장 비슷한 것을 따를 것**.
- 응답 크기 상한을 반드시 둘 것(예: 회원 3,000행, 커미션 4,004행 전체 OK, elec 은 아래 참조).
- `room_elec` 은 167만 행 → **절대 전량 반환 금지**. 기간·캠퍼스 파라미터로 서버에서 집계해
  방 단위(최대 1,200행)로 줄여서 반환.
- 유학원 계정 스코프(`scope.agency`)가 있으면: 회원/커미션은 자기 유학원만, 코스·요금·전기는
  민감정보가 아니므로 그대로 허용(단 판단 근거를 notes 에 적을 것).

## Supabase 조회 방법 (검증용)
`.env` 에 PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASS 가 있다. psql 은 없고 python3 + psycopg2 는 있다:
```bash
cd /Users/kwangseobpark/smeag-old-system-analysis && python3 - <<'EOF'
import psycopg2
env=dict(l.strip().split('=',1) for l in open('.env') if '=' in l and not l.startswith('#'))
c=psycopg2.connect(host=env['PG_HOST'],port=env['PG_PORT'],dbname=env['PG_DB'],user=env['PG_USER'],password=env['PG_PASS'],sslmode='require')
cur=c.cursor(); cur.execute("select ..."); print(cur.fetchall())
EOF
```
**실제로 쿼리를 돌려 결과를 확인하고**, 초안 SQL 이 에러 없이 도는지 검증할 것. (읽기 전용만)
레거시 원본 덤프도 참고 가능: `sql/<테이블>.sql` (room_elec.sql 은 130MB 이니 head 만).

## 산출물 (파일 3개, 정확히 이 이름으로)
1. `<key>.render.js` — `R.<key>=…` 와 `R.<key>__init=…` (그대로 붙여넣을 수 있는 완성 코드)
2. `<key>.api.js` — data.js 에 붙일 loader 함수 + parts 분기에 넣을 한 줄
3. `<key>.notes.md` — 레거시 화면 재현 근거, 컬럼 매핑표, 계산식, 실제 쿼리 실행 결과(행수/샘플),
   상한·제약, 통합 시 오케스트레이터가 해야 할 배선(메뉴 키 교체, LIVE_PARTS 등)

## 품질 기준
- SQL 은 실제로 실행해 검증(행수·샘플 기재).
- 렌더러 코드는 문법 오류 없어야 함: `node --check` 로 확인 가능하도록 파일 상단에 `/* eslint-disable */` 만 두고
  순수 JS 로 작성(단, `R` 은 외부 전역이므로 파일 맨 위에 `var R=R||{};` 같은 선언은 **넣지 말고**
  대신 `node --check` 통과를 위해 파일을 그냥 대입문으로 시작해도 된다 — 문법만 맞으면 됨).
- 레거시에 없는 기능을 마음대로 추가하지 말 것. 단 명백한 개선(정렬·검색·엑셀)은 기존 화면들과 동일 수준으로 허용.
