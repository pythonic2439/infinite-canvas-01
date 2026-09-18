import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";

export type ApiCallFormat = "openai" | "gemini" | "ark" | "autodl" | "duomi" | "mingze" | "doubao" | "agnes" | "dola";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
    /** Optional JSON body template for protocol-specific request params (e.g. AutoDL workflow params). */
    params?: string;
    /** 服务端渠道的每次生成点数 (本地渠道无此项)。 */
    points?: number;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    /** 防人脸拦截: 开启后发给该渠道的参考图会先在本地对眼部叠加网格等干扰。 */
    faceGuard?: boolean;
    /** 失败自动重试: dola 任务失败后自动重新提交的次数(0/未设置 = 不重试)。 */
    retryLimit?: number;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    /** resolveModelRequestConfig 注入: 当前渠道是否开启防人脸拦截。 */
    faceGuard?: boolean;
    /** resolveModelRequestConfig 注入: 当前渠道失败自动重试次数。 */
    retryLimit?: number;
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    /** 生视频默认画幅 (seedance 词表 16:9/9:16/1:1/4:3/3:4/21:9/adaptive)；独立于生图的比例字段 size，二者互不覆盖。 */
    videoRatio: string;
    background: string;
    count: string;
    canvasImageCount: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
// 方舟网关不回应带 Authorization 的 GET 的 CORS 预检 (模型列表/任务轮询会被浏览器拦截)，走本地启动器同源反向代理 /ark-proxy (见 run-infinite-canvas.mjs 的 PROXY_ROUTES)；保留 /api/v3 让 buildApiUrl 不再追加 /v1。

const ARK_BASE_URL = "/ark-proxy/api/v3";

