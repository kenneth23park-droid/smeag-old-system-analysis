#!/usr/bin/env bash
# ============================================================================
# 레거시(MySQL sunjae2117) 저부하 재백업 스크립트  [읽기 전용]
#
#   A군: 마스터/소형 테이블  → 통째 재덤프 (제자리 UPDATE 까지 확실히 반영)
#   B군: 대형 append-only 로그 → PK 워터마크 델타만 (2026-07-13 이후)
#   C군: 정적/제외 테이블      → 건너뜀
#
# 부하 억제 장치
#   --quick            : 결과를 서버 메모리에 다 올리지 않고 행 단위 스트리밍
#   --skip-lock-tables : 테이블 락 안 검 (레거시는 MyISAM → 기본 락이 쓰기를 막음)
#   --single-transaction 은 MyISAM 에서 무의미하므로 쓰지 않음
#   테이블 사이 sleep + nice/ionice 로 I/O 양보
#
# 사용:
#   export MYSQL_HOST=... MYSQL_USER=... MYSQL_PASS=... MYSQL_DB=sunjae2117
#   bash migration/scripts/legacy_delta_backup.sh
# ============================================================================
set -euo pipefail

: "${MYSQL_HOST:?MYSQL_HOST 필요}"
: "${MYSQL_USER:?MYSQL_USER 필요}"
: "${MYSQL_PASS:?MYSQL_PASS 필요}"
MYSQL_DB="${MYSQL_DB:-sunjae2117}"
MYSQL_PORT="${MYSQL_PORT:-3306}"

STAMP="$(date +%Y%m%d_%H%M)"
OUT="${OUT_DIR:-./backup/delta_$STAMP}"
mkdir -p "$OUT"

# 자격증명은 커맨드라인 노출 대신 임시 옵션파일로
CNF="$(mktemp)"; trap 'rm -f "$CNF"' EXIT
cat > "$CNF" <<EOF
[client]
host=$MYSQL_HOST
port=$MYSQL_PORT
user=$MYSQL_USER
password=$MYSQL_PASS
default-character-set=utf8
EOF

DUMP=(mysqldump --defaults-extra-file="$CNF"
      --quick --skip-lock-tables --skip-add-locks --no-tablespaces
      --default-character-set=utf8 --hex-blob
      --skip-extended-insert=FALSE --net_buffer_length=16384)

SLEEP="${SLEEP_SEC:-3}"     # 테이블 사이 휴식(초). 낮 시간대 실행 시 10 이상 권장
NICE=(nice -n 19)
command -v ionice >/dev/null && NICE=(nice -n 19 ionice -c3)

log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/backup.log"; }

# ── 0) 서버 상태 확인. 바쁘면 중단 ──────────────────────────────────────────
TR=$(mysql --defaults-extra-file="$CNF" -N -B -e \
     "SHOW GLOBAL STATUS LIKE 'Threads_running'" "$MYSQL_DB" | awk '{print $2}')
log "Threads_running=$TR"
if [ "${TR:-0}" -gt "${MAX_THREADS:-10}" ]; then
  log "서버가 바쁨(Threads_running=$TR). 중단. 한가한 시간대에 다시 실행하세요."
  exit 2
fi

# ── A군: 통째 재덤프 (합계 약 35만 행, 수십 MB) ────────────────────────────
FULL_TABLES=(
  student_info student_payment reserve_info student_counsel
  room_info room_list room_category room_date
  course_info course_category tution_fee smeag_dayoff smeag_sched_info
  student_group_info uhak_agency_com uhak_day_info
  cash_payments cash_payments_history
  g4_member g4_config g4_board g4_group g4_auth
)
for t in "${FULL_TABLES[@]}"; do
  log "FULL  $t"
  "${NICE[@]}" "${DUMP[@]}" "$MYSQL_DB" "$t" | gzip -1 > "$OUT/full_$t.sql.gz" \
    || log "  ! $t 실패(테이블 없음?) — 계속"
  sleep "$SLEEP"
done

# ── B군: 델타만 (테이블|WHERE 절) ──────────────────────────────────────────
#   워터마크 = 현재 Supabase 에 적재된 max(PK). 다음 회차엔 이 값을 갱신할 것.
DELTA=(
  "room_elec|re_idx > 1671022 OR update_timestamp >= '2026-07-13 00:00:00'"
  "room_change_log|change_idx > 552240"
  "student_info_history|snum > 183994"
  "room_move|m_idx > 610893 OR m_date >= '2026-07-13 00:00:00'"
  "student_info_invoice|no > 128709"
  "reserve_info_history|sno > 54698"
  "student_change|change_idx > 27046"
  "room_reserve|\`timestamp\` >= '2026-07-13 00:00:00'"
  "g4_point|po_id > 146403"
  "g4_visit|vi_id > 2131797"
)
for row in "${DELTA[@]}"; do
  t="${row%%|*}"; w="${row#*|}"
  log "DELTA $t  WHERE $w"
  "${NICE[@]}" "${DUMP[@]}" --no-create-info --where="$w" "$MYSQL_DB" "$t" \
    | gzip -1 > "$OUT/delta_$t.sql.gz" || log "  ! $t 실패 — 계속"
  sleep "$SLEEP"
done

# ── C군(건너뜀): zipcode(정적 5.2만), g4_visit_sum(파생),
#     room_info_test/room_elec_temp/room_elec_backup/room_move_ch/course_copy(임시),
#     room_reserve_old(2.8M 과거 스냅샷), student_payment_export

# ── 신규 워터마크 기록 (다음 회차 입력값) ───────────────────────────────────
mysql --defaults-extra-file="$CNF" -N -B "$MYSQL_DB" > "$OUT/watermarks.txt" <<'SQL'
SELECT 'room_elec',            MAX(re_idx)     FROM room_elec;
SELECT 'room_change_log',      MAX(change_idx) FROM room_change_log;
SELECT 'student_info_history', MAX(snum)       FROM student_info_history;
SELECT 'room_move',            MAX(m_idx)      FROM room_move;
SELECT 'student_info_invoice', MAX(no)         FROM student_info_invoice;
SELECT 'reserve_info_history', MAX(sno)        FROM reserve_info_history;
SELECT 'student_change',       MAX(change_idx) FROM student_change;
SELECT 'g4_point',             MAX(po_id)      FROM g4_point;
SELECT 'g4_visit',             MAX(vi_id)      FROM g4_visit;
SQL

log "완료: $OUT"
du -sh "$OUT" | tee -a "$OUT/backup.log"
