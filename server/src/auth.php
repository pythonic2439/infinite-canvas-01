<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/mailer.php';

/**
 * 账号体系: 邮箱验证码注册(送点) / 登录 / Cookie 会话。
 * Cookie: HttpOnly + Secure + SameSite=Lax, 同源请求自动携带 (网关/同步接口都靠它鉴权)。
 */

function issue_session(int $userId): string
{
    $token = random_token(32);
    $stmt = db()->prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    $stmt->execute([hash('sha256', $token), $userId, now(), now() + SESSION_TTL_SECONDS]);
    setcookie(SESSION_COOKIE, $token, [
        'expires' => now() + SESSION_TTL_SECONDS,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    return $token;
}

function current_session_user(): ?array
{
    $token = (string) ($_COOKIE[SESSION_COOKIE] ?? '');
    if ($token === '') {
        return null;
    }
    $stmt = db()->prepare('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?');
    $stmt->execute([hash('sha256', $token)]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    if ((int) $row['expires_at'] < now()) {
        db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
        return null;
    }
    // 滑动续期: 每天刷新一次过期时间
    if ((int) $row['expires_at'] - now() < SESSION_TTL_SECONDS - SESSION_RENEW_INTERVAL) {
        db()->prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')->execute([now() + SESSION_TTL_SECONDS, $row['token_hash']]);
    }
    if ($row['status'] !== 'active') {
        return null;
    }
    return $row;
}

function require_user(): array
{
    $user = current_session_user();
    if (!$user) {
        fail('not signed in', 401);
    }
    return $user;
}

function require_admin(): array
{
    $user = require_user();
    if ((int) $user['is_admin'] !== 1) {
        fail('admin only', 403);
    }
    return $user;
}

function public_user(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'email' => (string) $row['email'],
        'points' => (int) $row['points'],
        'isAdmin' => (int) $row['is_admin'] === 1,
        'createdAt' => (int) $row['created_at'],
    ];
}

/** 每日签到状态: 今日是否已签 + 可领点数。 */
function checkin_status(array $user): array
{
    return [
        'points' => max(0, (int) get_setting('checkin_points', '5')),
        'done' => (string) ($user['last_checkin_date'] ?? '') === date('Y-m-d'),
    ];
}

function handle_checkin(): void
{
    require_same_origin();
    $user = require_user();
    $today = date('Y-m-d');
    if ((string) $user['last_checkin_date'] === $today) {
        fail('今日已签到，明天再来', 409);
    }
    $reward = max(0, (int) get_setting('checkin_points', '5'));
    if ($reward <= 0) {
        fail('签到活动未开启', 409);
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        // 原子占位: 只有一次 UPDATE 能把 last_checkin_date 从旧值改成今天
        $stmt = $pdo->prepare('UPDATE users SET points = points + ?, last_checkin_date = ? WHERE id = ? AND last_checkin_date != ?');
        $stmt->execute([$reward, $today, $user['id'], $today]);
        if ($stmt->rowCount() !== 1) {
            $pdo->rollBack();
            fail('今日已签到，明天再来', 409);
        }
        log_points((int) $user['id'], $reward, 'checkin', null, null, '每日签到');
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    $fresh = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $fresh->execute([$user['id']]);
    $row = (array) $fresh->fetch();
    respond_ok(['user' => public_user($row), 'checkin' => checkin_status($row), 'reward' => $reward]);
}

function handle_send_code(): void
{
    require_same_origin();
    $body = json_body();
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail('邮箱格式不正确');
    }
    if (get_setting('signup_enabled', '1') !== '1') {
        fail('当前未开放注册');
    }
    // 限频: 同邮箱 60s 1 次 / 每天 5 次; 同 IP 每天 20 次
    if (!rate_limit('send-code-email:' . $email, 1, 60) || !rate_limit('send-code-emailday:' . $email, 5, 86400) || !rate_limit('send-code-ip:' . client_ip(), 20, 86400)) {
        fail('发送太频繁，请稍后再试', 429);
    }
    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    // 覆盖旧验证码, 一个邮箱同时只有一个有效码
    db()->prepare('DELETE FROM email_codes WHERE email = ?')->execute([$email]);
    db()->prepare('INSERT INTO email_codes (email, code, purpose, expires_at, created_at) VALUES (?, ?, "register", ?, ?)')
        ->execute([$email, $code, now() + 600, now()]);
    send_verification_code($email, $code);
    respond_ok();
}

function handle_register(): void
{
    require_same_origin();
    $body = json_body();
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    $code = trim((string) ($body['code'] ?? ''));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail('邮箱格式不正确');
    }
    if (strlen($password) < 8) {
        fail('密码至少 8 位');
    }
    if (get_setting('signup_enabled', '1') !== '1') {
        fail('当前未开放注册');
    }
    if (!rate_limit('register-ip:' . client_ip(), 5, 86400)) {
        fail('注册太频繁，请明天再试', 429);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM email_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1');
    $stmt->execute([$email]);
    $row = $stmt->fetch();
    if (!$row || (string) $row['code'] !== $code) {
        fail('验证码错误');
    }
    if ((int) $row['expires_at'] < now()) {
        fail('验证码已过期，请重新获取');
    }
    // 防爆破: 错 5 次作废
    $pdo->prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?')->execute([$email]);
    if ((int) $row['attempts'] >= 5) {
        fail('验证码错误次数过多，请重新获取');
    }

    $exists = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $exists->execute([$email]);
    if ($exists->fetchColumn()) {
        fail('该邮箱已注册，请直接登录', 409);
    }

    $gift = max(0, (int) get_setting('gift_points', '100'));
    $pdo->beginTransaction();
    $insert = $pdo->prepare('INSERT INTO users (email, password_hash, points, gw_token, created_at) VALUES (?, ?, ?, ?, ?)');
    $insert->execute([$email, password_hash($password, PASSWORD_DEFAULT), $gift, random_token(), now()]);
    $userId = (int) $pdo->lastInsertId();
    if ($gift > 0) {
        log_points($userId, $gift, 'gift', null, null, '注册赠送');
    }
    $pdo->commit();

    $pdo->prepare('DELETE FROM email_codes WHERE email = ?')->execute([$email]);
    issue_session($userId);
    $user = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $user->execute([$userId]);
    $row = (array) $user->fetch();
    respond_ok(['user' => public_user($row), 'checkin' => checkin_status($row)]);
}

function handle_login(): void
{
    require_same_origin();
    $body = json_body();
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    if (!rate_limit('login-ip:' . client_ip(), 30, 900)) {
        fail('尝试太频繁，请稍后再试', 429);
    }
    $stmt = db()->prepare('SELECT * FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $user = $stmt->fetch();
    if (!$user || !password_verify($password, (string) $user['password_hash'])) {
        fail('邮箱或密码错误', 401);
    }
    if ($user['status'] !== 'active') {
        fail('账号已被停用，请联系管理员', 403);
    }
    // 密码算法升级时透明重哈希
    if (password_needs_rehash((string) $user['password_hash'], PASSWORD_DEFAULT)) {
        db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
    }
    db()->prepare('UPDATE users SET last_login_at = ?, fail_count = 0 WHERE id = ?')->execute([now(), $user['id']]);
    issue_session((int) $user['id']);
    respond_ok(['user' => public_user((array) $user), 'checkin' => checkin_status((array) $user)]);
}

function handle_logout(): void
{
    $token = (string) ($_COOKIE[SESSION_COOKIE] ?? '');
    if ($token !== '') {
        db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    }
    setcookie(SESSION_COOKIE, '', ['expires' => 1, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    respond_ok();
}

/**
 * 生成失败退点: 前端在生成失败时调用。
 * 防滥用: 只退「最近 60 分钟内、同渠道同模型、尚未退过」的那笔生成扣费, 每笔只能退一次;
 * 每用户每天最多退 10 笔。手工乱调接口最多把自己刚花的点数退回, 无法凭空刷点。
 */
function handle_points_refund(): void
{
    require_same_origin();
    $user = require_user();
    $body = json_body();
    $channelId = trim((string) ($body['channel_id'] ?? ''));
    $model = trim((string) ($body['model'] ?? ''));
    if ($channelId === '' || $model === '') {
        fail('channel_id / model required');
    }
    if (!rate_limit('refund-user:' . $user['id'], 10, 86400)) {
        fail('今日退款请求次数已达上限', 429);
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM points_log WHERE user_id = ? AND reason = "generation" AND channel_id = ? AND model = ? AND refunded = 0 AND delta < 0 AND created_at >= ? ORDER BY id DESC LIMIT 1');
    $stmt->execute([$user['id'], $channelId, $model, now() - 3600]);
    $charge = $stmt->fetch();
    if (!$charge) {
        fail('没有可退的最近扣费记录', 404);
    }
    $cost = (int) -$charge['delta'];
    $pdo->beginTransaction();
    try {
        // 原子核销: 并发请求只有一个能把它标成已退
        $mark = $pdo->prepare('UPDATE points_log SET refunded = 1 WHERE id = ? AND refunded = 0');
        $mark->execute([$charge['id']]);
        if ($mark->rowCount() !== 1) {
            $pdo->rollBack();
            fail('该笔费用已退过', 409);
        }
        $pdo->prepare('UPDATE users SET points = points + ? WHERE id = ?')->execute([$cost, $user['id']]);
        $q = $pdo->prepare('SELECT points FROM users WHERE id = ?');
        $q->execute([$user['id']]);
        $balance = (int) ($q->fetchColumn() ?: 0);
        $pdo->prepare('INSERT INTO points_log (user_id, delta, balance_after, reason, channel_id, model, detail, created_at) VALUES (?, ?, ?, "refund", ?, ?, ?, ?)')
            ->execute([$user['id'], $cost, $balance, $channelId, $model, '失败退点 #' . $charge['id'], now()]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    respond_ok(['refunded' => $cost, 'points' => $balance]);
}

function log_points(int $userId, int $delta, string $reason, ?string $channelId = null, ?string $model = null, string $detail = ''): void
{
    $q = db()->prepare('SELECT points FROM users WHERE id = ?');
    $q->execute([$userId]);
    $balance = (int) ($q->fetchColumn() ?: 0);
    db()->prepare('INSERT INTO points_log (user_id, delta, balance_after, reason, channel_id, model, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute([$userId, $delta, $balance, $reason, $channelId, $model, $detail, now()]);
}
