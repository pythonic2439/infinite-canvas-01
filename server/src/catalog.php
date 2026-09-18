<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/auth.php';

/**
 * 服务端渠道目录: GET /api/catalog
 * 返回净化后的渠道与模型列表 —— baseUrl 一律改写为 "/api/gw/{channelId}"，
 * apiKey 一律替换为该用户的 gw_token；真实上游地址与 Key 只存在服务端。
 * 脚本模型的自定义脚本随目录下发 (脚本本身不含密钥)。
 */

/** 公开站点信息: 公告与客服联系方式 (游客/登录用户都可见, 留空则前端隐藏)。 */
function handle_site_info(): void
{
    respond_ok([
        'notice' => (string) get_setting('notice', ''),
        'support_contact' => (string) get_setting('support_contact', ''),
    ]);
}

function handle_catalog(): void
{
    $user = require_user();
    $pdo = db();
    $channels = $pdo->query('SELECT * FROM channels WHERE enabled = 1 ORDER BY sort, id')->fetchAll();
    $result = [];
    foreach ($channels as $channel) {
        $channelId = (string) $channel['id'];
        $models = $pdo->prepare('SELECT name, capability, script, params, points FROM models WHERE channel_id = ? AND enabled = 1');
        $models->execute([$channelId]);
        $modelList = [];
        foreach ($models->fetchAll() as $model) {
            $modelList[] = [
                'name' => (string) $model['name'],
                'capability' => (string) $model['capability'],
                'script' => $model['script'] !== null ? (string) $model['script'] : null,
                'params' => $model['params'] !== null ? (string) $model['params'] : null,
                'points' => (int) $model['points'],
            ];
        }
        if (!$modelList) {
            continue;
        }
        $result[] = [
            'id' => $channelId,
            'name' => (string) $channel['name'],
            'baseUrl' => '/api/gw/' . rawurlencode($channelId),
            'apiKey' => (string) $user['gw_token'],
            'apiFormat' => (string) $channel['api_format'],
            'models' => $modelList,
        ];
    }
    respond_ok([
        'channels' => $result,
        'user' => public_user($user),
        'checkin' => checkin_status($user),
    ]);
}
