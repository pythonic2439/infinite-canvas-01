# 部署说明 — 零一·无限画布 (infinite-canvas)

> 线上地址: <https://ai.01ai.space> · 服务器: 宝塔面板 / Nginx / 静态托管
> 本文档描述线上部署架构、构建发布流程、nginx/证书配置与备份恢复步骤。

## 1. 架构概览

```
浏览器 (SPA, React + Vite)
   │  https://ai.01ai.space
   ▼
Nginx (本服务器)
   ├── /                      → 静态托管 /www/wwwroot/infinite-canvas/web/dist
   ├── /api/v1/comfyui/       → 反代 https://autodl.art   (AutoDL ComfyUI API)
   └── /autodl-proxy/         → 反代 https://autodl.art/  (同上，路径重写风格不同)
```

- **纯前端架构**：所有 AI 渠道配置（Base URL / API Key / 模型 / 参数模板）保存在**浏览器 localStorage**
  （键 `infinite-canvas:ai_config_store`），服务器上没有任何 `.env` 或密钥文件。
- **反向代理的作用**：规避浏览器直连 `autodl.art` 的 CORS / ERR_NETWORK 问题；`client_max_body_size 50m`
  用于承载参考图 base64 请求体（数 MB 级）。
- **SSL**：acme.sh 签发 Let's Encrypt ECC 证书，自动续期后自动 reload nginx。

### 仓库内子项目（不参与线上部署）

| 目录 | 用途 |
|---|---|
| `web/` | 主前端（线上部署的就是它的构建产物 `web/dist`） |
| `canvas-agent/` | 本地 Canvas Agent，连接画布网页与本机 Codex / Claude Code |
| `docs/` | 文档站（Next.js/Fumadocs） |
| `plugins/` | 画布插件源码（构建产物随 `web/dist/plugins/` 发布） |
| `video_plugin_autodl_h3_字字动画/` | 字字动画宿主用的 AutoDL MiniMax-H3 视频 Python 插件（依赖宿主的 `plugin_utils.py`，本仓库内不可独立运行） |

## 2. 关键文件与路径

| 内容 | 路径 |
|---|---|
| 项目源码 | `/www/wwwroot/infinite-canvas` |
| 线上构建产物 | `/www/wwwroot/infinite-canvas/web/dist` |
| 运行期配置（默认空，分析开关） | `web/dist/config.js`（由 `docker-entrypoint.sh` 在容器环境生成；本地部署保持空默认即可） |
| Nginx vhost | `/www/server/panel/vhost/nginx/ai.01ai.space.conf` |
| SSL 证书 | `/www/server/panel/vhost/cert/ai.01ai.space/{fullchain.pem,privkey.pem}` |
| acme.sh 域名配置 | `/root/.acme.sh/ai.01ai.space_ecc/` |
| ACME 验证 webroot | `/www/wwwroot/infinite-canvas/web/acme`（HTTP-01 验证用） |
| 访问日志 | `/www/wwwlogs/ai.01ai.space.log` |

## 3. 构建与发布

```bash
cd /www/wwwroot/infinite-canvas/web
npm install         # 仅首次或依赖变更后
npm run typecheck   # tsc --noEmit
npm run build       # vite build → 输出到 web/dist
```

- 构建完成即发布：nginx 直接托管 `web/dist`，**无需重启任何服务**。
- `assets/*` 文件名带 hash、缓存 30 天（`immutable`）；`index.html` 不强缓存，发布后普通刷新浏览器即可生效。
- Node 版本要求见 `web/package.json`（本机使用 `/usr/local/bin/node`）。

## 4. Nginx 配置要点

配置文件：`/www/server/panel/vhost/nginx/ai.01ai.space.conf`，改动后执行：

```bash
nginx -t && nginx -s reload
```

要点：

1. **HTTP 80**：仅保留 `/.well-known/acme-challenge/`（webroot 指向 `web/acme`），其余 301 到 HTTPS。
2. **HTTPS 443**：TLSv1.2/1.3，ECDHE-ECDSA 套件；安全响应头（HSTS、X-Frame-Options 等）已开启。
3. **SPA 回退**：`location / { try_files $uri $uri/ /index.html; }`。
4. **静态长缓存**：`location /assets/` → `expires 30d` + `Cache-Control: public, immutable`。
5. **AutoDL 反代**（两个 location 均已配置）：
   - `proxy_pass https://autodl.art`，`proxy_set_header Host autodl.art`，`proxy_ssl_server_name on`；
   - 透传 `Authorization` 头（AutoDL 用裸 Token，不带 Bearer）；
   - `client_max_body_size 50m`、`proxy_read_timeout 300s`。

