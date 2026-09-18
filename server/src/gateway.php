<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/auth.php';

/**
 * 上游网关: /api/gw/{channelId}/{path...}
 *
 * 前端把服务端渠道的 baseUrl 视为 "/api/gw/{channelId}"，所有生成请求经本网关转发到真实上游；
 * 渠道真实 Key 永不下发 —— 下发给前端的是该用户的 gw_token，网关在转发前把它全量替换回真实 Key
 * (Authorization 头 / 请求体 / 查询串里出现的都替换，兼容脚本模型把 Key 写进 body 或 query 的写法)。
 *
 * 计费: POST 请求且上游返回 2xx 时，按 body 中 model 字段对应模型配置的点数扣费 (GET 轮询/拉列表免费)。
 */

/** 客户端 buildApiUrl 的规则: base 以 /v1、/api/v3、/api/plan/v3 结尾则不再追加 /v1。 */
function upstream_api_base(string $baseUrl): string
{
    $base = rtrim($baseUrl, '/');
    $lower = strtolower($base);
    if (str_ends_with($lower, '/v1') || str_ends_with($lower, '/api/v3') || str_ends_with($lower, '/api/plan/v3')) {
        return $base;
    }
    return $base . '/v1';
}

/** 拆分渠道多 Key: 逗号/分号/换行分隔 (与前端 key-pool.ts 同规则)。 */
function channel_keys(string $apiKey): array
{
    $keys = [];
    foreach (preg_split('/[,，;；\r\n]+/u', $apiKey) ?: [] as $part) {
        $key = trim($part);
        if ($key !== '') {
            $keys[] = $key;
        }
    }
    return $keys;
}

/** Key 池审计日志: 每请求记录渠道/Key指纹(不落明文)/模型/费用/上游状态, 用于轮询验证与计费对账。 */
function key_pool_log(string $line): void
{
    try {
        file_put_contents(DATA_DIR . '/key-pool.log', '[' . date('Y-m-d H:i:s') . '] ' . $line . "\n", FILE_APPEND | LOCK_EX);
    } catch (Throwable $e) {
        // 日志失败不影响转发
    }
}

