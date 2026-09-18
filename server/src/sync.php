<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/auth.php';

/**
 * 用户数据云同步: /api/sync/{domain}/manifest 与 /api/sync/{domain}/files/{name}
 * 路径语义与 WebDAV 同步引擎保持一致 (四域: canvas / assets / image-workbench / video-workbench)，
 * 前端复用同一套清单+文件模型，只是传输层换成本站接口。
 *
 * 存储: server/data/users/{uid}/sync/{domain}/manifest.json 与 files/{name}
 * (server/data 不在 nginx 站点根下, 只能经鉴权接口读写)
 */

const SYNC_DOMAINS = ['canvas', 'assets', 'image-workbench', 'video-workbench'];

function sync_user_dir(array $user): string
{
    $dir = USERS_DIR . '/' . (int) $user['id'] . '/sync';
    if (!is_dir($dir) && !mkdir($dir, 0750, true)) {
        fail('storage unavailable', 500);
    }
    return $dir;
}

function handle_sync_manifest(string $domain): void
{
    require_same_origin();
    $user = require_user();
    if (!in_array($domain, SYNC_DOMAINS, true)) {
        fail('unknown domain', 404);
    }
    $file = sync_user_dir($user) . '/' . $domain . '/manifest.json';
    if ($_SERVER['REQUEST_METHOD'] === 'PUT') {
        $raw = file_get_contents('php://input') ?: '';
        if (strlen($raw) > 8 * 1024 * 1024) {
            fail('manifest too large', 413);
        }
        $data = json_decode($raw, true);
        if (!is_array($data) || (($data['app'] ?? '') !== 'infinite-canvas') || !isset($data['domain']) || $data['domain'] !== $domain) {
            fail('invalid manifest');
        }
        $dir = dirname($file);
        if (!is_dir($dir) && !mkdir($dir, 0750, true)) {
            fail('storage unavailable', 500);
        }
        file_put_contents($file, $raw, LOCK_EX);
        respond_ok();
    }
    if (!is_file($file)) {
        respond(404, ['ok' => false, 'msg' => 'no manifest']);
    }
    header('Content-Type: application/json; charset=utf-8');
    echo (string) file_get_contents($file);
    exit;
}

function handle_sync_file(string $domain, string $name): void
{
    require_same_origin();
    $user = require_user();
    if (!in_array($domain, SYNC_DOMAINS, true)) {
        fail('unknown domain', 404);
    }
    // 文件名白名单: 只允许字母数字点横线下划线
    if (!preg_match('/^[A-Za-z0-9._-]{1,200}$/', $name)) {
        fail('invalid file name');
    }
    $dir = sync_user_dir($user) . '/' . $domain . '/files';
    $file = $dir . '/' . $name;
    if ($_SERVER['REQUEST_METHOD'] === 'PUT') {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw === '') {
            fail('empty file');
        }
        if (strlen($raw) > 200 * 1024 * 1024) {
            fail('file too large (max 200MB)', 413);
        }
        check_sync_quota($user, strlen($raw));
        if (!is_dir($dir) && !mkdir($dir, 0750, true)) {
            fail('storage unavailable', 500);
        }
        file_put_contents($file, $raw, LOCK_EX);
        respond_ok();
    }
    if (!is_file($file)) {
        respond(404, ['ok' => false, 'msg' => 'not found']);
    }
    // 服务器未装 fileinfo 扩展, mime_content_type() 不存在会 Fatal (全部 500), 按扩展名兜底
    $extMimes = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif', 'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'json' => 'application/json'];
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $mime = function_exists('mime_content_type') ? (mime_content_type($file) ?: 'application/octet-stream') : ($extMimes[$ext] ?? 'application/octet-stream');
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . (string) filesize($file));
    header('Cache-Control: private, max-age=3600');
    readfile($file);
    exit;
}

/** 粗粒度配额: 该域所有已存文件总大小 + 新文件 ≤ storage_quota_mb。 */
function check_sync_quota(array $user, int $incomingBytes): void
{
    $quotaBytes = max(64, (int) get_setting('storage_quota_mb', '2048')) * 1024 * 1024;
    $total = $incomingBytes;
    $root = USERS_DIR . '/' . (int) $user['id'];
    foreach (glob($root . '/*/files/*') ?: [] as $file) {
        if (is_file($file)) {
            $total += (int) filesize($file);
        }
    }
    if ($total > $quotaBytes) {
        respond(413, ['ok' => false, 'msg' => '云存储空间已满，请清理旧数据或联系管理员扩容']);
    }
}
