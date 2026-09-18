<?php
declare(strict_types=1);

/**
 * 全局配置常量。
 * 数据目录 server/data 不在 nginx 站点根 (web/dist) 下，Web 不可直接访问；
 * SQLite 库与用户同步数据都存放在这里。
 */

const DATA_DIR = __DIR__ . '/../data';
const DB_FILE = DATA_DIR . '/infinite-canvas.sqlite3';
const USERS_DIR = DATA_DIR . '/users';

// 会话
const SESSION_COOKIE = 'ic_session';
const SESSION_TTL_SECONDS = 2592000; // 30 天
const SESSION_RENEW_INTERVAL = 86400; // 每天滑动续期一次

// 站点设置默认值 (settings 表可覆盖)
const DEFAULT_SETTINGS = [
    'signup_enabled' => '1',       // 是否开放注册
    'gift_points' => '100',        // 注册赠送点数
    'checkin_points' => '5',       // 每日签到领取点数
    'gen_per_minute' => '10',      // 单用户每分钟生成次数上限
    'gen_per_day' => '200',        // 单用户每日生成次数上限
    'notice' => '',                // 站点公告 (前端顶部展示, 留空隐藏)
    'support_contact' => '',       // 客服联系方式 (文本/微信/图片URL, 留空隐藏)
    'alert_email' => '',           // 渠道异常告警收件邮箱 (留空发给首位管理员)
    'storage_quota_mb' => '2048',  // 每用户同步数据配额
    'smtp_host' => '',
    'smtp_port' => '465',
    'smtp_secure' => 'ssl',        // ssl | tls(STARTTLS) | none
    'smtp_username' => '',
    'smtp_password' => '',
    'smtp_from' => '',             // 发件人地址 (默认取 smtp_username)
    'smtp_from_name' => '零一·无限画布',
    'notice' => '',                // 前端公告 (预留)
];

// 默认模型点数单价 (导入渠道时按能力给初值, 管理后台可改)
const DEFAULT_POINTS_BY_CAPABILITY = [
    'image' => 1,
    'video' => 10,
    'text' => 1,
    'audio' => 2,
];

// 本地代理路径 → 真实上游 (导入 0913 配置时, 配置里的相对路径映射回真实地址)
const PROXY_BASE_MAP = [
    '/autodl-proxy' => 'https://autodl.art',
    '/duomi-proxy' => 'https://duomiapi.com',
    '/ark-proxy/api/v3' => 'https://ark.cn-beijing.volces.com/api/v3',
    '/mingze-proxy' => 'http://127.0.0.1:37651',
    '/doubao-proxy' => 'http://127.0.0.1:17777',
    '/dola-proxy' => 'http://[REMOVED-IP]:6007',
];
