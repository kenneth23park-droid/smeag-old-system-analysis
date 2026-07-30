# 회원관리 (member_list.php) — 렌더러 키 `members`

산출물: `members.render.js` (R.members / R.members__init), `members.api.js` (loadMembers + 배선),
이 문서. `node --check` 두 파일 모두 통과.

## 1. 레거시 근거 / 화면 성격
- 레거시 `member_list.php` = 그누보드4 회원목록 관리화면. 신전산 메뉴 정의의 표기 컬럼은
  `['ID','이름','레벨','이메일','가입일','최근접속']` → 6칸은 모두 그대로 포함하고,
  이 시스템 고유의 유학원 계정 정보(유학원명·커미션·학생수·계약일)를 상세 컬럼으로 덧붙였다.
- **회원 = 관리자/스태프 계정 + 유학원(agency) 계정이 한 테이블(`cms.g4_member`)에 섞여 있다.**
  그래서 `kind`(ADMIN/STAFF/AGENCY)를 서버에서 계산해 필터·칩·표에 구분 표기한다.

## 2. 레벨 의미의 근거 (auth 로직 실측)
`deploy/api/auth.js` → `app.member_authenticate(id,pw,ip)` (pg_proc 원문 확인):
- `force_th int := 8` — **mb_level >= 8 이면 관리자로 보고 최초 레거시 비번 로그인 시 강제 비번변경**
  (`must_change = (g.mb_level >= force_th)`).
- 자격증명 순서: `app.admin_users`(앱 비번, crypt) 우선 → 없으면 `cms.g4_member.mb_password`
  = `app.mysql_password(pw)` 비교. 즉 **레벨의 원천은 `cms.g4_member.mb_level`**.
- `deploy/api/data.js` 스코프 판정: `Number(session.mb_level) < 8` 이고 `mb_id` 가
  `legacy.student_info.uhak_id` 로 존재하면 유학원 계정 → 자기 유학원만 조회.
  → **8 이 관리자/비관리자 경계**라는 게 시스템 전체의 규약.

## 3. 실측 (Supabase, 읽기 전용 select 만)
`cms.g4_member` 총 **2,053행**.

레벨 분포:
| mb_level | 인원 |
|---|---|
| 1 | 150 |
| 2 | 1 |
| 3 | 287 |
| 5 | **1,583** |
| 6 | 1 |
| 7 | 24 |
| 8 | 1 |
| 9 | 1 |
| 10 | 5 |

상태/접속:
- `mb_leave_date <> ''` (탈퇴) **16**
- `mb_intercept_date <> ''` (차단) **125**, 추가로 `mb_memo_call='block'` **2** (유학원 인보이스 블럭)
- `mb_today_login > now()-30d` (최근30일 접속) **127**
- 이메일 없음 **30**
- `mb_datetime` 범위 2011-05-25 ~ 2026-07-10 · `mb_today_login` 범위 2011-10-18 ~ 2026-07-13

유학원 연결(3가지 신호) 크로스탭:
| mb_10 있음 | student_info.uhak_id 존재 | uhak_agency_com.mb_id 존재 | 인원 |
|---|---|---|---|
| ✔ | ✔ | ✔ | 1,410 |
| ✔ | ✘ | ✔ | 305 |
| ✘ | ✘ | ✘ | **175** ← 순수 직원/관리자 |
| ✔ | ✘ | ✘ | 124 |
| ✘ | ✔ | ✘ | 27 |
| ✔ | ✔ | ✘ | 11 |
| ✘ | ✔ | ✔ | 1 |

→ 채택한 `kind` 규칙 결과: **AGENCY 1,876 · STAFF 170 · ADMIN 7** (합 2,053).
- `uhak_id` 만으로 판정하면 1,449명(계약만 있고 아직 학생 없는 유학원 427명 누락) → 3신호 OR 로 확정.
- ADMIN 7명 실측: `cebusme`(Joon), `cebusme00`(programmer), `cebusme2`, `Joon`, `katie` = Lv10,
  `cebusme1`(Rachel Jung) = Lv9, `fumi` = Lv8. Lv7(24명) = 캠퍼스/부서 스태프(`capital1`,`encanto1`,
  `supervisor`, `kitchenmanager` 등) → STAFF.
