# -*- coding: utf-8 -*-
"""
타입 매핑 & 값 변환 (결정 3·4·5 대응). 변환은 전부 Supabase 적재 시점에만.
"""
import re
from config import ZERO_DATES, DATE_LIKE_COLUMNS, PII_COLUMN_PATTERNS

# ── MySQL → Postgres 타입 매핑 ──
def map_type(mysql_type: str) -> str:
    t = mysql_type.lower().strip()
    unsigned = "unsigned" in t
    base = t.replace("unsigned", "").strip()

    m = re.match(r"([a-z]+)(\(([^)]*)\))?", base)
    name = m.group(1) if m else base
    arg = m.group(3) if m and m.group(3) else None

    # enum/set (결정 5) → text + CHECK 는 DDL 단계에서. 여기선 text.
    if name in ("enum", "set"):
        return "text"
    if name == "tinyint":
        return "boolean" if arg == "1" else "smallint"
    if name in ("smallint", "mediumint"):
        return "integer" if unsigned else "smallint"
    if name == "int":
        return "bigint" if unsigned else "integer"
    if name == "bigint":
        return "numeric(20,0)" if unsigned else "bigint"
    if name in ("decimal", "numeric"):
        return "numeric(%s)" % arg if arg else "numeric"
    if name in ("float", "double", "real"):
        return "double precision"
    if name in ("datetime", "timestamp"):
        return "timestamptz"          # 존 없는 원본이나, 운영 편의상 timestamptz. NULL 정제 필수.
    if name == "date":
        return "date"
    if name == "time":
        return "time"
    if name == "year":
        return "smallint"
    if name in ("char", "varchar"):
        return "varchar(%s)" % arg if arg else "text"
    if name in ("tinytext", "text", "mediumtext", "longtext"):
        return "text"
    if name in ("tinyblob", "blob", "mediumblob", "longblob", "binary", "varbinary"):
        return "bytea"
    return "text"


def enum_values(mysql_type: str):
    """enum('A','B') → ['A','B'] (CHECK 제약 생성용)."""
    m = re.match(r"(enum|set)\((.*)\)", mysql_type.strip(), re.I)
    if not m:
        return None
    return [v.strip().strip("'") for v in m.group(2).split(",")]


def is_date_like(colname: str) -> bool:
    c = colname.lower()
    return any(k in c for k in DATE_LIKE_COLUMNS)


def is_pii(colname: str) -> bool:
    c = colname.lower()
    return any(p in c for p in PII_COLUMN_PATTERNS)


# ── 값 변환 (COPY 직전) ──
def clean_value(raw, pg_type: str, colname: str):
    """원시 문자열/None → COPY 텍스트 포맷 값. 제로데이트/빈날짜 → None."""
    if raw is None:
        return None
    s = raw
    if pg_type in ("date", "timestamptz", "time") or is_date_like(colname):
        if s.strip() in ZERO_DATES:
            return None
        # 문자열 날짜 이상치: 공백/불완전
        if pg_type == "date" and not re.match(r"^\d{4}-\d{2}-\d{2}$", s.strip()):
            # 'YYYY-MM-DD HH:MM:SS' 앞부분만
            mm = re.match(r"^(\d{4}-\d{2}-\d{2})", s.strip())
            return mm.group(1) if mm else None
    if pg_type == "boolean":
        return "t" if s.strip() in ("1", "t", "true", "Y", "y") else "f"
    return s


# ── COPY(TEXT) 이스케이프 ──
def copy_escape(v):
    if v is None:
        return r"\N"
    return (v.replace("\\", "\\\\")
             .replace("\n", "\\n")
             .replace("\r", "\\r")
             .replace("\t", "\\t"))


def row_to_copy_line(vals, pg_types, colnames):
    out = []
    for v, t, c in zip(vals, pg_types, colnames):
        out.append(copy_escape(clean_value(v, t, c)))
    return "\t".join(out) + "\n"
