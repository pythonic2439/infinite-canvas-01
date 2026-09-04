# -*- coding: utf-8 -*-
"""
AutoDL MiniMax-H3 视频生成插件（字字动画视频插件）

通过 AutoDL ComfyUI API 调用 MiniMax-H3 全系列视频工作流：
- H3文生视频（无参考图）
- H3首尾帧生成视频
- H3多图参考生视频（10秒 / 15秒版）
- H3多图多音频生视频（10秒 / 15秒版）

本地参考图/音频自动压缩并转 data URI 提交（实测可用格式）。
"""

import base64
import io
import json
import os
import shutil
import sys
import time
from pathlib import Path

import requests

plugin_dir = Path(__file__).parent

# plugin_utils.py 位于 plugins/ 目录（插件目录的上两级），与内置插件保持一致的追加方式
for _p in (plugin_dir.parent, plugin_dir.parent.parent):
    if str(_p) not in sys.path:
        sys.path.append(str(_p))
from plugin_utils import load_plugin_config

_PLUGIN_FILE = __file__
_PLUGIN_VERSION = "1.0.0"

_API_BASE = "https://autodl.art"

# kind: t2v=纯文生视频, flf=首尾帧, images=多图参考, audio=多图多音频
WORKFLOWS = {
    "minimax_h3_lightx2v_no_pic": {
        "name": "H3文生视频（10秒）",
        "max_duration": 10,
        "resolutions": ["480p竖", "480p横", "768p竖", "768p横"],
        "kind": "t2v",
    },
    "minimax_h3_lightx2v": {
        "name": "H3首尾帧生成视频（10秒）",
        "max_duration": 10,
        "resolutions": ["480p竖", "480p横", "768p竖", "768p横"],
        "kind": "flf",
    },
    "minimax_h3_lightx2v_v5": {
        "name": "H3多图参考生视频（10秒）",
        "max_duration": 10,
        "resolutions": [
            "480p竖", "480p横", "768p竖", "768p横",
            "1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)",
        ],
        "kind": "images",
    },
    "minimax_h3_lightx2v_v5_15s": {
        "name": "H3多图生视频（15秒）",
        "max_duration": 15,
        "resolutions": ["480p竖", "480p横", "768p竖", "768p横", "480p(1:1)", "768p(1:1)"],
        "kind": "images",
    },
    "minimax_h3_image_audio_to_video_v2": {
        "name": "H3多图多音频生视频（10秒）",
        "max_duration": 10,
        "resolutions": ["480p竖", "480p横", "768p竖", "768p横", "1080p竖", "1080p横"],
        "kind": "audio",
    },
    "minimax_h3_image_audio_to_video_v2_15s": {
        "name": "H3多图多音频生视频（15秒）",
        "max_duration": 15,
        "resolutions": ["480p竖", "480p横", "768p竖", "768p横"],
        "kind": "audio",
    },
}

ALL_RESOLUTIONS = [
    "768p竖", "768p横", "480p竖", "480p横",
    "1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)",
]

_RESOLUTION_DOWNGRADE = {
    "1080p竖": "768p竖",
    "1080p横": "768p横",
    "1080p(1:1)": "768p(1:1)",
    "768p(1:1)": "768p竖",
    "480p(1:1)": "480p竖",
}

_AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "audio/mp4",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
}

_default_params = {
    "api_key": "",
    "workflow_mode": "自动选择",
    "workflow_id": "minimax_h3_lightx2v_v5",
    "resolution": "768p竖",
    "duration_mode": "跟随分镜",
    "duration": 5,
    "seed": "",
    "timeout": 900,
    "poll_interval": 10,
    "max_image_size": 1024,
    "image_quality": 88,
}


def _log(msg):
    print(f"[AutoDL-H3] {msg}")


def get_params():
    params = _default_params.copy()
    params.update(load_plugin_config(_PLUGIN_FILE))
    return params


