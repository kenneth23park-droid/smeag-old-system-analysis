# -*- coding: utf-8 -*-
"""
구전산(레거시 MySQL) 역방향 업데이트 도구 — 안전모드 기본(DRY-RUN).

⚠️ 경고
   이 스크립트는 이 프로젝트의 기존 원칙 **"이관 단방향·원본 불가침"** 을
   의도적으로 벗어나, 레거시 **운영 MySQL 에 UPDATE 쓰기**를 수행할 수 있습니다.
   구전산(smeadmin.com)은 실운영 시스템이므로 반드시 아래 안전장치를 지켜 사용하세요.

설계된 안전장치
   1) 접속정보는 환경변수로만 주입 — 코드에 자격증명 하드코딩 금지
   2) 기본 DRY-RUN(실제 미실행). 실제 반영은 --commit AND --yes 둘 다 있어야 함
   3) UPDATE 대상 행의 변경 전 값(before-image)을 JSONL 로 백업 → 롤백 근거
   4) 감사로그(writeback_audit_*.jsonl): 누가/언제/무엇을
   5) 화이트리스트 테이블만 허용, PK 는 SET 금지, DELETE/DDL 불가(UPDATE 전용)
   6) 멱등: 현재값과 동일하면 skip (중복 반영 방지)
   7) 트랜잭션 일괄 처리 + 최대 행수 제한(--limit) + PK 없는 변경 거부

사용법
   export MYSQL_HOST=... MYSQL_PORT=3306 MYSQL_USER=... MYSQL_PASS=... MYSQL_DB=...
   # 1) 미리보기(안전, 실제 미반영)
   python legacy_writeback.py --changes changes.json
   # 2) 실제 반영(명시적, 위험)
   python legacy_writeback.py --changes changes.json --commit --yes

changes.json 형식 (배열)
   [
     {"table":"student_info","pk":{"s_idx":12345},
      "set":{"s_room":"CAPITAL2 508","s_regdate":"2026-07-25","s_jumin":"920101-1xxxxxx"}},
     ...
   ]

의존성: pip install pymysql
"""
import os, sys, json, argparse, datetime

# ── 안전: 쓰기 허용 테이블 화이트리스트(운영 정본만, 필요 시 신중히 확장) ──
ALLOW_TABLES = {"student_info", "student_change", "reserve_info", "student_payment"}
# PK 로만 쓰일 수 있는 컬럼(테이블별) — WHERE 에 반드시 이 중 하나가 있어야 함
TABLE_PK = {
    "student_info": ["s_idx"],
    "student_change": ["idx"],
    "reserve_info": ["idx"],
    "student_payment": ["idx"],
}
FORBIDDEN_SET_COLS = set(sum(TABLE_PK.values(), []))  # PK 는 SET 금지


def _env(name, default=None, required=False):
    v = os.getenv(name, default)
    if required and not v:
        sys.exit(f"[중단] 환경변수 {name} 필요 (접속정보는 env 로만 주입)")
    return v


def connect():
    try:
        import pymysql
    except ImportError:
        sys.exit("[중단] pymysql 필요:  pip install pymysql")
    return pymysql.connect(
        host=_env("MYSQL_HOST", required=True),
        port=int(_env("MYSQL_PORT", "3306")),
        user=_env("MYSQL_USER", required=True),
        password=_env("MYSQL_PASS", "") or "",
        database=_env("MYSQL_DB", required=True),
        charset="utf8mb4",
        autocommit=False,            # 트랜잭션 수동 제어
        connect_timeout=10,
        cursorclass=__import__("pymysql").cursors.DictCursor,
    )


def validate(ch, i):
    """단일 변경 항목 검증. 문제 있으면 사유 문자열 반환, 없으면 None."""
    t = ch.get("table")
    if t not in ALLOW_TABLES:
        return f"허용되지 않은 테이블: {t} (화이트리스트: {sorted(ALLOW_TABLES)})"
    pk = ch.get("pk") or {}
    if not pk:
        return "pk 없음 — WHERE 없이 대량변경 방지를 위해 거부"
    if not any(k in pk for k in TABLE_PK.get(t, [])):
        return f"pk 에 정본 키({TABLE_PK.get(t)}) 없음 — 거부"
    setv = ch.get("set") or {}
    if not setv:
        return "set 비어있음"
    bad = [c for c in setv if c in FORBIDDEN_SET_COLS]
    if bad:
        return f"PK 컬럼은 SET 금지: {bad}"
    return None


