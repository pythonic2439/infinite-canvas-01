import axios from "axios";

import type { AiConfig } from "@/stores/use-config-store";

// 渠道 API Key 支持逗号分隔多个（可来自不同账号），按请求轮询使用，摊薄单账号的 RPM 限制；
// 命中 429 限流的 Key 冷却 60 秒，期间轮询自动跳过，入口层可据此换号重试一次。
const KEY_SEPARATOR = /[,，;；\n]/;
const COOLDOWN_MS = 60_000;
const cursors = new Map<string, number>();
const cooldowns = new Map<string, number>();
// 每渠道最近一次选中的 Key: 换号归因的兜底（并发下会串扰，精确归因优先走 axios 错误里的请求头，见 penalizeKeyFromError）。
const lastPicked = new Map<string, string>();

export function splitChannelKeys(apiKey: string) {
    return apiKey.split(KEY_SEPARATOR).map((key) => key.trim()).filter(Boolean);
}

export function hasMultipleKeys(apiKey: string) {
    return splitChannelKeys(apiKey).length > 1;
}

export function channelKey(config: Pick<AiConfig, "apiKey">) {
    const keys = splitChannelKeys(config.apiKey);
    if (!keys.length) return "";
    if (keys.length === 1) {
        lastPicked.set(config.apiKey, keys[0]);
        return keys[0];
    }
    const now = Date.now();
    for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
    const pool = keys.filter((key) => !cooldowns.has(key));
    const candidates = pool.length ? pool : keys;
    const cursor = (cursors.get(config.apiKey) ?? 0) + 1;
    cursors.set(config.apiKey, cursor);
    const key = candidates[cursor % candidates.length];
    lastPicked.set(config.apiKey, key);
    return key;
}

export function penalizeKey(key: string) {
    if (key) cooldowns.set(key, Date.now() + COOLDOWN_MS);
}

export function penalizeLastKey(apiKey: string) {
    penalizeKey(lastPicked.get(apiKey) ?? "");
}

function isRateLimited(error: unknown) {
    return axios.isAxiosError(error) && error.response?.status === 429;
}

let lastErrorRateLimited = false;

// readAxiosError 统一转译错误前先记录原始状态，入口层据此判断是否值得换号重试。
export function noteRateLimit(error: unknown) {
    lastErrorRateLimited = isRateLimited(error);
}

export function takeRateLimited() {
    const value = lastErrorRateLimited;
    lastErrorRateLimited = false;
    return value;
}

// 并发下从原始 axios 错误的请求头取本次请求实际用的 Key（比 lastPicked 兜底精确）；只认 Key 池里存在的值，防止把 gw_token 等误入冷却。
export function penalizeKeyFromError(config: Pick<AiConfig, "apiKey">, error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const headers = (error.config?.headers ?? {}) as Record<string, unknown>;
    const used = Object.entries(headers)
        .filter(([name]) => ["authorization", "x-goog-api-key", "x-bridge-token"].includes(name.toLowerCase()))
        .map(([, value]) => (typeof value === "string" ? value.replace(/^Bearer\s+/i, "").trim() : ""))
        .find(Boolean);
    if (!used || !splitChannelKeys(config.apiKey).includes(used)) return false;
    penalizeKey(used);
    return true;
}

// 多 Key 渠道命中 429 时，把本次请求实际用的 Key 冷却后换号重试一次（image/video/audio 入口共用）。
// 原始 axios 错误直接看状态码（不消费 noteRateLimit 标记，留给并发中的转译错误路径）；已转译的错误靠标记兜底。
// 服务端渠道(baseUrl=/api/gw/)客户端只见 gw_token: 429 时网关已在服务端冷却该 Key, 直接重试一次即自动落到健康 Key。
export async function retryWithKeyRotation<T>(config: Pick<AiConfig, "apiKey" | "baseUrl">, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (!isRateLimited(error) && !takeRateLimited()) throw error;
        const serverSide = typeof config.baseUrl === "string" && config.baseUrl.startsWith("/api/gw/");
        if (!hasMultipleKeys(config.apiKey) && !serverSide) throw error;
        if (hasMultipleKeys(config.apiKey) && !penalizeKeyFromError(config, error)) penalizeLastKey(config.apiKey);
        return run();
    }
}
