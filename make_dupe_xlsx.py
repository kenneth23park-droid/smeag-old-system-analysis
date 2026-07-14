#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""중복의심 크로스체크용 엑셀 생성 (Supabase dorm_reservations flat 조회)."""
import os
import psycopg2
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

CONN = dict(
    host=os.getenv("PG_HOST", "aws-0-ap-northeast-1.pooler.supabase.com"), port=5432,
    user=os.getenv("PG_USER", "postgres.bauhnnpioaephlwurxzg"),
    password=os.environ["PG_PASS"],
    dbname="postgres", sslmode="require",
)

HDR = Font(bold=True, color="FFFFFF")
HDR_FILL = PatternFill("solid", fgColor="305496")
TITLE = Font(bold=True, size=13, color="305496")
BORDER = Border(*[Side(style="thin", color="D9D9D9")] * 4)
WARN_FILL = PatternFill("solid", fgColor="FCE4D6")


def style_header(ws, row, ncol):
    for c in range(1, ncol + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = HDR
        cell.fill = HDR_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER


def autosize(ws):
    for col in ws.columns:
        w = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(max(w + 2, 10), 40)


conn = psycopg2.connect(**CONN)
cur = conn.cursor()

wb = Workbook()

# ── Sheet 0: 개요 ─────────────────────────────────────────
ws = wb.active
ws.title = "개요"
ws["A1"] = "SMEAG 예약 중복의심 크로스체크"
ws["A1"].font = Font(bold=True, size=16, color="305496")

# ── 유형 A: num_days > span_days (2-테이블 중복 day-row 흔적) ──
cur.execute("""
    select r_idx, s_idx, ri_idx, bldg_type, check_in, check_out,
           num_days, span_days, (num_days - span_days) as extra_days, status
    from dorm_reservations
    where num_days > span_days
    order by (num_days - span_days) desc, r_idx, check_in
""")
rows_a = cur.fetchall()

# ── 유형 B: 같은 객실 기간겹침 (이중예약 의심) ──
cur.execute("""
    with confirmed as (
      select id, r_idx, s_idx, ri_idx, bldg_type, check_in, check_out, num_days, status
      from dorm_reservations
      where is_reserved = false
    )
    select a.r_idx, a.bldg_type,
           a.id, a.s_idx, a.check_in, a.check_out, a.num_days,
           b.id, b.s_idx, b.check_in, b.check_out, b.num_days,
           (least(a.check_out, b.check_out) - greatest(a.check_in, b.check_in) + 1) as overlap_days
    from confirmed a
    join confirmed b
      on a.r_idx = b.r_idx
     and a.id < b.id
     and a.check_in <= b.check_out
     and b.check_in <= a.check_out
    order by overlap_days desc, a.r_idx, a.check_in
""")
rows_b = cur.fetchall()

# 개요 표
summary = [
    ("유형", "설명", "건수"),
    ("A. 중복 day-row 흔적", "num_days > span_days (room_reserve/2026 겹침으로 원본에 중복일 존재)", len(rows_a)),
    ("B. 이중예약 의심 쌍", "같은 객실(r_idx) 확정예약 기간이 겹치는 쌍", len(rows_b)),
]
r0 = 3
for i, row in enumerate(summary):
    for j, v in enumerate(row):
        c = ws.cell(row=r0 + i, column=1 + j, value=v)
        c.border = BORDER
        if i == 0:
            c.font = HDR
            c.fill = HDR_FILL
ws["A8"] = "판정 가이드"
ws["A8"].font = TITLE
notes = [
    "· 유형 A: extra_days 만큼 원본에 같은 날짜가 중복 저장돼 있었음. 구간모델에선 이미 1행으로 병합됨. 값 검증용.",
    "· 유형 B: 실제 이중배정이면 정제 필요. overlap_days 클수록 우선 확인. 학생(s_idx)이 다르면 진짜 충돌.",
    "· s_idx 동일 + 기간겹침 = 같은 학생의 연속예약이 겹친 것(데이터 입력 이슈) 가능성.",
]
for i, t in enumerate(notes):
    ws.cell(row=9 + i, column=1, value=t)
autosize(ws)

# ── Sheet A ─────────────────────────────────────────
wsa = wb.create_sheet("A_중복day-row")
head_a = ["r_idx(객실)", "s_idx(학생)", "ri_idx", "건물", "check_in", "check_out",
          "num_days(원본일수)", "span_days(실구간)", "extra_days(중복일)", "status"]
wsa.append(head_a)
style_header(wsa, 1, len(head_a))
for row in rows_a:
    wsa.append([row[0], row[1], row[2], row[3], str(row[4]), str(row[5]),
                row[6], row[7], row[8], row[9]])
for r in range(2, wsa.max_row + 1):
    for c in range(1, len(head_a) + 1):
        wsa.cell(row=r, column=c).border = BORDER
    wsa.cell(row=r, column=9).fill = WARN_FILL
wsa.freeze_panes = "A2"
autosize(wsa)

# ── Sheet B ─────────────────────────────────────────
wsb = wb.create_sheet("B_이중예약의심")
head_b = ["r_idx(객실)", "건물",
          "A.id", "A.학생", "A.check_in", "A.check_out", "A.일수",
          "B.id", "B.학생", "B.check_in", "B.check_out", "B.일수",
          "overlap_days(겹침)", "학생동일?"]
wsb.append(head_b)
style_header(wsb, 1, len(head_b))
for row in rows_b:
    same = "동일" if row[3] == row[8] else "다름"
    wsb.append([row[0], row[1],
                row[2], row[3], str(row[4]), str(row[5]), row[6],
                row[7], row[8], str(row[9]), str(row[10]), row[11],
                row[12], same])
for r in range(2, wsb.max_row + 1):
    for c in range(1, len(head_b) + 1):
        wsb.cell(row=r, column=c).border = BORDER
    wsb.cell(row=r, column=13).fill = WARN_FILL
    # 학생 다름 = 진짜 충돌 강조
    if wsb.cell(row=r, column=14).value == "다름":
        wsb.cell(row=r, column=14).font = Font(bold=True, color="C00000")
wsb.freeze_panes = "A2"
autosize(wsb)

out = "/Users/kwangseobpark/smeag-old-system-analysis/SMEAG_중복의심_크로스체크.xlsx"
wb.save(out)
print("A(중복day-row):", len(rows_a))
print("B(이중예약의심):", len(rows_b))
print("saved:", out)
cur.close()
conn.close()
