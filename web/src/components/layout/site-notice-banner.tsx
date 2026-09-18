import { useEffect, useState } from "react";
import { Alert } from "antd";

import { fetchSiteInfo } from "@/services/api/site";

/**
 * 站点公告条: 后台设置 notice 后在导航栏下方展示, 用户关闭后按内容记忆不再弹出。
 */
export function SiteNoticeBanner() {
    const [notice, setNotice] = useState("");
    const [dismissed, setDismissed] = useState(true);

    useEffect(() => {
        void fetchSiteInfo()
            .then((info) => {
                setNotice(info.notice.trim());
                setDismissed(window.localStorage.getItem("infinite-canvas:notice-dismissed") === info.notice.trim());
            })
            .catch(() => undefined);
    }, []);

    if (!notice || dismissed) return null;
    return (
        <Alert
            className="!rounded-none !border-x-0 !border-t-0"
            type="info"
            showIcon
            message={notice}
            closable
            onClose={() => {
                window.localStorage.setItem("infinite-canvas:notice-dismissed", notice);
                setDismissed(true);
            }}
        />
    );
}
