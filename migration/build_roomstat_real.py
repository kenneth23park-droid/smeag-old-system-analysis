#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
레거시 MySQL 덤프(sql/*.sql, 읽기전용)에서 배치도(room_stat3.php) 실데이터를 추출해
신전산 화면(deploy/index.html)의 REAL.roomstat 구조로 내보낸다.

원본 무수정 원칙: sql/ 아래 덤프는 읽기만 한다(파싱 전용, 쓰기 없음).

조인:
  room_category(g_display='Y')  → 방구분 30그룹(bldg_type E=CAPITAL 24 / S=ENCANTO 6)
  room_list(r_state='Y')        → 방(r_name) · 침대슬롯(r_idx) · 정원(r_limit)
  room_reserve(rr_date, r_idx)  → 침대슬롯별 일자 점유 → 연속구간 세그먼트화
  student_info(s_idx)           → 표시이름(e_name|k_name) · now_status(holding 플래그)

출력: {"roomstat":{"groups":[{name, rooms:[{no, per, gender, beds:[{segs:[{s,e,st,et,nm,h}]}]}]}]}}
  st/et = 구간 시작/종료일의 rr_type (S=입실 E=퇴실 R=예약 I=재실)
"""
import json, os, re, sys
from collections import defaultdict, OrderedDict

SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sql')
WIN_FROM, WIN_TO = '2025-01-01', '2027-12-31'   # 배치도 표시 범위(±6개월 이동 여유 포함)
# 세그먼트 h(홀딩·미확정) 플래그 대상 now_status.
#   holding/holdinguse = 방홀딩,  checking/waiting = 수속중·미확정 가예약('Tammy for …' 등 담당자 임시선점)
#   화면(R.roomstat)의 이름칸 규칙이 "첫 점유자 이후의 예약(R)/홀딩(h) 에서 중단" 이므로,
#   레거시 배치도처럼 실학생 뒤에 붙는 임시선점 이름이 이름칸에 끼어들지 않는다.
HOLD_STATUS = {'holding', 'holdinguse', 'checking', 'waiting'}


def rd(name):
    with open(os.path.join(SQL, name), encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('('):
                yield line


def vals(line, limit=None):
    """INSERT 한 행 '( v, v, ... )' 을 값 리스트로. 따옴표 escape(\\', '')·콤마 포함 문자열 처리."""
    out, i, n = [], 1, len(line)
    while i < n:
        while i < n and line[i] in ' \t':
            i += 1
        if i >= n or line[i] in ');':
            break
        if line[i] == "'":
            i += 1
            buf = []
            while i < n:
                c = line[i]
                if c == '\\' and i + 1 < n:
                    buf.append(line[i + 1]); i += 2; continue
                if c == "'":
                    if i + 1 < n and line[i + 1] == "'":
                        buf.append("'"); i += 2; continue
                    i += 1; break
                buf.append(c); i += 1
            out.append(''.join(buf))
        else:
            j = i
            while j < n and line[j] not in ',)':
                j += 1
            tok = line[i:j].strip()
            out.append(None if tok == 'NULL' else tok)
            i = j
        if limit and len(out) >= limit:
            return out
        while i < n and line[i] in ' \t':
            i += 1
        if i < n and line[i] == ',':
            i += 1
    return out


# ── 1. 방구분(카테고리) ────────────────────────────────────────────────────────
cats = {}
for line in rd('room_category.sql'):
    v = vals(line, 7)
    if len(v) < 7:
        continue
    g_idx, g_name, g_display, g_order, g_type, bldg = int(v[0]), v[1], v[2], int(v[3]), v[4], v[5]
    if g_display != 'Y':
        continue
    cats[g_idx] = dict(name=g_name, order=g_order, gender=g_type, bldg=bldg)

# ── 2. 방 · 침대슬롯 ──────────────────────────────────────────────────────────
# (r_idx, g_idx, i_idx, r_num, r_name, r_limit, ... r_state, g_type, bldg_type, ts)
rooms = defaultdict(OrderedDict)   # g_idx → r_name → {'limit':n, 'slots':[r_idx…]}
slot_group = {}                    # r_idx → (g_idx, r_name)
for line in rd('room_list.sql'):
    v = vals(line)
    if len(v) < 18:   # r_idx,g_idx,i_idx,r_num,r_name,r_limit + r_pay*8 + r_state,g_type,bldg_type,ts
        continue
    r_idx, g_idx, r_name, r_limit, r_state = int(v[0]), int(v[1]), v[4], int(v[5]), v[14]
    if r_state != 'Y' or g_idx not in cats:
        continue
    r = rooms[g_idx].setdefault(r_name, {'limit': r_limit, 'slots': []})
    r['limit'] = max(r['limit'], r_limit)
    r['slots'].append(r_idx)
    slot_group[r_idx] = (g_idx, r_name)

# ── 3. 학생 이름 · 상태 ───────────────────────────────────────────────────────
# now_status 실측 집합: normal cancel checking extend paycancel holding etc graduated
# holdinguse refund waiting out exchange (+빈값). 소문자 알파벳 토큰 = 정상 행 판별에 사용
# (s_info/comment 등 멀티라인 text 필드의 연속행 방어)
names, holds = {}, set()
for line in rd('student_info.sql'):
    v = vals(line, 4)
    if len(v) < 4 or not v[0] or not v[0].isdigit() or not re.fullmatch(r'[a-z]*', v[3] or ''):
        continue
    s_idx = int(v[0])
    nm = (v[2] or '').strip() or (v[1] or '').strip()
    if nm:
        names[s_idx] = re.sub(r'\s+', ' ', nm)
    if v[3] in HOLD_STATUS:
        holds.add(s_idx)

# ── 4. 예약(room_reserve) → 침대슬롯별 일자 점유 ──────────────────────────────
# (rr_idx, r_idx, ri_idx, rr_date, s_idx, rr_type, bldg_type, ts)
days = defaultdict(list)   # r_idx → [(date, s_idx, rr_type)]
for line in rd('room_reserve.sql'):
    v = vals(line, 6)
    if len(v) < 6:
        continue
    r_idx = int(v[1]); d = v[3]
    if r_idx not in slot_group or not (WIN_FROM <= d <= WIN_TO):
        continue
    days[r_idx].append((d, int(v[4]) if v[4] and v[4].isdigit() else 0, v[5] or 'I'))


def nextday(d):
    y, m, dd = int(d[:4]), int(d[5:7]), int(d[8:10])
    import datetime
    return (datetime.date(y, m, dd) + datetime.timedelta(days=1)).isoformat()


def segs_of(r_idx):
    """같은 학생의 연속 일자를 한 구간으로. 구간 시작/종료일의 rr_type 을 st/et 로."""
    rows = sorted(set(days.get(r_idx, [])))
    out, cur = [], None
    for d, s_idx, t in rows:
        if cur and cur['s_idx'] == s_idx and nextday(cur['e']) == d:
            cur['e'] = d; cur['et'] = t
            continue
        if cur:
            out.append(cur)
        cur = dict(s=d, e=d, st=t, et=t, s_idx=s_idx)
    if cur:
        out.append(cur)
    res = []
    for sg in out:
        seg = {'s': sg['s'], 'e': sg['e'], 'st': sg['st'], 'et': sg['et'],
               'nm': names.get(sg['s_idx'], '')}
        if sg['s_idx'] in holds:
            seg['h'] = 1
        res.append(seg)
    return res


# ── 5. 신전산 REAL.roomstat 구조로 출력 ───────────────────────────────────────
GSUF = {'M': 'MALE', 'F': 'FEMALE', 'C': 'FAMILY'}
GEN = {'M': 'm', 'F': 'f', 'C': 'fam'}
groups, n_rooms, n_beds, n_segs = [], 0, 0, 0
for g_idx, c in sorted(cats.items(), key=lambda kv: kv[1]['order']):
    rs = []
    for r_name, r in rooms.get(g_idx, {}).items():
        beds = [{'segs': segs_of(sl)} for sl in r['slots']]
        n_segs += sum(len(b['segs']) for b in beds)
        n_beds += len(beds)
        rs.append({'no': r_name, 'per': '%d인실' % (r['limit'] or len(beds)),
                   'gender': GEN.get(c['gender'], 'fam'), 'beds': beds})
    n_rooms += len(rs)
    groups.append({'name': '%s / %s' % (c['name'], GSUF.get(c['gender'], 'FAMILY')),
                   'rooms': rs})

out = {'roomstat': {'groups': groups,
                    'meta': {'src': 'legacy dump', 'window': [WIN_FROM, WIN_TO],
                             'groups': len(groups), 'rooms': n_rooms,
                             'beds': n_beds, 'segs': n_segs}}}
dst = sys.argv[1] if len(sys.argv) > 1 else 'roomstat_real.json'
with open(dst, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
cap = sum(1 for g in groups if cats[[k for k, v in cats.items()
          if '%s / %s' % (v['name'], GSUF.get(v['gender'], 'FAMILY')) == g['name']][0]]['bldg'] == 'E')
print('groups=%d (CAPITAL/bldg_E=%d) rooms=%d beds=%d segs=%d → %s (%.1f MB)'
      % (len(groups), cap, n_rooms, n_beds, n_segs, dst, os.path.getsize(dst) / 1e6))
