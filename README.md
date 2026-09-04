<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 · 二次开发部署版 (infinite-canvas-01)</h1>

<p align="center">
  <a href="https://ai.01ai.space"><img src="https://img.shields.io/badge/演示站-ai.01ai.space-2b6de8?style=flat-square" alt="Demo"></a>
  <a href="https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/badge/上游-basketikun%2Finfinite--canvas-2b6de8?style=flat-square" alt="Upstream"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
  <a href="#--基础功能">基础功能</a> · <a href="#--本分支增强">本分支增强</a> · <a href="#-快速开始">快速开始</a> · <a href="#-效果展示">效果展示</a> · <a href="#-致谢">致谢</a>
</p>

基于开源项目 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 的二次开发与生产部署版本。

**在线体验：[https://ai.01ai.space](https://ai.01ai.space)** —— 纯前端应用，打开后在「设置 → 渠道」填入自己的 AI 接口地址与 API Key 即可使用（所有配置保存在浏览器本地，不上传服务器）。

## 基础功能

- **无限画布**：多画布项目、节点拖拽缩放、连线编排、小地图、撤销重做、导入导出。
- **AI 创作**：浏览器直连你配置的 AI 接口，支持文生图、图生图、参考图编辑、文本问答、音频与视频生成。
- **多渠道协议**：OpenAI / Gemini / 火山方舟(Seedance) / AutoDL ComfyUI / 多米 等格式，支持自定义调用脚本与参数模板。
- **画布助手**：围绕选中节点与上游内容对话、生图，结果直接插回画布；可接入本机 Codex / Claude Code 作为 Agent。
- **插件系统**：远程节点插件动态安装/更新，提供 TypeScript SDK 自行开发。
- **提示词库**：直连多个开源提示词项目并缓存到浏览器。

## 本分支增强

在上游基础上针对公网部署与豆包系模型做了以下定制：

- **dola 渠道**：接入「豆包管理器(dola)」公网 API（`dola-image` / `dola-video`），异步任务建单+轮询、参考图自动转公网链接、比例自动收敛到 API 支持的三档（1:1 / 9:16 / 16:9）。
- **防人脸拦截（Face Guard）**：基于 MediaPipe 离线人脸检测（模型随应用分发，不联网），对视频参考图眼部自动叠加网格/马赛克/斜条干扰；画布图片节点亦提供「眼部网格」手动工具。
- **生成结果外链本地化**：接口返回临时外链时统一下载、校验并落库到浏览器本地，避免外链过期、防盗链或广告拦截导致图片无法显示；下载失败自动回退原链接。
- **参考图自动压缩**：超过接口上限的参考图先在本地等比降采样再上传，未超限原样上传不损画质。
- **失败自动重试**：渠道级重试次数设置，dola 任务因网络抖动失败后自动重新提交。
- **Nginx 同源反代方案**：`/dola-proxy`、`/duomi-proxy`、`/autodl-proxy` 等同源转发配置范例，解决浏览器直连第三方接口的跨域/混合内容问题（见 `DEPLOY.md`）。

## 快速开始

### 本地开发

```bash
git clone https://github.com/pythonic2439/infinite-canvas-01.git
cd infinite-canvas-01/web
npm install
npm run dev
```

### Docker 运行

```bash
git clone https://github.com/pythonic2439/infinite-canvas-01.git
cd infinite-canvas-01
docker compose up -d
```

默认端口 3000，访问 `http://localhost:3000`，首次打开在右上角配置中填入 OpenAI 兼容的 `Base URL` 与 `API Key`。

### 生产部署（静态托管 + Nginx）

`npm run build` 产物即静态站点，任意静态服务器可托管；参考图转公网链接、接口反代等需要服务端配合的能力见根目录 `DEPLOY.md` 与 `ref-upload.php`。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 致谢

- 上游项目：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) —— 本仓库的全部基础能力均来自该项目，尊重并保留原作者信息。
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) —— 离线人脸检测能力。

## 开源协议

本项目沿用上游的 [MIT License](LICENSE)，可免费使用、修改、分发与商业使用。
