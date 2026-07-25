# -*- coding: utf-8 -*-
"""
구 MySQL 백업 → Supabase **전체 원샷 이관 + 100% 검증 + 리포트**.

무엇을 하나
  1) 백업(sql 덤프 디렉터리 또는 단일 통합 .sql)을 받아
  2) 스키마 준비(phase0) → 대용량/업무/CMS 병렬 적재(phase1~3) → 모델링·보안 후처리(phase4)
     를 **한 번에** 실행하고,
  3) 테이블별 **원본행수 = 적재행수 = Supabase행수** 를 대조해 100% 여부를 검증하고,
  4) 사람이 읽는 리포트(.md) + 기계용(.json) 을 생성한다.

원칙(불변)
  · 원본(sql/*.sql, MySQL 덤프)은 **읽기 전용**. 오직 Supabase 쪽에만 쓴다.
  · 기본 DRY-RUN(계획·원본행수·라우팅만). 실제 적재는 --execute.
  · 하나라도 불일치/에러면 **종료코드 ≠ 0** (에러없는 100% 이전을 강제).

사용
  # 0) 접속(.env 의 PG_PASS 자동 로드되거나 env 로 주입)
  export PG_PASS=...
  # 1) 미리보기(원본행수·라우팅·리포트 초안, DB 미변경)
  python migrate_all.py --backup ../sql
  # 2) 실제 전체 이관 + 검증 + 리포트
  python migrate_all.py --backup ../sql --execute
  # 단일 통합 덤프 파일도 가능(자동 테이블 분할)
  python migrate_all.py --backup ../backup/smeadmin_full.sql --execute

의존성: pip install psycopg2-binary
"""
import os
import sys
import glob
import time
import json
import shutil
import argparse
import datetime
import concurrent.futures as cf

import config as C
from loader import load_table
from mysql_dump import _INSERT_RE
from orchestrator import run_sql_file  # 재사용(후처리 SQL 실행기)

HERE = os.path.dirname(os.path.abspath(__file__))
REPORT_DIR = os.path.join(HERE, "reports")

# phase4 후처리 순서(orchestrator 와 동일)
POST_SQL = ("schema/reservations.sql", "schema/actual_checkout.sql",
            "schema/g4_score_eav.sql", "security/rls.sql", "schema/constraints.sql")


# ────────────────────────────────────────────────────────────────
# 백업 입력 해석: 디렉터리(테이블별 .sql) 또는 단일 통합 .sql(자동 분할)
# ────────────────────────────────────────────────────────────────
def resolve_backup(backup, workdir):
    """반환: {table: path}. 단일 통합덤프면 workdir 에 테이블별로 쪼갠다."""
    if os.path.isdir(backup):
        files = {}
        for p in glob.glob(os.path.join(backup, "*.sql")):
            name = os.path.splitext(os.path.basename(p))[0]
            files[name] = p
        return files
    if os.path.isfile(backup):
        return _split_combined(backup, workdir)
    sys.exit(f"[중단] 백업 경로 없음: {backup}")


def _split_combined(path, workdir):
    """단일 통합 .sql 을 CREATE TABLE 경계로 테이블별 파일로 분할."""
    import re
    cre = re.compile(r"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([^`]+)`", re.I)
    os.makedirs(workdir, exist_ok=True)
    files, cur_name, cur_f = {}, None, None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = cre.search(line)
            if m:
                if cur_f:
                    cur_f.close()
                cur_name = m.group(1)
                out = os.path.join(workdir, cur_name + ".sql")
                files[cur_name] = out
                cur_f = open(out, "w", encoding="utf-8")
            if cur_f:
                cur_f.write(line)
    if cur_f:
        cur_f.close()
    if not files:
        sys.exit(f"[중단] 통합덤프에서 CREATE TABLE 을 못 찾음: {path}")
    return files