def get_info():
    return {
        "name": "AutoDL MiniMax-H3 视频生成",
        "description": "通过 AutoDL ComfyUI API 调用 MiniMax-H3 全系列视频工作流（文生/首尾帧/多图参考/多图多音频，最长15秒），支持480p/768p/1080p，参考图自动压缩转 data URI 提交",
        "version": _PLUGIN_VERSION,
        "author": "autodl-h3",
        "images_per_batch": 1,
    }


# --------------------- 素材编码 ---------------------

def _image_to_data_uri(path, max_size=1024, quality=88):
    """本地图片 → 压缩 JPEG → data URI（实测 AutoDL 接受的格式）"""
    if not path or not os.path.isfile(path):
        raise Exception(f"PLUGIN_ERROR:::参考图不存在: {path}")
    try:
        from PIL import Image
        resample = getattr(Image, "Resampling", Image).LANCZOS
        with Image.open(path) as im:
            im = im.convert("RGB")
            w, h = im.size
            if max(w, h) > max_size:
                scale = float(max_size) / max(w, h)
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), resample)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=quality)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{b64}"
    except ImportError:
        pass
    except Exception as e:
        _log(f"图片压缩失败，回退原始字节: {path} ({e})")
    # PIL 不可用或压缩失败时按扩展名回退
    ext = os.path.splitext(path)[1].lower()
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(ext)
    if not mime:
        raise Exception(f"PLUGIN_ERROR:::不支持的图片格式: {ext}，请使用 JPG/PNG/WebP")
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"


def _audio_to_data_uri(path):
    """本地音频 → data URI（H3 支持 MP3/WAV/MP4/FLAC）"""
    if not path or not os.path.isfile(path):
        raise Exception(f"PLUGIN_ERROR:::参考音频不存在: {path}")
    ext = os.path.splitext(path)[1].lower()
    mime = _AUDIO_MIME.get(ext)
    if not mime:
        raise Exception(f"PLUGIN_ERROR:::不支持的音频格式 {ext}，H3 仅支持 MP3/WAV/MP4/FLAC")
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"


# --------------------- context 素材整理 ---------------------

def _normalize_indexed_map(raw):
    """把 reference_images / reference_audios 归一化为按序号升序的路径列表"""
    if not raw:
        return []
    if isinstance(raw, dict) and "参考图片MAP" in raw:
        raw = raw.get("参考图片MAP") or {}
    items = []
    for k, v in (raw.items() if isinstance(raw, dict) else []):
        try:
            idx = int(k)
        except (TypeError, ValueError):
            continue
        if isinstance(v, str) and v.strip():
            items.append((idx, v))
    items.sort(key=lambda x: x[0])
    return [p for _, p in items]


def _collect_assets(context):
    """整理参考图/音频列表。返回 (img_paths, audio_paths, first_frame, end_frame)"""
    first_frame = context.get("first_frame_path") or None
    end_frame = context.get("end_frame_path") or None

    img_paths = []
    if first_frame:
        img_paths.append(first_frame)
    img_paths.extend(_normalize_indexed_map(context.get("reference_images")))
    img_paths = img_paths[:9]

    audio_paths = _normalize_indexed_map(context.get("reference_audios"))
    audio_path = context.get("audio_path")
    if audio_path and os.path.isfile(audio_path) and audio_path not in audio_paths:
        audio_paths.append(audio_path)
    audio_paths = audio_paths[:3]

    return img_paths, audio_paths, first_frame, end_frame


# --------------------- 工作流选择与参数解析 ---------------------

def _choose_workflow(params, img_paths, audio_paths, first_frame, end_frame, duration):
    mode = params.get("workflow_mode", "自动选择")
    if mode == "手动指定":
        wf_id = params.get("workflow_id", "")
        if wf_id not in WORKFLOWS:
            raise Exception(f"PLUGIN_ERROR:::未知工作流ID: {wf_id}")
        return wf_id

    # 自动选择优先级：音频 > 首尾帧 > 多图 > 文生
    if audio_paths:
        if duration > 10:
            return "minimax_h3_image_audio_to_video_v2_15s"
        return "minimax_h3_image_audio_to_video_v2"
    if first_frame and end_frame:
        return "minimax_h3_lightx2v"
    if img_paths:
        if duration > 10:
            return "minimax_h3_lightx2v_v5_15s"
        return "minimax_h3_lightx2v_v5"
    return "minimax_h3_lightx2v_no_pic"


