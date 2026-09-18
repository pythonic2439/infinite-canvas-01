import { create } from "zustand";

import {
    checkinDaily,
    fetchAuthMe,
    fetchServerCatalog,
    loginAccount,
    logoutAccount,
    registerAccount,
    sendAuthCode,
    type AuthUser,
    type CheckinStatus,
    type ServerChannel,
} from "@/services/api/auth";
import { applyServerChannels, removeServerChannels, type ModelChannel } from "@/stores/use-config-store";

/**
 * 登录态管理。
 * - 登录成功后自动拉取服务端渠道目录并合入渠道列表 (baseUrl=/api/gw/..., Key=网关令牌)
 * - 登出时移除全部服务端渠道, 本地自带 Key 渠道不受影响
 * - 附带每日签到状态 (点数后台可配)
 */

type AuthStatus = "loading" | "anonymous" | "authenticated";

type AuthStore = {
    status: AuthStatus;
    user: AuthUser | null;
    checkin: CheckinStatus | null;
    /** 全局登录弹窗: 未登录用户触发生成类操作时自动弹出 (requireLogin) */
    loginModalOpen: boolean;
    setLoginModalOpen: (open: boolean) => void;
    init: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, password: string, code: string) => Promise<void>;
    sendCode: (email: string) => Promise<void>;
    logout: () => Promise<void>;
    /** 重新拉取目录 (渠道/模型/点数更新) 并刷新点数余额与签到状态 */
    refreshCatalog: () => Promise<void>;
    /** 每日签到, 成功后本地同步新余额 */
    doCheckin: () => Promise<number>;
};

async function loadCatalog() {
    const { channels, user, checkin } = await fetchServerCatalog();
    applyServerChannels(channels as unknown as ModelChannel[]);
    useAuthStore.setState({ user, checkin, status: "authenticated" });
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
    status: "loading",
    user: null,
    checkin: null,
    loginModalOpen: false,
    setLoginModalOpen: (open) => set({ loginModalOpen: open }),

    init: async () => {
        try {
            const { user, checkin } = await fetchAuthMe();
            if (!user) {
                removeServerChannels();
                set({ status: "anonymous", user: null, checkin: null });
                return;
            }
            useAuthStore.setState({ user, checkin });
            await loadCatalog().catch(() => undefined);
        } catch {
            set({ status: "anonymous", user: null, checkin: null });
        }
    },

    login: async (email, password) => {
        const user = await loginAccount(email, password);
        set({ user, status: "authenticated" });
        await loadCatalog().catch(() => undefined);
    },

    register: async (email, password, code) => {
        const user = await registerAccount(email, password, code);
        set({ user, status: "authenticated" });
        await loadCatalog().catch(() => undefined);
    },

    sendCode: async (email) => {
        await sendAuthCode(email);
    },

    logout: async () => {
        await logoutAccount();
        removeServerChannels();
        set({ user: null, checkin: null, status: "anonymous" });
    },

    refreshCatalog: async () => {
        if (get().status !== "authenticated") return;
        await loadCatalog();
    },

    doCheckin: async () => {
        const result = await checkinDaily();
        set({ user: result.user, checkin: result.checkin });
        return result.reward;
    },
}));

/** 生成类操作的前置闸门: 已登录放行; 未登录弹出登录框并返回 false (调用方直接中断, 不发请求)。 */
export function requireLogin(): boolean {
    const state = useAuthStore.getState();
    if (state.status === "authenticated" && state.user) return true;
    state.setLoginModalOpen(true);
    return false;
}
