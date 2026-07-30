// ============================================================================
// Edge Middleware — 실데이터 페이지 서버측 보호
// ----------------------------------------------------------------------------
// index.html 에는 실 MySQL 데이터(학생 실명·기숙사 배정)가 임베드되어 배포된다.
// 로그인 오버레이는 클라이언트측이라 소스에는 그대로 내려가므로, 세션 쿠키
// (/api/auth 가 발급한 HS256 sme_session) 없이는 정적 페이지 자체를 못 받게 막는다.
//   · 세션 있음 → 통과
//   · 세션 없음/만료/위조 → 302 /login (= /api/auth 로그인 폼)
// 제외 경로: /api/*(각 함수가 자체 인증) · /login · favicon · _vercel 내부
// 되돌리려면 이 파일 삭제 후 재배포하면 된다.
// ============================================================================
export const config = {
  matcher: ["/((?!api/|login|favicon.ico|robots.txt|_vercel).*)"],
};

const COOKIE = "sme_session";
const SECRET = process.env.AUTH_SESSION_SECRET || "";
const enc = new TextEncoder();

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

// /api/auth 의 signSession 과 동일한 HS256 JWT 검증 (edge: Web Crypto)
async function verifySession(token) {
  if (!token || !SECRET) return null;
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlBytes(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
    if (body.exp && body.exp * 1000 < Date.now()) return null;
    return body;
  } catch (_) {
    return null;
  }
}

export default async function middleware(req) {
  // 시크릿 미설정 등 예기치 못한 상황에서 사이트를 잠그지 않도록: 검증 불가면 그대로 통과시키지 않고
  // 로그인으로 보낸다(데이터 보호 우선). 단 SECRET 자체가 없으면 로그인도 불가하므로 통과.
  if (!SECRET) return;

  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const session = await verifySession(m && decodeURIComponent(m[1]));
  if (session) return;

  const url = new URL(req.url);
  return Response.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname)}`, url.origin), 302);
}
