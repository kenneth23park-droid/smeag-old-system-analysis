<?php
/* ============================================================================
 * login.php — 레거시(그누보드) 로그인 화면 재현 + Supabase 계정 검증
 * ----------------------------------------------------------------------------
 * · 기존 아이디/비밀번호 그대로 사용(사용자 결정 A). 비번 변경 없음.
 * · 검증: Supabase RPC  app.member_login(mb_id, mb_password)
 *     - app.admin_users(bcrypt) 우선 → cms.g4_member(레거시 MySQL 해시) 폴백
 * · 성공 시 세션에 계정정보 저장 후 원래 화면(url)으로 이동.
 * · 원본 g4_member 는 읽기 전용(불가침). 이 화면은 검증만 한다.
 * ========================================================================== */
require __DIR__ . '/auth.php';
require __DIR__ . '/db.php';

function h($v){ return htmlspecialchars($v ?? '', ENT_QUOTES, 'UTF-8'); }

// 로그인 후 돌아갈 경로(오픈 리다이렉트 방지: 같은 앱 내부 경로만 허용)
$back = isset($_GET['url']) ? (string)$_GET['url'] : 'index.php';
if (!preg_match('#^/?[A-Za-z0-9_./?=&%-]*$#', $back) || strpos($back, '//') !== false) {
    $back = 'index.php';
}

// 이미 로그인 상태면 통과
if (current_user()) {
    header('Location: ' . $back);
    exit;
}

$error = '';
$id_prefill = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $mb_id = isset($_POST['mb_id']) ? trim((string)$_POST['mb_id']) : '';
    $mb_pw = isset($_POST['mb_password']) ? (string)$_POST['mb_password'] : '';
    $id_prefill = $mb_id;
    $back = isset($_POST['url']) ? (string)$_POST['url'] : $back;
    if (!preg_match('#^/?[A-Za-z0-9_./?=&%-]*$#', $back) || strpos($back, '//') !== false) {
        $back = 'index.php';
    }

    if ($mb_id === '' || $mb_pw === '') {
        $error = '아이디와 비밀번호를 입력하세요.';
    } else {
        try {
            $st = $pdo->prepare('SELECT app.member_login(?, ?) AS r');
            $st->execute(array($mb_id, $mb_pw));
            $res = json_decode((string)$st->fetchColumn(), true);
        } catch (PDOException $e) {
            $res = null;
            $error = '로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
        }

        if (is_array($res) && !empty($res['ok'])) {
            // 세션 고정 방지
            session_regenerate_id(true);
            $_SESSION['user'] = array(
                'mb_id'    => $res['mb_id'],
                'mb_name'  => $res['mb_name'],
                'mb_level' => (int)$res['mb_level'],
                'source'   => $res['source'],
                'must_change' => !empty($res['must_change']),
            );
            header('Location: ' . $back);
            exit;
        } elseif ($error === '') {
            $error = '아이디 또는 비밀번호가 올바르지 않습니다.';
        }
    }
}
?>
<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMEAG 관리자 로그인</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
    background:linear-gradient(135deg,#1F4E78 0%,#163a5a 100%);color:#222}
  .box{width:360px;max-width:92vw;background:#fff;border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}
  .box header{background:#1F4E78;color:#fff;padding:22px 24px}
  .box header h1{margin:0;font-size:19px;letter-spacing:.3px}
  .box header p{margin:4px 0 0;font-size:12px;color:#bcd3ea}
  form{padding:24px}
  label{display:block;font-size:13px;color:#334;margin:0 0 6px;font-weight:bold}
  .field{margin-bottom:16px}
  input[type=text],input[type=password]{width:100%;padding:11px 12px;border:1px solid #ccd;
    border-radius:8px;font-size:14px}
  input[type=text]:focus,input[type=password]:focus{outline:none;border-color:#1F4E78;
    box-shadow:0 0 0 3px rgba(31,78,120,.15)}
  .chk{display:flex;align-items:center;gap:7px;font-size:13px;color:#556;margin-bottom:18px}
  button{width:100%;padding:12px;background:#1F4E78;color:#fff;border:0;border-radius:8px;
    font-size:15px;font-weight:bold;cursor:pointer}
  button:hover{background:#173c5e}
  .err{background:#fbe2d6;color:#c2410c;border:1px solid #e6a07f;border-radius:8px;
    padding:10px 12px;font-size:13px;margin-bottom:16px}
  .foot{padding:0 24px 20px;font-size:11.5px;color:#8896a4;line-height:1.6}
</style></head><body>
  <div class="box">
    <header>
      <h1>🏠 SMEAG 관리시스템</h1>
      <p>기존 아이디 · 비밀번호로 로그인하세요</p>
    </header>
    <form name="flogin" method="post" autocomplete="off">
      <input type="hidden" name="url" value="<?php echo h($back); ?>">
      <?php if ($error): ?><div class="err"><?php echo h($error); ?></div><?php endif; ?>
      <div class="field">
        <label for="mb_id">아이디</label>
        <input type="text" id="mb_id" name="mb_id" maxlength="20" required
               value="<?php echo h($id_prefill); ?>" autofocus>
      </div>
      <div class="field">
        <label for="mb_password">비밀번호</label>
        <input type="password" id="mb_password" name="mb_password" maxlength="20" required>
      </div>
      <label class="chk">
        <input type="checkbox" name="auto_login" value="on"> 자동로그인
      </label>
      <button type="submit">로그인</button>
    </form>
    <div class="foot">
      · 레거시 계정(관리자 · 스태프 · 유학원)이 그대로 연동됩니다.<br>
      · 데이터는 Supabase 로 이관되었으며, 원본 계정은 변경되지 않습니다.
    </div>
  </div>
</body></html>
