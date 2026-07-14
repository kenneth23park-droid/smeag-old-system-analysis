// 04: 크롤 결과 정규화·검증 — 코드사전(셀렉트옵션), 화면별 컬럼, 캠퍼스 코드 대조
const fs = require('fs');
const R = require('./crawl_results.json').results;

// 1) 셀렉트 옵션 사전 수집: 필드명 -> 옵션집합 (여러 화면 병합)
const dict = {}; // name -> Map(value -> label)
for (const r of R) {
  if (!r.forms) continue;
  for (const f of r.forms) for (const fl of f.fields) {
    if (fl.options) {
      dict[fl.name] = dict[fl.name] || new Map();
      for (const o of fl.options) if (!dict[fl.name].has(o.v)) dict[fl.name].set(o.v, o.t);
    }
  }
}
const dictOut = {};
for (const k in dict) dictOut[k] = [...dict[k].entries()].map(([v,t]) => ({v,t}));
fs.writeFileSync('dict_options.json', JSON.stringify(dictOut, null, 2));

console.log('=== 코드 사전 후보(셀렉트 필드) ===');
for (const k of Object.keys(dictOut).sort()) {
  const opts = dictOut[k];
  if (opts.length <= 25) console.log(`\n[${k}] (${opts.length})`, opts.map(o=>`${o.v}=${o.t}`).join(' | '));
  else console.log(`\n[${k}] (${opts.length}) 대용량 → 상위20:`, opts.slice(0,20).map(o=>`${o.v}=${o.t}`).join(' | '));
}

// 2) 화면별 컬럼 요약
console.log('\n\n=== 화면별 데이터 컬럼 ===');
for (const r of R) {
  if (r.dataTable && r.dataTable.cols && r.dataTable.cols.length) {
    console.log(`\n[${r.cat}/${r.label}] (${r.dataTable.colN}컬럼, 표본행 ${r.dataTable.dataRows})`);
    console.log('  ', r.dataTable.cols.join(' | '));
  }
}

// 3) 화면 상태 요약
console.log('\n\n=== 화면 상태 ===');
const bad = R.filter(r => r.error || r.redirectedToLogin);
console.log('총', R.length, '| 정상', R.length - bad.length, '| 문제', bad.length);
bad.forEach(b => console.log('  !', b.label, b.error || 'LOGIN'));

// 4) 건수 텍스트
console.log('\n=== 감지된 건수 ===');
R.filter(r=>r.counts&&r.counts.length).forEach(r => console.log(' ', r.label, '=>', r.counts.join(', ')));
