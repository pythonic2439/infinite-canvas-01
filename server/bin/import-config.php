<?php
declare(strict_types=1);

/**
 * 导入前端导出的渠道配置 JSON (如 infinite-canvas-config-local-0913.json) 到数据库。
 *
 * 用法: php import-config.php <config.json> [--force]
 * 行为:
 *   - 解析 config.channels: id/name/baseUrl/apiKey/apiFormat/models(name/capability/script/params)
 *   - 相对代理路径 (/duomi-proxy 等) 映射回真实上游地址
 *   - 模型点数按能力给默认值 (image=1, video=10, text=1, audio=2), 后台可再改
 *   - 同 id 渠道默认跳过, --force 覆盖
 */

require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/db.php';

$file = $argv[1] ?? '';
$force = in_array('--force', $argv, true);
if ($file === '' || !is_file($file)) {
    fwrite(STDERR, "用法: php import-config.php <config.json> [--force]\n");
    exit(1);
}
$raw = (string) file_get_contents($file);
$payload = json_decode($raw, true);
if (!is_array($payload) || !is_array($payload['config'] ?? null)) {
    fwrite(STDERR, "配置文件格式不对: 缺少 config 字段\n");
    exit(1);
}
$channels = $payload['config']['channels'] ?? [];
if (!is_array($channels) || !$channels) {
    fwrite(STDERR, "配置里没有渠道\n");
    exit(1);
}

$pdo = db();
$defaultPoints = DEFAULT_POINTS_BY_CAPABILITY;
$imported = 0;
$skipped = 0;

foreach ($channels as $index => $channel) {
    $id = trim((string) ($channel['id'] ?? ''));
    $name = trim((string) ($channel['name'] ?? ''));
    $baseUrl = trim((string) ($channel['baseUrl'] ?? ''));
    if ($id === '' || $name === '' || $baseUrl === '') {
        continue;
    }
    // 相对代理路径 → 真实上游 (与 nginx 反代指向一致)
    if (!preg_match('#^https?://#i', $baseUrl)) {
        $path = '/' . ltrim($baseUrl, '/');
        $path = preg_replace('#/api/v3$#', '/api/v3', $path) ?? $path;
        $mapped = null;
        foreach (PROXY_BASE_MAP as $proxyPrefix => $upstream) {
            if ($path === $proxyPrefix || str_starts_with($path, $proxyPrefix . '/')) {
                $mapped = $upstream . substr($path, strlen($proxyPrefix));
                break;
            }
        }
        if ($mapped === null) {
            fwrite(STDERR, "跳过渠道 {$name}: 未知相对 baseUrl {$baseUrl}\n");
            continue;
        }
        $baseUrl = $mapped;
    }
    $baseUrl = rtrim($baseUrl, '/');

    $exists = $pdo->prepare('SELECT id FROM channels WHERE id = ?');
    $exists->execute([$id]);
    if ($exists->fetchColumn() && !$force) {
        $skipped += 1;
        continue;
    }

    $pdo->prepare('INSERT INTO channels (id, name, base_url, api_key, api_format, default_points, enabled, sort)
        VALUES (?, ?, ?, ?, ?, 0, 1, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
            api_format = excluded.api_format, sort = excluded.sort')
        ->execute([
            $id,
            $name,
            $baseUrl,
            (string) ($channel['apiKey'] ?? ''),
            (string) ($channel['apiFormat'] ?? 'openai'),
            $index,
        ]);

    // 模型整表替换
    $pdo->prepare('DELETE FROM models WHERE channel_id = ?')->execute([$id]);
    $insert = $pdo->prepare('INSERT INTO models (channel_id, name, capability, script, params, points, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)');
    $count = 0;
    foreach ((array) ($channel['models'] ?? []) as $model) {
        $modelName = trim((string) ($model['name'] ?? ''));
        if ($modelName === '') {
            continue;
        }
        $capability = (string) ($model['capability'] ?? 'image');
        $points = $defaultPoints[$capability] ?? 1;
        $insert->execute([
            $id,
            $modelName,
            $capability,
            ($model['script'] ?? null) !== null ? (string) $model['script'] : null,
            ($model['params'] ?? null) !== null ? (string) $model['params'] : null,
            $points,
        ]);
        $count += 1;
    }
    $imported += 1;
    echo "导入渠道 {$name} ({$baseUrl}) — {$count} 个模型\n";
}

echo "完成: 导入 {$imported}, 跳过 {$skipped}\n";