- **레벨은 유학원/직원을 가르지 않는다**: Lv1 150명 중 23명이 유학원 연결, Lv7 중 4명도 유학원 연결.
  Lv3(287) vs Lv5(1,527) 는 국적 구분도 아니다(둘 다 kor 최다) — 유학원 등급(정/부) 정도로만 표기.

`mb_1~mb_11` 실측 의미(값 샘플로 확정):
| 컬럼 | 의미 | 채움 |
|---|---|---|
| mb_1 | 사업자등록번호 | 199 |
| mb_2 | 담당자(대표) 성명 | 538 |
| mb_3 | 계약일 (YYYY-MM-DD) | 1,847 |
| mb_4 | 입금은행명 | 1,846 |
| mb_5 | 계좌번호+예금주 | 1,846 |
| mb_6 | 유선 전화 | 316 |
| mb_7 | 유학원 표기명 | 247 |
| mb_8 | 커미션 방식 `percent`(1,104) / `amount`(613) / ''(336) | 1,717 |
| mb_9 | 커미션 값 (예 30 / 40000) | 1,717 |
| mb_10 | **유학원 코드(= mb_id 와 동일)** | 1,850 |
| mb_11 | 유학원 비중 수치화 (0=2,024 · 50=22 · 100=6 · 60=1) | 29 |
| mb_recommend | 등록실적 계산용 (0=1,926, 나머지 4·12·8·16…) | 127 |
| mb_memo | 관리 메모 | 52 |

> **mb_4/mb_5(은행·계좌번호)는 의도적으로 API 에 넣지 않았다.** 커미션 입금계좌는 COMMISSION 화면
> 소관이고 회원목록에 필요 없다. `mb_password`,`mb_jumin`,`mb_password_q/a`,`mb_lost_certify`,
> `mb_birth`,`mb_zip*`,`mb_addr1/2` 도 전부 미노출.

## 4. 컬럼 매핑 (API 필드 → 화면 헤더)
| API | 원본 | 화면 헤더(EN/KO) |
|---|---|---|
| kind | 계산 | KIND / 구분 (pill) |
| id | mb_id | ID |
| name / nick | mb_name / mb_nick | NAME / NICK |
| level | mb_level | LV + LEVEL(라벨) |
| email | mb_email | E-MAIL |
| phone | mb_hp → mb_tel → mb_6 (첫 비어있지 않은 값) | PHONE |
| sns | mb_sns | LINE |
| agency | mb_7 | AGENCY |
| comm/commval | mb_8 / mb_9 | COMM (`30 %` 또는 `40,000 (amt)`) |
| students | count(student_info where uhak_id=mb_id) | STUDENTS |
| comms | count(uhak_agency_com where mb_id) | COMM ROWS |
| recommend / weight | mb_recommend / mb_11 | RECOMM / WEIGHT |
| contract | mb_3 (형식 맞을 때만) | CONTRACT |
| joined | mb_datetime → YYYY-MM-DD | JOINED / 가입일 |
| login | mb_today_login → YYYY-MM-DD HH24:MI | LAST LOGIN / 최근접속 |
| ip | mb_login_ip | LAST IP |
| status | mb_leave_date→leave / mb_intercept_date·mb_memo_call='block'→block / else normal | STATUS (pill) |
| memo | mb_memo (공백정규화·160자) | MEMO |

정렬: `coalesce(mb_today_login, mb_datetime) desc nulls last, mb_no desc` (최근 접속 순).
상한: `MAX_MEMBERS = 3000` (전량 2,053 < 상한).

