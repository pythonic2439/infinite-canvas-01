import axios from "axios";

export type ExtractedFrame = { content: string; timeSec: number; source: "ffmpeg" | "browser" };
export type FrameExtractionResult = { frames: ExtractedFrame[]; source: "ffmpeg" | "browser" };

type FFmpegFrameResponse = {
    ok: boolean;
    msg?: string;
    count?: number;
    durationSec?: number;
    frames?: { data: string; timeSec: number }[];
};

/** 优先走本地启动器 ffmpeg 均匀抽帧 (编码兼容性最好、时间点精准); 不可用时退回浏览器 <video> 解码抽帧。 */
export async function extractVideoFrames(source: string, count: number): Promise<FrameExtractionResult> {
    const bounded = Math.max(2, Math.min(24, Math.round(count)));
    try {
        return await extractWithFFmpeg(source, bounded);
    } catch {
        return extractWithBrowser(source, bounded);
    }
}

async function extractWithFFmpeg(source: string, count: number): Promise<FrameExtractionResult> {
    let blob: Blob;
    try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        blob = await response.blob();
    } catch (error) {
        throw new Error(`读取视频失败: ${String((error as Error)?.message || error)}`);
    }
    if (blob.size > 512 * 1024 * 1024) throw new Error("视频超过 512MB，无法本地抽帧");
    const form = new FormData();
    form.append("file", blob, "source.mp4");
    let data: FFmpegFrameResponse;
    try {
        data = (await axios.post(`/api/ffmpeg/frames?count=${count}`, form, { timeout: 120000, headers: { "X-File-Name": "source.mp4" } })).data;
    } catch (error) {
        const detail = (error as { response?: { data?: FFmpegFrameResponse } })?.response?.data;
        throw new Error(detail?.msg || String((error as Error)?.message || error));
    }
    if (!data?.ok || !data.frames?.length) throw new Error(data?.msg || "ffmpeg 抽帧失败");
    return {
        source: "ffmpeg",
        frames: data.frames.map((frame) => ({ content: `data:image/png;base64,${frame.data}`, timeSec: frame.timeSec, source: "ffmpeg" as const })),
    };
}

/** 浏览器兜底: 用隐藏 video 元素按等分时间点逐帧 seek 后截图, 依赖浏览器支持的编码 (H.264/VP9 等)。 */
export async function extractWithBrowser(source: string, count: number): Promise<FrameExtractionResult> {
    const bounded = Math.max(2, Math.min(24, Math.round(count)));
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const metadataLoaded = waitForVideo(video, "loadedmetadata");
        video.src = source;
        video.load();
        await metadataLoaded;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长");
        const frames: ExtractedFrame[] = [];
        for (let index = 0; index < bounded; index += 1) {
            const time = Math.min(((index + 0.5) / bounded) * duration, Math.max(0, duration - 0.001));
            const seeked = waitForVideo(video, "seeked");
            video.currentTime = time;
            await seeked;
            frames.push({ content: await drawFrame(video), timeSec: Math.round(time * 1000) / 1000, source: "browser" });
        }
        return { frames, source: "browser" };
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

function drawFrame(video: HTMLVideoElement) {
    return new Promise<string>((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) {
            reject(new Error("canvas 2d context unavailable"));
            return;
        }
        context.drawImage(video, 0, 0);
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new Error("Failed to capture video frame"));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error("Failed to read frame blob"));
                reader.readAsDataURL(blob);
            },
            "image/png",
        );
    });
}

function waitForVideo(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked") {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            resolve();
        };
        const fail = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            reject(new Error(`Video event failed: ${eventName}`));
        };
        video.addEventListener(eventName, finish, { once: true });
        video.addEventListener("error", fail, { once: true });
    });
}

export type VideoSegment = { content: string; startSec: number; endSec: number };
export type VideoSplitResult = { segments: VideoSegment[]; durationSec: number };

type FFmpegSplitResponse = {
    ok: boolean;
    msg?: string;
    count?: number;
    durationSec?: number;
    segments?: { data: string; startSec: number; endSec: number }[];
};

/** 按时间点切割视频: 无浏览器兜底, 必须依赖本地启动器的 ffmpeg (浏览器无法无损切视频)。 */
export async function splitVideoByCuts(source: string, cuts: number[]): Promise<VideoSplitResult> {
    let blob: Blob;
    try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        blob = await response.blob();
    } catch (error) {
        throw new Error(`读取视频失败: ${String((error as Error)?.message || error)}`);
    }
    if (blob.size > 512 * 1024 * 1024) throw new Error("视频超过 512MB，无法本地分割");
    const form = new FormData();
    form.append("file", blob, "source.mp4");
    let data: FFmpegSplitResponse;
    try {
        data = (await axios.post(`/api/ffmpeg/split?cuts=${cuts.map((cut) => cut.toFixed(3)).join(",")}`, form, { timeout: 300000, headers: { "X-File-Name": "source.mp4" } })).data;
    } catch (error) {
        const detail = (error as { response?: { data?: FFmpegSplitResponse } })?.response?.data;
        throw new Error(detail?.msg || String((error as Error)?.message || error));
    }
    if (!data?.ok || !data.segments?.length) throw new Error(data?.msg || "ffmpeg 分割失败");
    return {
        durationSec: data.durationSec || 0,
        segments: data.segments.map((segment) => ({ content: `data:video/mp4;base64,${segment.data}`, startSec: segment.startSec, endSec: segment.endSec })),
    };
}
