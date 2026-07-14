# -*- coding: utf-8 -*-
"""MySQL DDL → Postgres CREATE TABLE 생성 (결정 5·6·7 반영)."""
from config import norm_ident
from transforms import map_type, enum_values


def build_create(ddl, schema: str):
    """TableDDL → (create_sql, pg_types[], colnames[]). FK 없음(원본 MyISAM)→ PK만, FK는 후처리 SQL."""
    tname = norm_ident(ddl.name)
    cols_sql, pg_types, colnames, checks = [], [], [], []
    for (col, mtype, nullable, default) in ddl.columns:
        cname = col.replace("-", "_")
        pgt = map_type(mtype)
        pg_types.append(pgt)
        colnames.append(col)   # 원본 컬럼명(파싱/매칭용)
        line = '  "%s" %s' % (cname, pgt)
        cols_sql.append(line)
        ev = enum_values(mtype)
        if ev and mtype.strip().lower().startswith("enum"):
            # (결정 5) enum → CHECK. 단, 레거시 NOT NULL enum 에 빈 문자열('')이
            # 저장된 사례가 있어 ''도 허용(원본 데이터 무손실 보존).
            allowed = list(dict.fromkeys(list(ev) + [""]))
            vals = ", ".join("'%s'" % v.replace("'", "''") for v in allowed)
            checks.append('  CONSTRAINT "chk_%s_%s" CHECK ("%s" IS NULL OR "%s" IN (%s))'
                          % (tname, cname, cname, cname, vals))
        # set 타입은 조합값('a,b')이 가능하므로 IN CHECK 부적합 → 생략(text 보존)
    pk = ""
    if ddl.pk:
        pkcols = ", ".join('"%s"' % c.replace("-", "_") for c in ddl.pk)
        pk = ',\n  PRIMARY KEY (%s)' % pkcols
    body = ",\n".join(cols_sql)
    if checks:
        body += ",\n" + ",\n".join(checks)
    sql = 'CREATE TABLE IF NOT EXISTS "%s"."%s" (\n%s%s\n);' % (schema, tname, body, pk)
    return sql, pg_types, colnames
