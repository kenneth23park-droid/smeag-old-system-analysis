#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
5개 전용화면 통합 — 회원관리 · COMMISSION · COURSE LIST · TUITION FEE · ELEC & WATER

동시 편집 세션과의 충돌을 최소화하기 위해 파일마다
  [읽기 → 메모리에서 전부 변환 → 해시 재확인 → 한 번에 쓰기]
를 수행한다. 읽기 시점과 쓰기 직전의 sha256 이 다르면(=다른 세션이 그 사이에 저장) 그 파일을
건드리지 않고 **전체를 중단**한다(부분 적용 방지).

멱등 — 이미 적용된 파일은 "적용됨(변경 없음)" 으로 통과한다.

사용:  python3 docs/design-admin/screens-2026-07-30/integrate.py [--dry-run]
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SRC = os.path.join(ROOT, "docs", "design-admin", "screens-2026-07-30")
DATA_JS = os.path.join(ROOT, "deploy", "api", "data.js")
INDEX = os.path.join(ROOT, "deploy", "index.html")
PROTO = os.path.join(ROOT, "docs", "design-admin", "prototype.html")

KEYS = ["members", "commission", "courses", "tuition", "elec"]
MARK = "SMEAG-5SCREENS-2026-07-30"          # 멱등 판정용 마커
DRY = "--dry-run" in sys.argv


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def code_of(path):
    """산출물 .js 에서 코드 부분만 — 선두 /* eslint-disable */ 제거 + 마지막 함수 끝(줄 시작 '}')까지."""
    s = read(path)
    s = re.sub(r"^/\* eslint-disable \*/\n", "", s)
    ends = [m.end() for m in re.finditer(r"^\};?$", s, re.M)]
    if not ends:
        raise SystemExit("코드 끝(줄 시작 '}' 또는 '};')을 찾지 못함: " + path)
    return s[: ends[-1]].rstrip() + "\n"


def cut_block(src, fname, extra_const=None):
    """data.js 에서 `async function <fname>(` 를 그 앞 주석블록과 함께 통째로 제거."""
    m = re.search(r"^async function %s\(" % re.escape(fname), src, re.M)
    if not m:
        return src, False
    start = m.start()
    # 앞의 연속된 '//' 주석줄까지 포함
    lines = src[:start].split("\n")
    i = len(lines) - 1
    while i > 0 and lines[i - 1].lstrip().startswith("//"):
        i -= 1
    start = len("\n".join(lines[:i]))
    if start:
        start += 1
    end = src.find("\n}\n", m.start())
    if end < 0:
        raise SystemExit("함수 끝을 찾지 못함: " + fname)
    end += 3
    out = src[:start] + src[end:]
    if extra_const:
        out = re.sub(r"^const %s = .*\n" % re.escape(extra_const), "", out, count=1, flags=re.M)
    return out, True


def sub1(src, old, new, what, optional=False):
    """정확히 1회 치환. 0회면(=이미 적용/앵커 변경) optional 이 아니면 중단."""
    n = src.count(old)
    if n == 0:
        if optional:
            print("    · skip(앵커 없음): %s" % what)
            return src, False
        raise SystemExit("앵커를 찾지 못함 — 중단: %s" % what)
    if n > 1:
        raise SystemExit("앵커가 %d 곳 — 모호하여 중단: %s" % (n, what))
    return src.replace(old, new), True


