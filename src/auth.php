<?php
// ── 세션/로그인 가드 ──
// 레거시 계정(아이디/비밀번호)으로 Supabase app.member_login RPC 검증 후 세션 유지.
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

function current_user() {
    return isset($_SESSION['user']) ? $_SESSION['user'] : null;
}

// 로그인 안 됐으면 로그인 화면으로. $url = 로그인 후 돌아올 경로
function require_login() {
    if (!current_user()) {
        $back = $_SERVER['REQUEST_URI'] ?? 'index.php';
        header('Location: login.php?url=' . rawurlencode($back));
        exit;
    }
}

// 레벨 기반 최소권한(선택). 미달 시 403.
function require_level($min) {
    $u = current_user();
    if (!$u || (int)$u['mb_level'] < (int)$min) {
        http_response_code(403);
        die('<h2>권한 없음</h2><p>이 화면은 레벨 ' . (int)$min . ' 이상만 접근할 수 있습니다.</p>');
    }
}