## 5. 쿼리 실행 검증 (members.api.js 의 SQL 그대로 실행)
- 관리자 스코프: **2,053행 · 884ms**
- 유학원 스코프(`scope.agency='GRM'`): **1행 · 160ms**
  샘플 → `{id:'GRM', level:5, kind:'AGENCY', agency:'TOKYO', comm:'percent', commval:'35',
  students:452, comms:9, contract:'2019-12-10', joined:'2012-12-17', login:'2026-07-13 19:24', status:'normal'}`
- (첫 콜드런은 4.1s 였고 웜 이후 0.9s. `statement_timeout: 20000` 안이지만
  student_info 90k·uhak_agency_com 4k 를 집계하는 CTE 2개가 비용의 대부분이다.)

## 6. 스코프(PII) 정책 — 판단 근거
- `scope.agency` 가 있으면 **자기 계정 1행만** 반환한다. 회원목록은 타 유학원의 이메일·전화·LINE·IP·
  커미션율이 전부 들어 있어 유학원끼리 서로 보면 안 된다(경쟁정보 + PII). 기존
  `loadStudents/loadDeposits/loadChangelog` 가 `uhak_id` 로 자기 것만 거르는 것과 같은 원칙,
  다만 회원 테이블은 소유 기준이 `mb_id` 자체이므로 `lower(m.mb_id)=lower($n)` 로 좁혔다.
- 비밀번호·주민번호는 어떤 스코프에서도 SQL 에 등장하지 않는다.

## 7. 오케스트레이터 배선 (통합 시 해야 할 일)
1. `deploy/index.html` 메뉴: `member:` 첫 줄
   `{k:'spec',t:'회원관리',u:'member_list.php',cols:[...]}` → **`{k:'members', ...}`** 로 교체
   (cols 는 남겨도 무해 — `R.members` 는 참조하지 않는다).
2. `LIVE_PARTS` 에 `members:['members']` 추가. `LIVE.ttls` 에 `members:300000` 권장(거의 안 바뀜).
   `liveHave` 에 `if(p==='members')return !!(REAL.members&&REAL.members.length);` 추가.
   `liveSync` 의 응답 적용부에 `if(j.members)REAL.members=j.members;` 추가.
3. `deploy/api/data.js`: `loadMembers` 함수 추가 · `ALL_PARTS` 에 `"members"` 추가 ·
   parts 분기에 `if (parts.includes("members")) out.members = await loadMembers(q, scope);`.
   (`S()`, `MAX_MEMBERS` 상수는 data.js 상단 유틸/상수 영역에 이미 있거나 함께 넣을 것 —
   `S` 는 기존 것 재사용, `MAX_MEMBERS` 만 신규.)
4. `R.members__init` 은 `renderMain` 의 `R[curKey+'__init']` 훅으로 자동 호출된다(추가 배선 불필요).
5. 엑셀은 `data-tblexcel="MEMBERS"` → 기존 `exportGridXls` 자동 배선(추가 코드 없음).

## 8. 주의점 / 한계
- `paintPaged` 는 모든 셀을 `esc()` 하므로 pill(HTML)이 문자로 보인다.
  `R.members__init` 의 `paint()` 가 페인트 직후 **0번(KIND)·19번(STATUS) 열만**
  `td.innerHTML = td.textContent` 로 복원한다. **컬럼 순서를 바꾸면 이 인덱스도 같이 고쳐야 한다.**
- `pgState['members']` 는 전역 페이지 상태라 필터 변경 시 `page=0` 으로 되돌린다(`reset0`).
- `mb_today_login` 은 로그인마다 갱신되므로 `loadStamp` 에 회원 지표를 넣으면 stamp 가 자주 바뀐다
  (캐시 무효화 관점에선 바람직, 다른 조각까지 재조회되는 부작용은 감수/또는 members 만 별도 캐시키).
- 상세 모달은 만들지 않았다(기존 모달 헬퍼는 `openStudentEdit` = 학생 전용). 규약대로 상세 컬럼을
  표에 21칸으로 포함했다. `.twrap` 가로스크롤로 표시된다.
