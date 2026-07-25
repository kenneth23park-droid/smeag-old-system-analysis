# -*- coding: utf-8 -*-
"""
그날 반영된 Supabase 변경분 → 구전산(MySQL) import 용 changes.json 생성기.

파이프라인
    export_daily_changes.py  (여기, 읽기전용: Supabase 만 SELECT)
        └─ changes.json ─→  legacy_writeback.py --commit --yes  (구전산 MySQL UPDATE)

이 스크립트는 Supabase(Postgres)를 **읽기만** 한다(원본·Supabase 모두 미변경).
산출물 changes.json 은 legacy_writeback.py 가 먹는 형식과 100% 동일:
    [{"table":"student_info","pk":{"s_idx":123},"set":{"s_room":"CAPITAL2 508"}}, ...]

────────────────────────────────────────────────────────────────────────
"그날 무엇이 바뀌었나"를 잡는 방법 (--source)
────────────────────────────────────────────────────────────────────────
  1) changelog (기본·권장)
     신전산 앱이 저장할 때마다 app.change_log 에 한 줄 남긴다고 가정.
       app.change_log(
         id bigint, target_table text, target_pk jsonb,
         changed_cols jsonb,          -- {"s_room":"CAPITAL2 508", ...}
         changed_at timestamptz default now(), actor text)
     → 그날치(changed_at::date = 대상일) 를 그대로 읽어 changes.json 생성.
     가장 정확하고 가벼움. "그날 반영분"의 정의가 명확해짐.

  2) column (폴백)
     대상 테이블에 갱신시각 컬럼(예: updated_at)이 있을 때,
       WHERE <ts_col>::date = 대상일
     로 그 행의 지정 컬럼(--cols)만 통째로 export. (변경된 컬럼 특정 불가 → 지정컬럼 전부)

────────────────────────────────────────────────────────────────────────
매핑: 이관은 '충실 리프트'라 Supabase legacy 스키마의 테이블/컬럼명이
      MySQL 과 동일 → 기본은 identity 매핑. 필요 시 MAPPING 에서 재정의.
────────────────────────────────────────────────────────────────────────

의존성: pip install psycopg2-binary
사용:
    export PG_PASS=...           # Supabase 접속 (config.py PG 재사용)
    # 1) 그날(어제) 변경분 미리보기 → changes.json
    python export_daily_changes.py --date 2026-07-25 --out changes.json
    # 2) 곧바로 구전산 반영은 legacy_writeback 이 담당(별도 실행, 명시적 --commit --yes)
    python legacy_writeback.py --changes changes.json            # dry-run
    python legacy_writeback.py --changes changes.json --commit --yes
"""
import os
import sys
import json
import argparse
import datetime

# config.PG(접속정보) 재사용 — 없으면 env 로만 동작
try:
    from config import PG
except Exception:
    PG = dict(
        host=os.getenv("PG_HOST", "aws-0-ap-northeast-1.pooler.supabase.com"),
        port=int(os.getenv("PG_PORT", "5432")),
        dbname=os.getenv("PG_DB", "postgres"),
        user=os.getenv("PG_USER", ""),
        password=os.getenv("PG_PASS", ""),
        sslmode=os.getenv("PG_SSLMODE", "require"),
    )

# ── legacy_writeback 과 반드시 일치: 구전산에 쓸 수 있는 테이블 + PK ──
#   (여기서 벗어나면 writeback 단계에서 검증 거부됨)
ALLOW_TABLES = {"student_info", "student_change", "reserve_info", "student_payment"}
TABLE_PK = {
    "student_info": ["s_idx"],
    "student_change": ["idx"],
    "reserve_info": ["idx"],
    "student_payment": ["idx"],
}
FORBIDDEN_SET_COLS = set(sum(TABLE_PK.values(), []))  # PK 는 SET 금지

# ── Supabase 스키마(충실 리프트). 테이블/컬럼명은 MySQL 과 동일하다고 가정 ──
SB_SCHEMA = os.getenv("SB_SCHEMA", "legacy")

# ── 매핑 재정의(필요 시). {sb_table: {"mysql": name, "cols": {sb_col: mysql_col}}} ──
#   비어 있으면 identity(테이블·컬럼 동일). 컬럼명이 바뀐 경우에만 채운다.
MAPPING = {
    # 예) "student_info": {"mysql": "student_info", "cols": {"s_room_new": "s_room"}},
}


def _map_table(sb_table):
    m = MAPPING.get(sb_table, {})
    return m.get("mysql", sb_table)


def _map_col(sb_table, sb_col):
    m = MAPPING.get(sb_table, {})
    return m.get("cols", {}).get(sb_col, sb_col)


def connect():
    try:
        import psycopg2
        import psycopg2.extras  # noqa
    except ImportError:
        sys.exit("[중단] psycopg2 필요:  pip install psycopg2-binary")
    if not PG.get("password"):
        sys.exit("[중단] PG_PASS(Supabase 비밀번호) 필요 — env 로 주입")
    import psycopg2
    return psycopg2.connect(**PG)


