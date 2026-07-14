# -*- coding: utf-8 -*-
"""
phpMyAdmin MySQL 덤프(.sql) 스트리밍 파서 — 원본 읽기 전용.

제공:
  parse_ddl(path)      -> TableDDL(name, columns[(col, mysqltype, nullable, default)], pk, indexes)
  iter_rows(path)      -> (columns, generator[tuple[str|None]])  값은 원시 SQL 리터럴을 파싱한 파이썬 str/None
포맷 가정: 튜플 1줄 = 1행  `(v1, v2, ...),`  (SMEAG 덤프 실측 포맷)
큰 파일도 라인 스트리밍으로 O(1) 메모리.
"""
import re
from dataclasses import dataclass, field

_CREATE_RE = re.compile(r"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([^`]+)`", re.I)
_COL_RE    = re.compile(r"^\s*`([^`]+)`\s+([a-zA-Z]+(?:\([^)]*\))?(?:\s+unsigned)?)\s*(.*)$")
_PK_RE     = re.compile(r"^\s*PRIMARY KEY\s*\(([^)]*)\)", re.I)
_INSERT_RE = re.compile(r"^INSERT INTO\s+`([^`]+)`\s*(\(([^)]*)\))?\s*VALUES", re.I)


@dataclass
class TableDDL:
    name: str
    columns: list = field(default_factory=list)   # [(col, mysqltype, nullable, default)]
    pk: list = field(default_factory=list)
    engine: str = ""
    charset: str = ""

    @property
    def colnames(self):
        return [c[0] for c in self.columns]


def parse_ddl(path: str) -> TableDDL:
    """CREATE TABLE 블록만 읽어 스키마 파싱 (ENGINE= 라인에서 종료)."""
    ddl = TableDDL(name="")
    in_create = False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not in_create:
                m = _CREATE_RE.search(line)
                if m:
                    ddl.name = m.group(1)
                    in_create = True
                continue
            # 컬럼 정의
            pk = _PK_RE.match(line)
            if pk:
                ddl.pk = [c.strip().strip("`") for c in pk.group(1).split(",")]
                continue
            cm = _COL_RE.match(line)
            if cm and not line.lstrip().upper().startswith(("KEY", "UNIQUE", "CONSTRAINT", "FULLTEXT")):
                col, typ, rest = cm.group(1), cm.group(2), cm.group(3)
                nullable = "NOT NULL" not in rest.upper()
                dm = re.search(r"DEFAULT\s+('(?:[^']*)'|\S+)", rest, re.I)
                default = dm.group(1).strip("'") if dm else None
                ddl.columns.append((col, typ.strip(), nullable, default))
                continue
            if line.upper().lstrip().startswith("ENGINE=") or ") ENGINE=" in line.upper():
                em = re.search(r"ENGINE=(\w+)", line, re.I)
                cm2 = re.search(r"CHARSET=(\w+)", line, re.I)
                ddl.engine = em.group(1) if em else ""
                ddl.charset = cm2.group(1) if cm2 else ""
                break
    return ddl


def _split_tuple(body: str):
    """`v1, 'a,b', NULL` → ['v1','a,b',None]. 따옴표/이스케이프 인지 상태머신.

    따옴표 여부를 필드 단위로 추적한다:
      - 따옴표 문자열: 내부 내용을 그대로 보존(의도적 공백 포함).
      - 무따옴표 토큰: 앞뒤 공백 제거(`, '` 포맷의 구분자 공백 제거), 'NULL'은 None.
    """
    out, buf = [], []
    quoted = False   # 현재 필드가 따옴표 문자열이었는지
    closed = False   # 따옴표 문자열이 닫힌 뒤(콤마 전 공백 무시용)
    i, n = 0, len(body)
    in_str = False

    def flush():
        nonlocal buf, quoted, closed
        if quoted:
            out.append("".join(buf))
        else:
            t = "".join(buf).strip()
            out.append(None if t.upper() == "NULL" else t)
        buf = []
        quoted = False
        closed = False

    while i < n:
        ch = body[i]
        if in_str:
            if ch == "\\" and i + 1 < n:      # MySQL 백슬래시 이스케이프
                nxt = body[i + 1]
                buf.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(nxt, nxt))
                i += 2
                continue
            if ch == "'":
                if i + 1 < n and body[i + 1] == "'":   # '' → '
                    buf.append("'")
                    i += 2
                    continue
                in_str = False
                closed = True
                i += 1
                continue
            buf.append(ch)
            i += 1
        else:
            if ch == ",":
                flush()
                i += 1
            elif closed:                       # 따옴표 닫힘 후 콤마 전까지(공백 등) 무시
                i += 1
            elif ch == "'":                    # 따옴표 문자열 시작: 앞 공백 버퍼 제거
                if "".join(buf).strip() == "":
                    buf = []
                in_str = True
                quoted = True
                i += 1
            else:
                buf.append(ch)
                i += 1
    flush()
    return out


def iter_rows(path: str):
    """(columns, row_generator) 반환. columns 는 INSERT 컬럼목록 또는 DDL 순서."""
    ddl = parse_ddl(path)
    cols_holder = {"cols": ddl.colnames}

    def gen():
        cur_cols = ddl.colnames
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            in_values = False
            for line in f:
                if not in_values:
                    m = _INSERT_RE.match(line)
                    if m:
                        if m.group(3):
                            cur_cols = [c.strip().strip("`") for c in m.group(3).split(",")]
                            cols_holder["cols"] = cur_cols
                        in_values = True
                        rest = line[m.end():].lstrip()
                        if rest.startswith("("):
                            yield from _emit(rest, cur_cols)
                            if rest.rstrip().endswith(";"):
                                in_values = False
                    continue
                s = line.strip()
                if not s:
                    continue
                if s.startswith("("):
                    yield from _emit(s, cur_cols)
                    if s.endswith(";"):
                        in_values = False
                elif s.endswith(";"):
                    in_values = False

    return cols_holder, gen()


def _emit(line: str, cols):
    s = line.strip().rstrip(";").rstrip(",")
    if s.startswith("(") and s.endswith(")"):
        vals = _split_tuple(s[1:-1])
        if len(vals) == len(cols):
            yield vals