- 이 화면은 **읽기 전용**이다. 레거시 member_list.php 의 레벨변경·차단·탈퇴처리 같은 쓰기 기능은
  구현하지 않았다(원본 불가침 규약 + 별도 쓰기 API 설계 필요).

---

## QA 결과 (리뷰어 검증 · 2026-07-30) — **PASS**

### A. 문법
`node --check members.render.js` / `members.api.js` 모두 통과(수정 후 재확인). 템플릿 리터럴 깨짐 없음
(render 는 전부 문자열 연결식이라 중첩 백틱 자체가 없음).

### B. SQL 실사 (Supabase, select 전용 · psycopg2)
`members.api.js` 의 SQL을 **문자 그대로** 실행:

| 케이스 | 행수 | 소요 |
|---|---|---|
| 관리자 스코프(`limit 3000`) 콜드 | **2,053** | 761 ms |
| 관리자 스코프 웜(2회차/3회차) | 2,053 | 248 / 526 ms |
| 유학원 스코프(`mb_id='GRM'`) | **1** | 238 ms |

- 2초 초과 쿼리 없음(초안 노트의 4.1s 콜드는 재현되지 않음 — 세션 첫 연결 비용으로 보임).
- 반환 분포 재검증: `kind` = AGENCY 1,876 / STAFF 170 / ADMIN 7, `status` = normal 1,912 / block 125 / leave 16 → 보고와 일치.
- 컬럼 타입 확인: `mb_11`,`mb_recommend`,`mb_no` = integer, `mb_level` = smallint,
  `mb_datetime`/`mb_today_login` = timestamptz → `coalesce(m.mb_11,0)` 등 타입 충돌 없음(실행으로 확인).
- 반환 키 21개 = 렌더러가 참조하는 필드와 1:1 일치(누락/오타 없음).
- 상한 3,000 > 실측 2,053 → 상한 안.

### C. 발견·수정한 문제

1. **[버그·기능] 2페이지부터 pill 이 태그 글자로 보임** — `paintPaged` 의 페이저 버튼(`«◀▶»`,
   `#ppJump`, `#ppPer`)은 내부에서 `paintPaged` 를 다시 호출해 `box` 를 통째로 다시 그린다.
   초안은 `paint()` 직후 1회만 `innerHTML=textContent` 로 복원해서, 페이지 이동·표시개수 변경 뒤에는
   `&lt;span class="pill warn"&gt;ADMIN&lt;/span&gt;` 이 그대로 노출됐다(실측 재현).
   → `pills()` 함수로 분리하고, **페이저 핸들러를 감싸(재귀적으로 재-wrap) 재페인트마다 복원**하도록 수정.
   복원 조건도 `textContent.slice(0,12)==='<span class='` 로 좁혀, pill 열이 아닌 값이 들어와도
   HTML 로 해석되지 않게 했다(이중 안전장치).
2. **[캐시·성능] `loadStamp` 에 `max(mb_today_login)` 추가 권고 삭제** — `stamp` 는 **전역**이라
   (`data.js` 의 `version = stampVersion(stamp)+parts...`, ETag·메모리캐시 키 전부 여기서 파생)
   회원이 로그인할 때마다 stamp 가 바뀌면 학생 90k·배치도 13개월 같은 **무거운 조각의 캐시까지 전부**
   깨진다. → 신규가입만 감지하는 `coalesce((select max(mb_no) from cms.g4_member)::text,'') mb_max`
   한 줄로 교체하도록 주석 수정.
3. **[방어] `scope` 미전달 대비** — `if (scope.agency)` → `const ag = scope && scope.agency;` 로 변경
   (현재 handler 는 항상 scope 를 넘기지만 loader 단독 호출 시 TypeError 방지).
4. **[표기] ADMIN pill 색 `pill female` → `pill warn`** — `female`(분홍=성별)은 의미가 어긋난다.
   `warn` 은 index.html 에 이미 정의된 클래스.
