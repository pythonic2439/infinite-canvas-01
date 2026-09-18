import type { ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { SiteNoticeBanner } from "@/components/layout/site-notice-banner";

// Agent 面板 (本地 Codex 桥, 商用价值有限) 已隐藏入口; 恢复时在此挂回 <AgentPanel /> 并还原
// canvas-top-bar / project.tsx 里的 agentOpen/compactAgentStatus/onToggleAgent 接线。
export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <SiteNoticeBanner />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
        </div>
    );
}