def _resolve_duration(params, context, wf_id):
    max_d = WORKFLOWS[wf_id]["max_duration"]
    duration = None
    if params.get("duration_mode", "跟随分镜") == "跟随分镜":
        sd = context.get("scene_duration")
        if sd:
            try:
                duration = int(round(float(sd)))
            except (TypeError, ValueError):
                duration = None
    if not duration:
        try:
            duration = int(params.get("duration", 5))
        except (TypeError, ValueError):
            duration = 5
    if duration < 1:
        duration = 1
    if duration > max_d:
        _log(f"时长 {duration}s 超过工作流上限，已截断为 {max_d}s")
        duration = max_d
    return duration


def _resolve_resolution(params, wf_id):
    allowed = WORKFLOWS[wf_id]["resolutions"]
    chosen = params.get("resolution", "768p竖")
    if chosen in allowed:
        return chosen
    cur = chosen
    while cur in _RESOLUTION_DOWNGRADE:
        cur = _RESOLUTION_DOWNGRADE[cur]
        if cur in allowed:
            _log(f"分辨率 {chosen} 不被当前工作流支持，已降级为 {cur}")
            return cur
    for fallback in ("768p竖", "480p竖"):
        if fallback in allowed:
            _log(f"分辨率 {chosen} 不被当前工作流支持，已回退为 {fallback}")
            return fallback
    return allowed[0]


# --------------------- API 调用 ---------------------

def _api_headers(api_key):
    return {"Authorization": api_key, "Content-Type": "application/json"}


def _submit_task(api_key, wf_id, body, timeout=60):
    url = f"{_API_BASE}/api/v1/comfyui/comfyui_workflow/{wf_id}"
    _log(f"提交任务: {url}")
    _log(f"提示词: {body.get('prompt', '')[:200]}")
    _log(f"参数: duration={body.get('duration')}s resolution={body.get('resolution')} "
         f"图片数={sum(1 for k in body if k.startswith('ref_image_'))} "
         f"音频数={sum(1 for k in body if k.startswith('ref_audio_'))}")
    try:
        resp = requests.post(url, headers=_api_headers(api_key), json=body, timeout=timeout)
    except requests.exceptions.RequestException as e:
        raise Exception(f"PLUGIN_ERROR:::提交任务网络异常: {e}")
    try:
        data = resp.json()
    except ValueError:
        raise Exception(f"PLUGIN_ERROR:::提交任务响应异常: HTTP {resp.status_code} {resp.text[:200]}")
    if resp.status_code == 401 or resp.status_code == 403:
        raise Exception("PLUGIN_ERROR:::API令牌无效或无权限，请检查插件设置中的令牌")
    if data.get("code") != "Success":
        raise Exception(f"PLUGIN_ERROR:::提交任务失败: {data.get('msg') or resp.text[:200]}")
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise Exception("PLUGIN_ERROR:::提交成功但未返回任务ID")
    _log(f"任务ID: {task_id}")
    return task_id


