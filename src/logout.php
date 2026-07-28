<?php
// ── 로그아웃: 세션 파기 후 로그인 화면으로 ──
require __DIR__ . '/auth.php';
$_SESSION = array();
if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
}
session_destroy();
header('Location: login.php');
exit;
