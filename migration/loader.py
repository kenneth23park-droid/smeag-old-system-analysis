# -*- coding: utf-8 -*-
"""
단일 테이블 워커 — 원본 .sql 스트리밍 → 변환 → Supabase COPY 적재.
멱등: DROP TABLE IF EXISTS 후 재생성(legacy/cms 스키마 한정). 원본은 절대 미변경.
대용량 전략: 인덱스 없이 COPY 후, 제약/인덱스는 orchestrator 후처리.
"""
import io
import os
import time
import psycopg2

from config import PG, route_schema, norm_ident, SPECIAL_TABLES, COPY_BATCH
from mysql_dump import parse_ddl, iter_rows
from pg_ddl import build_create
from transforms import row_to_copy_line


def _connect():
    return psycopg2.connect(**PG)


def load_table(sql_path: str, dry_run: bool = True) -> dict:
    """반환: {table, rows, seconds, status}. dry_run 이면 DDL/계획만 생성, 적재 없음."""
    t0 = time.time()
    ddl = parse_ddl(sql_path)
    table = ddl.name
    if table in SPECIAL_TABLES:
        return {"table": table, "rows": 0, "seconds": 0,
                "status": "SKIP-special(%s)" % SPECIAL_TABLES[table]}

    schema = route_schema(table)
    create_sql, pg_types, colnames = build_create(ddl, schema)
    target = '"%s"."%s"' % (schema, norm_ident(table))

    if dry_run:
        return {"table": table, "rows": None, "seconds": round(time.time() - t0, 2),
                "status": "DRY-RUN", "schema": schema, "ddl": create_sql}

    cols_holder, rows = iter_rows(sql_path)
    conn = _connect()
    conn.autocommit = False
    total = 0
    try:
        cur = conn.cursor()
        cur.execute('CREATE SCHEMA IF NOT EXISTS "%s";' % schema)
        cur.execute('DROP TABLE IF EXISTS %s CASCADE;' % target)
        cur.execute(create_sql)

        collist = ", ".join('"%s"' % c.replace("-", "_") for c in cols_holder["cols"])
        copy_sql = "COPY %s (%s) FROM STDIN WITH (FORMAT text)" % (target, collist)

        buf = io.StringIO()
        n_buf = 0
        for vals in rows:
            buf.write(row_to_copy_line(vals, pg_types, colnames))
            n_buf += 1
            total += 1
            if n_buf >= COPY_BATCH:
                buf.seek(0)
                cur.copy_expert(copy_sql, buf)
                buf = io.StringIO()
                n_buf = 0
        if n_buf:
            buf.seek(0)
            cur.copy_expert(copy_sql, buf)

        conn.commit()
        return {"table": table, "rows": total, "seconds": round(time.time() - t0, 2),
                "status": "OK", "schema": schema}
    except Exception as e:
        conn.rollback()
        return {"table": table, "rows": total, "seconds": round(time.time() - t0, 2),
                "status": "ERROR: %s" % e, "schema": schema}
    finally:
        conn.close()
