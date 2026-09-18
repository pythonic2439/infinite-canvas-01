<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

/**
 * SQLite 初始化与访问。单例 PDO, WAL 模式, 首次运行自动建表。
 */

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0750, true)) {
        respond(500, ['ok' => false, 'msg' => 'data directory unavailable']);
    }
    $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA foreign_keys = ON');
    init_schema($pdo);
    return $pdo;
}

function init_schema(PDO $pdo): void
{
    $pdo->exec('
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            points INTEGER NOT NULL DEFAULT 0,
            is_admin INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT "active",  -- active | disabled
            gw_token TEXT NOT NULL,
            fail_count INTEGER NOT NULL DEFAULT 0,
            fail_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_login_at INTEGER NOT NULL DEFAULT 0,
            last_checkin_date TEXT NOT NULL DEFAULT ""  -- 最后签到日期 Y-m-d, 空串=从未签到
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS email_codes (
            email TEXT NOT NULL,
            code TEXT NOT NULL,
            purpose TEXT NOT NULL DEFAULT "register",
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ip_limits (
            bucket TEXT NOT NULL,       -- 例如 "send-code:1.2.3.4" / "register:1.2.3.4"
            window_start INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (bucket, window_start)
        );
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,        -- 与前端渠道 id 对齐 (如 "0HU3-VFiGsaqtzQSJ462H")
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_format TEXT NOT NULL DEFAULT "openai",
            default_points INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            sort INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS models (
            channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            capability TEXT NOT NULL,
            script TEXT,
            params TEXT,
            points INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (channel_id, name)
        );
        CREATE TABLE IF NOT EXISTS key_pool_cursors (
            channel_id TEXT PRIMARY KEY,            -- 渠道多 Key 轮询游标 (网关全局共享, 见 gateway.php pick_channel_key)
            cursor INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS key_pool_cooldowns (
            key_hash TEXT PRIMARY KEY,              -- 命中上游 429 冷却中的 Key (只存 md5, 不存明文)
            until INTEGER NOT NULL                  -- 冷却截止时间戳 (秒)
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS points_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            delta INTEGER NOT NULL,                 -- 负数=扣点, 正数=赠送/充值
            balance_after INTEGER NOT NULL,
            reason TEXT NOT NULL,                   -- generation | gift | admin | refund | checkin
            channel_id TEXT,
            model TEXT,
            detail TEXT,
            refunded INTEGER NOT NULL DEFAULT 0,    -- 生成扣费已被失败退点核销 (防重复退款)
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_points_log_user ON points_log(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at);
    ');
    migrate_schema($pdo);
}

/** 既有库的增量迁移 (CREATE TABLE IF NOT EXISTS 不会补列)。 */
function migrate_schema(PDO $pdo): void
{
    $userColumns = array_column($pdo->query('PRAGMA table_info(users)')->fetchAll(), 'name');
    if (!in_array('last_checkin_date', $userColumns, true)) {
        $pdo->exec('ALTER TABLE users ADD COLUMN last_checkin_date TEXT NOT NULL DEFAULT ""');
    }
    $logColumns = array_column($pdo->query('PRAGMA table_info(points_log)')->fetchAll(), 'name');
    if (!in_array('refunded', $logColumns, true)) {
        $pdo->exec('ALTER TABLE points_log ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0');
    }
}

function get_setting(string $key, ?string $fallback = null): ?string
{
    $row = db()->prepare('SELECT value FROM settings WHERE key = ?');
    $row->execute([$key]);
    $value = $row->fetchColumn();
    if ($value === false || $value === null) {
        return DEFAULT_SETTINGS[$key] ?? $fallback;
    }
    return (string) $value;
}

function set_setting(string $key, string $value): void
{
    $stmt = db()->prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    $stmt->execute([$key, $value]);
}

function all_settings(): array
{
    $rows = db()->query('SELECT key, value FROM settings')->fetchAll();
    $map = [];
    foreach ($rows as $row) {
        $map[$row['key']] = $row['value'];
    }
    foreach (DEFAULT_SETTINGS as $key => $value) {
        if (!array_key_exists($key, $map)) {
            $map[$key] = $value;
        }
    }
    return $map;
}
