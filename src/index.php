<?php
require __DIR__ . '/auth.php';
require_login();                 // 로그인 필수 — 미로그인 시 login.php 로
$ME = current_user();
require __DIR__ . '/db.php';

// 어떤 예약 테이블이 있는지 감지 (room_reserve / room_reserve_2026)
$tables = array();
foreach (array('room_reserve', 'room_reserve_2026') as $t) {
    if (table_exists($pdo, $t)) $tables[] = $t;
}
$table = isset($_GET['t']) && in_array($_GET['t'], $tables, true) ? $_GET['t'] : (count($tables) ? $tables[0] : null);

// 대시보드 통계 (선택된 테이블)
$stats = null;
if ($table) {
    $stats = array();
    $q = $pdo->query("SELECT COUNT(*) c, MIN(rr_date) mn, MAX(rr_date) mx FROM \"$table\"");
    $stats['base'] = $q->fetch();
    $stats['type'] = array();
    $q = $pdo->query("SELECT rr_type, COUNT(*) c FROM \"$table\" GROUP BY rr_type ORDER BY c DESC");
    foreach ($q as $row) $stats['type'][] = $row;
    $stats['bldg'] = array();
    $q = $pdo->query("SELECT bldg_type, COUNT(*) c FROM \"$table\" GROUP BY bldg_type ORDER BY c DESC");
    foreach ($q as $row) $stats['bldg'][] = $row;
}