# ═══ 1) deploy/api/data.js ═══════════════════════════════════════════════════
def build_data_js(src):
    if MARK in src:
        return src, False
    # 1-1. 전용 렌더러로 이관되어 쓸모없어진 표(spec) 로더 5종 제거
    for fn, extra in [("loadMembers", None), ("loadCommission", None), ("loadCourses", None),
                      ("loadTuition", None), ("loadElec", "ELEC_COLS")]:
        src, ok = cut_block(src, fn, extra)
        print("    · 표 로더 제거 %-16s %s" % (fn, "OK" if ok else "(없음)"))

    # 1-2. TABLE_LOADERS 에서 5종 제외
    old_tl = """const TABLE_LOADERS = {
  members: loadMembers, points: loadPoints, visits: loadVisits,
  commission: loadCommission, courses: loadCourses, tuition: loadTuition,
  farmgym: loadFarmgym, boards: loadBoards, elec: loadElec,
  agencyvisit: loadAgencyvisit, dayoff: loadDayoff,
};"""
    new_tl = """// ※ members·commission·courses·tuition·elec 는 전용 렌더러(응답 out.<part>)로 이관되어
//   표(out.tables) 로더에서 제외했다 — %s
//   근거·배선: docs/design-admin/screens-2026-07-30/MERGE_PLAN.md
const TABLE_LOADERS = {
  points: loadPoints, visits: loadVisits,
  farmgym: loadFarmgym, boards: loadBoards,
  agencyvisit: loadAgencyvisit, dayoff: loadDayoff,
};""" % MARK
    src, _ = sub1(src, old_tl, new_tl, "TABLE_LOADERS")

    # 1-3. 전용 loader 5종 삽입(TABLE_LOADERS 정의 앞)
    blob = "\n".join(code_of(os.path.join(SRC, k + ".api.js")) for k in KEYS)
    head = ("// ════════════════════════════════════════════════════════════════════════════\n"
            "// 전용화면 조각 — 회원관리 · COMMISSION · COURSE LIST · TUITION FEE · ELEC & WATER\n"
            "// 응답은 out.<part> (표 폴백 out.tables 와 다른 경로). %s\n"
            "// ════════════════════════════════════════════════════════════════════════════\n" % MARK)
    src, _ = sub1(src, "// ※ members·commission", head + blob + "\n// ※ members·commission",
                  "전용 loader 삽입")

    # 1-4. elec 전용 쿼리 파라미터
    old_p = """  const to = isYmd(url.searchParams.get("to")) ? url.searchParams.get("to") : wkTo;"""
    new_p = old_p + """
  // elec(ELEC & WATER) 전용 — pickup 의 from/to 와 의미가 달라 별도 파라미터를 쓴다.
  const elecFrom = isYmd(url.searchParams.get("elecFrom")) ? url.searchParams.get("elecFrom") : "";
  const elecTo = isYmd(url.searchParams.get("elecTo")) ? url.searchParams.get("elecTo") : "";
  const elecRoom = /^\\d{1,9}$/.test(url.searchParams.get("elecRoom") || "") ? Number(url.searchParams.get("elecRoom")) : 0;"""
    src, _ = sub1(src, old_p, new_p, "elec 파라미터 파싱")

    # 1-5. 캐시키(version)에 elec 기간·방 포함
    old_v = """      + (allowed.includes("pickup") ? ":" + from + "_" + to : "")"""
    new_v = old_v + """
      + (allowed.includes("elec") ? ":" + elecFrom + "_" + elecTo + "_" + elecRoom : "")"""
    src, _ = sub1(src, old_v, new_v, "version 에 elec 기간 포함")

    # 1-6. handler 분기
    old_h = """    if (allowed.includes("chgref")) out.chgref = await loadChgref(q, scope);"""
    new_h = old_h + """
    if (allowed.includes("members")) out.members = await loadMembers(q, scope);
    if (allowed.includes("commission")) out.commission = await loadCommission(q, scope);
    if (allowed.includes("courses")) out.courses = await loadCourses(q, scope);
    if (allowed.includes("tuition")) out.tuition = await loadTuition(q, scope);
    if (allowed.includes("elec")) {                    // 기간 미지정이면 데이터 최신월로 자동
      const last = await elecLatestDate(q);            // 요청당 1회만 호출(0.2s seq scan)
      let ef = elecFrom, et = elecTo;
      if (!ef || !et) {
        const mm = (last || new Date().toISOString().slice(0, 10)).slice(0, 7);
        ef = monthStart(mm); et = monthEnd(mm);
      }
      out.elec = await loadElecMeter(q, ef, et, elecRoom);
      out.elec.latest = last;
    }"""
    src, _ = sub1(src, old_h, new_h, "handler parts 분기")

    # 1-7. 파일 상단 라우팅 주석의 parts 목록
    src = src.replace("//     parts: students | roomstat | groups | pickup | deposits | changelog",
                      "//     parts: students | roomstat | groups | pickup | deposits | changelog\n"
                      "//            | members | commission | courses | tuition | elec (전용화면)\n"
                      "//     elecFrom,elecTo=YYYY-MM-DD  elecRoom=i_idx   ELEC & WATER 기간·방", 1)
    return src, True


