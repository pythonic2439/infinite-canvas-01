import { useEffect, useState } from "react";
import { Button, Dropdown, Form, Input, Modal, Spin, Tabs, Tooltip, App as AntApp } from "antd";
import { CalendarCheck, Coins, Headset, LogOut, RefreshCw, CloudUpload, ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";
import { syncAppDataToServer } from "@/services/app-sync";
import { fetchSiteInfo } from "@/services/api/site";
import { cn } from "@/lib/utils";

/**
 * 顶栏用户区: 未登录显示「登录」入口; 已登录显示点数与账号菜单。
 * 包含登录/注册 (邮箱验证码) 对话框。
 */

// 顶栏快捷签到按钮: 未签到带红点提醒, 已签到置灰; 与账号菜单里的签到项同一套 store 逻辑。
export function AuthCheckinButton({ iconClassName }: { iconClassName?: string }) {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const status = useAuthStore((state) => state.status);
    const user = useAuthStore((state) => state.user);
    const checkin = useAuthStore((state) => state.checkin);
    const doCheckin = useAuthStore((state) => state.doCheckin);
    const [checkingIn, setCheckingIn] = useState(false);
    if (status !== "authenticated" || !user) return null;
    const runCheckin = async () => {
        if (checkingIn || checkin?.done) return;
        setCheckingIn(true);
        try {
            const reward = await doCheckin();
            message.success(t("auth.checkinDone", { count: reward }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.checkinFailed"));
        } finally {
            setCheckingIn(false);
        }
    };
    const label = checkin?.done ? t("auth.checkinDoneToday") : t("auth.checkinAction", { count: checkin?.points ?? 0 });
    return (
        <Tooltip
            title={
                <div className="max-w-56 text-left">
                    <div className="text-xs font-medium">{label}</div>
                    <div className="mt-0.5 text-xs opacity-70">{t("topNav.checkinDesc")}</div>
                </div>
            }
            mouseEnterDelay={0.2}
        >
            {/* span 包裹: disabled 按钮不触发鼠标事件, 悬停提示挂在外层 */}
            <span className="relative inline-flex">
                <button
                    type="button"
                    className={cn("relative", iconClassName)}
                    aria-label={label}
                    disabled={Boolean(checkin?.done) || checkingIn}
                    onClick={() => void runCheckin()}
                >
                    {checkingIn ? <Spin size="small" /> : <CalendarCheck className="size-4" />}
                    {!checkin?.done && !checkingIn ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500" /> : null}
                </button>
            </span>
        </Tooltip>
    );
}

export function AuthMenu({ iconClassName }: { iconClassName?: string }) {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const navigate = useNavigate();
    const status = useAuthStore((state) => state.status);
    const user = useAuthStore((state) => state.user);
    const checkin = useAuthStore((state) => state.checkin);
    const logout = useAuthStore((state) => state.logout);
    const refreshCatalog = useAuthStore((state) => state.refreshCatalog);
    const doCheckin = useAuthStore((state) => state.doCheckin);
    // 登录弹窗开合走全局 store: 生成类操作被 requireLogin 拦截时也会弹出
    const authOpen = useAuthStore((state) => state.loginModalOpen);
    const setAuthOpen = useAuthStore((state) => state.setLoginModalOpen);
    const [syncing, setSyncing] = useState(false);
    const [checkingIn, setCheckingIn] = useState(false);
    const [supportOpen, setSupportOpen] = useState(false);
    const [supportContact, setSupportContact] = useState("");
    const [welcomeOpen, setWelcomeOpen] = useState(false);
    const [welcomePoints, setWelcomePoints] = useState(0);

    useEffect(() => {
        void fetchSiteInfo()
            .then((info) => setSupportContact(info.supportContact.trim()))
            .catch(() => undefined);
    }, []);

    const isImageUrl = (value: string) => /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(value.trim());

    const runCheckin = async () => {
        if (checkingIn) return;
        setCheckingIn(true);
        try {
            const reward = await doCheckin();
            message.success(t("auth.checkinDone", { count: reward }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.checkinFailed"));
        } finally {
            setCheckingIn(false);
        }
    };

    // 登录/注册成功后静默做一次全量云同步, 新设备也能立刻看到全部数据
    const initialSync = () => {
        void syncAppDataToServer().catch((error) => console.warn("[cloud-sync] initial sync failed:", error));
    };

    const runCloudSync = async (silent = false) => {
        if (syncing) return;
        setSyncing(true);
        try {
            const result = await syncAppDataToServer();
            if (!silent) message.success(t("auth.cloudSyncDone", { projects: result.projects, files: result.files }));
        } catch (error) {
            if (!silent) message.error(error instanceof Error ? error.message : t("auth.cloudSyncFailed"));
        } finally {
            setSyncing(false);
        }
    };

    if (status === "loading") {
        return <Spin size="small" className={cn("mx-2", iconClassName)} />;
    }

    if (status === "anonymous" || !user) {
        return (
            <>
                <button
                    type="button"
                    className={cn(
                        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                        iconClassName,
                    )}
                    onClick={() => setAuthOpen(true)}
                >
                    <UserRound className="size-4" />
                    {t("auth.signIn")}
                </button>
                <AuthModal
                    open={authOpen}
                    onOpenChange={setAuthOpen}
                    onAuthenticated={initialSync}
                    onRegistered={(points) => {
                        setWelcomePoints(points);
                        setWelcomeOpen(true);
                    }}
                />
            </>
        );
    }

    const menuItems = [
        {
            key: "points",
            label: (
                <div className="flex items-center gap-2 py-0.5 text-stone-500">
                    <Coins className="size-4" />
                    {t("auth.pointsBalance", { count: user.points })}
                </div>
            ),
            disabled: true,
        },
        { type: "divider" as const },
        {
            key: "checkin",
            icon: checkingIn ? <Spin size="small" /> : <CalendarCheck className="size-4" />,
            label: checkin?.done
                ? t("auth.checkinDoneToday")
                : t("auth.checkinAction", { count: checkin?.points ?? 0 }),
            disabled: Boolean(checkin?.done) || checkingIn,
            onClick: () => void runCheckin(),
        },
        {
            key: "refresh",
            icon: <RefreshCw className="size-4" />,
            label: t("auth.refreshPoints"),
            onClick: () => {
                void refreshCatalog().then(() => message.success(t("auth.refreshed")));
            },
        },
        {
            key: "sync",
            icon: syncing ? <Spin size="small" /> : <CloudUpload className="size-4" />,
            label: t("auth.cloudSync"),
            onClick: () => void runCloudSync(),
        },
        ...(supportContact
            ? [
                  {
                      key: "support",
                      icon: <Headset className="size-4" />,
                      label: t("auth.support"),
                      onClick: () => setSupportOpen(true),
                  },
              ]
            : []),
        ...(user.isAdmin
            ? [
                  {
                      key: "admin",
                      icon: <ShieldCheck className="size-4" />,
                      label: t("auth.adminConsole"),
                      // 站内跳转而不是新开标签页: 新标签要整包重新下载/解析 3MB bundle, 站内是瞬时路由切换
                      onClick: () => navigate("/admin"),
                  },
              ]
            : []),
        { type: "divider" as const },
        {
            key: "logout",
            icon: <LogOut className="size-4" />,
            label: t("auth.signOut"),
            danger: true,
            onClick: () => {
                void logout().then(() => message.success(t("auth.signedOut")));
            },
        },
    ];

    return (
        <>
        <Dropdown
            menu={{ items: menuItems }}
            trigger={["click"]}
            overlayStyle={{ minWidth: 200 }}
        >
            <Tooltip
                title={
                    <div className="max-w-56 text-left">
                        <div className="text-xs font-medium">{t("topNav.accountTip")}</div>
                        <div className="mt-0.5 text-xs opacity-70">{user.email}</div>
                    </div>
                }
                mouseEnterDelay={0.2}
            >
            <button
                type="button"
                className={cn(
                    "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                    iconClassName,
                )}
            >
                <Coins className="size-4" />
                <span className="tabular-nums">{user.points}</span>
            </button>
            </Tooltip>
        </Dropdown>
        <Modal title={t("auth.supportTitle")} open={supportOpen} onCancel={() => setSupportOpen(false)} footer={null} width={360} centered>
            <div className="flex flex-col items-center gap-3 py-2">
                {isImageUrl(supportContact) ? <img src={supportContact} alt={t("auth.support")} className="max-h-72 rounded-xl" /> : <p className="whitespace-pre-wrap text-center text-sm leading-6 text-stone-600 dark:text-stone-300">{supportContact}</p>}
                <p className="text-xs text-stone-400">{t("auth.supportHint")}</p>
            </div>
        </Modal>
        <Modal title={t("auth.welcomeTitle")} open={welcomeOpen} onCancel={() => setWelcomeOpen(false)} footer={[<Button key="start" type="primary" onClick={() => setWelcomeOpen(false)}>{t("auth.welcomeStart")}</Button>]} width={420} centered>
            <div className="space-y-3 py-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">{t("auth.welcomeGift", { count: welcomePoints })}</p>
                <p>1. {t("auth.welcomeStep1")}</p>
                <p>2. {t("auth.welcomeStep2")}</p>
                <p>3. {t("auth.welcomeStep3")}</p>
            </div>
        </Modal>
        </>
    );
}

type AuthModalProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAuthenticated?: () => void;
    onRegistered?: (points: number) => void;
};

function AuthModal({ open, onOpenChange, onAuthenticated, onRegistered }: AuthModalProps) {
    const { t } = useTranslation();
    const { message } = AntApp.useApp();
    const login = useAuthStore((state) => state.login);
    const register = useAuthStore((state) => state.register);
    const sendCode = useAuthStore((state) => state.sendCode);
    const [tab, setTab] = useState<"login" | "register">("login");
    const [loading, setLoading] = useState(false);
    const [countdown, setCountdown] = useState(0);
    const [loginForm] = Form.useForm();
    const [registerForm] = Form.useForm();

    useEffect(() => {
        if (!countdown) return;
        const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
        return () => window.clearInterval(timer);
    }, [countdown]);

    useEffect(() => {
        if (open) return;
        loginForm.resetFields();
        registerForm.resetFields();
        setTab("login");
        setCountdown(0);
    }, [open, loginForm, registerForm]);

    const handleSendCode = async () => {
        try {
            const email = await registerForm.validateFields(["email"]).then((values) => values.email as string);
            await sendCode(email);
            setCountdown(60);
            message.success(t("auth.codeSent"));
        } catch (error) {
            if (error instanceof Error && error.message) message.error(error.message);
        }
    };

    const handleLogin = async (values: { email: string; password: string }) => {
        setLoading(true);
        try {
            await login(values.email.trim(), values.password);
            onOpenChange(false);
            onAuthenticated?.();
            message.success(t("auth.welcomeBack"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.loginFailed"));
        } finally {
            setLoading(false);
        }
    };

    const handleRegister = async (values: { email: string; password: string; code: string }) => {
        setLoading(true);
        try {
            await register(values.email.trim(), values.password, values.code.trim());
            onOpenChange(false);
            onAuthenticated?.();
            onRegistered?.(useAuthStore.getState().user?.points ?? 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.registerFailed"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal title={t("auth.title")} open={open} onCancel={() => onOpenChange(false)} footer={null} width={380} destroyOnHidden>
            <Tabs
                activeKey={tab}
                onChange={(key) => setTab(key as "login" | "register")}
                centered
                items={[
                    {
                        key: "login",
                        label: t("auth.signIn"),
                        children: (
                            <Form form={loginForm} layout="vertical" onFinish={handleLogin} requiredMark={false}>
                                <Form.Item name="email" label={t("auth.email")} rules={[{ required: true, type: "email", message: t("auth.emailInvalid") }]}>
                                    <Input placeholder="you@example.com" autoComplete="email" />
                                </Form.Item>
                                <Form.Item name="password" label={t("auth.password")} rules={[{ required: true, message: t("auth.passwordRequired") }]}>
                                    <Input.Password autoComplete="current-password" />
                                </Form.Item>
                                <Button type="primary" htmlType="submit" block loading={loading}>
                                    {t("auth.signIn")}
                                </Button>
                            </Form>
                        ),
                    },
                    {
                        key: "register",
                        label: t("auth.signUp"),
                        children: (
                            <Form form={registerForm} layout="vertical" onFinish={handleRegister} requiredMark={false}>
                                <Form.Item name="email" label={t("auth.email")} rules={[{ required: true, type: "email", message: t("auth.emailInvalid") }]}>
                                    <Input placeholder="you@example.com" autoComplete="email" />
                                </Form.Item>
                                <Form.Item label={t("auth.verificationCode")} required style={{ marginBottom: 16 }}>
                                    <div className="flex gap-2">
                                        <Form.Item name="code" noStyle rules={[{ required: true, message: t("auth.codeRequired") }]}>
                                            <Input placeholder={t("auth.codePlaceholder")} autoComplete="one-time-code" />
                                        </Form.Item>
                                        <Button className="shrink-0" disabled={countdown > 0} onClick={() => void handleSendCode()}>
                                            {countdown > 0 ? t("auth.codeCountdown", { count: countdown }) : t("auth.sendCode")}
                                        </Button>
                                    </div>
                                </Form.Item>
                                <Form.Item name="password" label={t("auth.password")} extra={t("auth.passwordHint")} rules={[{ required: true, min: 8, message: t("auth.passwordTooShort") }]}>
                                    <Input.Password autoComplete="new-password" />
                                </Form.Item>
                                <Button type="primary" htmlType="submit" block loading={loading}>
                                    {t("auth.signUpAndGetGift")}
                                </Button>
                            </Form>
                        ),
                    },
                ]}
            />
        </Modal>
    );
}
