<?php
declare(strict_types=1);

/**
 * 直接创建管理员账号 (跳过邮箱验证码, 用于首次部署引导 —— SMTP 还没配置时也能建号)。
 * 用法: php create-admin.php admin@example.com <password>
 * 若邮箱已存在则升级为管理员并重置密码。
 */

require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/db.php';
require_once __DIR__ . '/../src/auth.php';

$email = strtolower(trim($argv[1] ?? ''));
$password = (string) ($argv[2] ?? '');
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8) {
    fwrite(STDERR, "用法: php create-admin.php <email> <password≥8位>\n");
    exit(1);
}

$pdo = db();
$stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
$stmt->execute([$email]);
$existing = $stmt->fetchColumn();

if ($existing) {
    $pdo->prepare('UPDATE users SET password_hash = ?, is_admin = 1, status = "active" WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), $existing]);
    echo "已重置密码并设为管理员: {$email}\n";
    exit(0);
}

$gift = max(0, (int) get_setting('gift_points', '100'));
$pdo->prepare('INSERT INTO users (email, password_hash, points, is_admin, gw_token, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    ->execute([$email, password_hash($password, PASSWORD_DEFAULT), $gift, random_token(), time()]);
$userId = (int) $pdo->lastInsertId();
if ($gift > 0) {
    log_points($userId, $gift, 'gift', null, null, '管理员创建赠送');
}
echo "已创建管理员: {$email} (赠送 {$gift} 点)\n";