// AutoDL/多米走本地启动器内置的同源反向代理 (见 run-infinite-canvas.mjs 的 PROXY_ROUTES), 规避浏览器直连的 CORS/ERR_NETWORK 问题。
const AUTODL_BASE_URL = "/autodl-proxy";
const DUOMI_BASE_URL = "/duomi-proxy";
const LEGACY_AUTODL_BASE_URL = "https://autodl.art";
const LEGACY_DUOMI_BASE_URL = "https://duomiapi.com";
const LEGACY_MINGZE_BASE_URL = "http://127.0.0.1:37651";
// 鸣泽影坊本地视频自动化 API 无 CORS 头，浏览器不能直连；走本地启动器同源反向代理 /mingze-proxy (见 run-infinite-canvas.mjs 的 PROXY_ROUTES)，baseUrl 不带 /v1，由 buildApiUrl 统一追加。
const MINGZE_BASE_URL = "/mingze-proxy";
// 豆包管理器桥接服务 (127.0.0.1:17777, v2.2.28+) 同样无 CORS 头，浏览器不能直连；走 /doubao-proxy 同源转发，用 X-Bridge-Token 头鉴权（token 填进 API Key），baseUrl 不带 /v1，由桥接协议代码统一拼 /v1 路径。
const DOUBAO_BASE_URL = "/doubao-proxy";
// Agnes AI 网关 (new-api 架构) 自带开放 CORS 头，浏览器可直连，无需本地代理；baseUrl 自带 /v1，buildApiUrl 不会重复追加。
const AGNES_BASE_URL = "https://api.agnes-ai.cn/v1";
// dola 公网 API 经本站 nginx 反代 /dola-proxy 转发（HTTPS 页面直连其 http 上游会被浏览器混合内容拦截）。
const DOLA_BASE_URL = "/dola-proxy";
const LEGACY_DOLA_BASE_URL = "https://ai.01ai.space/dola-proxy";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
        {
            id: "duomi",
            name: i18n.t("config.protocols.duomi"),
            baseUrl: DUOMI_BASE_URL,
            apiKey: "",
            apiFormat: "duomi",
            models: [{ name: "gpt-image-2", capability: "image" }],
        },
        {
            id: "dola",
            name: i18n.t("config.protocols.dola"),
            baseUrl: DOLA_BASE_URL,
            apiKey: "",
            apiFormat: "dola",
            retryLimit: 1,
            models: [
                { name: "dola-video", capability: "video" },
                { name: "dola-image", capability: "image" },
            ],
        },
        {
            id: "mingze",
            name: i18n.t("config.protocols.mingze"),
            baseUrl: MINGZE_BASE_URL,
            apiKey: "",
            apiFormat: "mingze",
            models: [{ name: "seedance_v2.0", capability: "video" }, { name: "seedance_v2.5", capability: "video" }],
        },
        {
            id: "doubao",
            name: i18n.t("config.protocols.doubao"),
            baseUrl: DOUBAO_BASE_URL,
            apiKey: "",
            apiFormat: "doubao",
            models: [{ name: "seedance2.0fast", capability: "video" }, { name: "seedance2.0mini", capability: "video" }, { name: "dreamina-seedance2.5", capability: "video" }],
        },
        {
            id: "agnes",
            name: i18n.t("config.protocols.agnes"),
            baseUrl: AGNES_BASE_URL,
            apiKey: "",
            apiFormat: "agnes",
            models: [{ name: "agnes-image-2.5-flash", capability: "image" }, { name: "agnes-video-v2.0", capability: "video" }, { name: "agnes-video-2.5-flash", capability: "video" }],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "5",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts", "duomi::gpt-image-2", "dola::dola-video", "dola::dola-image"],
    quality: "auto",
    size: "1:1",
    videoRatio: "adaptive",
    background: "",
    count: "1",
    canvasImageCount: "3",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["seedance", "video", "sora", "veo", "kling", "wan", "hailuo"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

/** 模型可用性: 渠道存在且有凭证 (服务端渠道带网关令牌 / 本地渠道已填 Key)。 */
function isModelUsable(config: AiConfig, model: string) {
    if (!model.trim()) return false;
    const channel = resolveModelChannel(config, model);
    return Boolean(channel.baseUrl.trim() && channel.apiKey.trim());
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    // 旧节点持久化的模型可能指向无 Key 的本地渠道: 不可用时自动回退到可用的服务端模型,
    // 保证登录用户点生成直接经网关扣点出图, 不再被要求配置渠道。
    if (currentModel && modelMatchesCapability(config, currentModel, capability) && isModelUsable(config, currentModel)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability) && isModelUsable(config, defaultModel)) return defaultModel;
    if (isModelUsable(config, fallbackModel)) return fallbackModel;
    return selectableModelsByCapability(config, capability).find((model) => isModelUsable(config, model)) || fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

/** The JSON params template (if any) attached to a model; empty string means protocol defaults. */
export function resolveModelParams(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.params?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            version: 1,
            // 老数据无 videoRatio: 用其旧 size 归一出画幅做初始值, 避免升级后视频比例跳回 adaptive (migrate 内只用可选链+正则, 勿抛错)。
            migrate: (persisted) => {
                const state = (persisted || {}) as { config?: Partial<AiConfig>; webdav?: Partial<WebdavSyncConfig> };
                const config = (state.config || {}) as Partial<AiConfig>;
                // 保留完整 config 只叠加 videoRatio, 之后 merge 会展开 defaultConfig 全量归一
                return { config: { ...state.config, videoRatio: config.videoRatio || ratioFromLegacySize(config.size) } as AiConfig, webdav: (state.webdav || {}) as WebdavSyncConfig };
            },
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        reasoningEffort: config.reasoningEffort || "auto",
                        videoSeconds: config.videoSeconds || "5",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        canvasImageCount: config.canvasImageCount || "3",
                    },
                };
            },
        },
    ),
);