def _as_change(sb_table, pk_dict, set_dict):
    """검증 통과한 changes.json 항목 하나. 문제 있으면 (None, 사유)."""
    my_table = _map_table(sb_table)
    if my_table not in ALLOW_TABLES:
        return None, f"허용외 테이블 {my_table}"
    pk_cols = TABLE_PK.get(my_table, [])
    pk = {}
    for k, v in (pk_dict or {}).items():
        mk = _map_col(sb_table, k)
        if mk in pk_cols:
            pk[mk] = v
    if not pk:
        return None, f"PK({pk_cols}) 미포함"
    setv = {}
    for k, v in (set_dict or {}).items():
        mk = _map_col(sb_table, k)
        if mk in FORBIDDEN_SET_COLS:      # PK 는 SET 금지
            continue
        if mk in pk:                       # PK 는 WHERE 로만
            continue
        setv[mk] = v
    if not setv:
        return None, "변경할 컬럼 없음(PK 제외 후 공백)"
    return {"table": my_table, "pk": pk, "set": setv}, None


def from_changelog(cur, day):
    """app.change_log 에서 그날치 읽기 → [(sb_table, pk, set), ...]"""
    log_table = os.getenv("SB_CHANGELOG", "app.change_log")
    cur.execute(
        f"""SELECT target_table, target_pk, changed_cols
              FROM {log_table}
             WHERE changed_at::date = %s
             ORDER BY id""",
        (day,),
    )
    out = []
    for r in cur.fetchall():
        tbl, pk, cols = r[0], r[1], r[2]
        pk = pk if isinstance(pk, dict) else json.loads(pk or "{}")
        cols = cols if isinstance(cols, dict) else json.loads(cols or "{}")
        out.append((tbl, pk, cols))
    return out


def from_column(cur, day, tables, ts_col, cols):
    """updated_at 류 컬럼 기준으로 그날 갱신된 행의 지정 컬럼 전부 export."""
    if not cols:
        sys.exit("[중단] --source column 은 --cols 필수 (export 할 컬럼 지정)")
    out = []
    for sb_table in tables:
        my = _map_table(sb_table)
        pk_cols = TABLE_PK.get(my, [])
        sel = list(dict.fromkeys(pk_cols + cols))  # pk + 대상컬럼
        collist = ", ".join(f'"{c}"' for c in sel)
        cur.execute(
            f'SELECT {collist} FROM "{SB_SCHEMA}"."{sb_table}" '
            f'WHERE "{ts_col}"::date = %s',
            (day,),
        )
        names = [d[0] for d in cur.description]
        for row in cur.fetchall():
            d = dict(zip(names, row))
            pk = {c: d[c] for c in pk_cols if c in d}
            setv = {c: d[c] for c in cols if c in d}
            out.append((sb_table, pk, setv))
    return out


def main():
    ap = argparse.ArgumentParser(
        description="그날 Supabase 변경분 → 구전산 import 용 changes.json 생성(읽기전용)")
    ap.add_argument("--date", help="대상일 YYYY-MM-DD (기본: 어제)")
    ap.add_argument("--out", default="changes.json", help="산출 JSON 경로")
    ap.add_argument("--source", choices=["changelog", "column"], default="changelog",
                    help="변경분 탐지 방식 (기본 changelog)")
    ap.add_argument("--tables", nargs="*", default=sorted(ALLOW_TABLES),
                    help="column 방식일 때 대상 테이블")
    ap.add_argument("--ts-col", default="updated_at",
                    help="column 방식의 갱신시각 컬럼명")
    ap.add_argument("--cols", nargs="*", default=[],
                    help="column 방식에서 export 할 컬럼(예: s_room s_regdate)")
    args = ap.parse_args()

    if args.date:
        day = args.date
    else:
        # Date.now 미사용 환경 대비: --date 미지정 시 env 또는 명시 요구
        day = os.getenv("EXPORT_DATE")
        if not day:
            sys.exit("[중단] --date YYYY-MM-DD 를 지정하세요 (대상일).")

    conn = connect()
    raw, skipped = [], []
    try:
        with conn.cursor() as cur:
            if args.source == "changelog":
                triples = from_changelog(cur, day)
            else:
                triples = from_column(cur, day, args.tables, args.ts_col, args.cols)
    finally:
        conn.close()

    changes = []
    for sb_table, pk, setv in triples:
        item, why = _as_change(sb_table, pk, setv)
        if item:
            changes.append(item)
        else:
            skipped.append({"table": sb_table, "pk": pk, "why": why})

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(changes, f, ensure_ascii=False, indent=2, default=str)

    print(f"== export 완료 · 대상일 {day} · source={args.source} ==")
    print(f"  생성 {len(changes)}건 → {args.out}")
    if skipped:
        print(f"  제외 {len(skipped)}건 (아래 최대 10건):")
        for s in skipped[:10]:
            print(f"    - {s['table']} {s['pk']}: {s['why']}")
    print("\n다음 단계(구전산 반영):")
    print(f"  python legacy_writeback.py --changes {args.out}                 # dry-run(안전)")
    print(f"  python legacy_writeback.py --changes {args.out} --commit --yes  # 실반영")


if __name__ == "__main__":
    main()
