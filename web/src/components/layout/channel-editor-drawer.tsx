import { Button, Drawer, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Tooltip } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

// JSON body presets for AutoDL ComfyUI workflows; {{...}} placeholders are filled at request time.
const AUTO_DL_PARAM_PRESETS: Array<{ key: "t2v" | "flf" | "images" | "audio"; template: string }> = [
    { key: "t2v", template: `{\n  "prompt": "{{prompt}}",\n  "duration": "{{duration}}",\n  "resolution": "{{resolution}}"\n}` },
    { key: "flf", template: `{\n  "prompt": "{{prompt}}",\n  "duration": "{{duration}}",\n  "resolution": "{{resolution}}",\n  "first_frame": "{{images.0}}",\n  "last_frame": "{{images.1}}"\n}` },
    {
        key: "images",
        template: `{\n  "prompt": "{{prompt}}",\n  "duration": "{{duration}}",\n  "resolution": "{{resolution}}",\n  "ref_image_0": "{{images.0}}",\n  "ref_image_1": "{{images.1}}",\n  "ref_image_2": "{{images.2}}",\n  "ref_image_3": "{{images.3}}"\n}`,
    },
    {
        key: "audio",
        template: `{\n  "prompt": "{{prompt}}",\n  "duration": "{{duration}}",\n  "resolution": "{{resolution}}",\n  "ref_image_0": "{{images.0}}",\n  "ref_image_1": "{{images.1}}",\n  "ref_audio_0": "{{audios.0}}",\n  "ref_audio_1": "{{audios.1}}"\n}`,
    },
];

function ParamsTemplateEditor({ value, onSave, onCancel }: { value: string; onSave: (value: string) => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(value);
    const [preset, setPreset] = useState<string>();
    const placeholders = ["{{prompt}}", "{{duration}}", "{{resolution}}", "{{images}}", "{{audios}}", "{{images.0}}"].join("  ");
    return (
        <div className="grid gap-3">
            <Select
                className="w-full"
                placeholder={t("config.channelEditor.paramsPresetPlaceholder")}
                value={preset}
                onChange={(key) => {
                    const match = AUTO_DL_PARAM_PRESETS.find((item) => item.key === key);
                    if (match) {
                        setPreset(key);
                        setDraft(match.template);
                    }
                }}
                options={AUTO_DL_PARAM_PRESETS.map((item) => ({ label: t(`config.channelEditor.paramPresets.${item.key}`), value: item.key }))}
            />
            <Input.TextArea rows={9} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholders} />
            <div className="text-xs leading-5 text-stone-500">{t("config.channelEditor.paramsHint", { placeholders })}</div>
            <Space className="justify-end">
                <Button onClick={onCancel}>{t("common.cancel")}</Button>
                <Button type="primary" onClick={() => onSave(draft.trim())}>
                    {t("common.save")}
                </Button>
            </Space>
        </div>
    );
}

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [paramsTarget, setParamsTarget] = useState<ScriptTarget | null>(null);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: t("config.protocols.ark"), value: "ark" },
        { label: t("config.protocols.autodl"), value: "autodl" },
        { label: t("config.protocols.duomi"), value: "duomi" },
        { label: t("config.protocols.dola"), value: "dola" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const setParams = (name: string, params: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, params: params || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
                <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 md:col-span-2 dark:border-stone-800">
                    <div className="min-w-0 pr-3">
                        <div className="text-sm font-medium">{t("config.channelEditor.faceGuard")}</div>
                        <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.faceGuardDescription")}</div>
                    </div>
                    <Tooltip title={t("config.channelEditor.faceGuardTooltip")}>
                        <Switch checked={Boolean(draft.faceGuard)} onChange={(checked) => patch({ faceGuard: checked || undefined })} />
                    </Tooltip>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 md:col-span-2 dark:border-stone-800">
                    <div className="min-w-0 pr-3">
                        <div className="text-sm font-medium">{t("config.channelEditor.retryLimit")}</div>
                        <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.retryLimitDescription")}</div>
                    </div>
                    <InputNumber size="small" min={0} max={5} step={1} precision={0} value={draft.retryLimit ?? 0} onChange={(value) => patch({ retryLimit: Number(value) > 0 ? Number(value) : undefined })} />
                </div>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    {t("config.channelEditor.selectModels")}
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                {draft.apiFormat === "autodl" && (
                                    <Button size="small" type={model.params ? "primary" : "default"} ghost={Boolean(model.params)} onClick={() => setParamsTarget({ name: model.name, capability: model.capability, value: model.params || "" })}>
                                        {t(model.params ? "config.channelEditor.paramsReady" : "config.channelEditor.params")}
                                    </Button>
                                )}
                                <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                    {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />

            <Modal open={Boolean(paramsTarget)} title={t("config.channelEditor.paramsTitle", { name: paramsTarget?.name || "" })} width={620} footer={null} onCancel={() => setParamsTarget(null)}>
                <ParamsTemplateEditor
                    key={paramsTarget?.name || ""}
                    value={paramsTarget?.value || ""}
                    onSave={(params) => {
                        if (paramsTarget) setParams(paramsTarget.name, params);
                        setParamsTarget(null);
                    }}
                    onCancel={() => setParamsTarget(null)}
                />
            </Modal>
        </Drawer>
    );
}
