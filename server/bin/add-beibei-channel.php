<?php
declare(strict_types=1);

/**
 * 一次性脚本: 添加 BB API(贝贝API) 生图渠道 + gpt-image-2 模型。
 * 用法: sudo -u www php add-beibei-channel.php
 * 依据: 贝贝API 实测手册(2026-09-16) — OpenAI Images 兼容:
 *   POST /v1/images/generations (JSON) / POST /v1/images/edits (multipart, image 字段可重复)
 * 前端 api_format=openai 默认分支即此协议; 网关 URL 重建会按 base_url 是否带 /v1 自动拼接。
 * 幂等: 渠道存在则跳过, 模型用 REPLACE。
 */

require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/db.php';

const CHANNEL_ID = 'beibei';
const CHANNEL_NAME = '贝贝API';
const BASE_URL = 'https://www.bb-api.com/v1';
const API_KEY = '[REMOVED-KEY]';
const MODEL_NAME = 'gpt-image-2';
const MODEL_POINTS = 4; // 对齐 duomi 渠道同模型定价

$pdo = db();
$pdo->setAttribute(PDO::ATTR_TIMEOUT, 8);

$exists = $pdo->prepare('SELECT COUNT(*) FROM channels WHERE id = ?');
$exists->execute([CHANNEL_ID]);
if ((int) $exists->fetchColumn() === 0) {
    $pdo->prepare('INSERT INTO channels (id, name, base_url, api_key, api_format, default_points, enabled, sort) VALUES (?, ?, ?, ?, ?, 0, 1, 0)')
        ->execute([CHANNEL_ID, CHANNEL_NAME, BASE_URL, API_KEY, 'openai']);
    echo '已添加渠道: ' . CHANNEL_ID . "\n";
} else {
    echo '渠道已存在, 跳过: ' . CHANNEL_ID . "\n";
}

$pdo->prepare('REPLACE INTO models (channel_id, name, capability, script, params, points, enabled) VALUES (?, ?, ?, NULL, NULL, ?, 1)')
    ->execute([CHANNEL_ID, MODEL_NAME, 'image', MODEL_POINTS]);
echo '已写入模型: ' . CHANNEL_ID . '/' . MODEL_NAME . ' (image, ' . MODEL_POINTS . "点)\n";