5. **[표기] 커미션 정액 표기 `40,000 (amt)` → `40,000`** — `(amt)` 는 T() 로 감싸지지 않은
   영문 약어였다. `%` 유무만으로 percent/amount 가 구분되므로 접미어를 제거하고,
   숫자가 아닌 값·빈 값도 `—` 로 안전 처리.
6. **[정리]** 무의미한 `pgState.members.page=pgState.members.page||0` 한 줄 제거.

### D. 규약 준수 점검
- 사용자 문구는 모두 `T(ko,en)`. 남은 비-T 문자열은 고유명사/기호뿐(`ID`, `LV`, `LINE`, `ALL`,
  `member_list.php`, `📊 EXCEL`) — 기존 화면들과 동일한 취급.
- 사용한 클래스는 전부 `deploy/index.html` 에 **이미 존재**: `ph/sub/url/actions/btn/chips/chip/chip on/
  filters/field/field grow/dl-chk/card pad/banner/mono/pill(.good .warn .install .return .neutral)`.
  → **추가로 필요한 CSS 없음.**
- 재사용 확인(중복 구현 없음): `esc`(818행) · `T`(2677행) · `paintPaged`/`pgState`(1180~) ·
  `makeSortable`(1311행) · `REALBADGE`(988행) · `exportGridXls`(1348행, `data-tblexcel` 자동배선 2849행)
  — 전부 기존 것을 그대로 호출한다. 새로 만든 건 members 전용 로직(`memLevelLabel`/`memKindPill`/
  `memStatusPill`/`memCommText`/`memFiltered`)뿐이고, 이 이름들이 index.html 에 없음을 grep 으로 확인.

### E. 무데이터 안전성 스모크 (Playwright + index.html 에서 떼어낸 실제 헬퍼로 실행)
`REAL` 미정의 / `REAL=null` / `REAL={}` / `REAL.members=[]` / `REAL.members=[{}]`(전 필드 빈값) /
`#memBody` 없는 컨테이너로 `R.members__init` 호출 — **6케이스 전부 예외 없이 안내 카드 또는 정상 표**.
`pageerror` 0건. 120행 데이터로 페이지 이동(▶/»)·표시개수 100·필터·정렬·초기화·최근30일 체크까지
전 인터랙션 정상, pill 유지 확인.

### F. XSS
- 표의 모든 셀은 `paintPaged` 가 `esc()` 한다. 테스트 데이터에 `<script>` 와
  `<img src=x onerror=...>` 를 넣어 렌더한 결과 **DOM 에 img/script 노드 0개**(문자로만 표시) 확인.
- `innerHTML` 로 되돌리는 셀은 서버가 계산한 열거값(kind/status)에서 나온 우리 자신의 pill 마크업뿐이며,
  라벨도 `esc()` 를 한 번 더 거친다. 조건도 `'<span class='` 접두 일치로 제한.
- `#mbCount` 의 `innerHTML` 은 숫자(`toLocaleString`)와 고정 문구만 사용.

### G. PII
SQL 에 `mb_password`, `mb_jumin`, `mb_password_q/a`, `mb_lost_certify`, `mb_birth`, `mb_zip*`,
`mb_addr1/2`, `mb_4`(은행), `mb_5`(계좌) **어느 것도 등장하지 않음**(grep 확인).
유학원 스코프에서는 자기 1행만 반환됨을 실쿼리로 확인(GRM → 1행).

### H. 남은 한계 (수정 대상 아님 · 기존 화면 공통)
- `exportGridXls` 는 화면에 그려진 **현재 페이지(기본 50행)**만 내보낸다(`#main table.grid` 기준).
  전량 필요하면 표시개수를 200 으로 올린 뒤 내보내야 한다 — 다른 paged 화면과 동일한 제약.
- `paintPaged` 는 셀 단위 class 를 지원하지 않아 숫자 열에 `class="mono"` 를 줄 수 없다
  (규약의 `<td class="mono">` 는 직접 마크업하는 표에만 적용 가능). `paintPaged` 공통 개선 사안.
- 정렬은 현재 페이지 내에서만 동작(기존 `makeSortable` 동작 그대로).
