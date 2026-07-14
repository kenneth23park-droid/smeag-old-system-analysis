<?php
// ── Supabase(Postgres) 접속 : PDO pgsql ──
// 레거시 MySQL → Supabase 이관. UI/화면은 동일, 백엔드만 Postgres.
// 자격증명은 환경변수로 주입(docker-compose 의 .env). 소스에 비밀키 하드코딩 금지.
$DB_HOST = getenv('PG_HOST') ?: 'aws-0-ap-northeast-1.pooler.supabase.com';
$DB_PORT = getenv('PG_PORT') ?: '5432';
$DB_NAME = getenv('PG_DB')   ?: 'postgres';
$DB_USER = getenv('PG_USER') ?: 'postgres.bauhnnpioaephlwurxzg';
$DB_PASS = getenv('PG_PASS') ?: '';
$DB_SSL  = getenv('PG_SSLMODE') ?: 'require';

$dsn = "pgsql:host={$DB_HOST};port={$DB_PORT};dbname={$DB_NAME};sslmode={$DB_SSL}";
try {
    $pdo = new PDO($dsn, $DB_USER, $DB_PASS, array(
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ));
} catch (PDOException $e) {
    http_response_code(503);
    die('<h2>DB 연결 실패</h2><p>' . htmlspecialchars($e->getMessage()) .
        '</p><p>PG_* 환경변수(자격증명)를 확인하세요.</p>');
}

// 뷰/테이블 존재 여부 (public 스키마)
function table_exists($pdo, $name) {
    $st = $pdo->prepare(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name = ?"
    );
    $st->execute(array($name));
    return (bool)$st->fetchColumn();
}
