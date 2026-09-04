import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Segmented, Slider } from "antd";
import { RotateCcw, ScanFace } from "lucide-react";
import { useTranslation } from "react-i18next";

import { applyFaceGuard, DEFAULT_FACE_GUARD_OPTIONS, type FaceGuardOptions, type FaceGuardStyle } from "@/lib/face-guard";

export type CanvasImageFaceGuardPayload = { dataUrl: string };

/** 手动防人脸编辑: 本地检测人脸并给眼部叠加网格/马赛克/斜条, 确认后生成处理图节点。 */
export function CanvasNodeFaceGuardDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageFaceGuardPayload) => void }) {
    const { t } = useTranslation();
    const [options, setOptions] = useState<FaceGuardOptions>(DEFAULT_FACE_GUARD_OPTIONS);
    const [result, setResult] = useState<string | null>(null);
    const [faceCount, setFaceCount] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setOptions(DEFAULT_FACE_GUARD_OPTIONS);
        setResult(null);
        setFaceCount(null);
        setError("");
    }, [dataUrl, open]);

    // 选项变化时重新合成预览 (纯本地 Canvas, 毫秒级; 加载人脸模型仅在首次)。
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setBusy(true);
        applyFaceGuard(dataUrl, options)
            .then((guarded) => {
                if (cancelled) return;
                setResult(guarded || dataUrl);
                setFaceCount((current) => (current === null ? (guarded ? 1 : 0) : current));
            })
            .catch((cause) => {
                if (!cancelled) setError(String((cause as Error)?.message || cause));
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [dataUrl, open, options]);

    const styleOptions = useMemo(
        () => (["grid", "mosaic", "stripes"] as FaceGuardStyle[]).map((value) => ({ label: t(`canvas.faceGuard.styles.${value}`), value })),
        [t],
    );
    const regionOptions = useMemo(() => (["eyes", "face"] as const).map((value) => ({ label: t(`canvas.faceGuard.regions.${value}`), value })), [t]);

    return (
        <Modal title={t("canvas.faceGuard.title")} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={880} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(320px,1fr)_300px]" data-canvas-no-zoom>
                <div className="flex h-[min(60vh,560px)] items-center justify-center overflow-hidden rounded-xl border border-black/10 bg-stone-100 dark:border-white/10 dark:bg-stone-900">
                    {result ? <img src={result} alt="" className="max-h-full max-w-full object-contain" draggable={false} /> : <span className="text-sm opacity-60">{t("canvas.faceGuard.detecting")}</span>}
                </div>

                <div className="flex min-h-[320px] flex-col gap-5">
                    <div>
                        <div className="text-sm opacity-60">{t("canvas.faceGuard.hint")}</div>
                        {faceCount === 0 && !busy ? <div className="mt-2 text-xs text-[#d97706]">{t("canvas.faceGuard.noFaces")}</div> : null}
                        {error ? <div className="mt-2 text-xs text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("canvas.faceGuard.style")}</div>
                        <Segmented className="w-full" size="small" value={options.style} options={styleOptions} onChange={(value) => setOptions((current) => ({ ...current, style: value as FaceGuardStyle }))} />
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("canvas.faceGuard.region")}</div>
                        <Segmented className="w-full" size="small" value={options.region} options={regionOptions} onChange={(value) => setOptions((current) => ({ ...current, region: value as FaceGuardOptions["region"] }))} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("canvas.faceGuard.density")}</span>
                            <span className="text-xs tabular-nums opacity-60">{Math.round(options.cell * 100)}</span>
                        </div>
                        <Slider min={5} max={40} step={1} value={Math.round(options.cell * 100)} onChange={(value) => setOptions((current) => ({ ...current, cell: value / 100 }))} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("canvas.faceGuard.opacity")}</span>
                            <span className="text-xs tabular-nums opacity-60">{Math.round(options.opacity * 100)}</span>
                        </div>
                        <Slider min={20} max={100} step={5} value={Math.round(options.opacity * 100)} onChange={(value) => setOptions((current) => ({ ...current, opacity: value / 100 }))} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("canvas.faceGuard.margin")}</span>
                            <span className="text-xs tabular-nums opacity-60">{Math.round(options.margin * 100)}</span>
                        </div>
                        <Slider min={0} max={100} step={5} value={Math.round(options.margin * 100)} onChange={(value) => setOptions((current) => ({ ...current, margin: value / 100 }))} />
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={() => setOptions(DEFAULT_FACE_GUARD_OPTIONS)}>
                            {t("canvas.editors.reset")}
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button onClick={onClose}>{t("canvas.editors.cancel")}</Button>
                            <Button type="primary" icon={<ScanFace className="size-4" />} loading={busy} disabled={!result} onClick={() => result && onConfirm({ dataUrl: result })}>
                                {t("canvas.faceGuard.apply")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
