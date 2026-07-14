# -*- coding: utf-8 -*-
"""
결정 C 특수 핸들러: g4_score(1593컬럼) → EAV 적재.
core(좁은 회원표) + values(롱포맷) 로 분해하여 COPY. 원본 .sql 읽기 전용.

사용:
  python scripts/g4_score_eav.py            # dry-run(계획만)
  python scripts/g4_score_eav.py --execute
"""
import os
import io
import sys
import argparse
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import config as C
from mysql_dump import parse_ddl, iter_rows
from transforms import copy_escape, clean_value

CORE_COLS = ["mb_no", "mb_id", "mb_name", "mb_nick", "mb_level", "mb_email", "mb_datetime"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    dry = not args.execute

    path = os.path.join(C.SQL_DIR, "g4_score.sql")
    ddl = parse_ddl(path)
    all_cols = ddl.colnames
    attr_cols = [c for c in all_cols if c not in CORE_COLS]
    print("g4_score: 전체 %d컬럼 → core %d + EAV attr %d"
          % (len(all_cols), len(CORE_COLS), len(attr_cols)))
    if dry:
        print("DRY-RUN: 적재 없음. --execute 로 실행.")
        return
    if not C.PG["password"]:
        print("!! PG_PASS 미설정"); sys.exit(2)

    conn = psycopg2.connect(**C.PG); conn.autocommit = False
    cur = conn.cursor()
    idx = {c: i for i, c in enumerate(all_cols)}
    core_buf, val_buf = io.StringIO(), io.StringIO()
    n = nv = 0
    try:
        _, rows = iter_rows(path)
        for vals in rows:
            mb_no = vals[idx["mb_no"]]
            core_buf.write("\t".join(
                copy_escape(clean_value(vals[idx[c]], "timestamptz" if c == "mb_datetime" else "text", c))
                for c in CORE_COLS) + "\n")
            for c in attr_cols:
                v = clean_value(vals[idx[c]], "text", c)
                if v is None or v == "":
                    continue                      # 빈값은 EAV 에 저장 안함(희소성 활용)
                val_buf.write("%s\t%s\t%s\n" % (copy_escape(mb_no), copy_escape(c), copy_escape(v)))
                nv += 1
            n += 1
        core_buf.seek(0); val_buf.seek(0)
        cur.copy_expert("COPY cms.member_score_core (%s) FROM STDIN" % ", ".join(CORE_COLS), core_buf)
        cur.copy_expert("COPY cms.member_score_values (mb_no, attr_key, attr_val) FROM STDIN", val_buf)
        conn.commit()
        print("OK: core %d행, values %d행" % (n, nv))
    except Exception as e:
        conn.rollback(); print("ERROR:", e)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