def _poll_task(api_key, task_id, timeout, poll_interval, est_seconds, progress_callback):
    """轮询任务直到 SUCCESS / FAILED / 超时，返回 results 列表"""
    url = f"{_API_BASE}/api/v1/comfyui/comfyui_workflow/result/{task_id}"
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            raise Exception(f"PLUGIN_ERROR:::任务超时（>{int(timeout)}秒），task_id={task_id}")
        try:
            resp = requests.get(url, headers=_api_headers(api_key), timeout=30)
            data = resp.json()
        except (requests.exceptions.RequestException, ValueError) as e:
            _log(f"查询异常（将继续重试）: {e}")
            time.sleep(poll_interval)
            continue

        d = data.get("data") or {}
        status = d.get("status", "")

        if status == "SUCCESS":
            return d.get("results") or []
        if status == "FAILED":
            raise Exception(f"PLUGIN_ERROR:::生成失败: {data.get('msg') or '服务端未返回原因'}")

        run_secs = d.get("duration") or 0
        if status == "QUEUED":
            if progress_callback:
                progress_callback("排队中")
        elif status == "RUNNING":
            pct = min(95, max(5, int(run_secs * 100.0 / max(60, est_seconds))))
            if progress_callback:
                progress_callback("生成中", pct)
        _log(f"状态: {status} 已运行: {run_secs}s 轮询等待: {poll_interval}s")
        time.sleep(poll_interval)


def _download_video(url, dst, timeout=300):
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        content = resp.content
    except requests.exceptions.RequestException as e:
        raise Exception(f"PLUGIN_ERROR:::视频下载失败: {e}")
    if len(content) < 10240:
        raise Exception(f"PLUGIN_ERROR:::下载内容异常（仅 {len(content)} 字节），结果URL可能已过期")
    if content[4:8] != b"ftyp":
        raise Exception("PLUGIN_ERROR:::下载内容不是有效的 MP4 视频文件")
    with open(dst, "wb") as f:
        f.write(content)
    _log(f"已下载: {dst} ({len(content) / 1024 / 1024:.2f} MB)")


# --------------------- 主入口 ---------------------

def generate(context):
    _log("=" * 60)
    _log("开始生成视频 (AutoDL MiniMax-H3)")

    params = context.get("plugin_params") or get_params()
    cb = context.get("progress_callback")

    api_key = (params.get("api_key") or "").strip()
    if not api_key:
        raise Exception("PLUGIN_ERROR:::API令牌未配置，请在插件设置中填写 AutoDL 令牌（autodl.art → 令牌管理，分组选择 ComfyUI）")

    prompt = (context.get("prompt") or "").strip()
    if not prompt:
        raise Exception("PLUGIN_ERROR:::提示词为空")

    try:
        timeout = int(params.get("timeout", 900))
        poll_interval = max(3, int(params.get("poll_interval", 10)))
        max_image_size = max(256, int(params.get("max_image_size", 1024)))
        image_quality = max(30, min(95, int(params.get("image_quality", 88))))
    except (TypeError, ValueError):
        timeout, poll_interval, max_image_size, image_quality = 900, 10, 1024, 88

    img_paths, audio_paths, first_frame, end_frame = _collect_assets(context)

    # 先用分镜时长预估工作流，再解析精确时长/分辨率
    preview_duration = 5
    sd = context.get("scene_duration")
    if sd:
        try:
            preview_duration = int(round(float(sd)))
        except (TypeError, ValueError):
            preview_duration = 5
    wf_id = _choose_workflow(params, img_paths, audio_paths, first_frame, end_frame, preview_duration)
    duration = _resolve_duration(params, context, wf_id)
    resolution = _resolve_resolution(params, wf_id)
    wf = WORKFLOWS[wf_id]
    _log(f"工作流: {wf['name']} ({wf_id}) 时长: {duration}s 分辨率: {resolution}")

    # 构建请求体（默认模板: prompt / duration / resolution）
    body = {
        "prompt": prompt,
        "duration": duration,
        "resolution": resolution,
    }
    seed = str(params.get("seed", "") or "").strip()
    if seed:
        try:
            body["seed"] = int(seed)
        except ValueError:
            _log(f"忽略非法种子值: {seed}")

    if wf["kind"] == "flf":
        if not first_frame or not end_frame:
            raise Exception("PLUGIN_ERROR:::首尾帧工作流需要同时设置首帧图片和尾帧图片")
        body["first_frame"] = _image_to_data_uri(first_frame, max_image_size, image_quality)
        body["last_frame"] = _image_to_data_uri(end_frame, max_image_size, image_quality)
    elif wf["kind"] == "images":
        if not img_paths:
            raise Exception("PLUGIN_ERROR:::多图参考工作流至少需要 1 张参考图（当前分镜未设置参考图或首帧）")
        for i, p in enumerate(img_paths):
            body[f"ref_image_{i}"] = _image_to_data_uri(p, max_image_size, image_quality)
    elif wf["kind"] == "audio":
        for i, p in enumerate(img_paths):
            body[f"ref_image_{i}"] = _image_to_data_uri(p, max_image_size, image_quality)
        for i, a in enumerate(audio_paths):
            body[f"ref_audio_{i}"] = _audio_to_data_uri(a)
    # t2v: 无附加参数

    if cb:
        cb("提交任务中")

    task_id = _submit_task(api_key, wf_id, body)

    # 进度估算：实测约 10~20 秒/视频秒
    est_seconds = max(90, duration * 15)
    if cb:
        cb("排队中")
    results = _poll_task(api_key, task_id, timeout, poll_interval, est_seconds, cb)

    video_url = None
    for item in results:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or ""
        if item.get("type") == "video" or url.lower().endswith(".mp4"):
            video_url = url
            break
    if not video_url and results:
        first = results[0]
        video_url = first.get("url") if isinstance(first, dict) else None
    if not video_url:
        raise Exception("PLUGIN_ERROR:::任务成功但未返回视频URL，请稍后在 AutoDL 平台查看任务记录")

    if cb:
        cb("下载中", 95)

    viewer_index = int(context.get("viewer_index", 0))
    unique_name = context.get("unique_name", "unknown")
    generation_round = int(context.get("generation_round", 0))
    positions = context.get("output_position") or [0]
    out_dir = context.get("project_path") or context.get("output_dir") or "."
    os.makedirs(out_dir, exist_ok=True)

    result_paths = []
    first_dst = None
    for pos in positions:
        name = f"{viewer_index:04d}_{unique_name}_{generation_round}_{pos}.mp4"
        dst = os.path.abspath(os.path.join(out_dir, name))
        if first_dst is None:
            _download_video(video_url, dst)
            first_dst = dst
        else:
            shutil.copyfile(first_dst, dst)
            _log(f"已复制到: {dst}")
        result_paths.append(dst)

    if cb:
        cb("生成中", 100)
    _log(f"生成完成: {len(result_paths)} 个文件, task_id={task_id}")
    return result_paths


