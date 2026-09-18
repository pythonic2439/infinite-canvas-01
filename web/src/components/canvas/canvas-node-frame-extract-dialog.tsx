import { useEffect, useState } from "react";
import { Button, InputNumber, Modal } from "antd";
import { useTranslation } from "react-i18next";

export function CanvasNodeFrameExtractDialog({ open, onClose, onConfirm, extracting }: { open: boolean; onClose: () => void; onConfirm: (count: number) => void; extracting: boolean }) {
    const { t } = useTranslation();
    const [count, setCount] = useState(5);

    useEffect(() => {
        if (!open) return;
        setCount(5);
    }, [open]);

    const submit = () => {
        onConfirm(count);
    };

    return (
        <Modal
            title={t("canvas.videoFrames.extractTitle")}
            open={open}
            centered
            width={380}
            maskClosable={!extracting}
            keyboard={!extracting}
            onCancel={onClose}
            footer={
                <>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" loading={extracting} onClick={submit}>
                        {t("canvas.videoFrames.extractSubmit")}
                    </Button>
                </>
            }
        >
            <p className="text-sm opacity-60">{t("canvas.videoFrames.extractDescription")}</p>
            <div className="mt-4 flex items-center gap-3">
                <span className="text-sm">{t("canvas.videoFrames.extractCount")}</span>
                <InputNumber min={2} max={24} precision={0} value={count} onChange={(value) => setCount(Number(value || 5))} style={{ width: 96 }} />
                <span className="text-xs opacity-55">{t("canvas.videoFrames.extractRange")}</span>
            </div>
        </Modal>
    );
}
