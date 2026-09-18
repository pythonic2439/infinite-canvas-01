import type { CSSProperties } from "react";
import { Tooltip } from "antd";
import { Keyboard, Puzzle, Settings2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { AuthCheckinButton, AuthMenu } from "@/components/layout/auth-menu";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAuthStore } from "@/stores/use-auth-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAdmin = useAuthStore((state) => state.user?.isAdmin ?? false);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    // 顶栏按钮统一悬浮提示: 名称 + 说明, 双行展示, 跟随当前语言
    const tip = (title: string, desc: string) => (
        <div className="max-w-56 text-left">
            <div className="text-xs font-medium">{title}</div>
            <div className="mt-0.5 text-xs opacity-70">{desc}</div>
        </div>
    );
    const themeLabel = t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme");

    return (
        <div className="inline-flex shrink-0 items-center gap-2">
            {showConfig ? (
                <Tooltip title={tip(t("navigation.config"), t("topNav.settingsDesc"))} mouseEnterDelay={0.2}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")}>
                        <Settings2 className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
            <Tooltip title={tip(languageLabel, t("topNav.languageDesc"))} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AuthCheckinButton iconClassName={naturalIconClass} />
            {isAdmin ? (
                <Tooltip title={tip(t("auth.adminConsole"), t("topNav.adminDesc"))} mouseEnterDelay={0.2}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => navigate("/admin")} aria-label={t("auth.adminConsole")}>
                        <ShieldCheck className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
            <AuthMenu iconClassName={naturalIconClass} />
            <Tooltip title={tip(themeLabel, t("topNav.themeDesc"))} mouseEnterDelay={0.2}>
                <span className="inline-flex">
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={themeLabel} />
                </span>
            </Tooltip>
            {onOpenShortcuts ? (
                <Tooltip title={tip(t("topNav.shortcuts"), t("topNav.shortcutsDesc"))} mouseEnterDelay={0.2}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")}>
                        <Keyboard className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
