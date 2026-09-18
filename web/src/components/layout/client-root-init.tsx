import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useAuthStore } from "@/stores/use-auth-store";
import { syncAppDataToServer } from "@/services/app-sync";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

const CLOUD_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    // 启动时恢复登录态并拉取服务端渠道目录
    const initAuth = useAuthStore((state) => state.init);
    useEffect(() => {
        void initAuth();
    }, [initAuth]);

    // 登录态下自动云同步: 启动即同步一次, 之后每 5 分钟静默推送 (生成产物/画布/历史自动上服务器)
    const authStatus = useAuthStore((state) => state.status);
    // 目录跟随同周期刷新: 管理员停用/上架模型、调整点数后, 用户端最多 5 分钟自动跟进, 无需手动刷新
    const refreshCatalog = useAuthStore((state) => state.refreshCatalog);
    useEffect(() => {
        if (authStatus !== "authenticated") return;
        void refreshCatalog().catch(() => undefined);
        // 静默同步失败不能完全吞掉: 留 console.warn 便于排查"换设备画布没同步"类问题
        void syncAppDataToServer().catch((error) => console.warn("[cloud-sync] auto sync failed:", error));
        const timer = window.setInterval(() => {
            void refreshCatalog().catch(() => undefined);
            void syncAppDataToServer().catch((error) => console.warn("[cloud-sync] periodic sync failed:", error));
        }, CLOUD_SYNC_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [authStatus, refreshCatalog]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config.channels, message, openConfigDialog, t, updateConfig]);

    return <>{children}</>;
}