/** Key 池共享状态存 SQLite (全局生效): 各渠道轮询游标 + 429 冷却表。旧实现存 fpm 进程内, 多 worker 下冷却只拦到落在同 worker 的流量。 */
function pick_channel_key(string $channelId, string $apiKey): string
{
    $keys = channel_keys($apiKey);
    if (count($keys) <= 1) {
        return $keys[0] ?? '';
    }
    $pdo = db();
    $pdo->prepare('DELETE FROM key_pool_cooldowns WHERE until <= ?')->execute([time()]);
    $cooled = $pdo->query('SELECT key_hash FROM key_pool_cooldowns')->fetchAll(PDO::FETCH_COLUMN) ?: [];
    $pool = array_values(array_filter($keys, static fn(string $key): bool => !in_array(md5($key), $cooled, true)));
    $candidates = $pool ? $pool : $keys;
    // 游标原子自增并取回 (SQLite ≥3.35 RETURNING), 全局轮询不随 fpm worker 分裂; 全部冷却中则照常参与
    $stmt = $pdo->prepare('INSERT INTO key_pool_cursors (channel_id, cursor) VALUES (?, 1)
        ON CONFLICT(channel_id) DO UPDATE SET cursor = cursor + 1 RETURNING cursor');
    $stmt->execute([$channelId]);
    $cursor = max(1, (int) $stmt->fetchColumn());
    $key = $candidates[$cursor % count($candidates)];
    key_pool_log(sprintf('pick channel=%s cursor=%d key=%s pool=%d/%d', $channelId, $cursor, substr(md5($key), 0, 8), count($candidates), count($keys)));
    return $key;
}

/** 上游 429: 当前 Key 冷却 60 秒, 后续请求轮询自动换号 (SQLite 全局生效; 只存 md5 不存明文)。 */
function penalize_channel_key(string $apiKey): void
{
    if ($apiKey === '') {
        return;
    }
    db()->prepare('INSERT INTO key_pool_cooldowns (key_hash, until) VALUES (?, ?) ON CONFLICT(key_hash) DO UPDATE SET until = excluded.until')
        ->execute([md5($apiKey), time() + 60]);
    key_pool_log(sprintf('cooldown key=%s until=%s', substr(md5($apiKey), 0, 8), date('H:i:s', time() + 60)));
}

function handle_gateway(string $channelId, string $subPath): void
{
    $user = require_user();
    $stmt = db()->prepare('SELECT * FROM channels WHERE id = ?');
    $stmt->execute([$channelId]);
    $channel = $stmt->fetch();
    if (!$channel || (int) $channel['enabled'] !== 1) {
        fail('channel unavailable', 404);
    }
    if ($subPath === '') {
        fail('path required');
    }

    $gwToken = (string) $user['gw_token'];
    // 多 Key 渠道: 按请求轮询选一个, 请求里所有 gw_token 出现处都替换成该 Key
    $apiKey = pick_channel_key((string) $channel['id'], (string) $channel['api_key']);
    $method = $_SERVER['REQUEST_METHOD'];
    $queryString = (string) ($_SERVER['QUERY_STRING'] ?? '');
    $forwardQuery = $gwToken !== '' && $apiKey !== '' ? str_replace($gwToken, $apiKey, $queryString) : $queryString;

    // ---- 计费预检: 解析模型与点数, 余额不足直接 402, 不打上游 ----
    $model = '';
    $cost = 0;
    if ($method === 'POST') {
        // 用户限频: 防脚本刷点 / 防单用户打爆上游账号 (阈值后台可配)
        $perMinute = max(1, (int) get_setting('gen_per_minute', '10'));
        $perDay = max($perMinute, (int) get_setting('gen_per_day', '200'));
        if (!rate_limit('gen-user-min:' . $user['id'], $perMinute, 60) || !rate_limit('gen-user-day:' . $user['id'], $perDay, 86400)) {
            respond(429, ['ok' => false, 'error' => 'rate_limited', 'msg' => "生成太频繁：每分钟最多 {$perMinute} 次、每天最多 {$perDay} 次，请稍后再试"]);
        }
        $model = resolve_requested_model($gwToken);
        $cost = resolve_model_cost((string) $channel['id'], $model);
        if ($model !== '' && model_disabled((string) $channel['id'], $model)) {
            // 管理员停用的模型: 目录已不下发, 这里兜住缓存了旧目录的客户端 (停用即不可调用、不扣点)
            respond(404, ['ok' => false, 'msg' => "模型 {$model} 已停用，请刷新页面更新模型列表"]);
        }
        if ($cost > 0) {
            $q = db()->prepare('SELECT points FROM users WHERE id = ?');
            $q->execute([$user['id']]);
            if ((int) ($q->fetchColumn() ?: 0) < $cost) {
                respond(402, ['ok' => false, 'error' => 'insufficient_points', 'msg' => "点数不足：本次需要 {$cost} 点，请充值或联系管理员", 'needed' => $cost]);
            }
        }
    }

    // ---- 构造上游请求 (curl, 支持流式透传) ----
    // 客户端 baseUrl 是 /api/gw/{id} (不带版本后缀), 因此 buildApiUrl 恒定给它追加 /v1:
    // subPath 以 "v1/" 开头时, 这一段是客户端追加的版本段, 剥掉后按 buildApiUrl 语义套用真实 base;
    // 不带版本段的路径 (v1beta、agnesapi 等格式代码自拼的根级路径) 则直接套真实 base (剥掉其自带版本后缀)。
    $sub = ltrim($subPath, '/');
    $real = rtrim((string) $channel['base_url'], '/');
    if (preg_match('#^v1(/|$)#', $sub)) {
        $rest = preg_replace('#^v1(/|$)#', '', $sub);
        $upstreamUrl = upstream_api_base($real) . '/' . $rest;
    } elseif (preg_match('#(/v1|/api/v3|/api/plan/v3)$#i', $real)) {
        $upstreamUrl = preg_replace('#(/v1|/api/v3|/api/plan/v3)$#i', '', $real) . '/' . $sub;
    } else {
        $upstreamUrl = $real . '/' . $sub;
    }
    if ($forwardQuery !== '') {
        $upstreamUrl .= '?' . $forwardQuery;
    }

    $contentType = (string) ($_SERVER['CONTENT_TYPE'] ?? '');
    $rawBody = file_get_contents('php://input') ?: '';
    $isMultipart = str_contains($contentType, 'multipart/form-data');

    if ($isMultipart) {
        // multipart: 用 PHP 解析结果重建 (替换字段值里的 token, 文件流原样透传)
        $rebuild = rebuild_multipart_body($gwToken, $apiKey, $contentType);
        $body = $rebuild['body'];
        $contentType = $rebuild['content_type'];
    } elseif ($rawBody !== '') {
        // 非 multipart: 原样转发, 只做 token 替换 (JSON/二进制/纯文本都安全)
        $body = $gwToken !== '' && $apiKey !== '' ? str_replace($gwToken, $apiKey, $rawBody) : $rawBody;
    } else {
        $body = null;
    }

    $headers = [];
    foreach (request_headers() as $name => $value) {
        $lower = strtolower($name);
        if (in_array($lower, ['host', 'connection', 'content-length', 'transfer-encoding', 'expect', 'accept-encoding', 'cookie'], true)) {
            continue;
        }
        // multipart 重建后 boundary 已变, 原 Content-Type (带 WebKit boundary) 不能透传, 用重建的替换
        if ($isMultipart && $lower === 'content-type') {
            continue;
        }
        $headers[] = $name . ': ' . ($gwToken !== '' && $apiKey !== '' ? str_replace($gwToken, $apiKey, $value) : $value);
    }
    $headers[] = 'Content-Length: ' . strlen((string) $body);
    if ($isMultipart) {
        // Content-Type 必须与重建后的 body boundary 一致
        $headers[] = 'Content-Type: ' . $contentType;
    }

    $ch = curl_init($upstreamUrl);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_HEADERFUNCTION => function ($ch, string $line): int {
            $trimmed = trim($line);
            if ($trimmed === '') {
                return strlen($line);
            }
            // 状态行: "HTTP/2 200" / "HTTP/1.1 404 Not Found"
            if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $trimmed, $m)) {
                http_response_code((int) $m[1]);
                return strlen($line);
            }
            if (str_starts_with(strtolower($trimmed), 'set-cookie:')) {
                return strlen($line);
            }
            header($trimmed, false);
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk): int {
            echo $chunk;
            if (ob_get_level() > 0) {
                @ob_flush();
            }
            flush();
            return strlen($chunk);
        },
        CURLOPT_TIMEOUT => 0,
        CURLOPT_CONNECTTIMEOUT => 30,
    ]);
    if ($method === 'POST' || $body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? '');
    }
    // 上游响应头 (含 Content-Type) 由 HEADERFUNCTION 原样透传; 关闭输出缓冲让流式响应 (SSE) 逐块透传
    while (ob_get_level() > 0) {
        ob_end_flush();
    }

    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($status === 0) {
        respond(502, ['ok' => false, 'msg' => 'upstream unreachable: ' . $curlErr]);
    }

    // ---- 计费: 上游 2xx 且是 POST 才扣点 ----
    if ($method === 'POST') {
        key_pool_log(sprintf('charge-check channel=%s user=%d model=%s cost=%d status=%d key=%s', (string) $channel['id'], (int) $user['id'], $model, $cost, $status, substr(md5($apiKey), 0, 8)));
    }
    if ($method === 'POST' && $status >= 200 && $status < 300 && $cost > 0) {
        charge_points((int) $user['id'], $cost, (string) $channel['id'], $model, (string) $channel['name']);
    }
    if ($status === 429) {
        // 上游限流: 当前 Key 冷却 60 秒, 后续请求轮询自动跳过
        penalize_channel_key($apiKey);
    }
    if (in_array($status, [401, 403], true)) {
        // 渠道 Key 失效等: 邮件告警管理员 (每渠道每小时最多一封, 避免刷屏)
        notify_channel_alert((string) $channel['name'], $status);
    }
    exit; // 响应体已直接透传给客户端, 不能再落到后续路由
}

