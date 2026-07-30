import fs from "node:fs";
import vm from "node:vm";
const files = [
  "/Users/kwangseobpark/smeag-old-system-analysis/deploy/index.html",
  "/Users/kwangseobpark/smeag-old-system-analysis/deploy/m/index.html",
];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(src))) {
    i++;
    const before = src.slice(0, m.index);
    const line = before.split("\n").length;
    const isModule = /type=["']module/.test(m[0]);
    try {
      new vm.Script(m[1], { filename: `${f}#${i}` });
      console.log(`OK   ${f} block#${i} @line ${line} len ${m[1].length}${isModule ? " (module)" : ""}`);
    } catch (e) {
      console.log(`FAIL ${f} block#${i} @line ${line} len ${m[1].length} :: ${e.message}`);
    }
  }
  console.log(`-- ${f}: ${i} inline blocks`);
}
// data.js: 모듈 파싱
try {
  await import("/Users/kwangseobpark/smeag-old-system-analysis/deploy/api/data.js");
  console.log("OK   deploy/api/data.js parses & imports");
} catch (e) {
  console.log("FAIL deploy/api/data.js :: " + e.message);
}
