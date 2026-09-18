import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { useTranslation } from "react-i18next";
import axios from "axios";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";
import { sendTestMail as sendTestMailApi } from "@/services/api/auth";
import { splitChannelKeys } from "@/services/api/key-pool";
import { ApiKeyListEditor } from "@/components/layout/api-key-list-editor";

/**
 * 管理后台: 用户与点数 / 渠道与模型点数 / 站点设置 (SMTP 等) / 统计。
 * 仅 is_admin 用户可用 (服务端二次校验)。
 */

type AdminUser = { id: number; email: string; points: number; isAdmin: boolean; status: string; createdAt: number; lastLoginAt: number; generations: number };
type AdminModel = { name: string; capability: string; script: string | null; params: string | null; points: number; enabled: boolean };
type AdminChannel = { id: string; name: string; baseUrl: string; apiKey: string; apiFormat: string; defaultPoints: number; enabled: boolean; models: AdminModel[] };
type AdminStats = { users: number; newToday: number; consumedToday: number; consumedTotal: number; byModel: Array<{ model: string; times: number; points: number }>; perDay: Array<{ day: string; points: number }> };

const client = axios.create({ timeout: 30000 });

function messageOf(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { msg?: string } | undefined;
        return data?.msg || error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

async function adminGet<T>(path: string): Promise<T> {
    const response = await client.get<{ ok: boolean } & T>(`/api/admin/${path}`);
    return response.data as T & { ok: boolean };
}

async function adminPost(path: string, body: unknown): Promise<void> {
    await client.post(`/api/admin/${path}`, body);
}

export default function AdminPage() {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const user = useAuthStore((state) => state.user);
    const authStatus = useAuthStore((state) => state.status);

    if (authStatus === "loading") {
        return <div className="flex min-h-screen items-center justify-center text-sm text-stone-500">{t("admin.loading")}</div>;
    }
    if (!user?.isAdmin) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-stone-500">
                <p>{t("admin.forbidden")}</p>
                <Link to="/" className="text-stone-900 underline dark:text-stone-100">{t("admin.backHome")}</Link>
            </div>
        );
    }
    return (
        <div className="min-h-screen bg-stone-50 dark:bg-stone-950">
            <div className="mx-auto max-w-6xl px-6 py-8">
                <div className="mb-6 flex items-center justify-between">
                    <h1 className="text-xl font-semibold">{t("admin.title")}</h1>
                    <Link to="/" className="inline-flex items-center gap-1 text-sm text-stone-500 transition hover:text-stone-900 dark:hover:text-stone-100">
                        <ArrowLeft className="size-4" />
                        {t("admin.backHome")}
                    </Link>
                </div>
                <Tabs
                    items={[
                        { key: "stats", label: t("admin.tabStats"), children: <StatsTab /> },
                        { key: "users", label: t("admin.tabUsers"), children: <UsersTab /> },
                        { key: "channels", label: t("admin.tabChannels"), children: <ChannelsTab /> },
                        { key: "settings", label: t("admin.tabSettings"), children: <SettingsTab /> },
                    ]}
                />
            </div>
        </div>
    );
}

function StatsTab() {
    const { t } = useTranslation();
    const [stats, setStats] = useState<AdminStats | null>(null);
    useEffect(() => {
        void adminGet<AdminStats>("stats").then((data) => setStats(data)).catch(() => undefined);
    }, []);
    if (!stats) return <p className="text-sm text-stone-500">…</p>;
    const cards = [
        { label: t("admin.statUsers"), value: stats.users },
        { label: t("admin.statNewToday"), value: stats.newToday },
        { label: t("admin.statConsumedToday"), value: stats.consumedToday },
        { label: t("admin.statConsumedTotal"), value: stats.consumedTotal },
    ];
    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {cards.map((card) => (
                    <Card key={card.label} size="small">
                        <p className="text-xs text-stone-500">{card.label}</p>
                        <p className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</p>
                    </Card>
                ))}
            </div>
            <Card size="small" title={t("admin.byModel")}>
                <Table
                    size="small"
                    rowKey="model"
                    pagination={false}
                    dataSource={stats.byModel}
                    columns={[
                        { title: t("admin.modelName"), dataIndex: "model" },
                        { title: t("admin.modelTimes"), dataIndex: "times", width: 120 },
                        { title: t("admin.modelPoints"), dataIndex: "points", width: 120 },
                    ]}
                />
            </Card>
        </div>
    );
}

