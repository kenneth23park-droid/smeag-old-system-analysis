// ============================================================================
// /api/auth — Vercel 서버리스 로그인 (Supabase 네이티브, PHP 없음)
// ----------------------------------------------------------------------------
// · 레거시 계정(아이디/비밀번호) 그대로 로그인. 검증은 Postgres RPC
//   app.member_authenticate (레이트리밋 15분·10회 + IP로깅). 기존 비번 무변경(결정 A).
// · 관리자(Lv8+)는 레거시 비번 로그인 시 강제 비번변경(app.member_set_password).
// · 세션: HS256 JWT 를 httpOnly·Secure 쿠키로 발급 → 클라이언트 위조 불가.
// · DB 접속: pg(pooler) 직접. 키(anon/service_role) 불필요 — PG_* 환경변수만.
//
// 라우팅(단일 함수):
//   GET   /api/auth        → 세션 있으면 랜딩, 없으면 로그인 폼
//   GET   /api/auth?me     → 세션 JSON
//   POST  action=login     → 검증 →(관리자 강제변경 대상이면 변경화면)→ 쿠키 발급 → 303
//   POST  action=change    → 비번 변경(Lv8+ 강제) → 쿠키 발급 → 303
//   POST  action=logout    → 쿠키 파기 → 303
//
// 필요 환경변수(Vercel): PG_HOST PG_PORT PG_DB PG_USER PG_PASS PG_SSLMODE
//                        AUTH_SESSION_SECRET
// ============================================================================
import crypto from "node:crypto";
import pg from "pg";

const SECRET = process.env.AUTH_SESSION_SECRET || "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const MAX_AGE = 60 * 60 * 8; // 8시간

const PG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres",
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false },
};

// ── DB RPC (요청당 커넥션 1개) ───────────────────────────────────────────────
async function rpc(sql, params) {
  const client = new pg.Client(PG);
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows[0].r;
  } finally {
    await client.end();
  }
}
const authenticate = (id, pw, ip) =>
  rpc("select app.member_authenticate($1,$2,$3) as r", [id, pw, ip]);
