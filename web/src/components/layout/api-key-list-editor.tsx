import { Button, Input } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { splitChannelKeys } from "@/services/api/key-pool";

// Key 列表编辑：每条 Key 独占一行便于追加/删除；存储仍为逗号分隔字符串，前端 key-pool 与服务端网关按同一分隔规则拆分轮询。
// (渠道编辑抽屉 / 管理后台共用；props 可选以兼容 antd Form.Item 注入 value/onChange 的子组件契约)
export function ApiKeyListEditor({ value = "", onChange }: { value?: string; onChange?: (value: string) => void }) {
    const { t } = useTranslation();
    const [rows, setRows] = useState<string[]>(() => splitChannelKeys(value));
    // 记录本地最后一次提交的串：自己 onChange 产生的 value 不回填（保留正在输入的行/逗号），仅外部改写时重建行。
    const lastSynced = useRef(value);
    useEffect(() => {
        if (value === lastSynced.current) return;
        lastSynced.current = value;
        setRows(splitChannelKeys(value));
    }, [value]);
    const update = (next: string[]) => {
        const joined = next.map((row) => row.trim()).filter(Boolean).join(",");
        lastSynced.current = joined;
        setRows(next.length ? next : [""]);
        onChange?.(joined);
    };
    return (
        <div className="grid gap-2">
            {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-stone-500">{t("common.apiKeyItem", { index: index + 1 })}</span>
                    <Input.Password
                        value={row}
                        autoComplete="off"
                        placeholder="sk-..."
                        onChange={(event) => update(rows.map((item, i) => (i === index ? event.target.value : item)))}
                        onPaste={(event) => {
                            // 粘贴逗号/换行分隔的多个 Key 时自动拆成多行。
                            const parts = splitChannelKeys(event.clipboardData.getData("text"));
                            if (parts.length > 1) {
                                event.preventDefault();
                                update([...rows.slice(0, index), ...parts, ...rows.slice(index + 1)]);
                            }
                        }}
                    />
                    <Button type="text" danger icon={<Trash2 className="size-3.5" />} disabled={rows.length <= 1 && !row.trim()} onClick={() => update(rows.filter((_, i) => i !== index))} />
                </div>
            ))}
            <div className="flex items-center justify-between gap-3">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => update([...rows, ""])}>
                    {t("common.apiKeyAdd")}
                </Button>
                <span className="text-right text-xs leading-5 text-stone-500">{t("common.apiKeyHint", { count: rows.filter((row) => row.trim()).length })}</span>
            </div>
        </div>
    );
}
