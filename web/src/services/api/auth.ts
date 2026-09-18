import axios from "axios";

import type { ApiCallFormat, ModelCapability } from "@/stores/use-config-store";

/** 服务端账号/目录 API 客户端。会话走 HttpOnly Cookie, 同源请求自动携带。 */

export type AuthUser = {
    id: number;
    email: string;
    points: number;
    isAdmin: boolean;
    createdAt: number;
};

export type CheckinStatus = {
    /** 今日签到可领点数 (后台可配) */
    points: number;
    /** 今天是否已签过 */
    done: boolean;
};

export type ServerModel = {
    name: string;
    capability: ModelCapability;
    script: string | null;
    params: string | null;
    points: number;
};

export type ServerChannel = {
    id: string;
    name: string;
    baseUrl: string; // 形如 /api/gw/{id}, 真实上游与 Key 不下发
    apiKey: string; // 用户网关令牌
    apiFormat: ApiCallFormat;
    models: ServerModel[];
};

const client = axios.create({ timeout: 60000 });

function messageOf(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { msg?: string; message?: string } | undefined;
        return data?.msg || data?.message || error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

export async function fetchAuthMe(): Promise<{ user: AuthUser | null; checkin: CheckinStatus | null }> {
    const response = await client.get<{ ok: boolean; user: AuthUser | null; checkin: CheckinStatus | null }>("/api/auth/me");
    return { user: response.data.user, checkin: response.data.checkin ?? null };
}

export async function sendAuthCode(email: string) {
    try {
        await client.post("/api/auth/send-code", { email });
    } catch (error) {
        throw new Error(messageOf(error, "验证码发送失败"));
    }
}

export async function registerAccount(email: string, password: string, code: string): Promise<AuthUser> {
    try {
        const response = await client.post<{ ok: boolean; user: AuthUser }>("/api/auth/register", { email, password, code });
        return response.data.user;
    } catch (error) {
        throw new Error(messageOf(error, "注册失败"));
    }
}

export async function loginAccount(email: string, password: string): Promise<AuthUser> {
    try {
        const response = await client.post<{ ok: boolean; user: AuthUser }>("/api/auth/login", { email, password });
        return response.data.user;
    } catch (error) {
        throw new Error(messageOf(error, "登录失败"));
    }
}

export async function logoutAccount() {
    await client.post("/api/auth/logout").catch(() => undefined);
}

export async function checkinDaily(): Promise<{ user: AuthUser; checkin: CheckinStatus; reward: number }> {
    try {
        const response = await client.post<{ ok: boolean; user: AuthUser; checkin: CheckinStatus; reward: number }>("/api/auth/checkin");
        return response.data;
    } catch (error) {
        throw new Error(messageOf(error, "签到失败"));
    }
}

export async function fetchServerCatalog(): Promise<{ channels: ServerChannel[]; user: AuthUser; checkin: CheckinStatus | null }> {
    const response = await client.get<{ ok: boolean; channels: ServerChannel[]; user: AuthUser; checkin?: CheckinStatus }>("/api/catalog");
    return { channels: response.data.channels || [], user: response.data.user, checkin: response.data.checkin ?? null };
}

/** 后台: 发送 SMTP 测试邮件 */
export async function sendTestMail(to = "") {
    try {
        const response = await client.post<{ ok: boolean; to: string }>("/api/admin/settings/test-smtp", to ? { to } : {});
        return response.data.to;
    } catch (error) {
        throw new Error(messageOf(error, "发送失败"));
    }
}

/** 登录态失效 (401) 判定, 供各处统一处理。 */
export function isAuthError(error: unknown) {
    return axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403);
}
