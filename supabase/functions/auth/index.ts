// ============================================================================
// Supabase Edge Function : auth  (PHP 폐기 → Supabase 네이티브 로그인)
// ----------------------------------------------------------------------------
// · 레거시 계정(아이디/비밀번호)으로 로그인. 검증은 DB RPC app.member_authenticate
//   (service_role 호출, 레이트리밋 15분·10회 + IP로깅). 기존 비번 무변경(결정 A).
// · 세션: HS256 JWT 를 httpOnly·Secure 쿠키로 발급 → 클라이언트 위조 불가.
// · 서버측(Deno) 처리 → anon 키·검증로직 미노출. 의존성 0(Web Crypto 만 사용).
//
// 라우팅(모두 이 함수 하나로):
//   GET   ?           → 세션 있으면 랜딩, 없으면 로그인 폼
//   POST  action=login  → 검증 → 쿠키 발급 → 303 리다이렉트
//   POST  action=logout → 쿠키 파기 → 303 리다이렉트
//   GET   ?me           → 세션 JSON (프론트 연동용)
//
// 필요 시크릿(supabase secrets set):
//   AUTH_SESSION_SECRET   세션 서명 비밀키(길고 랜덤)
// 자동 주입: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 배포: supabase functions deploy auth --no-verify-jwt   (공개 로그인이라 JWT검증 끔)
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_SECRET = Deno.env.get("AUTH_SESSION_SECRET") ?? "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const MAX_AGE = 60 * 60 * 8; // 8시간

// ── base64url ──────────────────────────────────────────────────────────────
function b64url(data: Uint8Array): string {
  let s = btoa(String.fromCharCode(...data));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const enc = new TextEncoder();

async function hmacKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw", enc.encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
async function signSession(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + MAX_AGE };
  const p1 = b64url(enc.encode(JSON.stringify(header)));
  const p2 = b64url(enc.encode(JSON.stringify(body)));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${p1}.${p2}`));
  return `${p1}.${p2}.${b64url(new Uint8Array(sig))}`;
}
async function verifySession(token: string): Promise<Record<string, any> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [p1, p2, p3] = parts;
  const key = await hmacKey();
  const ok = await crypto.subtle.verify(
    "HMAC", key, b64urlDecode(p3), enc.encode(`${p1}.${p2}`),
  );
  if (!ok) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(p2)));
    if (typeof body.exp === "number" && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// ── DB RPC 호출 (service_role, 서버측) ──────────────────────────────────────
async function authenticate(mb_id: string, mb_pw: string, ip: string | null) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/member_authenticate`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_id: mb_id, p_pw: mb_pw, p_ip: ip }),
  });
  if (!r.ok) return { ok: false, error: "server_error" };
  return await r.json();
}

// ── 응답 헬퍼 ───────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any
  )[m]);
}
function htmlResp(body: string, status = 200, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extra },
  });
}
function cookieHeader(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}
function clearCookieHeader(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── 화면: 로그인 폼 ─────────────────────────────────────────────────────────
function loginPage(error = "", idPrefill = ""): string {
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
    <input type="password" id="mb_password" name="mb_password" maxlength="20" required></div>
   <label class="chk"><input type="checkbox" name="auto_login" value="on"> 자동로그인</label>
   <button type="submit">로그인</button>
  </form>
  <div class="foot">· 레거시 계정(관리자·스태프·유학원)이 그대로 연동됩니다.<br>· 데이터는 Supabase 로 이관되었으며, 원본 계정은 변경되지 않습니다.</div>
 </div>
</body></html>`;
}

// ── 화면: 로그인 후 랜딩(스텁) ───────────────────────────────────────────────
function landingPage(s: Record<string, any>): string {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMEAG 관리시스템</title>
<style>
 body{margin:0;font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#eef2f7;color:#12233a}
 header{background:#1F4E78;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
 header h1{margin:0;font-size:17px} .u{font-size:13px;color:#cfe0f0}
 .u b{color:#fff} .wrap{max-width:720px;margin:0 auto;padding:40px 22px}
 .card{background:#fff;border:1px solid #d3ddea;border-radius:12px;padding:26px;box-shadow:0 8px 28px rgba(18,35,58,.07)}
 .card h2{margin:0 0 6px;font-size:20px} .card p{color:#3f5065;font-size:14px;margin:0}
 form{display:inline} .lo{background:none;border:0;color:#fff;text-decoration:underline;cursor:pointer;font-size:13px;margin-left:12px;padding:0}
 .kv{margin-top:18px;font-size:13px;color:#647890} .kv code{font-family:ui-monospace,Menlo,monospace}
</style></head><body>
 <header><h1>🏠 SMEAG 관리시스템</h1>
  <div class="u"><b>${esc(s.mb_name ?? s.mb_id)}</b> (${esc(s.mb_id)} · Lv${Number(s.mb_level) || 0})
   <form method="post"><input type="hidden" name="action" value="logout"><button class="lo">로그아웃</button></form></div>
 </header>
 <div class="wrap"><div class="card">
   <h2>로그인 성공 ✅</h2>
   <p>Supabase 기반 인증으로 접속되었습니다. 여기에 실제 관리 화면(예약·학생·정산)을 연결합니다.</p>
   <div class="kv">계정 출처 <code>${esc(s.source ?? "")}</code> · 세션은 httpOnly 쿠키로 유지됩니다.</div>
 </div></div>
</body></html>`;
}

// ── 엔트리 ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const self = url.pathname; // 이 함수 경로로 리다이렉트
  const token = readCookie(req, COOKIE);
  const session = token ? await verifySession(token) : null;

  // JSON 세션 조회(프론트 연동)
  if (req.method === "GET" && url.searchParams.has("me")) {
    return new Response(JSON.stringify(session ?? { ok: false }), {
      status: session ? 200 : 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const form = await req.formData();
    const action = String(form.get("action") ?? "login");

    if (action === "logout") {
      return new Response(null, { status: 303, headers: { Location: self, "Set-Cookie": clearCookieHeader() } });
    }

    const mb_id = String(form.get("mb_id") ?? "").trim();
    const mb_pw = String(form.get("mb_password") ?? "");
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

    const res = await authenticate(mb_id, mb_pw, ip);
    if (res && res.ok) {
      const jwt = await signSession({
        mb_id: res.mb_id, mb_name: res.mb_name, mb_level: res.mb_level,
        source: res.source, must_change: !!res.must_change,
      });
      return new Response(null, { status: 303, headers: { Location: self, "Set-Cookie": cookieHeader(jwt) } });
    }

    const msg = res && res.error === "too_many_attempts"
      ? "로그인 시도가 많아 잠시 차단되었습니다. 15분 후 다시 시도하세요."
      : "아이디 또는 비밀번호가 올바르지 않습니다.";
    return htmlResp(loginPage(msg, mb_id), 401);
  }

  // GET
  if (session) return htmlResp(landingPage(session));
  return htmlResp(loginPage());
});