# ────────────────────────────────────────────────────────────────
# 원본행수(독립 카운트) — 파서 드롭 감지용 교차검증
#   가정: SMEAG 덤프는 튜플 1줄=1행. (파서 docstring 명시)
# ────────────────────────────────────────────────────────────────
def source_rows(path):
    n, in_values = 0, False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not in_values:
                m = _INSERT_RE.match(line)
                if m:
                    in_values = True
                    rest = line[m.end():].strip()
                    if rest.startswith("("):
                        n += 1
                        if rest.endswith(";"):
                            in_values = False
                continue
            s = line.strip()
            if not s:
                continue
            if s.startswith("("):
                n += 1
                if s.endswith(";"):
                    in_values = False
            elif s.endswith(";"):
                in_values = False
    return n


# ────────────────────────────────────────────────────────────────
# 대상(Supabase) 행수
# ────────────────────────────────────────────────────────────────
def target_rows(conn, schema, table):
    tbl = C.norm_ident(table)
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT count(*) FROM "%s"."%s"' % (schema, tbl))
            return cur.fetchone()[0]
    except Exception as e:
        return "ERR:%s" % str(e).splitlines()[0][:80]


# ────────────────────────────────────────────────────────────────
# 페이즈 계획(orchestrator.plan 과 동일 규칙, 제외/특수 반영)
# ────────────────────────────────────────────────────────────────
def plan_phases(files):
    tabs = {t: p for t, p in files.items() if t not in C.EXCLUDE_TABLES}
    big  = [t for t in tabs if t in C.PHASE_BIG and not t.startswith("g4_")]
    cms  = [t for t in tabs if t.startswith("g4_")]
    rest = [t for t in tabs if t not in C.PHASE_BIG and not t.startswith("g4_")]
    return tabs, {1: big, 2: rest, 3: cms}


def load_phase(tables, files, dry, workers):
    res = {}
    if not tables:
        return res
    with cf.ProcessPoolExecutor(max_workers=workers) as ex:
        fut = {ex.submit(load_table, files[t], dry): t for t in tables}
        for f in cf.as_completed(fut):
            t = fut[f]
            r = f.result()
            res[t] = r
            mark = "✓" if str(r["status"]).startswith(("OK", "DRY", "SKIP")) else "✗"
            print("  %s [%s] %-26s loaded=%s %ss %s" % (
                mark, r.get("schema", "-"), r["table"], r.get("rows"),
                r.get("seconds"), "" if r["status"] in ("OK", "DRY-RUN") else r["status"]))
    return res


# ────────────────────────────────────────────────────────────────
# 리포트 렌더
# ────────────────────────────────────────────────────────────────
def render_md(rep):
    L = []
    ok = rep["overall_ok"]
    if rep["mode"] == "DRY-RUN":
        verdict = "🔎 DRY-RUN(미검증·계획만) — 실제 이관은 --execute"
    elif ok:
        verdict = "✅ 100% 일치(PASS)"
    else:
        verdict = "❌ 불일치/에러 있음(FAIL)"
    L.append("# 이관 리포트 — 구 MySQL → Supabase")
    L.append("")
    L.append(f"> 실행모드: **{rep['mode']}** · 시작 {rep['started']} · 소요 {rep['elapsed_s']}s")
    L.append(f"> 판정: **{verdict}**")
    L.append("")
    s = rep["summary"]
    L.append("## 요약")
    L.append("")
    L.append("| 지표 | 값 |")
    L.append("|---|---|")
    L.append(f"| 대상 테이블 | {s['tables']} |")
    L.append(f"| 검증 일치 | {s['matched']} |")
    L.append(f"| 불일치 | {s['mismatched']} |")
    L.append(f"| 에러/특수(검증제외) | {s['errored']} / {s['special']} |")
    L.append(f"| 원본 총행 | {s['src_total']:,} |")
    L.append(f"| 적재 총행 | {s['loaded_total']:,} |")
    L.append(f"| Supabase 총행 | {s['tgt_total'] if isinstance(s['tgt_total'],str) else format(s['tgt_total'], ',')} |")
    L.append("")
    L.append("## 테이블별 검증")
    L.append("")
    L.append("| 결과 | 스키마 | 테이블 | 원본행 | 적재행 | Supabase행 | 초 | 상태 |")
    L.append("|---|---|---|---:|---:|---:|---:|---|")
    for r in rep["tables"]:
        L.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["result"], r["schema"], r["table"],
            _fmt(r["src"]), _fmt(r["loaded"]), _fmt(r["tgt"]),
            r["seconds"], r["status"]))
    L.append("")
    if rep["mismatches"]:
        L.append("## ⚠️ 불일치/에러 상세 (조치 필요)")
        L.append("")
        for r in rep["mismatches"]:
            L.append(f"- **{r['table']}** ({r['schema']}): 원본 {_fmt(r['src'])} / 적재 {_fmt(r['loaded'])} / Supabase {_fmt(r['tgt'])} — {r['status']}")
        L.append("")
    L.append("## 후처리(모델링·보안) SQL")
    L.append("")
    L.append("| 파일 | 결과 |")
    L.append("|---|---|")
    for p in rep["post_sql"]:
        L.append(f"| {p['file']} | {p['result']} |")
    L.append("")
    L.append("## 제외/특수 처리")
    L.append("")
    for line in rep["notes"]:
        L.append(f"- {line}")
    L.append("")
    L.append("---")
    L.append(f"*생성 {rep['generated']} · migrate_all.py*")
    return "\n".join(L)


