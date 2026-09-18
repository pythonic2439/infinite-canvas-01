<?php
declare(strict_types=1);

/**
 * 把指定邮箱的用户提升为管理员 (或 --revoke 撤销)。
 * 用法: php promote.php user@example.com [--revoke]
 */

require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/db.php';

$email = strtolower(trim($argv[1] ?? ''));
$revoke = in_array('--revoke', $argv, true);
if ($email === '') {
    fwrite(STDERR, "用法: php promote.php <email> [--revoke]\n");
    exit(1);
}
$stmt = db()->prepare('UPDATE users SET is_admin = ? WHERE email = ?');
$stmt->execute([$revoke ? 0 : 1, $email]);
if ($stmt->rowCount() === 0) {
    fwrite(STDERR, "用户不存在: {$email}\n");
    exit(1);
}
echo ($revoke ? '已撤销管理员: ' : '已设为管理员: ') . $email . "\n";
