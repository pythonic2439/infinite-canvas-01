<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/auth.php';

/**
 * 管理 API (需 is_admin):
 *   GET  /api/admin/users                用户列表 (含流水摘要)
 *   POST /api/admin/users/{id}           调整点数 / 启停 / 重置密码
 *   GET  /api/admin/users/{id}/points    某用户点数流水
 *   GET  /api/admin/channels             渠道+模型 (含真实 Key, 仅管理员)
 *   POST /api/admin/channels             新增/更新渠道
 *   POST /api/admin/channels/{id}/models 更新渠道模型 (整表替换, 含点数)
 *   POST /api/admin/channels/{id}        删除/启停渠道
 *   GET  /api/admin/settings | POST      站点设置 (SMTP/赠送点数等)
 *   GET  /api/admin/stats                统计概览
 */

function handle_admin(string $method, array $segments): void
{
    require_admin();
    $seg1 = $segments[1] ?? '';
    $seg2 = $segments[2] ?? '';
    $seg3 = $segments[3] ?? '';

    if ($seg1 === 'users' && $method === 'GET' && $seg2 === '') {
        admin_list_users();
        return;
    }
    if ($seg1 === 'users' && $seg2 !== '' && $method === 'POST' && $seg3 === '') {
        admin_update_user((int) $seg2);
        return;
    }
    if ($seg1 === 'users' && $seg2 !== '' && $seg3 === 'points' && $method === 'GET') {
        admin_user_points((int) $seg2);
        return;
    }
    if ($seg1 === 'channels' && $method === 'GET' && $seg2 === '') {
        admin_list_channels();
        return;
    }
    if ($seg1 === 'channels' && $method === 'POST' && $seg2 === '') {
        admin_upsert_channel();
        return;
    }
    if ($seg1 === 'channels' && $seg2 !== '' && $seg3 === 'models' && $method === 'POST') {
        admin_replace_models($seg2);
        return;
    }
    if ($seg1 === 'channels' && $seg2 !== '' && $seg3 === '' && $method === 'POST') {
        admin_update_channel($seg2);
        return;
    }
    if ($seg1 === 'settings' && $method === 'GET') {
        respond_ok(['settings' => settings_for_admin()]);
        return;
    }
    if ($seg1 === 'settings' && $method === 'POST') {
        admin_save_settings();
        return;
    }
    if ($seg1 === 'settings' && $seg2 === 'test-smtp' && $method === 'POST') {
        admin_test_smtp();
        return;
    }
    if ($seg1 === 'stats' && $method === 'GET') {
        admin_stats();
        return;
    }
    fail('unknown admin endpoint', 404);
}

