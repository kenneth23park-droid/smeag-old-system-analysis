#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_roomstat_real.py 산출 JSON 을 정적 배포본의 REAL 초기값으로 주입한다.

  python3 migration/inject_realdata.py roomstat_real.json deploy/index.html

대상 파일의 `let REAL=null; /*__REALDATA__*/` (또는 이미 주입된 상태)를 통째로 교체하므로
몇 번 실행해도 결과가 같다(idempotent). 로그인 세션이 있으면 /api/data 응답이
REAL.roomstat 을 덮어쓰므로, 주입값은 '세션 없이도 보이는 초기 실데이터' 역할을 한다.
"""
import json, re, sys

src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding='utf-8'))
blob = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
blob = blob.replace('\\', '\\\\').replace('</', '<\\/')      # </script> 차단 + 이스케이프 보존
meta = (data.get('roomstat') or {}).get('meta') or {}

html = open(dst, encoding='utf-8').read()
pat = re.compile(r'let REAL=(?:null|JSON\.parse\(\'(?:[^\'\\]|\\.)*\'\)); ?/\*__REALDATA__\*/')
m = pat.search(html)
if not m:
    sys.exit('주입 지점(let REAL=…; /*__REALDATA__*/)을 찾지 못했습니다: ' + dst)
new = "let REAL=JSON.parse('%s'); /*__REALDATA__*/" % blob.replace("'", "\\'")
open(dst, 'w', encoding='utf-8').write(html[:m.start()] + new + html[m.end():])
print('injected %s → %s (%.1f MB, groups=%s rooms=%s beds=%s segs=%s)'
      % (src, dst, len(new) / 1e6, meta.get('groups'), meta.get('rooms'),
         meta.get('beds'), meta.get('segs')))
