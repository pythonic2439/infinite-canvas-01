import axios from "axios";

export type DoubaoStatus = {
    online: boolean;
    licenseActive: boolean;
    version?: string;
    accounts?: number;
    dolaConnected?: boolean;
    token?: string;
    hostPresent?: boolean;
    hostRunning?: boolean;
};

export type DoubaoRenewResult = DoubaoStatus & {
    ok: boolean;
    launched: boolean;
    hostPresent: boolean;
    token?: string;
    launchError?: string;
    elapsedMs?: number;
};

export async function fetchDoubaoStatus(signal?: AbortSignal): Promise<DoubaoStatus> {
    const { data } = await axios.get<DoubaoStatus>("/api/doubao/status", { signal });
    return data || { online: false, licenseActive: false };
}

export async function renewDoubao(timeoutMs = 150000): Promise<DoubaoRenewResult> {
    const { data } = await axios.post<DoubaoRenewResult>(`/api/doubao/renew?timeout=${timeoutMs}`);
    return data || { ok: false, online: false, licenseActive: false, launched: false, hostPresent: false };
}