/** 渠道鉴权失败告警: 发邮件给管理员, 按渠道节流 (1 小时一封)。 */
function notify_channel_alert(string $channelName, int $status): void
{
    try {
        $throttleKey = 'alert_last:' . md5($channelName);
        $last = (int) (get_setting($throttleKey, '0') ?: 0);
        if (time() - $last < 3600) {
            return;
        }
        set_setting($throttleKey, (string) time());
        $to = (string) get_setting('alert_email', '');
        if ($to === '') {
            $row = db()->query('SELECT email FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1')->fetchColumn();
            $to = $row ? (string) $row : '';
        }
        if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
            return;
        }
        send_mail($to, "【渠道告警】{$channelName} 鉴权失败 (HTTP {$status})", "渠道「{$channelName}」的上游请求返回 HTTP {$status}（鉴权失败）。\n\n可能是 API Key 失效、欠费或无该模型权限，请尽快到管理后台检查更新，受影响用户的生成正在失败。\n\n时间：" . date('Y-m-d H:i:s'));
    } catch (Throwable $e) {
        error_log('[gateway] alert mail failed: ' . $e->getMessage());
    }
}

function charge_points(int $userId, int $cost, string $channelId, string $model, string $channelName): void
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $q = $pdo->prepare('SELECT points FROM users WHERE id = ?');
        $q->execute([$userId]);
        $balance = (int) ($q->fetchColumn() ?: 0);
        if ($balance < $cost) {
            $pdo->rollBack();
            key_pool_log("charge-skip user={$userId} balance={$balance} cost={$cost} (insufficient)");
            return;
        }
        $pdo->prepare('UPDATE users SET points = points - ? WHERE id = ?')->execute([$cost, $userId]);
        $newBalance = $balance - $cost;
        $pdo->prepare('INSERT INTO points_log (user_id, delta, balance_after, reason, channel_id, model, detail, created_at) VALUES (?, ?, ?, "generation", ?, ?, ?, ?)')
            ->execute([$userId, -$cost, $newBalance, $channelId, $model, $channelName, now()]);
        $pdo->commit();
        key_pool_log("charge-ok user={$userId} cost={$cost} balance_after={$newBalance} model={$model}");
    } catch (Throwable $e) {
        $pdo->rollBack();
        key_pool_log("charge-ERROR user={$userId} cost={$cost} model={$model}: " . $e->getMessage());
        error_log('[gateway] charge failed: ' . $e->getMessage());
    }
}

