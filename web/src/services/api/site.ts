import axios from "axios";

import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/** 站点公开信息 (公告/客服), 游客与登录用户都可见。 */
export type SiteInfo = { notice: string; supportContact: string };

let cachedSiteInfo: SiteInfo | null = null;

export async function fetchSiteInfo(force = false): Promise<SiteInfo> {
    if (cachedSiteInfo && !force) return cachedSiteInfo;
    const response = await axios.get<{ ok: boolean; notice: string; support_contact: string }>("/api/site");
    cachedSiteInfo = { notice: response.data.notice || "", supportContact: response.data.support_contact || "" };
    return cachedSiteInfo;
}

/**
 * 生成失败退点 (fire-and-forget): 仅服务端渠道生效;
 * 服务端只核销「最近 1 小时内同渠道同模型未退过」的那笔扣费, 重复调用/误调用都不会多发点数。
 * 取消请求 (用户主动停止) 不退 —— 任务可能仍在上游继续。
 */
export function maybeRefundGeneration(config: AiConfig, model: string, error?: unknown): void {
    try {
        if (!model?.trim()) return;
        if (error && (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError"))) return;
        const resolved = resolveModelRequestConfig(config, model);
        if (!resolved.baseUrl.startsWith("/api/gw/")) return;
        const channelId = decodeURIComponent(resolved.baseUrl.slice("/api/gw/".length).replace(/\/+$/, ""));
        void axios.post("/api/points/refund", { channel_id: channelId, model: modelOptionName(model) }).catch(() => undefined);
    } catch {
        // 退点是尽力而为, 任何异常都不影响主流程
    }
}
