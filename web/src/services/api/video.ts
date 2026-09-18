import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { guardReferenceImages } from "@/lib/face-guard";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, resolveVideoRatio, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { channelKey, noteRateLimit, retryWithKeyRotation } from "./key-pool";
import { requireLogin } from "@/stores/use-auth-store";
import { uploadReferenceImageUrl, compressDolaReference } from "./image";
import { maybeRefundGeneration } from "./site";
import { buildApiUrl, modelOptionName, resolveModelParams, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; video_id?: string; status?: string; error?: { message?: string } | string; url?: string; result_url?: string; video_url?: string; no_watermark_url?: string; download_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type AutoDlTask = { task_id?: string; status?: string; results?: unknown[] };
type AutoDlEnvelope = { code?: number | string; data?: AutoDlTask | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "autodl" | "plugin" | "mingze" | "doubao" | "agnes" | "dola"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${channelKey(config)}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

// 豆包管理器桥接服务用 X-Bridge-Token 头鉴权 (token 填在渠道 API Key), 不走 Bearer。
function doubaoHeaders(config: AiConfig, contentType?: string) {
    return {
        "X-Bridge-Token": channelKey(config),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    // 商业站点无游客模式: 未登录弹出登录框并中断
    if (!requireLogin()) throw new Error(apiText("loginRequired"));
    // dola 渠道失败自动重试: 隧道抖动导致的任务中断(参考图拉取失败等)重提常可成功, 次数由渠道设置控制。
    const requestConfig = resolveModelRequestConfig(config, (config.model || config.videoModel).trim());
    const retries = requestConfig.apiFormat === "dola" ? Math.max(0, Math.min(5, Math.floor(Number(requestConfig.retryLimit) || 0))) : 0;
    for (let retry = 0; ; retry += 1) {
        try {
            const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
            try {
                return await pollVideoGenerationUntilDone(config, task, options);
            } catch (error) {
                // 任务已提交扣费后的失败 (轮询失败/超时): 服务端渠道自动退点
                maybeRefundGeneration(config, task.model, error);
                throw error;
            }
        } catch (error) {
            if (retry >= retries || options?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
            await delay(3000, options?.signal);
        }
    }
}

/** 已建任务后仅轮询至完成: 画布节点凭 videoTaskId 恢复等待时复用 (刷新/换设备后继续等出片)。 */
export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    return pollVideoGenerationUntilDone(config, task, options);
}

/** 任务被上游判定失败 (区别于网络/轮询中断): 失败的任务无法恢复, 节点应清掉 videoTaskId。 */
export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

async function pollVideoGenerationUntilDone(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    // Dola video jobs commonly take several minutes after submission. The
    // local relay keeps the task alive for its configured 30-minute timeout,
    // so the client must not stop polling after the generic 5-minute window.
    const localDola = isLocalDolaApi(config, task.model);
    // 所有视频渠道统一允许最长约 30 分钟(1800s)的排队/渲染等待。
    // 5s 间隔渠道需 360 次, 2.5s 间隔渠道需 720 次。
    const maxAttempts = task.provider === "seedance" || task.provider === "autodl" || task.provider === "mingze" || task.provider === "doubao" || task.provider === "agnes" || task.provider === "dola" || localDola ? 360 : 720;
    const pollDelayMs = task.provider === "seedance" || task.provider === "autodl" || task.provider === "mingze" || task.provider === "doubao" || task.provider === "agnes" || task.provider === "dola" || localDola ? 5000 : 2500;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw videoTaskFailed(state.error);
        if (attempt === maxAttempts - 1) throw new Error(apiText("videoTimeout", { provider: task.provider === "seedance" ? "Seedance " : task.provider === "autodl" ? "AutoDL " : "" }));
        await delay(pollDelayMs, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    return retryWithKeyRotation(config, () => createVideoGenerationTaskOnce(config, prompt, references, videoReferences, audioReferences, options));
}

async function createVideoGenerationTaskOnce(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    // 防人脸拦截: 渠道开启时先给参考图眼部叠加干扰, 再走各协议分支。
    const guardedReferences = await guardReferenceImages(requestConfig, references);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, guardedReferences, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, guardedReferences, videoReferences, audioReferences, options);
    }
    if (requestConfig.apiFormat === "autodl") {
        // requestConfig.model is the bare workflow id (channel prefix stripped).
        return createAutoDlVideoTask(requestConfig, requestConfig.model, prompt, guardedReferences, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error(apiText("videoReferencesUnsupported"));
    }
    if (requestConfig.apiFormat === "mingze") {
        return createMingzeVideoTask(requestConfig, selectedModel, prompt, guardedReferences, options);
    }
    if (requestConfig.apiFormat === "agnes") {
        return createAgnesVideoTask(requestConfig, selectedModel, prompt, guardedReferences, options);
    }
    if (requestConfig.apiFormat === "dola") {
        return createDolaVideoTask(requestConfig, selectedModel, prompt, guardedReferences, options);
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, guardedReferences, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return retryWithKeyRotation(config, () => pollVideoGenerationTaskOnce(config, task, options));
}

async function pollVideoGenerationTaskOnce(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "autodl") return pollAutoDlVideoTask(requestConfig, task, options);
    if (task.provider === "mingze") return pollMingzeVideoTask(requestConfig, task, options);
    if (task.provider === "doubao") return pollDoubaoVideoTask(requestConfig, task, options);
    if (task.provider === "agnes") return pollAgnesVideoTask(requestConfig, task, options);
    if (task.provider === "dola") return pollDolaVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (isLocalDolaApi(config, model)) return createLocalDolaVideoTask(config, model, prompt, references, options);
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createLocalDolaVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const duration = Number(config.videoSeconds) >= 30 ? 30 : 15;
    const ratio = localDolaVideoRatio(config.size);
    // Canvas references are often local object URLs or IndexedDB storage keys;
    // convert them to data URLs so the local relay can materialize and upload
    // them through its native Dola reference pipeline.
    const imageUrls = (await Promise.all(references.slice(0, 10).map((image) => imageToDataUrl(image, options)))).filter(Boolean);
    try {
        const response = await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos/generations"), {
            model: modelOptionName(model),
            prompt,
            duration,
            ratio,
            image_urls: imageUrls,
        }, { headers: { ...aiHeaders(config), "Content-Type": "application/json" }, signal: options?.signal });
        const created = unwrapVideoResponse(response.data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const path = isLocalDolaApi(config, task.model) ? `/videos/tasks/${encodeURIComponent(task.id)}` : `/videos/${encodeURIComponent(task.id)}`;
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, path), { headers: aiHeaders(config), signal: options?.signal })).data);
        const localApi = isLocalDolaApi(config, task.model);
        const url = videoResultUrl(video, localApi);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options, localApi ? config : undefined) };
        if (["completed", "succeeded", "success", "done"].includes(String(video.status || "").toLowerCase())) {
            const content = await axios.get<Blob>(localApi ? aiApiUrl(config, `/videos/tasks/${encodeURIComponent(task.id)}/download`) : aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (["failed", "cancelled", "canceled", "error"].includes(String(video.status || "").toLowerCase())) return { status: "failed", error: readApiErrorMessage(video.error) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions, config?: AiConfig): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", headers: config ? aiHeaders(config) : undefined, signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (config) throw new Error(readAxiosError(error, apiText("videoDownloadFailed")));
        return { url, mimeType: "video/mp4" };
    }
}