/** 从请求 (JSON body / form 字段 / 查询串) 里解析 model 字段。 */
function resolve_requested_model(string $gwToken = ''): string
{
    $contentType = (string) ($_SERVER['CONTENT_TYPE'] ?? '');
    $raw = file_get_contents('php://input') ?: '';
    if (str_contains($contentType, 'application/json')) {
        $data = json_decode($raw, true);
        if (is_array($data) && isset($data['model']) && is_string($data['model'])) {
            return $data['model'];
        }
    }
    if (str_contains($contentType, 'multipart/form-data') || str_contains($contentType, 'application/x-www-form-urlencoded')) {
        $model = (string) ($_POST['model'] ?? '');
        if ($model !== '') {
            return $model;
        }
    }
    // Gemini 脚本风格: 模型名在 URL 路径里 (…/models/{model}:generateContent)
    $path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    if (preg_match('#/models/([^/:]+):#', $path, $m)) {
        return $m[1];
    }
    parse_str((string) ($_SERVER['QUERY_STRING'] ?? ''), $query);
    return isset($query['model']) && is_string($query['model']) ? $query['model'] : '';
}

/** 模型是否已被管理员停用 (models.enabled=0)。未登记的模型不在此列。 */
function model_disabled(string $channelId, string $model): bool
{
    $stmt = db()->prepare('SELECT enabled FROM models WHERE channel_id = ? AND name = ?');
    $stmt->execute([$channelId, $model]);
    $enabled = $stmt->fetchColumn();
    return $enabled !== false && (int) $enabled !== 1;
}

