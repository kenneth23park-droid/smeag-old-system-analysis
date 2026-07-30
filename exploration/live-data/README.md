# 라이브 DB 조회(/api/data) 검증 하네스

메뉴 선택 시 Supabase 실데이터를 조회해 화면을 그리는 경로(`deploy/api/data.js` + `deploy/index.html`,
`deploy/m/index.html`)를 로컬에서 검증·측정하는 스크립트. 모두 **읽기 전용**(레거시 MySQL 무접속).

전제: 리포지토리 루트 `.env` 에 `PG_*` 값, `deploy/node_modules` 에 `pg`(= `cd deploy && npm i`).
세션쿠키는 각 스크립트가 로컬 시크릿으로 위조해 핸들러에 직접 주입한다(테스트 전용).

| 스크립트 | 용도 |
|---|---|
| `perf.mjs`  | 조각별 응답시간·용량, 메모리캐시/304 효과 측정 |
| `probe.mjs` | 조회 인덱스 생성 + 전후 쿼리시간 비교(Supabase 이관본에만 인덱스 추가) |
| `e2e.mjs`   | 데스크톱 Playwright — 부팅/메뉴선택/재진입/수동⟳/픽업·변경이력 |
| `e2e2.mjs`  | Group Students·DEPOSIT 등 `k:'spec'` 화면의 조각 매핑 확인 |
| `e2e_m.mjs` | 모바일(/m) 탭 이동 시 최신화 확인 |

실행: `node exploration/live-data/perf.mjs` (한 번에 하나씩 — 동시 실행하면 커넥션이 몰린다)