def _fmt(v):
    return format(v, ",") if isinstance(v, int) else str(v)


# ────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="구 MySQL 백업 → Supabase 전체 원샷 이관 + 검증 + 리포트")
    ap.add_argument("--backup", default=C.SQL_DIR, help="백업 경로(sql 디렉터리 또는 단일 통합 .sql)")
    ap.add_argument("--execute", action="store_true", help="실제 적재(미지정=DRY-RUN)")
    ap.add_argument("--workers", type=int, default=C.MAX_WORKERS)
    ap.add_argument("--phase", default="0,1,2,3,4", help="실행 페이즈 CSV(기본 전체)")
    args = ap.parse_args()

    dry = not args.execute
    phases = set(args.phase.split(","))
    ts = datetime.datetime.now()
    stamp = ts.strftime("%Y%m%d_%H%M%S")
    t0 = time.time()

    if args.execute and not C.PG.get("password"):
        sys.exit("[중단] PG_PASS 미설정 — .env 로 주입 후 실행")

    print(f"== 전체 이관 [{'DRY-RUN' if dry else 'EXECUTE'}] · 백업={args.backup} · {stamp} ==")

    workdir = os.path.join(REPORT_DIR, f"_split_{stamp}")
    files = resolve_backup(args.backup, workdir)
    tabs, ph = plan_phases(files)
    print(f"  대상 {len(tabs)}개 (제외 {len(set(files)&C.EXCLUDE_TABLES)}개) · "
          f"big={len(ph[1])} rest={len(ph[2])} cms={len(ph[3])}")

    notes = []
    for t in sorted(set(files) & C.EXCLUDE_TABLES):
        notes.append(f"제외(결정 D): {t}")
    for t in sorted(C.REVIEW_TABLES & set(tabs)):
        notes.append(f"검토대상 포함: {t}")
    for t in sorted(set(C.SPECIAL_TABLES) & set(tabs)):
        notes.append(f"특수처리({C.SPECIAL_TABLES[t]}): {t} — 1:1 행수검증 제외(후처리 SQL로 변환)")

    # ── phase 0 ──
    post = []
    if "0" in phases:
        print("\n[Phase 0] 스키마/마스터 준비")
        r = run_sql_file("schema/00_init.sql", dry)
        print("  ", r)

    # ── phase 1~3 적재 ──
    load_res = {}
    for pnum in (1, 2, 3):
        if str(pnum) in phases:
            label = {1: "대용량 병렬", 2: "업무 테이블 병렬", 3: "CMS g4_* 병렬"}[pnum]
            print(f"\n[Phase {pnum}] {label} ({len(ph[pnum])}개, workers={args.workers})")
            load_res.update(load_phase(ph[pnum], files, dry, args.workers))

    # ── phase 4 후처리 ──
    if "4" in phases:
        print("\n[Phase 4] 모델링·보안 후처리 (순차)")
        for rel in POST_SQL:
            r = run_sql_file(rel, dry)
            print("  ", r)
            post.append({"file": rel, "result": r})

    # ── 검증: 원본행 vs 적재행 vs Supabase행 ──
    print("\n[검증] 원본행 = 적재행 = Supabase행 대조")
    conn = None
    if not dry:
        import psycopg2
        conn = psycopg2.connect(**C.PG)

    rows = []
    src_total = loaded_total = tgt_total = 0
    matched = mismatched = errored = special = 0
    for t in sorted(tabs):
        schema = C.route_schema(t)
        src = source_rows(files[t])
        src_total += src
        lr = load_res.get(t, {})
        loaded = lr.get("rows")
        status = lr.get("status", "-")
        is_special = t in C.SPECIAL_TABLES

        if is_special:
            special += 1
            rows.append({"result": "특수", "schema": schema, "table": t,
                         "src": src, "loaded": loaded if loaded is not None else "-",
                         "tgt": "EAV", "seconds": lr.get("seconds", "-"),
                         "status": status})
            continue

        if dry:
            tgt = "-"
            result = "예정"
        else:
            tgt = target_rows(conn, schema, t)
            if isinstance(loaded, int):
                loaded_total += loaded
            if isinstance(tgt, int):
                tgt_total += tgt
            # 100% 판정: 원본 = 적재 = 대상
            if isinstance(tgt, int) and isinstance(loaded, int) and src == loaded == tgt:
                result = "✅"
                matched += 1
            elif isinstance(tgt, str):   # 대상 조회 에러
                result = "✗에러"
                errored += 1
            else:
                result = "✗불일치"
                mismatched += 1
        rows.append({"result": result, "schema": schema, "table": t,
                     "src": src, "loaded": loaded if loaded is not None else "-",
                     "tgt": tgt, "seconds": lr.get("seconds", "-"), "status": status})

    if conn:
        conn.close()

    mismatches = [r for r in rows if str(r["result"]).startswith("✗")]
    overall_ok = (not dry) and mismatched == 0 and errored == 0 and \
        all(str(p["result"]).startswith("OK") for p in post)

    rep = {
        "mode": "EXECUTE" if not dry else "DRY-RUN",
        "started": ts.strftime("%Y-%m-%d %H:%M:%S"),
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_s": round(time.time() - t0, 1),
        "backup": args.backup,
        "overall_ok": overall_ok,
        "summary": {
            "tables": len(tabs), "matched": matched, "mismatched": mismatched,
            "errored": errored, "special": special,
            "src_total": src_total, "loaded_total": loaded_total,
            "tgt_total": tgt_total if not dry else "-",
        },
        "tables": rows,
        "mismatches": mismatches,
        "post_sql": post,
        "notes": notes,
    }

    # ── 리포트 저장 ──
    os.makedirs(REPORT_DIR, exist_ok=True)
    md_path = os.path.join(REPORT_DIR, f"migration_report_{stamp}.md")
    js_path = os.path.join(REPORT_DIR, f"migration_report_{stamp}.json")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_md(rep))
    with open(js_path, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2, default=str)

    # 통합덤프 분할 임시본 정리
    if os.path.isdir(workdir):
        shutil.rmtree(workdir, ignore_errors=True)

    print("\n" + "=" * 60)
    if dry:
        print(f"DRY-RUN 완료 · 원본 총 {src_total:,}행 · 실제 이관은 --execute")
    elif overall_ok:
        print(f"✅ 이관 완료 · 100% 일치 ({matched}/{len(tabs)-special} 테이블, 특수 {special}) · {rep['elapsed_s']}s")
    else:
        print(f"❌ 이관 검증 실패 · 불일치 {mismatched} · 에러 {errored} — 리포트 확인 후 재실행")
    print(f"리포트: {md_path}")
    print(f"       {js_path}")
    print("=" * 60)

    # 에러없는 100% 이전 강제: 실패 시 종료코드 1
    sys.exit(0 if (dry or overall_ok) else 1)


if __name__ == "__main__":
    main()