function resolve_model_cost(string $channelId, string $model): int
{
    if ($model === '') {
        $row = db()->prepare('SELECT default_points FROM channels WHERE id = ?');
        $row->execute([$channelId]);
        return max(0, (int) ($row->fetchColumn() ?: 0));
    }
    $row = db()->prepare('SELECT points FROM models WHERE channel_id = ? AND name = ?');
    $row->execute([$channelId, $model]);
    $points = $row->fetchColumn();
    if ($points === false) {
        // 模型未登记: 不计费 (管理员在后台登记模型才会收费)
        return 0;
    }
    return max(0, (int) $points);
}

/** 重建 multipart body: 普通字段值做 token 替换, 文件字段原样搬运。 */
function rebuild_multipart_body(string $gwToken, string $apiKey, string $contentType): array
{
    $replace = static fn(string $value): string => ($gwToken !== '' && $apiKey !== '') ? str_replace($gwToken, $apiKey, $value) : $value;

    $boundary = '----icproxy' . bin2hex(random_bytes(12));
    $body = '';
    foreach ($_POST as $name => $value) {
        $body .= "--{$boundary}\r\n";
        $body .= 'Content-Disposition: form-data; name="' . $name . "\"\r\n\r\n";
        $body .= $replace((string) $value) . "\r\n";
    }
    foreach (flat_files($_FILES) as $file) {
        $body .= "--{$boundary}\r\n";
        $body .= 'Content-Disposition: form-data; name="' . $file['field'] . '"; filename="' . addslashes($file['filename']) . "\"\r\n";
        $body .= 'Content-Type: ' . $file['mime'] . "\r\n\r\n";
        $body .= (string) file_get_contents($file['tmp_name']) . "\r\n";
    }
    $body .= "--{$boundary}--\r\n";
    return ['body' => $body, 'content_type' => 'multipart/form-data; boundary=' . $boundary];
}

/**
 * 把 $_FILES 摊平成单文件记录列表。
 * 同名多文件字段 (FormData append 同一个 name) 在 PHP 里是 name[]=>array 结构, 需要递归展开;
 * 字段名去掉 [0] 编号还原上游原始字段名。
 */
function flat_files(array $files, string $fieldPrefix = ''): array
{
    $result = [];
    foreach ($files as $key => $value) {
        if (!is_array($value)) {
            continue;
        }
        if (is_string($value['tmp_name'] ?? null)) {
            if (($value['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                continue;
            }
            $fieldName = $fieldPrefix !== '' ? $fieldPrefix : (string) $key;
            $fieldName = preg_replace('/\[\d+\]$/', '', $fieldName) ?? $fieldName;
            $result[] = [
                'field' => $fieldName,
                'filename' => (string) ($value['name'] ?? 'blob'),
                'mime' => (string) ($value['type'] ?? 'application/octet-stream'),
                'tmp_name' => $value['tmp_name'],
            ];
            continue;
        }
        // 嵌套结构: name/tmp_name 等是数组, 逐个下标展开
        $count = is_array($value['tmp_name'] ?? null) ? count($value['tmp_name']) : 0;
        for ($i = 0; $i < $count; $i += 1) {
            $entry = [
                'name' => $value['name'][$i] ?? null,
                'type' => $value['type'][$i] ?? null,
                'tmp_name' => $value['tmp_name'][$i] ?? null,
                'error' => $value['error'][$i] ?? UPLOAD_ERR_NO_FILE,
                'size' => $value['size'][$i] ?? 0,
            ];
            $result = array_merge($result, flat_files([$key => $entry], $fieldPrefix !== '' ? $fieldPrefix : (string) $key));
        }
    }
    return $result;
}

/** apache/nginx fastcgi 下都可靠的请求头读取。 */
function request_headers(): array
{
    static $cached = null;
    if (is_array($cached)) {
        return $cached;
    }
    if (function_exists('apache_request_headers')) {
        $cached = array_change_key_case(apache_request_headers() ?: [], CASE_LOWER);
        // nginx+fastcgi 下 apache_request_headers 也可用, 但保底再做一遍
    }
    if (!is_array($cached) || !$cached) {
        $cached = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($key, 5)))));
                $cached[$name] = $value;
            }
        }
    }
    return $cached;
}