const setPassword = (id, oldPw, newPw, ip) =>
  rpc("select app.member_set_password($1,$2,$3,$4) as r", [id, oldPw, newPw, ip]);

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
function signSession(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + MAX_AGE };
  const p1 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p2 = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(`${p1}.${p2}`).digest("base64url");
  return `${p1}.${p2}.${sig}`;
}
function verifySession(token) {
  try {
    const [p1, p2, p3] = String(token).split(".");
    if (!p1 || !p2 || !p3) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${p1}.${p2}`).digest("base64url");
    const a = Buffer.from(p3), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(p2, "base64url").toString("utf8"));
    if (typeof body.exp === "number" && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return Object.fromEntries(new URLSearchParams(req.body));
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
  ));
}
function sendHtml(res, body, status = 200) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = status;
  res.end(body);
}
function sendJson(res, obj, status = 200, setCookie) {
  if (setCookie) res.setHeader("Set-Cookie", setCookie);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}
function cookieHeader(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}
function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
function redirect(res, location, setCookie) {
  if (setCookie) res.setHeader("Set-Cookie", setCookie);
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.end();
}

// ── 화면 ─────────────────────────────────────────────────────────────────────
function loginPage(error = "", idPrefill = "") {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMEAG 관리자 로그인</title>
<style>
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
   font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",-apple-system,BlinkMacSystemFont,sans-serif;
   background:linear-gradient(135deg,#1F4E78,#163a5a);color:#222}
 .box{width:360px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}
 header{background:#1F4E78;color:#fff;padding:22px 24px} header h1{margin:0;font-size:19px} header p{margin:4px 0 0;font-size:12px;color:#bcd3ea}
 form{padding:24px} label{display:block;font-size:13px;color:#334;margin:0 0 6px;font-weight:bold} .field{margin-bottom:16px}
 input[type=text],input[type=password]{width:100%;padding:11px 12px;border:1px solid #ccd;border-radius:8px;font-size:14px}
 input:focus{outline:none;border-color:#1F4E78;box-shadow:0 0 0 3px rgba(31,78,120,.15)}
 .chk{display:flex;align-items:center;gap:7px;font-size:13px;color:#556;margin-bottom:18px}
 button{width:100%;padding:12px;background:#1F4E78;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer}
 button:hover{background:#173c5e}
 .err{background:#fbe2d6;color:#c2410c;border:1px solid #e6a07f;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:16px}
 .foot{padding:0 24px 20px;font-size:11.5px;color:#8896a4;line-height:1.6}
</style></head><body>
 <div class="box">
  <header><h1>🏠 SMEAG 관리시스템</h1><p>기존 아이디 · 비밀번호로 로그인하세요</p></header>
  <form method="post" autocomplete="off">
   <input type="hidden" name="action" value="login">
   ${error ? `<div class="err">${esc(error)}</div>` : ""}
   <div class="field"><label for="mb_id">아이디</label>
    <input type="text" id="mb_id" name="mb_id" maxlength="20" required value="${esc(idPrefill)}" autofocus></div>
   <div class="field"><label for="mb_password">비밀번호</label>
    <input type="password" id="mb_password" name="mb_password" maxlength="40" required></div>
   <label class="chk"><input type="checkbox" name="auto_login" value="on"> 자동로그인</label>
   <button type="submit">로그인</button>
  </form>
  <div class="foot">· 레거시 계정(관리자·스태프·유학원)이 그대로 연동됩니다.<br>· 데이터는 Supabase 로 이관되었으며, 원본 계정은 변경되지 않습니다.</div>
 </div>
</body></html>`;
}
function changePage(mbId, error = "") {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>비밀번호 변경 · SMEAG</title>
<style>
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
   font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",-apple-system,BlinkMacSystemFont,sans-serif;
   background:linear-gradient(135deg,#1F4E78,#163a5a);color:#222}
 .box{width:380px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}
 header{background:#b8681c;color:#fff;padding:22px 24px} header h1{margin:0;font-size:18px} header p{margin:4px 0 0;font-size:12px;color:#f6e2cd}
 form{padding:24px} label{display:block;font-size:13px;color:#334;margin:0 0 6px;font-weight:bold} .field{margin-bottom:15px}
 input[type=password]{width:100%;padding:11px 12px;border:1px solid #ccd;border-radius:8px;font-size:14px}
 input:focus{outline:none;border-color:#b8681c;box-shadow:0 0 0 3px rgba(184,104,28,.15)}
 .who{font-size:13px;color:#556;margin-bottom:14px}.who b{color:#1F4E78}
 button{width:100%;padding:12px;background:#b8681c;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer}
 button:hover{background:#98550f}
 .err{background:#fbe2d6;color:#c2410c;border:1px solid #e6a07f;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
 .hint{font-size:11.5px;color:#8896a4;margin-top:-8px;margin-bottom:14px}
</style></head><body>
 <div class="box">
  <header><h1>🔒 비밀번호 변경 필요</h1><p>관리자 계정은 보안을 위해 최초 로그인 시 변경해야 합니다</p></header>
  <form method="post" autocomplete="off">
   <input type="hidden" name="action" value="change">
   <input type="hidden" name="mb_id" value="${esc(mbId)}">
   <div class="who">계정 <b>${esc(mbId)}</b></div>
   ${error ? `<div class="err">${esc(error)}</div>` : ""}
   <div class="field"><label for="old">현재 비밀번호</label>
    <input type="password" id="old" name="old_password" maxlength="40" required autofocus></div>
   <div class="field"><label for="np">새 비밀번호</label>
    <input type="password" id="np" name="new_password" maxlength="40" required></div>
   <div class="hint">8자 이상 · 아이디와 다르게 · 단순한 값 금지</div>
   <div class="field"><label for="np2">새 비밀번호 확인</label>
    <input type="password" id="np2" name="new_password2" maxlength="40" required></div>
   <button type="submit">변경하고 로그인</button>
  </form>
 </div>
</body></html>`;
}
function landingPage(s) {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMEAG 관리시스템</title>
<style>
 body{margin:0;font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#eef2f7;color:#12233a}
 header{background:#1F4E78;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
 header h1{margin:0;font-size:17px} .u{font-size:13px;color:#cfe0f0} .u b{color:#fff}
 .wrap{max-width:720px;margin:0 auto;padding:40px 22px}
 .card{background:#fff;border:1px solid #d3ddea;border-radius:12px;padding:26px;box-shadow:0 8px 28px rgba(18,35,58,.07)}
 .card h2{margin:0 0 6px;font-size:20px} .card p{color:#3f5065;font-size:14px;margin:0}
 form{display:inline} .lo{background:none;border:0;color:#fff;text-decoration:underline;cursor:pointer;font-size:13px;margin-left:12px;padding:0}
 .kv{margin-top:18px;font-size:13px;color:#647890} .kv code{font-family:ui-monospace,Menlo,monospace}
 a.app{display:inline-block;margin-top:18px;padding:10px 16px;background:#1F4E78;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}
</style></head><body>
 <header><h1>🏠 SMEAG 관리시스템</h1>
  <div class="u"><b>${esc(s.mb_name ?? s.mb_id)}</b> (${esc(s.mb_id)} · Lv${Number(s.mb_level) || 0})
   <form method="post"><input type="hidden" name="action" value="logout"><button class="lo">로그아웃</button></form></div>
 </header>
 <div class="wrap"><div class="card">
   <h2>로그인 성공 ✅</h2>
   <p>Supabase 기반 인증으로 접속되었습니다. 세션은 httpOnly 쿠키로 유지됩니다.</p>
   <a class="app" href="/">관리 화면으로 이동 →</a>
   <div class="kv" style="margin-top:16px">계정 출처 <code>${esc(s.source ?? "")}</code></div>
 </div></div>
</body></html>`;
}

// ── 엔트리 ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const self = (req.url || "/api/auth").split("?")[0];
  const token = readCookie(req, COOKIE);
  const session = token ? verifySession(token) : null;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;

  if (req.method === "GET") {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.has("me")) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = session ? 200 : 401;
      return res.end(JSON.stringify(session ?? { ok: false }));
    }
    return sendHtml(res, session ? landingPage(session) : loginPage());
  }

  if (req.method === "POST") {
    let body;
    try { body = await parseBody(req); } catch { body = {}; }
    const action = String(body.action || "login");
    // JSON 모드: 페이지 내 로그인 게이트(fetch)가 Accept: application/json 으로 호출.
    // 쿠키는 그대로 Set-Cookie 로 발급(브라우저가 same-origin fetch 에서 저장).
    const json = (req.headers.accept || "").includes("application/json");

    if (action === "logout") {
      if (json) return sendJson(res, { ok: true }, 200, clearCookieHeader());
      return redirect(res, self, clearCookieHeader());
    }

    try {
      if (action === "change") {
        const cid = String(body.mb_id || "").trim();
        const oldPw = String(body.old_password || "");
        const np1 = String(body.new_password || "");
        const np2 = String(body.new_password2 || "");
        if (np1 !== np2) {
          if (json) return sendJson(res, { ok: false, error: "mismatch", message: "새 비밀번호가 서로 일치하지 않습니다." }, 400);
          return sendHtml(res, changePage(cid, "새 비밀번호가 서로 일치하지 않습니다."), 400);
        }
        const cres = await setPassword(cid, oldPw, np1, ip);
        if (cres && cres.ok) {
          const jwt = signSession({ mb_id: cres.mb_id, mb_name: cres.mb_name, mb_level: cres.mb_level, source: "member_set" });
          if (json) return sendJson(res, { ok: true, mb_id: cres.mb_id, mb_name: cres.mb_name, mb_level: cres.mb_level }, 200, cookieHeader(jwt));
          return redirect(res, self, cookieHeader(jwt));
        }
        const cmsg = cres && cres.error === "weak_password"
          ? `새 비밀번호가 정책에 맞지 않습니다 (${esc(cres.reason || "")}).`
          : cres && cres.error === "bad_old_password"
          ? "현재 비밀번호가 올바르지 않습니다."
          : "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도하세요.";
        if (json) return sendJson(res, { ok: false, error: (cres && cres.error) || "change_failed", message: cmsg }, 400);
        return sendHtml(res, changePage(cid, cmsg), 400);
      }

      // login
      const mb_id = String(body.mb_id || "").trim();
      const mb_pw = String(body.mb_password || "");
      const rres = await authenticate(mb_id, mb_pw, ip);
      if (rres && rres.ok) {
        if (rres.must_change) {
          if (json) return sendJson(res, { ok: true, must_change: true, mb_id: rres.mb_id, mb_name: rres.mb_name, mb_level: rres.mb_level }, 200);
          return sendHtml(res, changePage(rres.mb_id), 200);
        }
        const jwt = signSession({ mb_id: rres.mb_id, mb_name: rres.mb_name, mb_level: rres.mb_level, source: rres.source });
        if (json) return sendJson(res, { ok: true, mb_id: rres.mb_id, mb_name: rres.mb_name, mb_level: rres.mb_level, source: rres.source }, 200, cookieHeader(jwt));
        return redirect(res, self, cookieHeader(jwt));
      }
      const msg = rres && rres.error === "too_many_attempts"
        ? "로그인 시도가 많아 잠시 차단되었습니다. 15분 후 다시 시도하세요."
        : "아이디 또는 비밀번호가 올바르지 않습니다.";
      if (json) return sendJson(res, { ok: false, error: (rres && rres.error) || "invalid_credentials", message: msg }, 401);
      return sendHtml(res, loginPage(msg, mb_id), 401);
    } catch (e) {
      if (json) return sendJson(res, { ok: false, error: "server_error", message: "서버 오류가 발생했습니다." }, 500);
      return sendHtml(res, loginPage("서버 오류가 발생했습니다. 잠시 후 다시 시도하세요."), 500);
    }
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
}
