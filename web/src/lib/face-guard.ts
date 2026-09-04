import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

import type { AiConfig } from "@/stores/use-config-store";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type FaceGuardStyle = "grid" | "mosaic" | "stripes";

export type FaceGuardOptions = {
    style: FaceGuardStyle;
    /** 网格单元边长 / 马赛克块边长, 相对眼区高度的倍率 (0.05~0.5)。 */
    cell: number;
    /** 叠加不透明度 0~1。 */
    opacity: number;
    /** 眼区向外扩的比例 0~1。 */
    margin: number;
    /** 覆盖区域: eyes=仅双眼, face=整张脸。 */
    region: "eyes" | "face";
};

export const DEFAULT_FACE_GUARD_OPTIONS: FaceGuardOptions = { style: "grid", cell: 0.16, opacity: 0.75, margin: 0.35, region: "eyes" };

export type EyeBox = { x: number; y: number; width: number; height: number };

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** 懒加载本地 MediaPipe FaceLandmarker (WASM + 模型均随应用离线分发)。 */
export function getFaceLandmarker() {
    landmarkerPromise ||= (async () => {
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        return FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "GPU" },
            runningMode: "IMAGE",
            numFaces: 10,
        });
    })().catch((error) => {
        landmarkerPromise = null;
        throw error;
    });
    return landmarkerPromise;
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to load image"));
        image.src = src;
    });
}

// MediaPipe FaceLandmarker 关键点索引: 左眼/右眼各取内外角与上下缘。
const LEFT_EYE = { outer: 33, inner: 133, top: 159, bottom: 145 };
const RIGHT_EYE = { outer: 263, inner: 362, top: 386, bottom: 374 };
const FACE_OUTLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

function boxFromPoints(points: Array<{ x: number; y: number }>) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function eyeBoxes(landmarks: Array<{ x: number; y: number }>, margin: number): EyeBox[] {
    const boxes: EyeBox[] = [];
    for (const eye of [LEFT_EYE, RIGHT_EYE]) {
        const corners = [landmarks[eye.outer], landmarks[eye.inner], landmarks[eye.top], landmarks[eye.bottom]];
        if (corners.some((point) => !point)) continue;
        const box = boxFromPoints(corners);
        const growX = box.width * margin;
        const growY = box.height * margin;
        boxes.push({ x: box.x - growX, y: box.y - growY, width: box.width + growX * 2, height: box.height + growY * 2 });
    }
    return boxes;
}

function faceBox(landmarks: Array<{ x: number; y: number }>, margin: number): EyeBox[] {
    const box = boxFromPoints(FACE_OUTLINE.map((index) => landmarks[index]).filter(Boolean));
    const growX = box.width * margin * 0.5;
    const growY = box.height * margin * 0.5;
    return [{ x: box.x - growX, y: box.y - growY, width: box.width + growX * 2, height: box.height + growY * 2 }];
}

/** 检测图片中每张人脸的干扰覆盖区域 (归一化坐标)。 */
export async function detectFaceBoxes(dataUrl: string, options: FaceGuardOptions = DEFAULT_FACE_GUARD_OPTIONS): Promise<EyeBox[]> {
    const [landmarker, image] = await Promise.all([getFaceLandmarker(), loadImage(dataUrl)]);
    const result: FaceLandmarkerResult = landmarker.detect(image);
    const boxes: EyeBox[] = [];
    for (const landmarks of result.faceLandmarks || []) {
        boxes.push(...(options.region === "face" ? faceBox(landmarks, options.margin) : eyeBoxes(landmarks, options.margin)));
    }
    return boxes;
}

