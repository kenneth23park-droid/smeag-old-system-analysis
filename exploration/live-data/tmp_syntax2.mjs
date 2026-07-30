import fs from "node:fs";import vm from "node:vm";
for (const f of ["/Users/kwangseobpark/smeag-old-system-analysis/deploy/index.html","/Users/kwangseobpark/smeag-old-system-analysis/deploy/m/index.html"]) {
  let src = fs.readFileSync(f,"utf8");
  // HTML 주석을 같은 길이 공백으로 치환(라인번호 보존)
  src = src.replace(/<!--[\s\S]*?-->/g, (s)=>s.replace(/[^\n]/g," "));
  const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;let m,i=0;
  while((m=re.exec(src))){i++;const line=src.slice(0,m.index).split("\n").length;
    try{new vm.Script(m[1]);console.log(`OK   ${f.split("/deploy/")[1]} block#${i} @${line} len ${m[1].length}`);}
    catch(e){console.log(`FAIL ${f.split("/deploy/")[1]} block#${i} @${line} :: ${e.message}`);}}
}
