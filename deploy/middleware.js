// Vercel Edge Middleware — HTTP Basic 인증으로 프로덕션 접근 보호(무료 플랜 대응)
// 자격증명은 Vercel 환경변수(SITE_USER / SITE_PASS)에서만 읽음 — 소스/깃에 비밀번호 없음.
export const config = { matcher: '/:path*' };

export default function middleware(request) {
  const user = process.env.SITE_USER || 'admin';
  const pass = process.env.SITE_PASS || '';
  const auth = request.headers.get('authorization') || '';
  const expected = 'Basic ' + btoa(`${user}:${pass}`);
  if (pass && auth === expected) return; // 인증 통과 → 정적 파일 서빙
  return new Response('인증이 필요합니다 (SMEAG Admin).', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="SMEAG Admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
