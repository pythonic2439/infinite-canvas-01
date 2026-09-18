# 多用户商业化后端 (PHP 8.2 + SQLite)

站点 `ai.01ai.space` 的多用户/点数/网关后端。nginx 把 `/api/` 路由到 `api/index.php`
(`location = /api/ref-upload` 与 `/api/v1/comfyui/` 优先级更高，不受影响)。

## 架构

```
浏览器 ── 登录后从 /api/catalog 拿"净化渠道" (baseUrl=/api/gw/{id}, Key=网关令牌)
       ── 生成请求经 /api/gw/{id}/... 转发到真实上游 (真实 Key 只在服务端)
       ── POST 且上游 2xx 时按模型点数扣费 (GET 轮询/拉列表免费)
       ── /api/sync/{domain}/... 四域数据云同步 (与 WebDAV 同引擎)
```

- 数据目录 `server/data/`（站点根之外，Web 不可直接访问；已加入 .gitignore）
- SQLite 库 `server/data/infinite-canvas.sqlite3`（WAL 模式）
- 用户同步文件 `server/data/users/{uid}/sync/{domain}/`

## 运维命令

```bash
# 导入/更新渠道配置 (从前端"导出配置"的 JSON 导入; --force 覆盖同名渠道)
php server/bin/import-config.php <config.json> [--force]

# 创建/重置管理员 (跳过邮箱验证码, 首次部署引导用)
php server/bin/create-admin.php <email> <password≥8位>

# 提升/撤销已有用户的管理员
php server/bin/promote.php <email> [--revoke]
```

## 部署注意

- **目录属主必须是 www**: `chown -R www:www server/data`（php-fpm 以 www 运行，root 属主会导致写入 500）
- 管理后台 `https://ai.01ai.space/admin`：用户/点数、渠道/模型单价、SMTP 邮件服务、注册开关与赠送点数
- SMTP 未配置时注册收不到验证码 —— 先在管理后台填好 SMTP（QQ 邮箱/阿里云邮件推送等）
- 单价默认值：image=1、video=10、text=1、audio=2 点；未登记的模型不计费
- 鸣泽影坊(127.0.0.1:37651)/豆包桥接(127.0.0.1:17777)反代已配置，但上游服务必须在本机运行才可用
- **dola 上游地址不入库**：`import-config.php` 映射 `/dola-proxy` 时读取环境变量 `DOLA_UPSTREAM`
  （如 `http://<IP>:6007`），未设置则该映射为空；php-fpm 下用 `env[PHP]=...` 或脚本前 `export` 注入
- 含真实 Key 的一次性脚本（如添加渠道）**禁止硬编码入库**——Key 一律走管理后台或环境变量