function UsersTab() {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [editing, setEditing] = useState<AdminUser | null>(null);
    const [pointsDelta, setPointsDelta] = useState<number>(0);
    const [newPassword, setNewPassword] = useState("");

    const reload = () => void adminGet<{ users: AdminUser[] }>("users").then((data) => setUsers(data.users)).catch((error) => message.error(messageOf(error, "load failed")));
    useEffect(reload, [message]);

    const applyUpdate = async (target: AdminUser, body: Record<string, unknown>) => {
        try {
            await adminPost(`users/${target.id}`, body);
            message.success(t("admin.saved"));
            setEditing(null);
            setPointsDelta(0);
            setNewPassword("");
            reload();
        } catch (error) {
            message.error(messageOf(error, "save failed"));
        }
    };

    return (
        <Card size="small">
            <Table
                size="small"
                rowKey="id"
                dataSource={users}
                pagination={{ pageSize: 20 }}
                columns={[
                    { title: "ID", dataIndex: "id", width: 70 },
                    { title: t("admin.email"), dataIndex: "email" },
                    {
                        title: t("admin.points"),
                        dataIndex: "points",
                        width: 110,
                        render: (value: number) => <span className="tabular-nums font-medium">{value}</span>,
                    },
                    { title: t("admin.generations"), dataIndex: "generations", width: 110 },
                    {
                        title: t("admin.status"),
                        dataIndex: "status",
                        width: 100,
                        render: (value: string) => (value === "active" ? <Tag color="green">{t("admin.active")}</Tag> : <Tag color="red">{t("admin.disabled")}</Tag>),
                    },
                    {
                        title: "",
                        width: 90,
                        render: (_: unknown, record: AdminUser) => (
                            <Button size="small" onClick={() => setEditing(record)}>
                                {t("admin.manage")}
                            </Button>
                        ),
                    },
                ]}
            />
            <Modal title={editing?.email} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden>
                {editing ? (
                    <div className="space-y-4 pt-2">
                        <div>
                            <p className="mb-1.5 text-sm font-medium">{t("admin.adjustPoints")}</p>
                            <Space.Compact className="w-full">
                                <InputNumber className="w-full" value={pointsDelta} onChange={(value) => setPointsDelta(Number(value) || 0)} />
                                <Button disabled={!pointsDelta} onClick={() => void applyUpdate(editing, { pointsDelta })}>
                                    {t("admin.apply")}
                                </Button>
                            </Space.Compact>
                        </div>
                        <div>
                            <p className="mb-1.5 text-sm font-medium">{t("admin.resetPassword")}</p>
                            <Space.Compact className="w-full">
                                <Input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="≥ 8" />
                                <Button disabled={newPassword.length < 8} onClick={() => void applyUpdate(editing, { resetPassword: newPassword })}>
                                    {t("admin.apply")}
                                </Button>
                            </Space.Compact>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm">{t("admin.enableAccount")}</span>
                            <Switch checked={editing.status === "active"} onChange={(checked) => void applyUpdate(editing, { status: checked ? "active" : "disabled" })} />
                        </div>
                    </div>
                ) : null}
            </Modal>
        </Card>
    );
}

const API_FORMAT_OPTIONS = ["openai", "gemini", "ark", "autodl", "duomi", "mingze", "doubao", "agnes", "dola"].map((value) => ({ value, label: value }));

function maskKey(key: string) {
    if (!key) return "—";
    // 渠道支持逗号/换行分隔的多 Key 轮询, 逐个打码展示
    return splitChannelKeys(key)
        .map((part) => (part.length <= 10 ? `${part.slice(0, 2)}****` : `${part.slice(0, 6)}****${part.slice(-4)}`))
        .join(", ");
}