## 5. 应用内渠道配置（浏览器端）

1. 打开 <https://ai.01ai.space> → 设置 → 渠道，新增渠道，**接口格式选 AutoDL**。
2. Base URL 三种写法（推荐前两种，走本站反代避免 CORS）：
   - `https://ai.01ai.space` —— 应用自动拼接 `/api/v1/comfyui`；
   - `https://ai.01ai.space/autodl-proxy` —— 显式代理前缀；
   - `https://autodl.art` —— 直连，受浏览器 CORS 限制，通常不可用。
3. API Key：在 autodl.art「令牌管理」创建，**分组必须选 ComfyUI**（裸 Token，应用会自动去掉误粘贴的 `Bearer ` 前缀）。
4. 模型名 = AutoDL 工作流 ID，常用：
   - `minimax_h3_lightx2v_v5` 多图参考生视频（10s，字字动画验证过的主路径）
   - `minimax_h3_lightx2v_v5_15s` 多图参考（15s）
   - `minimax_h3_image_audio_to_video_v2(_15s)` 多图多音频（`_15s` 版所有字段可选，可只挂参考图）
   - `minimax_h3_lightx2v` 首尾帧（first_frame/last_frame）· `minimax_h3_lightx2v_no_pic` 纯文生
5. 模型可配 JSON 参数模板（可选），占位符：`{{prompt}}` `{{duration}}` `{{resolution}}` `{{images.N}}` `{{audios.N}}`；
   整值占位符为空时该字段自动省略。
6. 字字动画插件（`video_plugin_autodl_h3_字字动画/`）：自动按素材选工作流（音频 > 首尾帧 > 多图 > 文生），
   参考图 PIL 压缩至 ≤1024px JPEG 后转 data URI 提交。

### 已知坑

- **参考图被平台审核拦截时无任何报错**：任务照样 SUCCESS 并计费，但参考图被静默丢弃、按纯文生视频生成，
  表现为"视频与参考图完全无关"（含真实人脸/敏感场景的图易触发）。判别方法：到 AutoDL 任务记录确认输入图已落盘
  （`comfyui/inputs/...` URL 可直接下载核对），再换一张无人脸的图做 A/B。属平台行为，不要改应用代码。
- AutoDL 结果 URL 有效期较短，应用取到后应尽快转存。
- H3 的 `seed` 字段：应用默认不发（平台自行解析），任务记录里看到的 seed 是平台回填的。

## 6. 从备份恢复

备份包结构：

```
infinite-canvas_<日期>.tar.gz
├── infinite-canvas/            # 项目源码 + web/dist 构建产物（不含 web/node_modules）
└── server-configs/
    ├── nginx/ai.01ai.space.conf
    ├── cert/ai.01ai.space/     # SSL 证书 + 私钥
    └── acme.sh/ai.01ai.space_ecc/   # 证书续期配置
```

恢复步骤：

```bash
# 1. 解压
tar -xzf infinite-canvas_<日期>.tar.gz -C /tmp/restore

# 2. 恢复项目
cp -a /tmp/restore/infinite-canvas /www/wwwroot/

# 3. 恢复 nginx 配置与证书
cp /tmp/restore/server-configs/nginx/ai.01ai.space.conf /www/server/panel/vhost/nginx/
mkdir -p /www/server/panel/vhost/cert/ai.01ai.space
cp /tmp/restore/server-configs/cert/ai.01ai.space/* /www/server/panel/vhost/cert/ai.01ai.space/
chmod 600 /www/server/panel/vhost/cert/ai.01ai.space/*

# 4. 恢复 acme.sh 续期配置（换机器时需先安装 acme.sh）
cp -a /tmp/restore/server-configs/acme.sh/ai.01ai.space_ecc /root/.acme.sh/

# 5. 检查并重载 nginx
nginx -t && nginx -s reload

# 6. （可选）重新构建
cd /www/wwwroot/infinite-canvas/web && npm install && npm run build
```

换新机器时注意：DNS 解析指向新服务器 → 重新安装 acme.sh 并恢复域名配置 → 手动跑一次
`/root/.acme.sh/acme.sh --renew -d ai.01ai.space --ecc --force` 验证续期链路。

## 7. 备份注意事项

- 备份包含 **SSL 私钥**，请妥善保管，不要放到公开位置。
- 备份不含 `web/node_modules`（731MB，`npm install` 可复原）、用户数据（画布内容/渠道配置均在各用户浏览器 localStorage）。
- 字字动画插件的令牌等参数由其宿主应用管理，不在本仓库备份范围内。