# ═══ 2) deploy/index.html · docs/design-admin/prototype.html ═════════════════
MENU_SWAP = [
    ("{k:'spec',t:'회원관리',u:'member_list.php'", "{k:'members',t:'회원관리',u:'member_list.php'"),
    ("{k:'spec',t:'COMMISSION',u:'uhak_agency_commission.php'", "{k:'commission',t:'COMMISSION',u:'uhak_agency_commission.php'"),
    ("{k:'spec',t:'COURSE LIST',u:'course_list.php'", "{k:'courses',t:'COURSE LIST',u:'course_list.php'"),
    ("{k:'spec',t:'TUITION FEE',u:'tution_fee.php'", "{k:'tuition',t:'TUITION FEE',u:'tution_fee.php'"),
    ("{k:'spec',t:'ELEC & WATER',u:'room_elec.php'", "{k:'elec',t:'ELEC & WATER',u:'room_elec.php'"),
]


def build_html(src, live):
    if MARK in src:
        return src, False
    for old, new in MENU_SWAP:
        src, _ = sub1(src, old, new, "메뉴키 " + old[:32])

    # 렌더러 5종 삽입(R.commrules 정의 앞)
    blob = "\n".join(code_of(os.path.join(SRC, k + ".render.js")) for k in KEYS)
    head = ("// ═══ 전용화면 5종 — 회원관리 · COMMISSION · COURSE LIST · TUITION FEE · ELEC & WATER ═══\n"
            "// %s · 설계/근거: docs/design-admin/screens-2026-07-30/\n"
            "// __init 은 renderMain 의 R[curKey+'__init'] 훅이 자동 호출한다(추가 배선 불필요).\n" % MARK)
    src, _ = sub1(src, "// ─── COMMISSION RULES", head + blob + "\n// ─── COMMISSION RULES",
                  "렌더러 삽입")
    if not live:
        return src, True

    # PART_TABLES — 전용화면으로 이관한 5종 제거(표 폴백 경로와 이중화되지 않게)
    src, _ = sub1(src,
                  "  members:['member_list.php'], points:['point_list.php'], visits:['visit_list.php'],\n"
                  "  commission:['uhak_agency_commission.php'], courses:['course_list.php'], tuition:['tution_fee.php'],\n"
                  "  farmgym:['student_farm.php','student_gym.php'], elec:['room_elec.php'],\n",
                  "  points:['point_list.php'], visits:['visit_list.php'],\n"
                  "  farmgym:['student_farm.php','student_gym.php'],\n",
                  "PART_TABLES 5종 제거")

    # LIVE_PARTS
    src, _ = sub1(src, "  changelog:['changelog'], spec:['students'],\n};",
                  "  changelog:['changelog'], spec:['students'],\n"
                  "  // 전용화면 5종 — 학생 데이터는 필요 없다(불필요한 전량조회 방지)\n"
                  "  members:['members'], commission:['commission'], courses:['courses'],\n"
                  "  tuition:['tuition'], elec:['elec'],\n};",
                  "LIVE_PARTS")

    # liveHave
    src, _ = sub1(src, "  if(p==='changelog')return !!(REAL.changelog&&REAL.changelog.length);",
                  "  if(p==='changelog')return !!(REAL.changelog&&REAL.changelog.length);\n"
                  "  if(p==='members')return !!(REAL.members&&REAL.members.length);\n"
                  "  if(p==='commission')return !!(REAL.commission&&REAL.commission.rows&&REAL.commission.rows.length);\n"
                  "  if(p==='courses')return !!(REAL.courses&&REAL.courses.rows&&REAL.courses.rows.length);\n"
                  "  if(p==='tuition')return !!(REAL.tuition&&REAL.tuition.rows&&REAL.tuition.rows.length);\n"
                  "  if(p==='elec')return !!(REAL.elec&&REAL.elec.rows);",
                  "liveHave")

    # liveSync — 요청 파라미터(elec 기간·방) + 응답 반영
    src, _ = sub1(src, "  if(need.includes('roomstat'))qs.set('month',month);",
                  "  if(need.includes('roomstat'))qs.set('month',month);\n"
                  "  if(need.includes('elec')&&typeof elecState!=='undefined'){\n"
                  "    qs.set('elecFrom',elecState.from||'');qs.set('elecTo',elecState.to||'');\n"
                  "    if(elecState.room)qs.set('elecRoom',elecState.room);}",
                  "liveSync qs(elec)")
    src, _ = sub1(src, "    if(j.changelog)REAL.changelog=j.changelog;",
                  "    if(j.changelog)REAL.changelog=j.changelog;\n"
                  "    if(j.members)REAL.members=j.members;\n"
                  "    if(j.commission)REAL.commission=j.commission;\n"
                  "    if(j.courses)REAL.courses=j.courses;\n"
                  "    if(j.tuition)REAL.tuition=j.tuition;\n"
                  "    if(j.elec)REAL.elec=j.elec;",
                  "liveSync 응답 반영")

    # 코스 마스터 캐시: 라이브 courses 우선 (수강등록·멀티수강의 코스명/·off 배지)
    src, _ = sub1(src,
                  "function _buildCourseCache(){_courseNameCache={};_courseActiveCache={};",
                  "function _buildCourseCache(){_courseNameCache={};_courseActiveCache={};\n"
                  "  // 라이브 코스 마스터(REAL.courses)가 있으면 그것을 1순위로 쓴다.\n"
                  "  const lc=REAL&&REAL.courses&&REAL.courses.rows;\n"
                  "  if(lc&&lc.length){lc.forEach(r=>{const c=String(r.idx==null?'':r.idx).trim();\n"
                  "    if(c){_courseNameCache[c]=(r.en||r.ko||c);_courseActiveCache[c]=(String(r.state||'').toUpperCase()==='Y');}});return;}",
                  "_buildCourseCache 라이브 우선", optional=True)
    return src, True


def main():
    targets = [(DATA_JS, build_data_js, None), (INDEX, build_html, True), (PROTO, build_html, False)]
    plan = []
    for path, fn, arg in targets:
        print("── %s" % os.path.relpath(path, ROOT))
        before = sha(path)
        src = read(path)
        out, changed = (fn(src) if arg is None else fn(src, arg))
        if not changed:
            print("    · 이미 적용됨(마커 존재) — 건너뜀")
            continue
        plan.append((path, before, out))

    if not plan:
        print("\n변경할 것 없음(전부 적용 상태).")
        return
    if DRY:
        print("\n[dry-run] 쓰지 않고 종료. 대상 %d개" % len(plan))
        return

    # 쓰기 직전 재확인 — 읽은 뒤에 다른 세션이 저장했으면 전부 중단
    for path, before, _ in plan:
        if sha(path) != before:
            raise SystemExit("⚠ 다른 세션이 그 사이 %s 를 저장했습니다 — 아무것도 쓰지 않고 중단합니다."
                             % os.path.relpath(path, ROOT))
    for path, _, out in plan:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
        print("    ✔ 적용: %s" % os.path.relpath(path, ROOT))
    print("\n완료 %d개 파일." % len(plan))


if __name__ == "__main__":
    main()