function drawGrid(context: CanvasRenderingContext2D, box: EyeBox, cellPx: number, opacity: number) {
    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = "rgba(0, 195, 255, 0.9)";
    context.lineWidth = Math.max(1, cellPx / 12);
    context.beginPath();
    for (let x = box.x; x <= box.x + box.width + 0.5; x += cellPx) {
        context.moveTo(x, box.y);
        context.lineTo(x, box.y + box.height);
    }
    for (let y = box.y; y <= box.y + box.height + 0.5; y += cellPx) {
        context.moveTo(box.x, y);
        context.lineTo(box.x + box.width, y);
    }
    context.stroke();
    context.strokeStyle = "rgba(255, 0, 128, 0.9)";
    context.lineWidth = Math.max(1, cellPx / 16);
    context.strokeRect(box.x, box.y, box.width, box.height);
    context.restore();
}

function drawStripes(context: CanvasRenderingContext2D, box: EyeBox, cellPx: number, opacity: number) {
    context.save();
    context.globalAlpha = opacity;
    context.lineWidth = Math.max(2, cellPx / 3);
    context.strokeStyle = "rgba(0, 0, 0, 0.85)";
    context.beginPath();
    for (let y = box.y - box.height; y < box.y + box.height; y += cellPx * 2) {
        context.moveTo(box.x, y + box.height);
        context.lineTo(box.x + box.width, y);
    }
    context.stroke();
    context.restore();
}

function drawMosaic(context: CanvasRenderingContext2D, box: EyeBox, cellPx: number) {
    // 像素化: 先画到离屏小画布再放大回去, 块大小取 cellPx。
    const small = document.createElement("canvas");
    const cols = Math.max(2, Math.round(box.width / cellPx));
    const rows = Math.max(2, Math.round(box.height / cellPx));
    small.width = cols;
    small.height = rows;
    const smallContext = small.getContext("2d");
    if (!smallContext) return;
    smallContext.imageSmoothingEnabled = false;
    smallContext.drawImage(context.canvas, box.x, box.y, box.width, box.height, 0, 0, cols, rows);
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(small, 0, 0, cols, rows, box.x, box.y, box.width, box.height);
    context.restore();
}

/** 在图片的人脸区域叠加干扰效果 (网格/马赛克/斜条), 返回新的 dataUrl; 未检出人脸时返回 null。 */
export async function applyFaceGuard(dataUrl: string, options: FaceGuardOptions = DEFAULT_FACE_GUARD_OPTIONS): Promise<string | null> {
    const boxes = await detectFaceBoxes(dataUrl, options);
    if (!boxes.length) return null;
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D not available");
    context.drawImage(image, 0, 0);
    for (const normalized of boxes) {
        const box: EyeBox = {
            x: Math.max(0, Math.round(normalized.x * canvas.width)),
            y: Math.max(0, Math.round(normalized.y * canvas.height)),
            width: Math.round(normalized.width * canvas.width),
            height: Math.round(normalized.height * canvas.height),
        };
        if (box.width < 2 || box.height < 2) continue;
        const cellPx = Math.max(3, Math.round(Math.max(box.width, box.height) * options.cell));
        if (options.style === "mosaic") drawMosaic(context, box, cellPx);
        else if (options.style === "stripes") drawStripes(context, box, cellPx, options.opacity);
        else drawGrid(context, box, cellPx, options.opacity);
    }
    return canvas.toDataURL("image/png");
}

/** 渠道开启防人脸拦截时, 对参考图眼部叠加干扰; 仅替换请求副本, 不改动画布/资产库原图。单张处理失败时回退原图。 */
export async function guardReferenceImages(config: AiConfig, references: ReferenceImage[]): Promise<ReferenceImage[]> {
    if (!config.faceGuard || !references.length) return references;
    return Promise.all(
        references.map(async (image) => {
            try {
                const dataUrl = await imageToDataUrl(image);
                if (!dataUrl || !dataUrl.startsWith("data:")) return image;
                const guarded = await applyFaceGuard(dataUrl);
                return guarded ? { ...image, dataUrl: guarded, url: undefined, storageKey: undefined } : image;
            } catch {
                return image;
            }
        }),
    );
}