// 跨标签页同步: persist 默认不监听 storage 事件, 画布/工作台开两个标签页时, 一边改的
// 模型/画幅/画质另一边感知不到, 生成时用的还是打开页面时的旧配置 (例如画幅停在 auto,
// 上游就会按自己的默认尺寸出图而不是用户选的比例)。
if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
        if (event.key === CONFIG_STORE_KEY && event.newValue) useConfigStore.persist.rehydrate();
    });
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** persist 迁移用: 旧 config.size 可能存 "1:1"/"1280x720" 等, 归一成视频画幅 token; 无法归一给 adaptive (勿 import seedance-video, 会环依赖)。 */
function ratioFromLegacySize(size?: string) {
    const value = (size || "").trim();
    if (/^\d+:\d+$/.test(value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const target = Number(match[1]) / Math.max(1, Number(match[2]));
    let best: [string, number] = ["16:9", 16 / 9];
    const candidates: Array<[string, number]> = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16], ["21:9", 21 / 9]];
    for (const item of candidates) {
        if (Math.abs(item[1] - target) < Math.abs(best[1] - target)) best = item;
    }
    return best[0];
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        const params = typeof item === "string" ? undefined : item.params?.trim() || undefined;
        const points = typeof item === "string" ? undefined : typeof item.points === "number" && item.points > 0 ? item.points : undefined;
        result.push(points ? { name, capability, script, params, points } : { name, capability, script, params });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
        faceGuard: channel?.faceGuard || undefined,
        retryLimit: channel?.retryLimit || undefined,
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        faceGuard: channel.faceGuard,
        retryLimit: channel.retryLimit,
    };
}

/** dola 渠道的图片模型只接受 1:1 / 9:16 / 16:9 三档比例, 选择器按此收敛。 */
export function isDolaImageModel(config: AiConfig, value?: string) {
    const model = value || config.model || config.imageModel;
    return modelOptionName(model).toLowerCase() === "dola-image" && resolveModelChannel(config, model).apiFormat === "dola";
}

/**
 * 服务端渠道的 baseUrl 统一以 /api/gw/ 开头 (真实上游与 Key 留在服务端)。
 * 登录后整组合入渠道列表, 登出时整组移除; 本地自带 Key 渠道不受影响。
 */
export function isServerChannel(channel: ModelChannel) {
    return channel.baseUrl.startsWith("/api/gw/");
}

/** 估算单次生成的点数单价: 服务端渠道模型带 points (网关按上游 2xx 的 POST 扣点); 本地渠道或未登记单价返回 null (不展示)。 */
export function estimateGenerationPoints(config: AiConfig, modelValue: string): number | null {
    const channel = resolveModelChannel(config, modelValue);
    if (!isServerChannel(channel)) return null;
    const name = modelOptionName(modelValue || config.model);
    const model = channel.models.find((item) => item.name === name);
    return (model?.points ?? 0) > 0 ? (model?.points as number) : null;
}

export function applyServerChannels(serverChannels: ModelChannel[]) {
    useConfigStore.setState((state) => {
        // 服务端渠道按 id 整体替换同名本地渠道 (内置预设 duomi/agnes 与服务端目录 id 相同,
        // 不替换会出现同 id 双渠道, 按 id 查找时命中无 Key 的本地预设导致误判不可用)。
        const serverIds = new Set(serverChannels.map((channel) => channel.id));
        // 本地渠道仅保留用户自带 Key 的 (BYOK 必须有 Key 才可用): 出厂预设 (default/dola/mingze/doubao,
        // 全部无 Key) 在登录后是纯噪音, 一并丢弃 —— 商业部署的可用模型统一来自服务端目录。
        const localChannels = state.config.channels.filter((channel) => !isServerChannel(channel) && !serverIds.has(channel.id) && channel.apiKey.trim() !== "");
        const channels = [...localChannels, ...serverChannels];
        const config = { ...state.config, channels, models: modelOptionsFromChannels(channels) };
        // 服务端优先: 当前选中模型无效 (已下架) 或指向无 Key 的本地渠道时, 自动切到服务端同能力模型,
        // 保证登录用户创建节点即可直接生成 (经网关扣点), 无需自行配置渠道。
        const pickDefault = (current: string, capability: ModelCapability) => {
            const channel = current ? channels.find((item) => item.models.some((model) => model.name === modelOptionName(current))) : undefined;
            const usable = Boolean(channel && (isServerChannel(channel) || channel.apiKey.trim() !== ""));
            if (usable) return current;
            return serverChannels.flatMap((item) => item.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(item.id, model.name)))[0] || current;
        };
        return {
            config: {
                ...config,
                model: pickDefault(normalizeModelOptionValue(config.model, channels), "image"),
                imageModel: pickDefault(normalizeModelOptionValue(config.imageModel || config.model, channels), "image"),
                videoModel: pickDefault(normalizeModelOptionValue(config.videoModel, channels), "video"),
                textModel: pickDefault(normalizeModelOptionValue(config.textModel || config.model, channels), "text"),
                audioModel: pickDefault(normalizeModelOptionValue(config.audioModel, channels), "audio"),
            },
        };
    });
}

