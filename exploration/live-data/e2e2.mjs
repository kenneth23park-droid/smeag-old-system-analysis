// Group Students(cash 카테고리) / DEPOSIT(student) 조각 매핑 검증
import fs from "node:fs";import http from "node:http";import path from "node:path";import crypto from "node:crypto";
import { chromium } from "/Users/kwangseobpark/smeag-old-system-analysis/node_modules/playwright/index.mjs";
for (const l of fs.readFileSync("/Users/kwangseobpark/smeag-old-system-analysis/.env","utf8").split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^["']|["']$/g,"");}
process.env.AUTH_SESSION_SECRET="local_test_secret";
const {default:h}=await import("/Users/kwangseobpark/smeag-old-system-analysis/deploy/api/data.js");
const sign=(p)=>{const a=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");const n=Math.floor(Date.now()/1e3);
const b=Buffer.from(JSON.stringify({...p,iat:n,exp:n+3600})).toString("base64url");
return `${a}.${b}.`+crypto.createHmac("sha256",process.env.AUTH_SESSION_SECRET).update(`${a}.${b}`).digest("base64url");};
const S=sign({mb_id:"admin1",mb_level:9});const calls=[];
const srv=http.createServer(async(req,res)=>{const u=new URL(req.url,"http://x");
 if(u.pathname==="/api/data"){calls.push(u.search);req.headers.cookie="sme_session="+encodeURIComponent(S);return h(req,res);}
 if(u.pathname==="/api/auth"){res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({mb_id:"admin1",mb_name:"T",mb_level:9}));}
 const f=u.pathname==="/"?"/index.html":u.pathname;const p=path.join("/Users/kwangseobpark/smeag-old-system-analysis/deploy",f);
 if(!fs.existsSync(p)){res.statusCode=404;return res.end("nf");}
 res.setHeader("Content-Type","text/html; charset=utf-8");res.end(fs.readFileSync(p));});
await new Promise(r=>srv.listen(4323,r));
const br=await chromium.launch();const page=await br.newPage({viewport:{width:1500,height:900}});
const errs=[];page.on("pageerror",e=>errs.push(e.message));
await page.goto("http://127.0.0.1:4323/?pc=1",{waitUntil:"domcontentloaded"});
await page.waitForTimeout(9000);
for(const [cat,title] of [["cash","Group Students"],["student","DEPOSIT"],["student","Deposit(test)"]]){
  const b=calls.length;
  await page.evaluate(([cat,title])=>{const m=MENU[cat].find(x=>x.t===title);curCat=cat;curMenu=m;curKey=m.k;return goMenu();},[cat,title]);
  await page.waitForTimeout(2500);
  const rows=await page.$$eval("#main table.grid tbody tr",n=>n.length);
  const first=((await page.textContent("#main table.grid tbody tr:first-child").catch(()=>""))||"").replace(/\s+/g," ").slice(0,80);
  console.log(title.padEnd(15),"호출",JSON.stringify(calls.slice(b)),"| 행",rows,"|",first);
}
console.log("errors:",errs.length?errs.slice(0,3):"none");
await br.close();srv.close();