def main():
    ap = argparse.ArgumentParser(description="레거시 MySQL 역방향 UPDATE(안전모드 기본 dry-run)")
    ap.add_argument("--changes", required=True, help="변경목록 JSON 경로")
    ap.add_argument("--commit", action="store_true", help="실제 DB 반영(미지정 시 DRY-RUN)")
    ap.add_argument("--yes", action="store_true", help="--commit 과 함께 필수(오작동 방지 이중확인)")
    ap.add_argument("--limit", type=int, default=500, help="최대 처리 행수(안전한도)")
    args = ap.parse_args()

    with open(args.changes, encoding="utf-8") as f:
        changes = json.load(f)
    if not isinstance(changes, list):
        sys.exit("[중단] changes 는 배열이어야 함")
    if len(changes) > args.limit:
        sys.exit(f"[중단] 변경 {len(changes)}건 > 한도 {args.limit}. --limit 로 상향(신중).")

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    live = args.commit and args.yes
    mode = "COMMIT(실반영)" if live else ("DRY-RUN(--yes 없음)" if args.commit else "DRY-RUN(미리보기)")
    print(f"== 레거시 역방향 업데이트 [{mode}] · 대상 {len(changes)}건 · {ts} ==")

    # 검증 먼저(전량)
    errs = [(i, validate(c, i)) for i, c in enumerate(changes)]
    errs = [(i, e) for i, e in errs if e]
    if errs:
        for i, e in errs[:20]:
            print(f"  [검증실패] #{i}: {e}")
        sys.exit(f"[중단] 검증 실패 {len(errs)}건 — 수정 후 재실행")

    conn = connect()
    bpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"writeback_backup_{ts}.jsonl")
    apath = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"writeback_audit_{ts}.jsonl")
    who = _env("MYSQL_USER", "?")
    applied = skipped = 0
    try:
        with conn.cursor() as cur, open(bpath, "w", encoding="utf-8") as bf, open(apath, "w", encoding="utf-8") as af:
            for i, ch in enumerate(changes):
                t, pk, setv = ch["table"], ch["pk"], ch["set"]
                where = " AND ".join(f"`{k}`=%s" for k in pk)
                wvals = list(pk.values())
                # 현재값(before-image) 조회
                cols = ",".join(f"`{c}`" for c in setv)
                cur.execute(f"SELECT {cols} FROM `{t}` WHERE {where} LIMIT 2", wvals)
                rows = cur.fetchall()
                if len(rows) == 0:
                    print(f"  #{i} {t}{pk}: 대상행 없음 → skip"); skipped += 1; continue
                if len(rows) > 1:
                    print(f"  #{i} {t}{pk}: WHERE 가 {len(rows)}행 매칭 → 안전상 skip"); skipped += 1; continue
                before = rows[0]
                # 멱등: 이미 동일하면 skip
                if all(str(before.get(c)) == str(v) for c, v in setv.items()):
                    print(f"  #{i} {t}{pk}: 값 동일 → skip(멱등)"); skipped += 1; continue
                bf.write(json.dumps({"table": t, "pk": pk, "before": before, "set": setv}, ensure_ascii=False, default=str) + "\n")
                sql = f"UPDATE `{t}` SET " + ",".join(f"`{c}`=%s" for c in setv) + f" WHERE {where}"
                params = list(setv.values()) + wvals
                if live:
                    cur.execute(sql, params)
                    af.write(json.dumps({"at": ts, "by": who, "table": t, "pk": pk, "set": setv}, ensure_ascii=False, default=str) + "\n")
                    print(f"  #{i} {t}{pk}: UPDATE {list(setv)} ✔")
                else:
                    print(f"  #{i} {t}{pk}: [DRY-RUN] {sql}  -- {params}")
                applied += 1
        if live:
            conn.commit()
            print(f"\n✔ 커밋 완료 · 반영 {applied} · skip {skipped}\n  백업(before): {bpath}\n  감사로그: {apath}")
            print("  롤백이 필요하면 백업 JSONL 의 before 값으로 재-UPDATE 하세요.")
        else:
            conn.rollback()
            print(f"\n(DRY-RUN) 반영 예정 {applied} · skip {skipped} · 실제 변경 없음."
                  f"\n실제 반영하려면:  --commit --yes")
    except Exception as e:
        conn.rollback()
        sys.exit(f"[오류·전체 롤백] {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
