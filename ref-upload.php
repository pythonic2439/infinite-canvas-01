<?php
declare(strict_types=1);

/**
 * 参考图上传接口：把浏览器本地参考图存到本站，返回可公开访问的 URL。
 * 用途：多米(duomiapi)等生图接口的参考图只接受公网链接，不支持 base64/dataURL。
 *
 * 请求：POST multipart/form-data，字段 file（图片，≤20MB）
 * 响应：{"ok":true,"url":"https://<host>/ref-images/<name>"} 或 {"ok":false,"msg":"..."}
 * 说明：无鉴权（同源 Origin 校验 + 类型白名单 + 随机文件名），图片 3 天后懒清理。
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

const UPLOAD_DIR = __DIR__ . '/ref-images';
const MAX_BYTES = 20971520;       // 20MB
const RETENTION_SECONDS = 259200; // 3 天

function respond(int $code, array $data): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['ok' => false, 'msg' => 'POST only']);
}

// 同源校验：浏览器 fetch POST 必带 Origin（或 Referer），与 Host 不一致则拒绝
$host = $_SERVER['HTTP_HOST'] ?? '';
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$referer = $_SERVER['HTTP_REFERER'] ?? '';
if ($host === '') {
    respond(400, ['ok' => false, 'msg' => 'missing host']);
}
if ($origin !== '') {
    if (strcasecmp((string) parse_url($origin, PHP_URL_HOST), $host) !== 0) {
        respond(403, ['ok' => false, 'msg' => 'origin not allowed']);
    }
} elseif ($referer !== '') {
    if (strcasecmp((string) parse_url($referer, PHP_URL_HOST), $host) !== 0) {
        respond(403, ['ok' => false, 'msg' => 'referer not allowed']);
    }
} else {
    respond(403, ['ok' => false, 'msg' => 'missing origin']);
}

$file = $_FILES['file'] ?? null;
if (!is_array($file)) {
    respond(400, ['ok' => false, 'msg' => 'file field required']);
}
if ((int) ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    respond(400, ['ok' => false, 'msg' => 'upload error code ' . (string) $file['error']]);
}
$size = (int) ($file['size'] ?? 0);
if ($size <= 0) {
    respond(400, ['ok' => false, 'msg' => 'empty file (reference could not be read)']);
}
if ($size > MAX_BYTES) {
    respond(413, ['ok' => false, 'msg' => 'file too large (max 20MB)']);
}

// 类型白名单：用 getimagesize 探测真实内容，防止伪装后缀
$extByMime = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/gif' => 'gif'];
$info = @getimagesize((string) $file['tmp_name']);
$mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
if (!isset($extByMime[$mime])) {
    respond(415, ['ok' => false, 'msg' => 'unsupported image type: ' . $mime]);
}

if (!is_dir(UPLOAD_DIR) && !mkdir(UPLOAD_DIR, 0755, true)) {
    respond(500, ['ok' => false, 'msg' => 'storage unavailable']);
}

$name = date('YmdHis') . '-' . bin2hex(random_bytes(9)) . '.' . $extByMime[$mime];
if (!move_uploaded_file((string) $file['tmp_name'], UPLOAD_DIR . '/' . $name)) {
    respond(500, ['ok' => false, 'msg' => 'save failed']);
}

// 懒清理：约 10% 的请求顺带清理过期文件，避免无鉴权目录无限堆积
if (random_int(1, 10) === 1) {
    $cutoff = time() - RETENTION_SECONDS;
    foreach (glob(UPLOAD_DIR . '/*') ?: [] as $old) {
        if (is_file($old) && (int) filemtime($old) < $cutoff) {
            @unlink($old);
        }
    }
}

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
$scheme = $https ? 'https' : 'http';
respond(200, ['ok' => true, 'url' => $scheme . '://' . $host . '/ref-images/' . $name]);