function ChannelsTab() {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const [channels, setChannels] = useState<AdminChannel[]>([]);
    const [editing, setEditing] = useState<AdminChannel | null>(null);
    const [drafts, setDrafts] = useState<AdminModel[]>([]);
    // 渠道设置: null=关闭, {id: null}=新增, {id: string}=编辑
    const [settingsChannel, setSettingsChannel] = useState<{ id: string | null } | null>(null);
    const [settingsForm] = Form.useForm();
    const [savingSettings, setSavingSettings] = useState(false);

    const reload = () => void adminGet<{ channels: AdminChannel[] }>("channels").then((data) => setChannels(data.channels)).catch((error) => message.error(messageOf(error, "load failed")));
    useEffect(reload, [message]);

    const openEditor = (channel: AdminChannel) => {
        setEditing(channel);
        setDrafts(channel.models.map((model) => ({ ...model })));
    };

    const saveModels = async () => {
        if (!editing) return;
        try {
            await adminPost(`channels/${encodeURIComponent(editing.id)}/models`, { models: drafts });
            message.success(t("admin.saved"));
            setEditing(null);
            reload();
        } catch (error) {
            message.error(messageOf(error, "save failed"));
        }
    };

    const toggleChannel = async (channel: AdminChannel, enabled: boolean) => {
        try {
            await adminPost(`channels/${encodeURIComponent(channel.id)}`, { enabled });
            reload();
        } catch (error) {
            message.error(messageOf(error, "save failed"));
        }
    };

    const openSettings = (channel: AdminChannel | null) => {
        setSettingsChannel({ id: channel?.id ?? null });
        settingsForm.setFieldsValue(
            // Key 列表 WYSIWYG: 编辑时直接展示真实 Key (admin 接口才下发), 增删行保存后生效
            channel
                ? { name: channel.name, baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, defaultPoints: channel.defaultPoints, enabled: channel.enabled }
                : { name: "", baseUrl: "", apiKey: "", apiFormat: "openai", defaultPoints: 0, enabled: true },
        );
    };

    const saveSettings = async () => {
        try {
            const values = await settingsForm.validateFields();
            if (!settingsChannel) return;
            const body: Record<string, unknown> = {
                id: settingsChannel.id ?? (values.id || "").trim(),
                name: values.name,
                baseUrl: values.baseUrl,
                apiFormat: values.apiFormat,
                defaultPoints: values.defaultPoints ?? 0,
                enabled: Boolean(values.enabled),
            };
            if (!body.id) {
                message.error(t("admin.channelIdRequired"));
                return;
            }
            // Key 列表始终提交规范化后的串 (空 = 清空全部 Key, 前端禁止以免渠道不可用)
            const keys = splitChannelKeys(String(values.apiKey ?? ""));
            if (!keys.length) {
                message.error(t("admin.channelKeyRequired"));
                return;
            }
            body.apiKey = keys.join(",");
            setSavingSettings(true);
            await adminPost("channels", body);
            message.success(t("admin.saved"));
            setSettingsChannel(null);
            reload();
        } catch (error) {
            if (error && typeof error === "object" && "errorFields" in error) return; // 表单校验错误
            message.error(messageOf(error, "save failed"));
        } finally {
            setSavingSettings(false);
        }
    };

    const deleteChannel = async (channel: AdminChannel) => {
        try {
            await adminPost(`channels/${encodeURIComponent(channel.id)}`, { delete: true });
            message.success(t("admin.channelDeleted"));
            reload();
        } catch (error) {
            message.error(messageOf(error, "save failed"));
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button type="primary" onClick={() => openSettings(null)}>
                    {t("admin.addChannel")}
                </Button>
            </div>
            {channels.map((channel) => (
                <Card
                    key={channel.id}
                    size="small"
                    // 标题/操作区都允许换行: 小屏下 baseUrl、Key、按钮不再被裁掉或需要拖拽才能看到
                    styles={{ header: { flexWrap: "wrap", rowGap: 8, height: "auto", minHeight: 48 } }}
                    title={
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            {channel.name}
                            <Tag className="mr-0">{channel.apiFormat}</Tag>
                            <span className="text-xs font-normal text-stone-400">{channel.models.length} 模型</span>
                            <span className="min-w-0 break-all font-mono text-xs font-normal text-stone-400" title={channel.baseUrl}>
                                {channel.baseUrl}
                            </span>
                            <span className="min-w-0 break-all font-mono text-xs font-normal text-stone-400">Key: {maskKey(channel.apiKey)}</span>
                            {!channel.enabled ? <Tag color="red">{t("admin.channelDisabled")}</Tag> : null}
                        </span>
                    }
                    extra={
                        <Space wrap size={4}>
                            <Switch size="small" checked={channel.enabled} checkedChildren={t("admin.enabledShort")} unCheckedChildren={t("admin.disabledShort")} onChange={(checked) => void toggleChannel(channel, checked)} />
                            <Button size="small" onClick={() => openSettings(channel)}>
                                {t("admin.channelSettings")}
                            </Button>
                            <Button size="small" onClick={() => openEditor(channel)}>
                                {t("admin.editPoints")}
                            </Button>
                            <Popconfirm title={t("admin.deleteChannelConfirm")} onConfirm={() => void deleteChannel(channel)} okButtonProps={{ danger: true }}>
                                <Button size="small" danger>
                                    {t("admin.delete")}
                                </Button>
                            </Popconfirm>
                        </Space>
                    }
                >
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
                        {channel.models.map((model) => (
                            <div key={model.name} className="flex items-center justify-between gap-2 border-b border-dashed border-stone-100 py-1 dark:border-stone-800">
                                <span className="min-w-0 break-all" title={model.name}>
                                    {model.enabled ? "" : "🚫 "}
                                    {model.name}
                                    <span className="ml-1 text-stone-400">{model.capability}</span>
                                </span>
                                <span className="shrink-0 tabular-nums text-stone-500">{model.points} 点</span>
                            </div>
                        ))}
                    </div>
                </Card>
            ))}
            <Modal
                title={editing?.name}
                open={Boolean(editing)}
                onCancel={() => setEditing(null)}
                onOk={() => void saveModels()}
                okText={t("admin.save")}
                width={560}
            >
                <div className="max-h-[60vh] space-y-2 overflow-y-auto py-2">
                    <div className="rounded-md bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-500 dark:bg-stone-900/60">{t("admin.modelsModalHint")}</div>
                    {drafts.map((model, index) => (
                        <div key={model.name} className="flex items-center gap-3 text-sm">
                            <span className="w-10 shrink-0 text-xs text-stone-400">{model.capability}</span>
                            <span className={`min-w-0 flex-1 truncate ${model.enabled ? "" : "text-stone-400 line-through"}`} title={model.name}>
                                {model.name}
                            </span>
                            {/* 模型级启停: 关闭后目录不下发, 网关也直接拒绝 (停用即不可调用/不计费) */}
                            <Switch
                                size="small"
                                checked={model.enabled}
                                checkedChildren={t("admin.enabledShort")}
                                unCheckedChildren={t("admin.disabledShort")}
                                onChange={(checked) => setDrafts((current) => current.map((item, i) => (i === index ? { ...item, enabled: checked } : item)))}
                            />
                            <InputNumber
                                size="small"
                                min={0}
                                value={model.points}
                                onChange={(value) => setDrafts((current) => current.map((item, i) => (i === index ? { ...item, points: Math.max(0, Number(value) || 0) } : item)))}
                                addonAfter={t("admin.pointsUnit")}
                            />
                        </div>
                    ))}
                </div>
            </Modal>
            <Modal
                title={settingsChannel?.id ? t("admin.channelSettings") : t("admin.addChannel")}
                open={Boolean(settingsChannel)}
                onCancel={() => setSettingsChannel(null)}
                onOk={() => void saveSettings()}
                confirmLoading={savingSettings}
                okText={t("admin.save")}
                width={520}
                centered
            >
                <div className="max-h-[62vh] overflow-y-auto">
                    <Form form={settingsForm} layout="vertical" className="pt-2" requiredMark={false}>
                    {settingsChannel?.id ? (
                        <Form.Item label="ID">
                            <Input value={settingsChannel.id} disabled className="font-mono text-xs" />
                        </Form.Item>
                    ) : (
                        <Form.Item name="id" label="ID" rules={[{ required: true, message: t("admin.channelIdRequired") }]} extra={t("admin.channelIdHint")}>
                            <Input placeholder="my-channel" className="font-mono" />
                        </Form.Item>
                    )}
                    <div className="grid grid-cols-2 gap-x-4">
                        <Form.Item name="name" label={t("admin.channelName")} rules={[{ required: true, message: t("admin.channelNameRequired") }]}>
                            <Input placeholder="01即梦" />
                        </Form.Item>
                        <Form.Item name="apiFormat" label={t("admin.channelApiFormat")} rules={[{ required: true }]}>
                            <Select options={API_FORMAT_OPTIONS} />
                        </Form.Item>
                    </div>
                    <Form.Item name="baseUrl" label={t("admin.channelBaseUrl")} rules={[{ required: true, pattern: /^https?:\/\//i, message: t("admin.channelBaseUrlInvalid") }]} extra={t("admin.channelBaseUrlHint")}>
                        <Input placeholder="https://api.example.com" className="font-mono text-xs" />
                    </Form.Item>
                    <Form.Item name="apiKey" label={t("admin.channelApiKey")} extra={settingsChannel?.id ? t("admin.channelApiKeyHintEdit") : t("admin.channelApiKeyHintNew")}>
                        <ApiKeyListEditor />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-x-4">
                        <Form.Item name="defaultPoints" label={t("admin.channelDefaultPoints")}>
                            <InputNumber min={0} className="w-full" />
                        </Form.Item>
                        <Form.Item name="enabled" label={t("admin.channelEnabled")} valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    </div>
                    </Form>
                </div>
            </Modal>
        </div>
    );
}

function SettingsTab() {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const [form] = Form.useForm();
    const [saving, setSaving] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [testing, setTesting] = useState(false);

    const sendTestMail = async () => {
        setTesting(true);
        try {
            const to = await sendTestMailApi();
            message.success(t("admin.testMailSent", { to }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.testMailFailed"));
        } finally {
            setTesting(false);
        }
    };

    useEffect(() => {
        void adminGet<{ settings: Record<string, string | boolean> }>("settings")
            .then((data) => {
                form.setFieldsValue(data.settings);
                setLoaded(true);
            })
            .catch((error) => message.error(messageOf(error, "load failed")));
    }, [form, message]);

    const save = async (values: Record<string, unknown>) => {
        setSaving(true);
        try {
            await adminPost("settings", values);
            message.success(t("admin.saved"));
        } catch (error) {
            message.error(messageOf(error, "save failed"));
        } finally {
            setSaving(false);
        }
    };

    if (!loaded) return <p className="text-sm text-stone-500">…</p>;
    return (
        <Card size="small" className="max-w-2xl">
            <Form form={form} layout="vertical" onFinish={save} initialValues={{ signup_enabled: "1", gift_points: "100", smtp_secure: "ssl" }}>
                <div className="grid grid-cols-1 gap-x-6 md:grid-cols-3">
                    <Form.Item name="signup_enabled" label={t("admin.signupEnabled")} valuePropName="value" getValueFromEvent={(checked: boolean) => (checked ? "1" : "0")} getValueProps={(value) => ({ value: value === "1" })}>
                        <Switch />
                    </Form.Item>
                    <Form.Item name="gift_points" label={t("admin.giftPoints")}>
                        <InputNumber min={0} className="w-full" />
                    </Form.Item>
                    <Form.Item name="checkin_points" label={t("admin.checkinPoints")} extra={t("admin.checkinPointsHint")}>
                        <InputNumber min={0} className="w-full" />
                    </Form.Item>
                </div>
                <p className="mb-3 mt-1 border-t border-stone-100 pt-4 text-sm font-medium dark:border-stone-800">{t("admin.sectionOperation")}</p>
                <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
                    <Form.Item name="gen_per_minute" label={t("admin.genPerMinute")}>
                        <InputNumber min={1} className="w-full" />
                    </Form.Item>
                    <Form.Item name="gen_per_day" label={t("admin.genPerDay")}>
                        <InputNumber min={1} className="w-full" />
                    </Form.Item>
                    <Form.Item name="notice" label={t("admin.notice")} className="md:col-span-2">
                        <Input.TextArea rows={2} placeholder={t("admin.noticeHint")} />
                    </Form.Item>
                    <Form.Item name="support_contact" label={t("admin.supportContact")} extra={t("admin.supportContactHint")} className="md:col-span-2">
                        <Input.TextArea rows={2} placeholder={t("admin.supportContactPlaceholder")} />
                    </Form.Item>
                </div>
                <div className="mb-4 grid grid-cols-1 gap-x-6 md:grid-cols-2">
                    <Form.Item name="alert_email" label={t("admin.alertEmail")} extra={t("admin.alertEmailHint")}>
                        <Input placeholder={t("admin.alertEmailPlaceholder")} />
                    </Form.Item>
                </div>
                <p className="mb-3 mt-1 border-t border-stone-100 pt-4 text-sm font-medium dark:border-stone-800">SMTP</p>
                <div className="mb-4">
                    <Button onClick={() => void sendTestMail()} loading={testing}>
                        {t("admin.sendTestMail")}
                    </Button>
                    <span className="ml-3 text-xs text-stone-400">{t("admin.sendTestMailHint")}</span>
                </div>
                <div className="grid grid-cols-1 gap-x-6 md:grid-cols-3">
                    <Form.Item name="smtp_host" label="SMTP Host">
                        <Input placeholder="smtp.example.com" />
                    </Form.Item>
                    <Form.Item name="smtp_port" label="Port">
                        <InputNumber className="w-full" min={1} max={65535} />
                    </Form.Item>
                    <Form.Item name="smtp_secure" label={t("admin.smtpSecure")}>
                        <Select
                            options={[
                                { value: "ssl", label: "SSL (465)" },
                                { value: "tls", label: "STARTTLS (587)" },
                                { value: "none", label: "None" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="smtp_username" label={t("admin.smtpUsername")}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="smtp_password" label={t("admin.smtpPassword")} extra={t("admin.smtpPasswordHint")}>
                        <Input.Password placeholder="••••••" />
                    </Form.Item>
                    <Form.Item name="smtp_from" label={t("admin.smtpFrom")}>
                        <Input placeholder="noreply@example.com" />
                    </Form.Item>
                </div>
                <Button type="primary" htmlType="submit" loading={saving}>
                    {t("admin.save")}
                </Button>
            </Form>
        </Card>
    );
}
