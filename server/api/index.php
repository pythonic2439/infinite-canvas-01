<?php
declare(strict_types=1);

/**
 * API 前端控制器。nginx 把 /api/ (除已存在的 = /api/ref-upload) 都路由到本文件。
 * 路由表:
 *   POST /api/auth/send-code | register | login | logout
 *   GET  /api/auth/me
 *   GET  /api/catalog
 *   ANY  /api/gw/{channelId}/{path...}     上游网关 (登录用户, 计费)
 *   GET/PUT /api/sync/{domain}/manifest    用户数据同步 (四域)
 *   GET/PUT /api/sync/{domain}/files/{name}
 *   /api/admin/*                           管理 API
 */

require_once __DIR__ . '/../src/util.php';
require_once __DIR__ . '/../src/db.php';
require_once __DIR__ . '/../src/auth.php';
require_once __DIR__ . '/../src/mailer.php';
require_once __DIR__ . '/../src/gateway.php';
require_once __DIR__ . '/../src/sync.php';
require_once __DIR__ . '/../src/catalog.php';
require_once __DIR__ . '/../src/admin.php';

$method = $_SERVER['REQUEST_METHOD'];
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);

// 去掉站点可能存在的子路径前缀, 统一成 /api/... 开头
$prefix = '/api';
if (!str_starts_with($path, $prefix)) {
    fail('not found', 404);
}
$segments = array_values(array_filter(explode('/', substr($path, strlen($prefix))), static fn(string $s) => $s !== ''));
$head = $segments[0] ?? '';

try {
    if ($head === 'auth') {
        $action = $segments[1] ?? '';
        if ($method === 'POST' && $action === 'send-code') {
            handle_send_code();
        }
        if ($method === 'POST' && $action === 'register') {
            handle_register();
        }
        if ($method === 'POST' && $action === 'login') {
            handle_login();
        }
        if ($method === 'POST' && $action === 'logout') {
            handle_logout();
        }
        if ($method === 'GET' && $action === 'me') {
            $user = current_session_user();
            respond_ok(['user' => $user ? public_user($user) : null, 'checkin' => $user ? checkin_status($user) : null]);
        }
        if ($method === 'POST' && $action === 'checkin') {
            handle_checkin();
        }
        fail('unknown auth endpoint', 404);
    }

    if ($head === 'catalog' && $method === 'GET') {
        handle_catalog();
    }

    if ($head === 'site' && $method === 'GET') {
        handle_site_info();
    }

    if ($head === 'points' && ($segments[1] ?? '') === 'refund' && $method === 'POST') {
        handle_points_refund();
    }

    if ($head === 'gw' && isset($segments[1])) {
        $channelId = $segments[1];
        $subPath = implode('/', array_slice($segments, 2));
        handle_gateway($channelId, $subPath);
    }

    if ($head === 'sync' && in_array($segments[2] ?? '', ['manifest', 'manifest.json'], true)) {
        handle_sync_manifest($segments[1] ?? '');
    }
    if ($head === 'sync' && ($segments[2] ?? '') === 'files' && isset($segments[3])) {
        handle_sync_file($segments[1] ?? '', $segments[3]);
    }

    if ($head === 'admin') {
        handle_admin($method, $segments);
    }

    fail('not found', 404);
} catch (PDOException $e) {
    error_log('[api] db error: ' . $e->getMessage());
    fail('server error', 500);
} catch (Throwable $e) {
    error_log('[api] error: ' . $e->getMessage());
    fail('server error: ' . $e->getMessage(), 500);
}
