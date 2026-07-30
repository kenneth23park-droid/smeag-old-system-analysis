// 부하/성능 재측정: 커넥션 재사용 + 메모리 캐시 효과
import fs from "node:fs";
import crypto from "node:crypto";
for (const line of fs.readFileSync("/Users/kwangseobpark/smeag-old-system-analysis/.env","utf8").split("\n")){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^["']|["']$/g,"");}
process.env.AUTH_SESSION_SECRET="local_test_secret";
const {default:h}=await import("/Users/kwangseobpark/smeag-old-system-analysis/deploy/api/data.js");
const sign=(p)=>{const a=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");const n=Math.floor(Date.now()/1e3);
 const b=Buffer.from(JSON.stringify({...p,iat:n,exp:n+3600})).toString("base64url");
 return `${a}.${b}.`+crypto.createHmac("sha256",process.env.AUTH_SESSION_SECRET).update(`${a}.${b}`).digest("base64url");};
const C="sme_session="+encodeURIComponent(sign({mb_id:"admin1",mb_level:9}));
const call=async(qs,inm)=>{const req={method:"GET",url:"/api/data"+qs,headers:{cookie:C}};if(inm)req.headers["if-none-match"]=inm;
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(b){this.body=b||"";}};
 const t=Date.now();await h(req,res);return {res,ms:Date.now()-t,kb:Math.round(Buffer.byteLength(res.body||"")/1024)};};
const show=(l,r)=>console.log(l.padEnd(34), String(r.res.statusCode).padStart(3), String(r.ms+"ms").padStart(7), String(r.kb+"KB").padStart(8), (r.res.headers["x-data-source"]||"-"));
let r=await call("?parts=students");show("1 학생 (cold, 첫 커넥션)",r);const et=r.res.headers.etag;
r=await call("?parts=students");show("2 학생 (메모리캐시)",r);
r=await call("?parts=students",et);show("3 학생 (브라우저 ETag→304)",r);
r=await call("?parts=roomstat&month=2026-07");show("4 배치도 (cold)",r);const et4=r.res.headers.etag;
r=await call("?parts=roomstat&month=2026-07");show("5 배치도 (메모리캐시)",r);
r=await call("?parts=roomstat&month=2026-07",et4);show("6 배치도 (304)",r);
r=await call("?stamp=1");show("7 버전스탬프",r);
r=await call("?parts=pickup");show("8 픽업",r);
r=await call("?parts=groups");show("9 그룹",r);
r=await call("?parts=deposits");show("10 입금",r);
r=await call("?parts=changelog");show("11 변경이력",r);
r=await call("?parts=students,roomstat&month=2026-08");show("12 학생+배치도(다른 달)",r);
process.exit(0);
