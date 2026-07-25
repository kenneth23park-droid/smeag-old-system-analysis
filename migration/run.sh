#!/usr/bin/env bash
# 이관 오케스트레이터 실행 래퍼. 기본 DRY-RUN. 원본 MySQL 불변.
set -euo pipefail
cd "$(dirname "$0")"

# .env(PG_PASS 등) 로드 — 프로젝트 루트 우선
[ -f ../.env ] && set -a && . ../.env && set +a

case "${1:-plan}" in
  plan)      python3 orchestrator.py ;;                       # dry-run 전체 계획
  execute)   python3 orchestrator.py --execute ;;             # 실제 이관(주의)
  phase)     python3 orchestrator.py --phase "${2}" --execute ;;
  only)      python3 orchestrator.py --only "${2}" --execute ;;
  g4score)   python3 scripts/g4_score_eav.py "${2:-}" ;;      # EAV 특수핸들러
  # 원샷: 백업 → Supabase 전체 이관 + 100% 검증 + 리포트
  all)       python3 migrate_all.py --backup "${2:-../sql}" ;;             # dry-run(미리보기)
  all-exec)  python3 migrate_all.py --backup "${2:-../sql}" --execute ;;   # 실제 이관+검증+리포트
  *) echo "usage: run.sh [plan|execute|phase <csv>|only <tables>|g4score --execute|all [backup]|all-exec [backup]]"; exit 1 ;;
esac
