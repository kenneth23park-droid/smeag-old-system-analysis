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
  *) echo "usage: run.sh [plan|execute|phase <csv>|only <tables>|g4score --execute]"; exit 1 ;;
esac