// 예약 목록 (검색 + 페이지네이션, prepared statement)
$per = 50;
$page = isset($_GET['p']) ? max(1, (int)$_GET['p']) : 1;
$off = ($page - 1) * $per;
$s_idx = isset($_GET['s']) ? trim($_GET['s']) : '';
$rows = array();
$total = 0;
if ($table) {
    if ($s_idx !== '' && ctype_digit($s_idx)) {
        $st = $pdo->prepare("SELECT rr_idx,r_idx,ri_idx,rr_date,s_idx,rr_type,bldg_type,\"timestamp\" FROM \"$table\" WHERE s_idx=? ORDER BY rr_date DESC LIMIT ? OFFSET ?");
        $si = (int)$s_idx;
        $st->bindValue(1, $si, PDO::PARAM_INT);
        $st->bindValue(2, $per, PDO::PARAM_INT);
        $st->bindValue(3, $off, PDO::PARAM_INT);
        $st->execute();
        $rows = $st->fetchAll();
        $cst = $pdo->prepare("SELECT COUNT(*) c FROM \"$table\" WHERE s_idx=?");
        $cst->bindValue(1, $si, PDO::PARAM_INT);
        $cst->execute();
        $total = (int)$cst->fetchColumn();
    } else {
        $st = $pdo->prepare("SELECT rr_idx,r_idx,ri_idx,rr_date,s_idx,rr_type,bldg_type,\"timestamp\" FROM \"$table\" ORDER BY rr_idx DESC LIMIT ? OFFSET ?");
        $st->bindValue(1, $per, PDO::PARAM_INT);
        $st->bindValue(2, $off, PDO::PARAM_INT);
        $st->execute();
        $rows = $st->fetchAll();
        $total = isset($stats['base']['c']) ? (int)$stats['base']['c'] : 0;
    }
}
$pages = $total ? (int)ceil($total / $per) : 1;
function h($v){ return htmlspecialchars($v, ENT_QUOTES, 'UTF-8'); }
$TYPE_KO = array('I'=>'재실','E'=>'퇴실','S'=>'입실','R'=>'대기');
?>
<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMEAG 레거시 예약 조회</title>
<style>
 body{font-family:Arial,'Apple SD Gothic Neo',sans-serif;margin:0;background:#f4f6f9;color:#222}
 header{background:#1F4E78;color:#fff;padding:14px 22px}
 header h1{margin:0;font-size:18px} .wrap{padding:20px}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
 .card{background:#fff;border:1px solid #dde;border-radius:8px;padding:14px 18px;min-width:150px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
 .card .n{font-size:22px;font-weight:bold;color:#1F4E78} .card .l{font-size:12px;color:#666}
 .pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;margin:2px 4px 2px 0;background:#eef}
 table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
 th{background:#1F4E78;color:#fff;padding:8px;text-align:left} td{padding:6px 8px;border-bottom:1px solid #eee}
 tr:hover td{background:#f0f4fb}
 .tabs a{display:inline-block;padding:6px 14px;margin-right:6px;background:#fff;border:1px solid #ccd;border-radius:6px 6px 0 0;text-decoration:none;color:#1F4E78}
 .tabs a.on{background:#1F4E78;color:#fff}
 form{margin:14px 0} input[type=text]{padding:7px;border:1px solid #ccd;border-radius:6px}
 button{padding:7px 14px;background:#1F4E78;color:#fff;border:0;border-radius:6px;cursor:pointer}
 .pg a{padding:5px 10px;margin:2px;border:1px solid #ccd;border-radius:5px;text-decoration:none;color:#1F4E78;background:#fff}
 .pg .cur{background:#1F4E78;color:#fff} .warn{background:#fff3cd;border:1px solid #ffe08a;padding:14px;border-radius:8px}
 .t-I{color:#2a7} .t-E{color:#c33} .t-S{color:#27c} .t-R{color:#e80}
</style></head><body>
<header style="display:flex;align-items:center;justify-content:space-between">
  <h1>🏠 SMEAG 레거시 예약 시스템 (조회 전용)</h1>
  <div style="font-size:13px;color:#cfe0f0">
    <b style="color:#fff"><?php echo h($ME['mb_name']); ?></b>
    (<?php echo h($ME['mb_id']); ?> · Lv<?php echo (int)$ME['mb_level']; ?>)
    <a href="logout.php" style="color:#fff;margin-left:10px;text-decoration:underline">로그아웃</a>
  </div>
</header>
<div class="wrap">
<?php if (!count($tables)): ?>
  <div class="warn"><b>예약 테이블이 없습니다.</b> 덤프 import를 먼저 실행하세요. (QUICKSTART.md 3단계)</div>
<?php else: ?>
  <div class="tabs">
    <?php foreach ($tables as $t): ?>
      <a class="<?php echo $t===$table?'on':''; ?>" href="?t=<?php echo h($t); ?>"><?php echo h($t); ?></a>
    <?php endforeach; ?>
  </div>
  <?php if ($stats): ?>
  <div class="cards" style="margin-top:14px">
    <div class="card"><div class="n"><?php echo number_format($stats['base']['c']); ?></div><div class="l">총 행 수</div></div>
    <div class="card"><div class="n"><?php echo h($stats['base']['mn']); ?></div><div class="l">최소 날짜</div></div>
    <div class="card"><div class="n"><?php echo h($stats['base']['mx']); ?></div><div class="l">최대 날짜</div></div>
    <div class="card"><div class="l">예약유형</div>
      <?php foreach ($stats['type'] as $r): $k=$r['rr_type']; ?>
        <span class="pill"><?php echo h($k).'('.(isset($TYPE_KO[$k])?$TYPE_KO[$k]:'?').') '.number_format($r['c']); ?></span>
      <?php endforeach; ?>
    </div>
    <div class="card"><div class="l">건물유형</div>
      <?php foreach ($stats['bldg'] as $r): ?>
        <span class="pill"><?php echo h($r['bldg_type']!==''?$r['bldg_type']:'(빈값)').' '.number_format($r['c']); ?></span>
      <?php endforeach; ?>
    </div>
  </div>
  <?php endif; ?>

  <form method="get">
    <input type="hidden" name="t" value="<?php echo h($table); ?>">
    <input type="text" name="s" placeholder="학생번호(s_idx)로 검색" value="<?php echo h($s_idx); ?>">
    <button>검색</button>
    <?php if ($s_idx!==''): ?><a href="?t=<?php echo h($table); ?>" style="margin-left:8px">전체보기</a><?php endif; ?>
    <span style="color:#666;margin-left:10px">검색결과 <?php echo number_format($total); ?>건</span>
  </form>

  <table>
    <tr><th>rr_idx</th><th>객실(r_idx)</th><th>예약묶음(ri_idx)</th><th>날짜</th><th>학생(s_idx)</th><th>유형</th><th>건물</th><th>등록시각</th></tr>
    <?php foreach ($rows as $r): $k=$r['rr_type']; ?>
      <tr>
        <td><?php echo h($r['rr_idx']); ?></td>
        <td><?php echo h($r['r_idx']); ?></td>
        <td><?php echo h($r['ri_idx']); ?></td>
        <td><?php echo h($r['rr_date']); ?></td>
        <td><a href="?t=<?php echo h($table); ?>&s=<?php echo h($r['s_idx']); ?>"><?php echo h($r['s_idx']); ?></a></td>
        <td class="t-<?php echo h($k); ?>"><?php echo h($k).' '.(isset($TYPE_KO[$k])?$TYPE_KO[$k]:''); ?></td>
        <td><?php echo h($r['bldg_type']); ?></td>
        <td><?php echo h($r['timestamp']); ?></td>
      </tr>
    <?php endforeach; ?>
  </table>

  <div class="pg" style="margin-top:14px">
    <?php
      $base = "?t=".h($table).($s_idx!==''?"&s=".h($s_idx):"");
      $start=max(1,$page-3); $end=min($pages,$page+3);
      if($page>1) echo "<a href=\"$base&p=".($page-1)."\">← 이전</a>";
      for($i=$start;$i<=$end;$i++) echo "<a class=\"".($i==$page?'cur':'')."\" href=\"$base&p=$i\">$i</a>";
      if($page<$pages) echo "<a href=\"$base&p=".($page+1)."\">다음 →</a>";
      echo " <span style=\"color:#666\">($page / $pages 페이지)</span>";
    ?>
  </div>
<?php endif; ?>
</div></body></html>