function admin_list_users(): void
{
    $rows = db()->query('SELECT u.id, u.email, u.points, u.is_admin, u.status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM points_log p WHERE p.user_id = u.id AND p.delta < 0) AS generations
        FROM users u ORDER BY u.created_at DESC LIMIT 1000')->fetchAll();
    $users = array_map(static fn(array $row): array => [
        'id' => (int) $row['id'],
        'email' => (string) $row['email'],
        'points' => (int) $row['points'],
        'isAdmin' => (int) $row['is_admin'] === 1,
        'status' => (string) $row['status'],
        'createdAt' => (int) $row['created_at'],
        'lastLoginAt' => (int) $row['last_login_at'],
        'generations' => (int) $row['generations'],
    ], $rows);
    respond_ok(['users' => $users]);
}

function admin_update_user(int $userId): void
{
    $body = json_body();
    $stmt = db()->prepare('SELECT * FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $user = $stmt->fetch();
    if (!$user) {
        fail('user not found', 404);
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        if (array_key_exists('pointsDelta', $body) && (int) $body['pointsDelta'] !== 0) {
            $delta = (int) $body['pointsDelta'];
            $pdo->prepare('UPDATE users SET points = MAX(0, points + ?) WHERE id = ?')->execute([$delta, $userId]);
            log_points($userId, $delta, 'admin', null, null, (string) ($body['note'] ?? '管理员调整'));
        }
        if (isset($body['status']) && in_array($body['status'], ['active', 'disabled'], true)) {
            $pdo->prepare('UPDATE users SET status = ? WHERE id = ?')->execute([$body['status'], $userId]);
            if ($body['status'] === 'disabled') {
                $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$userId]);
            }
        }
        if (!empty($body['resetPassword'])) {
            $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
                ->execute([password_hash((string) $body['resetPassword'], PASSWORD_DEFAULT), $userId]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        fail('update failed: ' . $e->getMessage(), 500);
    }
    $stmt->execute([$userId]);
    respond_ok(['user' => public_user((array) $stmt->fetch())]);
}

function admin_user_points(int $userId): void
{
    $stmt = db()->prepare('SELECT delta, balance_after, reason, channel_id, model, detail, created_at FROM points_log WHERE user_id = ? ORDER BY id DESC LIMIT 200');
    $stmt->execute([$userId]);
    respond_ok(['logs' => $stmt->fetchAll()]);
}

function admin_list_channels(): void
{
    $pdo = db();
    $channels = $pdo->query('SELECT * FROM channels ORDER BY sort, id')->fetchAll();
    $result = [];
    foreach ($channels as $channel) {
        $models = $pdo->prepare('SELECT name, capability, script, params, points, enabled FROM models WHERE channel_id = ? ORDER BY name');
        $models->execute([$channel['id']]);
        $result[] = [
            'id' => (string) $channel['id'],
            'name' => (string) $channel['name'],
            'baseUrl' => (string) $channel['base_url'],
            'apiKey' => (string) $channel['api_key'],
            'apiFormat' => (string) $channel['api_format'],
            'defaultPoints' => (int) $channel['default_points'],
            'enabled' => (int) $channel['enabled'] === 1,
            'models' => array_map(static fn(array $m): array => [
                'name' => (string) $m['name'],
                'capability' => (string) $m['capability'],
                'script' => $m['script'] !== null ? (string) $m['script'] : null,
                'params' => $m['params'] !== null ? (string) $m['params'] : null,
                'points' => (int) $m['points'],
                'enabled' => (int) $m['enabled'] === 1,
            ], $models->fetchAll()),
        ];
    }
    respond_ok(['channels' => $result]);
}

function admin_upsert_channel(): void
{
    $body = json_body();
    $id = trim((string) ($body['id'] ?? ''));
    $name = trim((string) ($body['name'] ?? ''));
    $baseUrl = trim((string) ($body['baseUrl'] ?? ''));
    if ($id === '' || $name === '' || !preg_match('#^https?://#i', $baseUrl)) {
        fail('id / name / baseUrl 必填 (baseUrl 需 http(s) 开头)');
    }
    $apiKey = array_key_exists('apiKey', $body) ? trim((string) $body['apiKey']) : null;
    $check = db()->prepare('SELECT COUNT(*) FROM channels WHERE id = ?');
    $check->execute([$id]);
    if ((int) $check->fetchColumn() > 0) {
        // 已存在: Key 字段传入即生效 (可为空串 = 清空)；未传入 (旧客户端) COALESCE 保持原 Key
        db()->prepare('UPDATE channels SET name = ?, base_url = ?, api_key = COALESCE(?, api_key), api_format = ?, default_points = ?, enabled = ?, sort = ? WHERE id = ?')
            ->execute([
                $name,
                rtrim($baseUrl, '/'),
                $apiKey,
                (string) ($body['apiFormat'] ?? 'openai'),
                max(0, (int) ($body['defaultPoints'] ?? 0)),
                !empty($body['enabled']) ? 1 : 0,
                (int) ($body['sort'] ?? 0),
                $id,
            ]);
    } else {
        // Key 支持逗号/分号/换行分隔多个, 网关按请求轮询 (见 gateway.php pick_channel_key)
        db()->prepare('INSERT INTO channels (id, name, base_url, api_key, api_format, default_points, enabled, sort)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([
                $id,
                $name,
                rtrim($baseUrl, '/'),
                $apiKey ?? '',
                (string) ($body['apiFormat'] ?? 'openai'),
                max(0, (int) ($body['defaultPoints'] ?? 0)),
                !empty($body['enabled']) ? 1 : 0,
                (int) ($body['sort'] ?? 0),
            ]);
    }
    respond_ok();
}

function admin_update_channel(string $channelId): void
{
    // POST /api/admin/channels/{id} 带 {enabled: false} 视为停用; {delete: true} 删除
    $body = json_body();
    $stmt = db()->prepare('SELECT id FROM channels WHERE id = ?');
    $stmt->execute([$channelId]);
    if (!$stmt->fetchColumn()) {
        fail('channel not found', 404);
    }
    if (!empty($body['delete'])) {
        db()->prepare('DELETE FROM channels WHERE id = ?')->execute([$channelId]);
        respond_ok();
    }
    if (array_key_exists('enabled', $body)) {
        db()->prepare('UPDATE channels SET enabled = ? WHERE id = ?')->execute([$body['enabled'] ? 1 : 0, $channelId]);
    }
    respond_ok();
}

function admin_replace_models(string $channelId): void
{
    $body = json_body();
    $models = $body['models'] ?? null;
    if (!is_array($models)) {
        fail('models array required');
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare('DELETE FROM models WHERE channel_id = ?')->execute([$channelId]);
        $insert = $pdo->prepare('INSERT INTO models (channel_id, name, capability, script, params, points, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)');
        foreach ($models as $model) {
            $name = trim((string) ($model['name'] ?? ''));
            if ($name === '') {
                continue;
            }
            $insert->execute([
                $channelId,
                $name,
                (string) ($model['capability'] ?? 'image'),
                $model['script'] ?? null,
                $model['params'] ?? null,
                max(0, (int) ($model['points'] ?? 0)),
                !empty($model['enabled']) ? 1 : 0,
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        fail('replace models failed: ' . $e->getMessage(), 500);
    }
    respond_ok();
}

function settings_for_admin(): array
{
    $settings = all_settings();
    // 密码不回传, 只回传是否已配置
    $settings['smtp_password_set'] = $settings['smtp_password'] !== '';
    unset($settings['smtp_password']);
    return $settings;
}

function admin_save_settings(): void
{
    $body = json_body();
    $allowed = array_keys(DEFAULT_SETTINGS);
    foreach ($allowed as $key) {
        if (!array_key_exists($key, $body)) {
            continue;
        }
        if ($key === 'smtp_password' && (string) $body[$key] === '') {
            continue; // 空值不覆盖已有密码
        }
        set_setting($key, (string) $body[$key]);
    }
    respond_ok();
}

/** 发送测试邮件: 默认发给当前管理员, 可指定收件人。 */
function admin_test_smtp(): void
{
    $body = json_body();
    $to = strtolower(trim((string) ($body['to'] ?? '')));
    if ($to === '') {
        $to = (string) require_admin()['email'];
    }
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
        fail('收件邮箱格式不正确');
    }
    send_test_mail($to);
    respond_ok(['to' => $to]);
}

function admin_stats(): void
{
    $pdo = db();
    $userCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $todayStart = strtotime('today');
    $q = $pdo->prepare('SELECT COUNT(*) FROM users WHERE created_at >= ?');
    $q->execute([$todayStart]);
    $newToday = (int) $q->fetchColumn();
    $q = $pdo->prepare('SELECT COALESCE(SUM(-delta), 0) FROM points_log WHERE delta < 0 AND created_at >= ?');
    $q->execute([$todayStart]);
    $consumedToday = (int) $q->fetchColumn();
    $consumedTotal = (int) $pdo->query('SELECT COALESCE(SUM(-delta), 0) FROM points_log WHERE delta < 0')->fetchColumn();
    $byModel = $pdo->query('SELECT model, COUNT(*) AS times, SUM(-delta) AS points FROM points_log WHERE delta < 0 AND model IS NOT NULL GROUP BY model ORDER BY times DESC LIMIT 50')->fetchAll();
    $perDay = $pdo->query('SELECT date(created_at, "unixepoch") AS day, SUM(-delta) AS points FROM points_log WHERE delta < 0 AND created_at >= ' . (time() - 30 * 86400) . ' GROUP BY day ORDER BY day')->fetchAll();
    respond_ok([
        'users' => $userCount,
        'newToday' => $newToday,
        'consumedToday' => $consumedToday,
        'consumedTotal' => $consumedTotal,
        'byModel' => $byModel,
        'perDay' => $perDay,
    ]);
}
