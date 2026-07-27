<?php
/* ============================================================================
 * index.php  —  신시스템 ↔ Supabase "연결 확인" 전용 (다른 기능 없음)
 * ----------------------------------------------------------------------------
 * 목적: 레거시 서버에서 Supabase(신 DB)로 연결이 되는지만 점검한다.
 *       화면(SPA)·데이터 재이관·CRUD 는 여기 없음(요청대로 "연결 확인"만).
 *
 * 사용법
 *   1) 아래 CONFIG 의 SUPABASE_URL / SUPABASE_KEY 를 채운다.
 *      - SUPABASE_URL : 예) https://bauhnnpioaephlwurxzg.supabase.co
 *      - SUPABASE_KEY : 대시보드 → Settings → API 의 anon(publishable) key
 *   2) 이 파일을 레거시 서버(예: /gnuboard4/adm/conn_test.php)에 올린다.
 *      ※ 기존 index.php 를 덮어쓰지 말 것! 테스트 끝나면 삭제.
 *   3) 브라우저로 그 주소를 열면 연결 결과(초록=성공/빨강=실패)가 뜬다.
 *
 * 보안
 *   - anon 키는 클라이언트용이라 노출돼도 RLS 로 보호되는 값(그래도 테스트 후 정리 권장).
 *   - service_role 키는 절대 여기 넣지 말 것(넣더라도 PHP 는 서버측 실행이라 소스는
 *     안 보이지만, 서버 오설정 시 유출 위험 → 연결 테스트엔 anon 키만 사용).
 *   - 이 파일은 "테스트 도구"다. 확인 끝나면 서버에서 삭제하라.
 *
 * 전제(하나라도 안 되면 실패로 표시됨)
 *   - Supabase 프로젝트가 켜져(Resume) 있어야 함.
 *   - 레거시 서버가 바깥(https)으로 나갈 수 있어야 함(방화벽).
 * ========================================================================== */

/* ───────────── CONFIG (여기만 채우세요) ───────────── */
$SUPABASE_URL = 'https://bauhnnpioaephlwurxzg.supabase.co';   // 프로젝트 URL
$SUPABASE_KEY = 'PASTE_YOUR_ANON_KEY_HERE';                    // ← anon 키 붙여넣기
$CHECK_TABLE  = '';   // (선택) 데이터 유무까지 보려면 테이블명 입력 예:'student_info' — 비우면 연결만 확인
/* ─────────────────────────────────────────────────── */

header('Content-Type: text/html; charset=utf-8');

/* 간단 HTTP GET (cURL 우선, 없으면 stream) — 응답 [status, body, error, ms] 반환 */
function http_get($url, $headers, &$ms) {
    $t0 = microtime(true);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        $body = curl_exec($ch);
        $err  = curl_error($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $ms = round((microtime(true) - $t0) * 1000);
        return array('status' => $code, 'body' => $body, 'error' => $err);
    }
    // 폴백: file_get_contents
    $hdr = '';
    foreach ($headers as $h) { $hdr .= $h . "\r\n"; }
    $ctx = stream_context_create(array('http' => array(
        'method' => 'GET', 'header' => $hdr, 'timeout' => 12, 'ignore_errors' => true)));
    $body = @file_get_contents($url, false, $ctx);
    $code = 0;
    if (isset($http_response_header[0]) &&
        preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) { $code = (int)$m[1]; }
    $ms = round((microtime(true) - $t0) * 1000);
    return array('status' => $code, 'body' => $body, 'error' => ($body === false ? 'request failed' : ''));
}

$configured = ($SUPABASE_KEY !== 'PASTE_YOUR_ANON_KEY_HERE' && $SUPABASE_KEY !== '');
$checks = array();

if ($configured) {
    $H = array('apikey: ' . $SUPABASE_KEY, 'Authorization: Bearer ' . $SUPABASE_KEY);

    // 1) REST 루트(PostgREST) — 키 수락 여부
    $ms = 0; $r = http_get(rtrim($SUPABASE_URL, '/') . '/rest/v1/', $H, $ms);
    $checks[] = array(
        'name' => 'Supabase REST 연결 (/rest/v1/)',
        'ok'   => ($r['status'] >= 200 && $r['status'] < 500 && $r['status'] != 401),
        'detail' => 'HTTP ' . $r['status'] . ' · ' . $ms . 'ms'
                    . ($r['status'] == 401 ? ' · 키 거부(401) — anon 키 확인' : '')
                    . ($r['error'] ? ' · ' . htmlspecialchars($r['error']) : ''),
    );

    // 2) Auth health
    $ms = 0; $r2 = http_get(rtrim($SUPABASE_URL, '/') . '/auth/v1/health', $H, $ms);
    $checks[] = array(
        'name' => 'Supabase Auth health (/auth/v1/health)',
        'ok'   => ($r2['status'] >= 200 && $r2['status'] < 400),
        'detail' => 'HTTP ' . $r2['status'] . ' · ' . $ms . 'ms'
                    . ($r2['error'] ? ' · ' . htmlspecialchars($r2['error']) : ''),
    );

    // 3) (선택) 테이블 건수 — 데이터 유무 확인
    if ($CHECK_TABLE !== '') {
        $url = rtrim($SUPABASE_URL, '/') . '/rest/v1/' . rawurlencode($CHECK_TABLE) . '?select=*&limit=1';
        $H3 = array_merge($H, array('Prefer: count=exact', 'Range-Unit: items', 'Range: 0-0'));
        $ms = 0; $r3 = http_get($url, $H3, $ms);
        $note = '';
        if ($r3['status'] == 200 || $r3['status'] == 206) { $note = '테이블 접근 OK'; }
        else if ($r3['status'] == 401 || $r3['status'] == 403) { $note = 'RLS/권한으로 차단(정상일 수 있음)'; }
        else if ($r3['status'] == 404) { $note = '테이블 없음 — 재이관 안 됨?'; }
        $checks[] = array(
            'name' => '테이블 확인 (' . htmlspecialchars($CHECK_TABLE) . ')',
            'ok'   => ($r3['status'] == 200 || $r3['status'] == 206),
            'detail' => 'HTTP ' . $r3['status'] . ' · ' . $ms . 'ms · ' . $note,
        );
    }
}

