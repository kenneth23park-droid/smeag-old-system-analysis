// 항공편 실시간 조회 프록시 (AviationStack). API 키는 Vercel 환경변수 AVIATIONSTACK_KEY 에만 존재.
// 클라이언트는 /api/flight?code=OZ710&date=YYYY-MM-DD 로 호출. 키 노출 없음.
export default async function handler(req, res) {
  const key = process.env.AVIATIONSTACK_KEY;
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5분 캐시(호출수 절약)
  if (!key) return res.status(200).json({ error: 'no_key', summary: 'API 키 미설정' });
  if (!code || code.length < 3) return res.status(200).json({ error: 'no_code' });
  try {
    const api = `http://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${code}&limit=1`;
    const r = await fetch(api);
    const j = await r.json();
    if (j && j.error) return res.status(200).json({ error: (j.error.message || j.error.info || 'api_error') });
    const f = (j.data || [])[0];
    if (!f) return res.status(200).json({ error: 'not_found', summary: `${code} 실시간 정보 없음` });
    const dep = f.departure || {}, arr = f.arrival || {};
    const hm = s => (s ? String(s).slice(11, 16) : '—');
    const delay = dep.delay ? `(+${dep.delay}m)` : '';
    const summary = `${code} ${dep.iata || '?'}→${arr.iata || '?'} 출발 ${hm(dep.scheduled)}${delay} 도착 ${hm(arr.scheduled)} · ${f.flight_status || ''}`;
    return res.status(200).json({ summary, status: f.flight_status, code,
      dep: { iata: dep.iata, scheduled: dep.scheduled, estimated: dep.estimated, delay: dep.delay },
      arr: { iata: arr.iata, scheduled: arr.scheduled, estimated: arr.estimated } });
  } catch (e) {
    return res.status(200).json({ error: 'fetch_fail' });
  }
}