export function removeServerChannels() {
    applyServerChannels([]);
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            // 迁移旧的直连上游地址到内置同源代理路径。
            baseUrl: channel.baseUrl === LEGACY_AUTODL_BASE_URL ? AUTODL_BASE_URL : channel.baseUrl === LEGACY_DUOMI_BASE_URL ? DUOMI_BASE_URL : channel.baseUrl === LEGACY_MINGZE_BASE_URL ? MINGZE_BASE_URL : channel.baseUrl === LEGACY_DOLA_BASE_URL ? DOLA_BASE_URL : isLegacyArkBaseUrl(channel.baseUrl) ? ARK_BASE_URL : channel.baseUrl,
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    // Ensure the built-in DuoMi preset channel is available even for configs persisted before it existed.
    if (!channels.some((channel) => channel.apiFormat === "duomi")) {
        channels.push(
            createModelChannel({
                id: "duomi",
                name: i18n.t("config.protocols.duomi"),
                baseUrl: DUOMI_BASE_URL,
                apiKey: "",
                apiFormat: "duomi",
                models: [{ name: "gpt-image-2", capability: "image" }],
            }),
        );
    }
    // Ensure the built-in Mingze preset channel is available even for configs persisted before it existed.
    if (!channels.some((channel) => channel.apiFormat === "mingze")) {
        channels.push(
            createModelChannel({
                id: "mingze",
                name: i18n.t("config.protocols.mingze"),
                baseUrl: MINGZE_BASE_URL,
                apiKey: "",
                apiFormat: "mingze",
                models: [{ name: "seedance_v2.0", capability: "video" }, { name: "seedance_v2.5", capability: "video" }],
            }),
        );
    }
    // Ensure the built-in Agnes preset channel is available even for configs persisted before it existed.
    if (!channels.some((channel) => channel.apiFormat === "agnes")) {
        channels.push(
            createModelChannel({
                id: "agnes",
                name: i18n.t("config.protocols.agnes"),
                baseUrl: AGNES_BASE_URL,
                apiKey: "",
                apiFormat: "agnes",
                models: [{ name: "agnes-image-2.5-flash", capability: "image" }, { name: "agnes-video-v2.0", capability: "video" }, { name: "agnes-video-2.5-flash", capability: "video" }],
            }),
        );
    }
    // Ensure the built-in dola preset channel is available even for configs persisted before it existed.
    if (!channels.some((channel) => channel.apiFormat === "dola")) {
        channels.push(
            createModelChannel({
                id: "dola",
                name: i18n.t("config.protocols.dola"),
                baseUrl: DOLA_BASE_URL,
                apiKey: "",
                apiFormat: "dola",
                retryLimit: 1,
                models: [{ name: "dola-video", capability: "video" }, { name: "dola-image", capability: "image" }],
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    if (apiFormat === "ark") return ARK_BASE_URL;
    if (apiFormat === "autodl") return AUTODL_BASE_URL;
    if (apiFormat === "duomi") return DUOMI_BASE_URL;
    if (apiFormat === "mingze") return MINGZE_BASE_URL;
    if (apiFormat === "doubao") return DOUBAO_BASE_URL;
    if (apiFormat === "agnes") return AGNES_BASE_URL;
    if (apiFormat === "dola") return DOLA_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" || apiFormat === "ark" || apiFormat === "autodl" || apiFormat === "duomi" || apiFormat === "mingze" || apiFormat === "doubao" || apiFormat === "agnes" || apiFormat === "dola" ? apiFormat : "openai";
}

// 旧的方舟直连地址 (含 /api/v3、/api/coding 等路径) 统一迁移到内置同源代理。
function isLegacyArkBaseUrl(baseUrl: string) {
    return /^https:\/\/ark\.cn-beijing\.volces\.com(\/|$)/i.test(baseUrl.trim());
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
