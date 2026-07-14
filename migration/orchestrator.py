# -*- coding: utf-8 -*-
"""
이관 오케스트레이터 — 병렬(worker pool) + 단계 DAG.

페이즈:
  0  schema/00_init.sql        스키마·도메인 마스터 준비 (SQL, 순차)
  1  대용량 독립 테이블         병렬 로드 (PHASE_BIG)
  2  나머지 업무 테이블         병렬 로드 (legacy)
  3  CMS g4_* (결정 B)          병렬 로드 (cms)
  4  후처리 SQL(순차):
       schema/reservations.sql  (결정 A) reserve_info 정본 → dorm_* 모델 + 호환뷰
       schema/g4_score_eav.sql  (결정 C) g4_score 1593컬럼 → EAV
       security/rls.sql         (결정 E) RLS + PII 마스킹뷰
       schema/constraints.sql   FK/인덱스 (결정 7)

기본은 DRY-RUN. 실제 적재는 --execute 필요.  원본 sql/*.sql 은 읽기 전용.
사용:
  python orchestrator.py                 # 계획/DDL 미리보기(dry-run)
  python orchestrator.py --execute        # 실제 이관
  python orchestrator.py --only room_elec --execute
  python orchestrator.py --phase 1,2 --execute
"""
import os
import sys
import glob
import argparse
import concurrent.futures as cf

import config as C
from loader import load_table

HERE = os.path.dirname(__file__)


def discover():
    """sql/ 에서 이관 대상 파일 목록(결정 D 제외 반영)."""
    files = {}
    for p in glob.glob(os.path.join(C.SQL_DIR, "*.sql")):
        name = os.path.splitext(os.path.basename(p))[0]
        if name in C.EXCLUDE_TABLES:
            continue
        files[name] = p
    return files


def plan(files):
    """페이즈별 테이블 배치."""
    big  = [t for t in files if t in C.PHASE_BIG and not t.startswith("g4_")]
    cms  = [t for t in files if t.startswith("g4_")]
    rest = [t for t in files if t not in C.PHASE_BIG and not t.startswith("g4_")]
    return {1: big, 2: rest, 3: cms}


def run_sql_file(rel, dry_run):
    path = os.path.join(HERE, rel)
    if not os.path.exists(path):
        return "MISSING %s" % rel
    if dry_run:
        return "DRY-RUN sql %s" % rel
    import psycopg2
    conn = psycopg2.connect(**C.PG)
    conn.autocommit = True
    try:
        with open(path, "r", encoding="utf-8") as f:
            conn.cursor().execute(f.read())
        return "OK sql %s" % rel
    except Exception as e:
        return "ERROR sql %s: %s" % (rel, e)
    finally:
        conn.close()


def run_phase(tables, files, dry_run, workers):
    results = []
    if not tables:
        return results
    with cf.ProcessPoolExecutor(max_workers=workers) as ex:
        fut = {ex.submit(load_table, files[t], dry_run): t for t in tables}
        for f in cf.as_completed(fut):
            r = f.result()
            results.append(r)
            mark = "✓" if str(r["status"]).startswith(("OK", "DRY")) else "✗"
            print("  %s [%s] %-24s rows=%s %ss %s"
                  % (mark, r.get("schema", "-"), r["table"], r["rows"],
                     r["seconds"], "" if r["status"] in ("OK", "DRY-RUN") else r["status"]))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true", help="실제 적재(미지정=dry-run)")
    ap.add_argument("--phase", default="0,1,2,3,4", help="실행 페이즈 CSV")
    ap.add_argument("--only", default="", help="특정 테이블만(CSV)")
    ap.add_argument("--workers", type=int, default=C.MAX_WORKERS)
    args = ap.parse_args()
    dry = not args.execute
    phases = set(args.phase.split(","))

    if dry:
        print("=== DRY-RUN (실제 적재 안함). 실행하려면 --execute ===")
    if not C.PG["password"] and args.execute:
        print("!! PG_PASS 미설정 — .env 로 주입 후 실행"); sys.exit(2)

    files = discover()
    for t in C.REVIEW_TABLES & set(files):
        print("  ⚠ 검토대상 포함:", t)
    if args.only:
        only = set(args.only.split(","))
        files = {k: v for k, v in files.items() if k in only}

    ph = plan(files)

    if "0" in phases:
        print("\n[Phase 0] 스키마/마스터 준비")
        print("  ", run_sql_file("schema/00_init.sql", dry))
    for pnum in (1, 2, 3):
        if str(pnum) in phases:
            label = {1: "대용량 병렬", 2: "업무 테이블 병렬", 3: "CMS g4_* 병렬"}[pnum]
            print("\n[Phase %d] %s (%d개, workers=%d)" % (pnum, label, len(ph[pnum]), args.workers))
            run_phase(ph[pnum], files, dry, args.workers)
    if "4" in phases:
        print("\n[Phase 4] 모델링·보안 후처리 (순차)")
        for rel in ("schema/reservations.sql", "schema/g4_score_eav.sql",
                    "security/rls.sql", "schema/constraints.sql"):
            print("  ", run_sql_file(rel, dry))

    print("\n완료(%s)." % ("dry-run" if dry else "execute"))


if __name__ == "__main__":
    main()