# --------------------- UI 动作 ---------------------

def handle_action(action, data=None):
    if data is None:
        data = {}

    if action == "test_connection":
        params = get_params()
        api_key = (params.get("api_key") or "").strip()
        if not api_key:
            return {"ok": False, "error": "API令牌未填写"}
        try:
            # 用非法分辨率探测令牌有效性：参数校验失败=令牌有效，不会产生费用
            resp = requests.post(
                f"{_API_BASE}/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_no_pic",
                headers=_api_headers(api_key),
                json={"prompt": "test", "resolution": "__probe__"},
                timeout=30,
            )
            if resp.status_code in (401, 403):
                return {"ok": False, "error": f"令牌无效或无权限 (HTTP {resp.status_code})"}
            try:
                jd = resp.json()
            except ValueError:
                return {"ok": False, "error": f"响应异常: HTTP {resp.status_code}"}
            msg = str(jd.get("msg") or "")
            code = jd.get("code") or ""
            if code == "RequestParameterIsWrong" or "参数" in msg:
                return {"ok": True, "message": "令牌有效（参数校验已通过）"}
            if code == "Success":
                return {"ok": True, "message": "令牌有效"}
            if code in ("BadRequest",):
                return {"ok": False, "error": f"请求被拒绝: {msg}"}
            return {"ok": False, "error": f"未知响应: {code} {msg}"}
        except requests.exceptions.RequestException as e:
            return {"ok": False, "error": f"网络异常: {e}"}

    if action == "get_workflows":
        return {"ok": True, "workflows": {k: v["name"] for k, v in WORKFLOWS.items()}}

    return {"ok": False, "error": f"未知动作: {action}"}
