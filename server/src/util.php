<?php
declare(strict_types=1);

/**
 * 通用工具: JSON 响应、请求体解析、限频、同源校验。
 */

function respond(int $code, array $data): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function respond_ok(array $data = []): void
{
    respond(200, array_merge(['ok' => true], $data));
}

function json_body(): array
{
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function fail(string $msg, int $code = 400): void
{
    respond($code, ['ok' => false, 'msg' => $msg]);
}

/** 客户端真实 IP (站点无其他反代层, 直接取 REMOTE_ADDR)。 */
function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

/**
 * 固定窗口限频: 每个 bucket 在 window 秒内最多 max 次。
 * 返回 false 表示已超限。
 */
function rate_limit(string $bucket, int $max, int $window): bool
{
    $pdo = db();
    $now = time();
    $windowStart = intdiv($now, $window) * $window;
    $stmt = $pdo->prepare('INSERT INTO ip_limits (bucket, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1');
    $stmt->execute([$bucket, $windowStart]);
    $q = $pdo->prepare('SELECT count FROM ip_limits WHERE bucket = ? AND window_start = ?');
    $q->execute([$bucket, $windowStart]);
    $count = (int) ($q->fetchColumn() ?: 0);
    // 顺带清理 3 个窗口前的旧记录 (约 10% 概率)
    if (random_int(1, 8) === 1) {
        $pdo->prepare('DELETE FROM ip_limits WHERE window_start < ?')->execute([$now - 3 * $window]);
    }
    return $count <= $max;
}

/** 同源校验: 浏览器同源 POST 必带 Origin/Referer, 与 Host 一致才放行 (与 ref-upload.php 一致)。 */
function require_same_origin(): void
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    if ($host === '') {
        fail('missing host');
    }
    // Host 可能带端口 (非标准端口), 归一化成裸主机名再比较
    $hostName = (string) (parse_url('http://' . $host, PHP_URL_HOST) ?: $host);
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    $referer = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    if ($origin !== '') {
        if (strcasecmp((string) parse_url($origin, PHP_URL_HOST), $hostName) !== 0) {
            fail('origin not allowed', 403);
        }
        return;
    }
    if ($referer !== '') {
        if (strcasecmp((string) parse_url($referer, PHP_URL_HOST), $hostName) !== 0) {
            fail('referer not allowed', 403);
        }
        return;
    }
    // 无 Origin/Referer 的同源 GET (如图片标签) 放行; 写操作 CSRF 面小, cookie 用 SameSite=Lax 保护
}

function now(): int
{
    return time();
}

function random_token(int $bytes = 24): string
{
    return bin2hex(random_bytes($bytes));
}