// 鸣泽影坊本地视频自动化: 创建任务 -> 轮询 /jobs/{id} -> 完成时取 /jobs/{id}/result。
// 参考图与本地 Dola 视频同源，转成 data URL 后经 image_urls 传入做图生视频。
async function createMingzeVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const imageUrls = (await Promise.all(references.slice(0, 10).map((image) => imageToDataUrl(image, options)))).filter(Boolean);
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(
                    aiApiUrl(config, "/videos"),
                    {
                        model: modelOptionName(model),
                        prompt,
                        seconds: normalizeVideoSeconds(config.videoSeconds),
                        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
                    },
                    { headers: aiHeaders(config, "application/json"), signal: options?.signal },
                )
            ).data,
        ) as unknown as VideoResponse & { job_id?: string };
        const jobId = created.job_id || created.id;
        if (!jobId) throw new Error(apiText("noVideoTaskId"));
        return { id: jobId, provider: "mingze", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollMingzeVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapVideoResponse(
            (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/jobs/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data,
        ) as unknown as VideoResponse & { resources?: unknown[]; error_message?: string; error?: unknown };
        const url = mingzeResultFromArray(state.resources) || mingzeResultUrl(state) || videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        const status = String(state.status || "").toLowerCase();
        if (["completed", "finished", "succeeded", "done", "success"].includes(status)) {
            return mingzeResultFromJob(config, task.id, options);
        }
        if (["failed", "error", "cancelled", "canceled"].includes(status)) {
            const message = typeof state.error_message === "string" && state.error_message ? state.error_message : readApiErrorMessage(state.error);
            return { status: "failed", error: message || apiText("videoGenerationFailed") };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function mingzeResultFromJob(config: AiConfig, jobId: string, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = await axios.get<Blob>(aiApiUrl(config, `/jobs/${encodeURIComponent(jobId)}/result`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
        const blob = response.data;
        if (!blob.type.includes("json") && !blob.type.includes("text")) {
            await assertVideoBlob(blob);
            return { status: "completed", result: { blob } };
        }
        const raw = await blob.text();
        let payload: unknown = raw;
        try {
            payload = JSON.parse(raw);
        } catch {
            // plain-text result, may still be an error message
        }
        if (payload && typeof payload === "object") {
            const apiError = readApiErrorMessage(payload as Record<string, unknown>);
            if (apiError) throw new Error(apiError);
        }
        const url = mingzeResultUrl(payload);
        if (!url) return { status: "failed", error: apiText("mingzeNoResult") };
        return { status: "completed", result: await videoResultFromUrl(url, options) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoDownloadFailed")));
    }
}

// Result payloads may nest the actual video object under {data}; unwrap it and reuse the shared URL-field reader.
function mingzeResultUrl(payload: unknown): string {
    if (typeof payload === "string") return videoResultUrl({ url: payload }) || "";
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    if (record.data && typeof record.data === "object") {
        const nested = mingzeResultUrl(record.data);
        if (nested) return nested;
    }
    return videoResultUrl(record as VideoResponse) || "";
}

// Job responses carry finished resources in an array; scan each entry for a playable video URL.
function mingzeResultFromArray(resources: unknown): string {
    if (!Array.isArray(resources)) return "";
    for (const item of resources) {
        const url = mingzeResultUrl(item);
        if (url) return url;
    }
    return "";
}

// 豆包管理器桥接服务 (v1 REST 契约, 见 doubao_bridge_capture/API.md):
// POST /v1/video/generations 创建任务, GET /v1/video/generations/{id} 轮询, 成功取 result.video_url。
// 目标平台 doubao(seedance2.0fast/mini, ≤15s) 与 dola(额外支持 dreamina-seedance2.5, ≤30s) 按模型+时长自动选择。
const DOUBAO_DURATIONS: Record<"doubao" | "dola", number[]> = { doubao: [5, 10, 15], dola: [5, 10, 15, 30] };

function doubaoTargetPlatform(model: string, duration: number): "doubao" | "dola" {
    return model === "dreamina-seedance2.5" || duration > 15 ? "dola" : "doubao";
}

function doubaoDuration(value: number, target: "doubao" | "dola"): number {
    const options = DOUBAO_DURATIONS[target];
    const duration = Number.isFinite(value) && value > 0 ? value : 10;
    return options.reduce((closest, option) => (Math.abs(option - duration) < Math.abs(closest - duration) ? option : closest));
}

async function createDoubaoVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    // 桥接只接收本地文件路径作为参考图 (image_paths)，画布引用无法直接注入，暂不支持图生视频。
    if (references.length) throw new Error(apiText("doubaoReferencesUnsupported"));
    const rawModel = modelOptionName(model);
    const requested = Number(config.videoSeconds) || 10;
    const target = doubaoTargetPlatform(rawModel, requested);
    const duration = doubaoDuration(requested, target);
    const ratio = localDolaVideoRatio(config.size);
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(
                    aiApiUrl(config, "/v1/video/generations"),
                    {
                        prompt,
                        image_paths: [],
                        duration,
                        ratio,
                        model: rawModel,
                        target_platform: target,
                        remove_watermark: true,
                    },
                    { headers: doubaoHeaders(config, "application/json"), signal: options?.signal },
                )
            ).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "doubao", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

type DoubaoTaskState = ApiVideoResponse & { status?: string; stage?: string; result?: { video_url?: string; file_path?: string }; error?: { message?: string } | null };
async function pollDoubaoVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapVideoResponse(
            (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/v1/video/generations/${encodeURIComponent(task.id)}`), { headers: doubaoHeaders(config), signal: options?.signal })).data,
        ) as DoubaoTaskState;
        const status = String(state.status || "").toLowerCase();
        const url = state.result?.video_url || state.result?.file_path || videoResultUrl(state);
        if (status === "succeeded") {
            if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
            return { status: "failed", error: apiText("doubaoNoResult") };
        }
        if (["failed", "error", "cancelled", "canceled"].includes(status)) {
            return { status: "failed", error: readApiErrorMessage(state.error) || apiText("videoGenerationFailed") };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

// Agnes AI 视频异步任务: POST /v1/videos 创建 (JSON)，轮询 GET /agnesapi?video_id=...&model_name=...，成功后取 metadata.url。
// 两套请求体按模型区分：v2.0 用 num_frames/frame_rate 控制时长（≤441 且 8n+1，固定 24fps）；
// 2.5 系列为 OpenAI Videos 兼容格式，用字符串 seconds（4–12）+ size/aspect_ratio，禁止传 width/height/num_frames 等字段。
// 参考图都要求公网 URL，本地引用先传图床转链接（与多米参考图同一通道）。
const AGNES_VIDEO_FRAME_RATE = 24;
const AGNES_VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

// 画布"秒数"折算为 24fps 帧数，取整到 8n+1 并夹在 [25, 441]（约 1~18 秒）。
function agnesVideoFrames(seconds: string) {
    return Math.min(441, Math.max(25, Math.round((Math.max(1, Math.min(18, Math.floor(Number(seconds) || 5))) * AGNES_VIDEO_FRAME_RATE) / 8) * 8 + 1));
}

const isAgnesVideo25 = (model: string) => model.includes("2.5");

// 2.5 系列时长为字符串形式，夹在 4–12 秒。
function agnesVideoSeconds(seconds: string) {
    return String(Math.min(12, Math.max(4, Math.round(Number(seconds) || 5))));
}

// 2.5 系列分辨率档位：flash 仅支持 720P；正式版按清晰度映射 720P/960P/2K。
function agnesVideoSize(model: string, vquality: string) {
    if (model.includes("flash")) return "720P";
    const height = Number(normalizeVideoResolution(vquality).replace("p", "")) || 720;
    return height >= 1080 ? "2K" : height > 720 ? "960P" : "720P";
}

// 画布比例归一到 2.5 系列支持的 6 种画幅（不支持 auto 与白名单外的值）。
function agnesVideoRatio(size: string) {
    const value = size.trim();
    if (AGNES_VIDEO_RATIOS.includes(value)) return value;
    const [width, height] = value.split(/[x:]/).map(Number);
    const target = width > 0 && height > 0 ? width / height : 16 / 9;
    return AGNES_VIDEO_RATIOS.reduce((best, item) => {
        const [w, h] = item.split(":").map(Number);
        const [bw, bh] = best.split(":").map(Number);
        return Math.abs(w / h - target) < Math.abs(bw / bh - target) ? item : best;
    });
}

async function createAgnesVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    // 2.5 系列 reference 模式最多 5 张参考图；v2.0 图生视频只收单张 image。
    const images = await Promise.all(
        references.slice(0, isAgnesVideo25(modelName) ? 5 : 1).map(async (image) => {
            if (/^https?:\/\//i.test(image.dataUrl)) return image.dataUrl;
            try {
                return await uploadReferenceImageUrl(image, options?.signal);
            } catch (error) {
                if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
                throw new Error(apiText("duomiReferenceUploadFailed", { message: error instanceof Error ? error.message : String(error) }));
            }
        }),
    );
    const body = isAgnesVideo25(modelName)
        ? {
              model: modelName,
              prompt,
              seconds: agnesVideoSeconds(config.videoSeconds),
              mode: images.length ? "reference" : "text",
              size: agnesVideoSize(modelName, config.vquality),
              aspect_ratio: agnesVideoRatio(config.size),
              ...(images.length ? { images } : {}),
          }
        : {
              model: modelName,
              prompt,
              ...(images.length ? { image: images[0] } : {}),
              num_frames: agnesVideoFrames(config.videoSeconds),
              frame_rate: AGNES_VIDEO_FRAME_RATE,
          };
    try {
        const created = unwrapVideoResponse(
            (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        // 官方推荐用 video_id 查询任务（可能与 task_id 不同），缺省时回退任务 id。
        return { id: created.video_id || created.id, provider: "agnes", model: modelName };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollAgnesVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        // 查询统一走 /agnesapi（官方推荐，两种模型通用）；keyframe/reference 模式必须带 model_name。
        const query = new URLSearchParams({ video_id: task.id, model_name: task.model });
        const state = unwrapVideoResponse(
            (await axios.get<ApiVideoResponse>(`${config.baseUrl.replace(/\/v1\/?$/, "")}/agnesapi?${query.toString()}`, { headers: aiHeaders(config), signal: options?.signal })).data,
        ) as unknown as VideoResponse & { metadata?: { url?: string } };
        // Agnes 把成片地址放在 metadata.url，不在通用结果字段列表里，需要单独读取。
        const url = state.metadata?.url || videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        const status = String(state.status || "").toLowerCase();
        if (["completed", "succeeded", "success", "done"].includes(status)) return { status: "failed", error: apiText("agnesNoResult") };
        if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(state.error) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error(apiText("seedanceAudioRequiresVisual"));
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error(apiText("videoPromptRequired"));
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(resolveVideoRatio(config)),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("seedanceNoTaskId"));
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskCreateFailed")));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "failed", error: apiText("seedanceNoVideoUrl") };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired")
            return { status: "failed", error: readApiErrorMessage(state.error?.message) || apiText(state.status === "expired" ? "seedanceVideoTimeout" : "seedanceVideoFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskQueryFailed")));
    }
}

// dola(豆包账号管理器) 公网 API: POST /videos/generations 建任务, GET /videos/tasks/{id} 轮询;
// duration 仅接受 15/30, ratio 只收比例 token, 参考图 image_urls 只收公网 URL。
type DolaVideoTask = { id?: string; status?: string; error?: { message?: string } | string | null; video_url?: string; result_url?: string; data?: Array<string | { url?: string; no_watermark_url?: string; video_url?: string }> | null };

const DOLA_VIDEO_RATIOS: Array<[string, number]> = [
    ["21:9", 21 / 9],
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["9:16", 9 / 16],
];

// dola video only accepts ratio tokens like "16:9"; map pixel sizes to the nearest common ratio.
function dolaVideoRatio(size: string) {
    const value = size.trim();
    if (/^\d+:\d+$/.test(value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    const target = match ? Number(match[1]) / Number(match[2]) : 16 / 9;
    return DOLA_VIDEO_RATIOS.reduce((best, item) => (Math.abs(item[1] - target) < Math.abs(best[1] - target) ? item : best))[0];
}

async function createDolaVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(
        references.slice(0, 7).map(async (image) => {
            if (/^https?:\/\//i.test(image.dataUrl)) return image.dataUrl;
            return uploadReferenceImageUrl({ ...image, dataUrl: await compressDolaReference(image) }, options?.signal);
        }),
    );
    if (!prompt.trim() && !images.length) throw new Error(apiText("videoPromptRequired"));
    const payload = {
        model: modelOptionName(model),
        prompt: prompt.trim(),
        duration: Number(config.videoSeconds) >= 30 ? 30 : 15,
        ratio: dolaVideoRatio(config.size),
        ...(images.length ? { image_urls: images } : {}),
    };
    try {
        const created = (await axios.post<DolaVideoTask>(aiApiUrl(config, "/videos/generations"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data;
        if (!created.id) throw new Error(apiText("dolaNoTaskId"));
        return { id: created.id, provider: "dola", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollDolaVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<DolaVideoTask>(aiApiUrl(config, `/videos/tasks/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const url = dolaVideoUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        const status = (state.status || "").toLowerCase();
        if (["succeeded", "completed", "success"].includes(status)) return { status: "failed", error: apiText("dolaNoVideo") };
        if (["failed", "error", "cancelled", "expired"].includes(status) || state.error) {
            return { status: "failed", error: readApiErrorMessage(state) || apiText("dolaVideoFailed") };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function dolaVideoUrl(state: DolaVideoTask) {
    const items = Array.isArray(state.data) ? state.data : [];
    return [state.video_url, state.result_url, ...items.map((item) => (typeof item === "string" ? item : item?.video_url || item?.no_watermark_url || item?.url || ""))]
        .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))[0] || "";
}

// AutoDL MiniMax-H3 workflow families; kind decides how references map to request fields (proven against the 字字动画 plugin).
type AutoDlWorkflowKind = "t2v" | "flf" | "images" | "audio";

const AUTO_DL_WORKFLOW_KINDS: Record<string, AutoDlWorkflowKind> = {
    "minimax_h3_lightx2v_no_pic": "t2v",
    "minimax_h3_lightx2v": "flf",
    "minimax_h3_b99_002": "flf",
    "minimax_h3_lightx2v_v5": "images",
    "minimax_h3_lightx2v_v5_15s": "images",
    "minimax_h3_image_audio_to_video_v2": "audio",
    "minimax_h3_image_audio_to_video_v2_15s": "audio",
};

function autoDlWorkflowKind(model: string): AutoDlWorkflowKind {
    const known = AUTO_DL_WORKFLOW_KINDS[model.toLowerCase()];
    if (known) return known;
    const id = model.toLowerCase();
    if (id.includes("no_pic")) return "t2v";
    if (id.includes("audio")) return "audio";
    if (id.includes("flf") || id.includes("first") || id.includes("last")) return "flf";
    return "images";
}

async function createAutoDlVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (videoReferences.length) {
        throw new Error(apiText("videoReferencesUnsupported"));
    }
    const images = await Promise.all(references.slice(0, SEEDANCE_REFERENCE_LIMITS.images).map((image) => autoDlImageRef(image)));
    const audios = await Promise.all(audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios).map((audio) => resolveSeedanceAudioUrl(audio)));
    if (!prompt.trim() && !images.length && !audios.length) {
        throw new Error(apiText("videoPromptRequired"));
    }
    const values: Record<string, unknown> = {
        prompt: prompt.trim(),
        duration: autoDlDuration(config.videoSeconds, model),
        resolution: autoDlResolution(config.vquality, config.size, model),
        images,
        audios,
    };
    const kind = autoDlWorkflowKind(model);
    if (kind === "t2v" && (images.length || audios.length)) {
        // Text-to-video workflows have no reference inputs; the platform accepts the params but the graph ignores them.
        throw new Error(apiText("autoDlT2vWithRefs"));
    }
    const template = resolveModelParams(config, model);
    let body: Record<string, unknown>;
    if (template) {
        try {
            body = applyAutoDlTemplate(template, values);
        } catch (error) {
            throw new Error(apiText("autoDlTemplateInvalid", { message: error instanceof Error ? error.message : String(error) }));
        }
    } else {
        body = autoDlDefaultBody(kind, values, model);
    }
    try {
        const created = unwrapAutoDlTask(
            (
                await axios.post<AutoDlEnvelope>(autoDlApiUrl(config, `/comfyui_workflow/${encodeURIComponent(model)}`), body, {
                    headers: autoDlHeaders(config, "application/json"),
                    signal: options?.signal,
                })
            ).data,
        );
        if (!created.task_id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.task_id, provider: "autodl", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

// H3 ref images accept JPG/PNG/WebP URLs or data URIs; downscale to ≤1024px JPEG like the proven 字字动画 plugin —
// full-size originals (several MB of base64) get silently dropped server-side, which yields videos unrelated to the references.
async function autoDlImageRef(image: ReferenceImage) {
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    if (!dataUrl.startsWith("data:image/")) return dataUrl;
    try {
        const source = new Image();
        source.src = dataUrl;
        await source.decode();
        const scale = Math.min(1, 1024 / Math.max(source.naturalWidth, source.naturalHeight));
        const width = Math.max(1, Math.round(source.naturalWidth * scale));
        const height = Math.max(1, Math.round(source.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return dataUrl;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
        return canvas.toDataURL("image/jpeg", 0.88);
    } catch {
        return dataUrl;
    }
}

// Default request body per workflow family: prompt/duration/resolution plus ref_image_N / ref_audio_N / first_frame+last_frame.
// Validation matches the 字字动画 plugin: each workflow kind only accepts the reference types its graph actually wires —
// e.g. the 10s image+audio workflow silently ignores ref images when no audio is attached, producing unrelated videos.
// Exception: minimax_h3_image_audio_to_video_v2_15s marks every field optional in the docs, so ref images alone are accepted.
function autoDlDefaultBody(kind: AutoDlWorkflowKind, values: Record<string, unknown>, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = { prompt: values.prompt, duration: values.duration, resolution: values.resolution };
    const images = values.images as string[];
    const audios = values.audios as string[];
    if (kind === "flf") {
        if (!images[0] || !images[1]) throw new Error(apiText("autoDlFlfRequired"));
        body.first_frame = images[0];
        body.last_frame = images[1];
    } else if (kind === "images" || kind === "audio") {
        if (kind === "images" && !images.length) throw new Error(apiText("autoDlImagesRequired"));
        if (kind === "audio" && !audios.length && !/15s$/i.test(model)) throw new Error(apiText("autoDlAudiosRequired"));
        images.forEach((image, index) => {
            body[`ref_image_${index}`] = image;
        });
        if (kind === "audio") {
            audios.forEach((audio, index) => {
                body[`ref_audio_${index}`] = audio;
            });
        }
    }
    return body;
}

// Fills a user JSON template: {{name}} as a whole value injects the raw value (string/number/array; empty or missing drops the field), inline placeholders are stringified.
const AUTO_DL_PARAM_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

function applyAutoDlTemplate(template: string, values: Record<string, unknown>): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(template);
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
    const fill = (node: unknown): unknown => {
        if (typeof node === "string") {
            const whole = node.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
            if (whole) return autoDlParamValue(values, whole[1]);
            return node.replace(AUTO_DL_PARAM_PATTERN, (_, key: string) => String(autoDlParamValue(values, key) ?? ""));
        }
        if (Array.isArray(node)) return node.map(fill);
        if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fill(value)]));
        return node;
    };
    const result = fill(parsed);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(apiText("autoDlTemplateNotObject"));
    return result as Record<string, unknown>;
}

function autoDlParamValue(values: Record<string, unknown>, key: string) {
    const [root, index] = key.split(".");
    const value = values[root];
    if (index !== undefined && Array.isArray(value)) return value[Number(index)];
    if (Array.isArray(value) && !value.length) return undefined;
    return value;
}

async function pollAutoDlVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapAutoDlTask((await axios.get<AutoDlEnvelope>(autoDlApiUrl(config, `/comfyui_workflow/result/${encodeURIComponent(task.id)}`), { headers: autoDlHeaders(config), signal: options?.signal })).data);
        const status = String(state.status || "").toUpperCase();
        if (status === "SUCCESS") {
            const url = autoDlResultUrl(state.results);
            if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
            return { status: "failed", error: apiText("autoDlNoResult") };
        }
        if (status === "FAILED") return { status: "failed", error: apiText("autoDlTaskFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

/** AutoDL ComfyUI workflow endpoint; baseUrl may be the site root, /api/v1, or the full /api/v1/comfyui path. */
function autoDlApiUrl(config: AiConfig, path: string) {
    let base = config.baseUrl.trim().replace(/\/+$/, "");
    if (!/\/comfyui$/i.test(base)) base = /\/api\/v1$/i.test(base) ? `${base}/comfyui` : `${base}/api/v1/comfyui`;
    return `${base}${path}`;
}

// AutoDL expects the raw token in Authorization, without a Bearer prefix; strip one if pasted that way.
function autoDlHeaders(config: AiConfig, contentType?: string) {
    const token = channelKey(config).trim().replace(/^Bearer\s+/i, "");
    return {
        Authorization: token,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function unwrapAutoDlTask(payload: AutoDlEnvelope | null | undefined): AutoDlTask {
    if (!payload) throw new Error(apiText("noVideoTask"));
    const code = String(payload.code || "").toLowerCase();
    if (code && code !== "success") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
    if (!payload.data) throw new Error(apiText("noVideoTask"));
    return payload.data;
}

function autoDlResultUrl(results: unknown) {
    if (!Array.isArray(results)) return "";
    return (
        results
            .map((item) => {
                if (typeof item === "string") return item;
                const record = item as { url?: unknown; video_url?: unknown };
                return typeof record?.url === "string" ? record.url : typeof record?.video_url === "string" ? record.video_url : "";
            })
            .find((url) => isPublicMediaUrl(url)) || ""
    );
}

// H3 caps duration per workflow family: 15s variants allow 15s, other minimax_h3_ workflows 10s.
function autoDlDuration(value: string, model: string) {
    const seconds = Math.max(1, Math.min(15, Math.floor(Number(value) || 5)));
    const max = /15s/i.test(model) ? 15 : /^minimax_h3_/i.test(model) ? 10 : 15;
    return Math.min(seconds, max);
}

// Orientation suffix from the size setting: ratio tokens, pixel sizes, or auto (defaults to landscape).
function autoDlOrientation(size: string) {
    if (size === "1:1") return "(1:1)";
    const match = size.match(/^(\d+)x(\d+)$/);
    if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width && height) {
            if (Math.abs(width / height - 1) < 0.02) return "(1:1)";
            return width < height ? "竖" : "横";
        }
    }
    return ["9:16", "3:4", "2:3"].includes(size) ? "竖" : "横";
}

// Resolutions each known H3 workflow accepts; unsupported choices are downgraded step by step (verified against the 字字动画 plugin).
const AUTO_DL_RESOLUTIONS: Record<string, string[]> = {
    "minimax_h3_lightx2v_no_pic": ["480p竖", "480p横", "768p竖", "768p横"],
    "minimax_h3_lightx2v": ["480p竖", "480p横", "768p竖", "768p横"],
    "minimax_h3_b99_002": ["480p竖", "480p横", "768p竖", "768p横"],
    "minimax_h3_lightx2v_v5": ["480p竖", "480p横", "768p竖", "768p横", "1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"],
    "minimax_h3_lightx2v_v5_15s": ["480p竖", "480p横", "768p竖", "768p横", "480p(1:1)", "768p(1:1)"],
    "minimax_h3_image_audio_to_video_v2": ["480p竖", "480p横", "768p竖", "768p横", "1080p竖", "1080p横"],
    "minimax_h3_image_audio_to_video_v2_15s": ["480p竖", "480p横", "768p竖", "768p横"],
};

const AUTO_DL_RESOLUTION_DOWNGRADE: Record<string, string> = {
    "1080p竖": "768p竖",
    "1080p横": "768p横",
    "1080p(1:1)": "768p(1:1)",
    "768p(1:1)": "768p竖",
    "480p(1:1)": "480p竖",
};

// AutoDL H3 resolutions look like "480p竖" / "768p横" / "1080p(1:1)"; H3 uses 768p instead of 720p.
function autoDlResolution(quality: string, size: string, model: string) {
    const tier = { "480p": "480p", "1080p": "1080p" }[normalizeVideoResolution(quality)] || "768p";
    const suffix = autoDlOrientation(size);
    const chosen = `${tier}${suffix}`;
    const allowed = AUTO_DL_RESOLUTIONS[model.toLowerCase()];
    if (!allowed || allowed.includes(chosen)) return chosen;
    let current = chosen;
    while (AUTO_DL_RESOLUTION_DOWNGRADE[current]) {
        current = AUTO_DL_RESOLUTION_DOWNGRADE[current];
        if (allowed.includes(current)) return current;
    }
    return allowed[0];
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error(apiText("seedanceVideoDuration"));
        total += video.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceVideoTotalDuration"));
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error(apiText("seedanceAudioDuration"));
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceAudioTotalDuration"));
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceVideo"));
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceAudio"));
    return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("localAssetReadFailed")));
        reader.readAsDataURL(blob);
    });
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, apiText("seedanceNoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask | DoubaoTaskState | Record<string, unknown>, allowLocalDownload = false) {
    const video = payload as VideoResponse;
    const candidates = allowLocalDownload
        ? [video.download_url, video.no_watermark_url, video.video_url, video.result_url, video.url, video.content?.video_url, video.content?.url]
        : [video.no_watermark_url, video.video_url, video.result_url, video.url, video.content?.video_url, video.content?.url];
    return candidates.find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url) || (allowLocalDownload && /^https?:\/\/(?:127\.0\.0\.1|localhost):8088\/v1\/videos\/tasks\/[^/]+\/download\/?$/i.test(url))));
}

function isLocalDolaApi(config: AiConfig, model: string) {
    return modelOptionName(model).toLowerCase() === "dola-video" || config.baseUrl.includes("127.0.0.1:8088") || config.baseUrl.includes("localhost:8088");
}

function localDolaVideoRatio(value: string) {
    const normalized = String(value || "").trim();
    if (["9:16", "2:3", "3:4"].includes(normalized)) return "9:16";
    const match = normalized.match(/^(\d+)x(\d+)$/);
    if (match && Number(match[2]) > Number(match[1])) return "9:16";
    return "16:9";
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    noteRateLimit(error);
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        // 同源请求的 ERR_NETWORK 是连接闪断(移动网络/NAT 掐断长连接), 不是跨域; 文案要区分开。
        if (!error.response && error.code === "ERR_NETWORK") return isSameOriginRequest(error.config?.url) ? apiText("networkDisconnected") : apiText("corsRequired");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

/** 判断出错请求是否发往当前站点: 同源断网/闪断不该报"跨域拦截"。 */
function isSameOriginRequest(url: string | undefined) {
    if (!url) return true;
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
        return true;
    }
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