$allok = $configured && count($checks) > 0;
foreach ($checks as $c) { if (!$c['ok']) { $allok = false; } }
?><!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>index.php — Supabase 연결 확인</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","Segoe UI",sans-serif;
    background:#eef3f8;color:#17242b;line-height:1.6;}
  .wrap{max-width:640px;margin:0 auto;padding:40px 20px;}
  h1{font-size:22px;margin:0 0 4px;} .sub{color:#586b76;font-size:13px;margin:0 0 24px;}
  .verdict{border-radius:12px;padding:18px 20px;font-weight:800;font-size:16px;margin-bottom:20px;}
  .verdict.ok{background:#dcf0e1;color:#15803d;border:1px solid #15803d;}
  .verdict.no{background:#fbe2d6;color:#c2410c;border:1px solid #c2410c;}
  .verdict.cfg{background:#fef3c7;color:#92400e;border:1px solid #b45309;}
  .card{background:#fff;border:1px solid #d9e2ea;border-radius:12px;padding:6px 18px;box-shadow:0 4px 16px rgba(20,50,80,.08);}
  .row{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px dashed #e2e8f0;}
  .row:last-child{border-bottom:0;}
  .dot{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;margin-top:2px;}
  .dot.ok{background:#15803d;} .dot.no{background:#c2410c;}
  .row .nm{font-weight:700;font-size:14px;} .row .dt{font-size:12.5px;color:#586b76;font-family:ui-monospace,Menlo,monospace;}
  .note{font-size:12.5px;color:#586b76;margin-top:20px;line-height:1.7;}
  code{background:#f5f8fb;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px;font-size:12px;}
</style></head><body>
<div class="wrap">
  <h1>🔌 index.php — Supabase 연결 확인</h1>
  <p class="sub">신시스템 ↔ Supabase 연결만 점검하는 테스트 도구 (다른 기능 없음)</p>

<?php if (!$configured): ?>
  <div class="verdict cfg">⚙️ 설정 필요 — 파일 상단 CONFIG 의 <code>SUPABASE_KEY</code> 에 anon 키를 붙여넣으세요.</div>
  <div class="note">
    현재 <code>SUPABASE_URL</code> = <code><?php echo htmlspecialchars($SUPABASE_URL); ?></code><br>
    anon 키를 넣고 새로고침하면 연결 검사를 시작합니다.
  </div>
<?php else: ?>
  <div class="verdict <?php echo $allok ? 'ok' : 'no'; ?>">
    <?php echo $allok ? '✅ 연결 성공 — 서버에서 Supabase 에 정상 도달합니다.' : '❌ 연결 실패 — 아래 항목을 확인하세요.'; ?>
  </div>
  <div class="card">
    <?php foreach ($checks as $c): ?>
      <div class="row">
        <span class="dot <?php echo $c['ok'] ? 'ok' : 'no'; ?>"><?php echo $c['ok'] ? '✓' : '✕'; ?></span>
        <div><div class="nm"><?php echo htmlspecialchars($c['name']); ?></div>
          <div class="dt"><?php echo $c['detail']; ?></div></div>
      </div>
    <?php endforeach; ?>
  </div>
  <div class="note">
    <b>해석 가이드</b><br>
    · 모두 초록 → 서버↔Supabase <b>연결·키 정상</b>. 다음 단계(데이터 재이관/화면 연결)로 진행 가능.<br>
    · <code>HTTP 0</code> 또는 타임아웃 → 레거시 서버가 <b>바깥으로 못 나감</b>(방화벽) 또는 프로젝트 <b>일시정지</b>.<br>
    · <code>401</code> → <b>anon 키가 틀림</b>.<br>
    · 테이블 <code>404</code> → 그 테이블이 Supabase 에 <b>아직 없음(재이관 필요)</b>.<br>
    · <code>401/403</code>(테이블) → RLS 로 막힘(개인정보 보호 관점에선 정상).
  </div>
<?php endif; ?>

  <div class="note">⚠️ 이 파일은 <b>테스트 전용</b>입니다. 기존 <code>index.php</code> 를 덮어쓰지 말고 별도 이름(예 <code>conn_test.php</code>)으로 올리고, 확인 후 <b>삭제</b>하세요.</div>
</div>
</body></html>
