#!/usr/bin/env bash
# 그날 반영된 Supabase 변경분 → 구전산(MySQL) 일일 동기화 (export → import).
#
# 안전 기본값: import 는 DRY-RUN. 실제 반영은 COMMIT=1 을 줄 때만.
#   1) export : Supabase 읽기전용 → changes_<날짜>.json
#   2) import : legacy_writeback.py (DRY-RUN 기본, COMMIT=1 이면 --commit --yes)
#
# 사용:
#   # 접속정보(env)
#   export PG_PASS=...                                   # Supabase(export 대상)
#   export MYSQL_HOST=... MYSQL_USER=... MYSQL_PASS=... MYSQL_DB=...   # 구전산(import 대상)
#
#   # 미리보기(안전, 실제 미반영)
#   ./run_daily_sync.sh 2026-07-25
#   # 실제 반영(명시적)
#   COMMIT=1 ./run_daily_sync.sh 2026-07-25
set -euo pipefail
cd "$(dirname "$0")"

DAY="${1:-${EXPORT_DATE:-}}"
if [ -z "$DAY" ]; then
  echo "사용법: ./run_daily_sync.sh YYYY-MM-DD   (또는 EXPORT_DATE env)" >&2
  exit 1
fi
PY="${PYTHON:-python3}"
OUT="changes_${DAY}.json"

echo "── [1/2] export: Supabase 그날($DAY) 변경분 → $OUT (읽기전용)"
"$PY" export_daily_changes.py --date "$DAY" --out "$OUT"

echo
if [ "${COMMIT:-0}" = "1" ]; then
  echo "── [2/2] import: 구전산 MySQL 실반영 (--commit --yes)"
  "$PY" legacy_writeback.py --changes "$OUT" --commit --yes
else
  echo "── [2/2] import: 구전산 MySQL DRY-RUN (미리보기 · 실제 미반영)"
  echo "     실제 반영하려면:  COMMIT=1 ./run_daily_sync.sh $DAY"
  "$PY" legacy_writeback.py --changes "$OUT"
fi
