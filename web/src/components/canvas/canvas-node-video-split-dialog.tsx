import { useEffect, useState } from "react";
import { Button, Input, Modal, Tag } from "antd";
import { useTranslation } from "react-i18next";

function parseCuts(input: string): number[] {
    return input
        .split(/[,，\s]+/)
        .map((part) => {
            if (/^\d+:\d+(\.\d+)?$/.test(part)) {
                const [minutes, seconds] = part.split(":");
                return Number(minutes) * 60 + Number(seconds);
            }
            return Number(part);
        })
        .filter((value) => Number.isFinite(value) && value > 0);
}

export function CanvasNodeVideoSplitDialog({ open, onClose, onConfirm, splitting, durationSec, defaultCut }: { open: boolean; onClose: () => void; onConfirm: (cuts: number[]) => void; splitting: boolean; durationSec: number; defaultCut: number }) {
    const { t } = useTranslation();
    const [input, setInput] = useState("");
    const [cuts, setCuts] = useState<number[]>([]);

    useEffect(() => {
        if (!open) return;
        const initial = defaultCut > 0.05 ? [defaultCut] : [];
        setInput(initial.map((value) => value.toFixed(2)).join(", "));
        setCuts(initial);
    }, [open, defaultCut]);

    const submit = () => {
        if (cuts.length) onConfirm(cuts);
    };

    return (
        <Modal
            title={t("canvas.videoFrames.splitTitle")}
            open={open}
            centered
            width={440}
            maskClosable={!splitting}
            keyboard={!splitting}
            onCancel={onClose}
            footer={
                <>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" loading={splitting} disabled={!cuts.length} onClick={submit}>
                        {t("canvas.videoFrames.splitSubmit")}
                    </Button>
                </>
            }
        >
            <p className="text-sm opacity-60">{t("canvas.videoFrames.splitDescription", { duration: durationSec.toFixed(2) })}</p>
            <Input
                className="mt-4"
                value={input}
                disabled={splitting}
                placeholder={t("canvas.videoFrames.splitPlaceholder")}
                onChange={(event) => {
                    const next = event.target.value;
                    setInput(next);
                    setCuts(parseCuts(next));
                }}
                onPressEnter={submit}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs opacity-60">
                <span>{t("canvas.videoFrames.splitHint")}</span>
                {cuts.length ? <Tag color="blue">{t("canvas.videoFrames.splitSegments", { count: cuts.length + 1 })}</Tag> : null}
            </div>
        </Modal>
    );
}
