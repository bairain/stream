# -*- coding: utf-8 -*-
"""STREAM - 本地视频管理器

扫描媒体根目录（含子目录）中的视频文件，提供：
- /api/library      媒体库列表（按子目录分类）
- /api/thumb        视频封面（OpenCV 抽帧，本地缓存）
- /api/video        HTTP Range 流式播放
- /api/config       媒体根目录设置
"""
import base64
import hashlib
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path, PurePosixPath

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

# PyInstaller 打包后（客户端模式）：配置/数据放 exe 旁边，静态资源从打包目录读
IS_FROZEN = bool(getattr(sys, "frozen", False))
if IS_FROZEN:
    BASE_DIR = Path(sys.executable).resolve().parent
    STATIC_DIR = Path(getattr(sys, "_MEIPASS", "")) / "static"
else:
    BASE_DIR = Path(__file__).resolve().parent
    STATIC_DIR = BASE_DIR / "static"
CONFIG_PATH = BASE_DIR / "config.json"
THUMB_DIR = BASE_DIR / ".thumbs"

VIDEO_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".rmvb", ".rm", ".3gp", ".vob", ".ogv",
}
# 浏览器 <video> 一般可直接解码的格式
PLAYABLE_EXTS = {".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv"}
MIME_MAP = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".ogv": "video/ogg", ".avi": "video/x-msvideo",
}

DEFAULT_CONFIG = {
    "media_root": "", "port": 8501, "player_mode": "web",
    "external_player": "default",   # default | vlc | mpv | custom
    "player_path": "",              # external_player = custom 时的播放器程序路径
    "card_size": "medium",          # small | medium | large
    "card_ratio": "16:9",           # 16:9 | 21:9 | 4:3 | 3:4 | 9:16
    "card_title": False,            # 在卡片上直接显示文件/剧集名
    "lan_mode": False,              # 局域网模式：广播到局域网，远程设备不能改目录
}

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text("utf-8")))
        except Exception:
            pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def get_media_root() -> Path:
    cfg = load_config()
    root = cfg.get("media_root", "").strip()
    if root:
        return Path(root)
    default = BASE_DIR / "media"
    default.mkdir(exist_ok=True)
    return default

# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def encode_id(relpath: str) -> str:
    return base64.urlsafe_b64encode(relpath.encode("utf-8")).decode("ascii")


def decode_id(item_id: str) -> str:
    try:
        return base64.urlsafe_b64decode(item_id.encode("ascii")).decode("utf-8")
    except Exception:
        raise HTTPException(400, "非法的视频 ID")


_short_cache: dict[str, str] = {}


def _short_path(p: Path) -> str:
    """Windows 下 OpenCV 无法打开含中文的路径，转成 8.3 短路径绕过。"""
    s = str(p)
    if os.name != "nt" or s.isascii():
        return s
    if s in _short_cache:
        return _short_cache[s]
    out = s
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetShortPathNameW(s, buf, 32768):
            out = buf.value
    except Exception:
        pass
    _short_cache[s] = out
    return out


def res_label(width: int | None, height: int | None) -> str | None:
    if not width:
        return None
    if width >= 3700 or (height and height >= 2000):
        return "4K"
    if width >= 1800:
        return "1080P"
    if width >= 1200:
        return "720P"
    return "SD"


def _natkey(s: str) -> list:
    """自然排序键：让 EP2 排在 EP10 前面。"""
    return [(0, int(t)) if t.isdigit() else (1, t.lower())
            for t in re.split(r"(\d+)", s)]


def thumb_cache_path(item: dict) -> Path:
    # 用完整 SHA1 命名，确保每个视频独立缓存。
    # （旧版用 base64(key)[:48] 截断，同季度各分集前缀相同导致缓存名冲突，
    #   所有分集共用第一集的封面——这正是"每集封面都一样"的根因）
    key = f"v3_{item['id']}_{item['mtime']}_{item['size']}"
    return THUMB_DIR / (hashlib.sha1(key.encode("utf-8")).hexdigest() + ".jpg")


def _frame_score(frame) -> float:
    """帧质量评分：清晰度（Laplacian 方差）+ 色彩丰富度，排除近黑/近白帧。"""
    h, w = frame.shape[:2]
    if h > 240:
        small = cv2.resize(frame, (max(1, int(w * 240 / h)), 240), interpolation=cv2.INTER_AREA)
    else:
        small = frame
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    bright = float(gray.mean())
    if bright < 22 or bright > 232:  # 黑场 / 白屏（OP、字幕板等）
        return -1.0
    sharp = cv2.Laplacian(gray, cv2.CV_64F).var()
    color = float(np.mean([small[:, :, i].std() for i in range(3)]))
    return sharp * (1.0 - 0.5 * abs(bright - 120) / 120.0) + color * 3.0


def _sample_positions(path: Path, n: int = 7) -> list[float]:
    """按文件路径生成稳定的伪随机采样点（比例 0-1）。

    不同剧集得到不同采样点，避免同一剧集每集都恰好落在相同 OP 画面；
    路径不变则采样点不变，重建缓存结果依然稳定。
    """
    seed = int(hashlib.md5(str(path).encode("utf-8", "replace")).hexdigest()[:8], 16)
    rng = random.Random(seed)
    span = 0.84                       # 避开片头 8% 与片尾 8%
    base = [0.08 + span * (i + 0.5) / n for i in range(n)]
    jitter = span / n * 0.45
    return [min(0.94, max(0.06, b + rng.uniform(-jitter, jitter))) for b in base]


def _ahash(frame) -> int:
    """64 位感知哈希（8x8 均值哈希），用于判断两帧画面是否相似。"""
    small = cv2.resize(frame, (8, 8), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    avg = gray.mean()
    h = 0
    for i, v in enumerate(gray.flatten()):
        if v > avg:
            h |= 1 << i
    return h


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def extract_frame(path: Path, avoid_hashes: list[int] | None = None):
    """多点采样抽帧：在视频多个时间点取帧，选清晰且色彩最丰富的一帧。

    avoid_hashes：同剧其他集已采用封面的感知哈希。与它们相似的候选帧会被
    大幅降权，从而让同一剧集的各集封面尽量取自不同场景。
    """
    cap = cv2.VideoCapture(_short_path(path))
    if not cap.isOpened():
        return None
    try:
        frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        dur_ms = (frames / fps * 1000.0) if (fps > 0 and frames and frames > 0) else 0.0
        best, best_score = None, -1.0
        if dur_ms > 0:
            for pos in _sample_positions(path):
                cap.set(cv2.CAP_PROP_POS_MSEC, dur_ms * pos)
                ok, frame = cap.read()
                if not ok or frame is None:
                    continue
                score = _frame_score(frame)
                if score < 0:
                    continue
                if avoid_hashes and any(_hamming(_ahash(frame), a) <= 10 for a in avoid_hashes):
                    score *= 0.3  # 与同剧其他集封面高度相似，降权
                if score > best_score:
                    best, best_score = frame, score
                if best_score > 1500:  # 已足够清晰，提前结束
                    break
        if best is not None:
            return best
        # 兜底：直接读前几帧
        cap.set(cv2.CAP_PROP_POS_MSEC, 0)
        for _ in range(10):
            ok, frame = cap.read()
            if ok and frame is not None:
                return frame
        return None
    finally:
        cap.release()

# ---------------------------------------------------------------------------
# 媒体库状态（后台线程扫描 + 补充元数据）
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_thumb_lock = threading.Lock()
_enrich_cancel = threading.Event()  # 置位后运行中的封面生成线程尽快退出
_items: list[dict] = []
_by_id: dict[str, dict] = {}
_scan_complete = True
_root: Path = get_media_root()


def scan_library_sync() -> None:
    """层级扫描：根目录/类别/影片/分集目录/视频文件。

    - 一级子目录  = 类别（如 电影、番剧）→ 顶栏导航
    - 二级子目录  = 具体影片（剧集名）；类别下的散落视频 = 单部电影
    - 影片目录内  = 分集视频；更深的子目录 = 分集目录（如 第一季），可任意嵌套
    - 根目录散落的视频 → 归入"其他"
    """
    global _items, _by_id, _root, _scan_complete
    root = get_media_root()
    found: list[dict] = []

    def add_video(p: Path, category: str, show: str, season: str | None, is_movie: bool) -> None:
        ext = p.suffix.lower()
        if ext not in VIDEO_EXTS:
            return
        try:
            st = p.stat()
        except OSError:
            return
        found.append({
            "id": encode_id(p.relative_to(root).as_posix()),
            "title": p.stem,
            "category": category,
            "show": show,
            "season": season,
            "is_movie": is_movie,
            "relpath": p.relative_to(root).as_posix(),
            "ext": ext.lstrip("."),
            "size": st.st_size,
            "mtime": st.st_mtime,
            "duration": None,
            "width": None,
            "height": None,
            "res_label": None,
            "playable": ext in PLAYABLE_EXTS,
        })

    if root.is_dir():
        for level1 in sorted(root.iterdir(), key=lambda p: p.name):
            if not level1.is_dir():
                add_video(level1, "其他", level1.stem, None, True)
                continue
            category = level1.name
            for level2 in sorted(level1.iterdir(), key=lambda p: p.name):
                if level2.is_file():
                    add_video(level2, category, level2.stem, None, True)  # 单部电影
                    continue
                if not level2.is_dir():
                    continue
                show = level2.name
                for f in sorted(level2.iterdir(), key=lambda p: _natkey(p.name)):
                    add_video(f, category, show, None, False)  # 影片根下的正片
                for dirpath, _dirnames, filenames in os.walk(level2):
                    d = Path(dirpath)
                    if d == level2:
                        continue
                    season = "/".join(d.relative_to(level2).parts)
                    for fn in sorted(filenames, key=_natkey):
                        add_video(d / fn, category, show, season, False)

    found.sort(key=lambda x: (
        x["category"] != "其他",
        _natkey(x["category"]),
        _natkey(x["show"]),
        x["season"] is not None,
        _natkey(x["season"] or ""),
        _natkey(x["title"]),
    ))
    with _lock:
        _root = root
        _items = found
        _by_id = {it["id"]: it for it in found}
        _scan_complete = False


def enrich_worker(cancel: threading.Event) -> None:
    """后台生成封面缓存：读取分辨率/时长 + 多点采样抽帧。

    - 按剧分组：剧内按集数顺序处理，同剧已用封面的感知哈希会传给后续
      集数做避让（避免每集都是同一 OP/场景）；剧与剧之间 3 线程并行。
    - 缓存文件用完整 SHA1 命名，每个视频独立，绝无冲突。
    - cancel 置位后各线程尽快退出，且不会误标扫描完成。
    """
    global _scan_complete
    THUMB_DIR.mkdir(exist_ok=True)
    # 清理无效缓存：仅保留 sha1 命名的封面（旧 base64 截断名全部淘汰）
    try:
        for f in THUMB_DIR.iterdir():
            if f.is_file() and not re.fullmatch(r"[0-9a-f]{40}\.(jpg|bad)", f.name):
                f.unlink(missing_ok=True)
    except OSError:
        pass

    with _lock:
        snapshot = list(_items)
        by_id = dict(_by_id)
        root = _root

    # 按剧分组（保持扫描顺序，剧内自然按集数排序）
    shows: dict[str, list[dict]] = {}
    for item in snapshot:
        if item["id"] not in by_id:
            continue
        shows.setdefault(f"{item['category']}/{item['show']}", []).append(item)

    def process_show(show_key: str, items: list[dict]) -> None:
        used_hashes: list[int] = []

        def remember(frame) -> None:
            try:
                used_hashes.append(_ahash(frame))
                del used_hashes[:-16]
            except Exception:
                pass

        for item in items:
            if cancel.is_set():
                return
            path = root / PurePosixPath(item["relpath"])
            # 元数据
            try:
                cap = cv2.VideoCapture(_short_path(path))
                if cap.isOpened():
                    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or None
                    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or None
                    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                    fps = cap.get(cv2.CAP_PROP_FPS) or 0
                    dur = (frames / fps) if (fps > 0 and frames and frames > 0) else None
                    cap.release()
                else:
                    w = h = dur = None
            except Exception:
                w = h = dur = None
            item["width"], item["height"] = w, h
            item["duration"] = round(dur, 1) if dur else None
            item["res_label"] = res_label(w, h)
            # 封面（已有缓存或失败标记则跳过抽帧）
            cache = thumb_cache_path(item)
            if cache.with_suffix(".bad").exists():
                continue
            if cache.exists():
                # 已有封面：把它的感知哈希记入同剧列表，供后续集数避让
                try:
                    img = cv2.imdecode(np.fromfile(str(cache), dtype=np.uint8), cv2.IMREAD_COLOR)
                    if img is not None:
                        remember(img)
                except Exception:
                    pass
                continue
            try:
                frame = extract_frame(path, avoid_hashes=used_hashes)
            except Exception:
                frame = None
            if frame is None:
                try:
                    cache.with_suffix(".bad").write_bytes(b"")
                except OSError:
                    pass
            else:
                ih, iw = frame.shape[:2]
                if iw > 640:
                    frame = cv2.resize(frame, (640, int(ih * 640 / iw)), interpolation=cv2.INTER_AREA)
                ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
                if ok:
                    try:
                        cache.write_bytes(buf.tobytes())
                        remember(frame)
                    except OSError:
                        pass

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=3) as ex:
        for show_key, items in shows.items():
            ex.submit(process_show, show_key, items)

    if not cancel.is_set():
        with _lock:
            _scan_complete = True


def start_rescan() -> None:
    def worker():
        scan_library_sync()
        ev = threading.Event()
        global _enrich_cancel
        _enrich_cancel = ev  # 每次运行持有独立取消信号，旧线程不受新运行影响
        enrich_worker(ev)
    threading.Thread(target=worker, daemon=True).start()

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------

app = FastAPI(title="STREAM", docs_url=None, redoc_url=None)


@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/library")
def api_library():
    with _lock:
        items = [dict(it) for it in _items]
        complete = _scan_complete
        root = str(_root)
    return {"root": root, "scan_complete": complete, "items": items}


@app.post("/api/scan")
def api_scan():
    start_rescan()
    return {"ok": True}


def _local_ip() -> str:
    """获取本机局域网 IP（UDP connect 不实际发包）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _is_local(host: str) -> bool:
    """判断请求来源是否为本机（127.0.0.1 / ::1 / 本机局域网 IP）。"""
    if not host:
        return True
    if host in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        return host == _local_ip()
    except OSError:
        return False


@app.get("/api/config")
def api_get_config(req: Request):
    cfg = load_config()
    return {
        "media_root": str(get_media_root()),
        "player_mode": cfg.get("player_mode", "web"),
        "external_player": cfg.get("external_player", "default"),
        "player_path": cfg.get("player_path", ""),
        "card_size": cfg.get("card_size", "medium"),
        "card_ratio": cfg.get("card_ratio", "16:9"),
        "card_title": bool(cfg.get("card_title", False)),
        "lan_mode": bool(cfg.get("lan_mode", False)),
        "client_local": _is_local(req.client.host if req.client else ""),
        "lan_url": f"http://{_local_ip()}:{int(cfg.get('port') or 8501)}",
        "configurable": True,
    }


@app.post("/api/config")
async def api_set_config(req: Request):
    body = await req.json()
    cfg = load_config()
    old_root = str(get_media_root())
    client_local = _is_local(req.client.host if req.client else "")
    root = str(body.get("media_root", "")).strip()
    if not root or not Path(root).is_dir():
        raise HTTPException(400, "目录不存在，请输入已存在的文件夹路径")
    if root != old_root and not client_local:
        raise HTTPException(403, "局域网客户端无法修改媒体目录")
    cfg["media_root"] = root
    mode = body.get("player_mode")
    if mode is not None:
        if mode not in ("web", "system"):
            raise HTTPException(400, "player_mode 只能是 web 或 system")
        if mode == "system" and not client_local:
            raise HTTPException(403, "局域网客户端无法使用系统播放器")
        cfg["player_mode"] = mode
    ext = body.get("external_player")
    if ext is not None:
        if ext not in ("default", "vlc", "mpv", "custom"):
            raise HTTPException(400, "external_player 只能是 default / vlc / mpv / custom")
        cfg["external_player"] = ext
    if body.get("player_path") is not None:
        cfg["player_path"] = str(body.get("player_path")).strip()
    if cfg.get("external_player") == "custom" and not cfg.get("player_path"):
        raise HTTPException(400, "选择自定义播放器时需要填写程序路径")
    size = body.get("card_size")
    if size is not None:
        if size not in ("small", "medium", "large"):
            raise HTTPException(400, "card_size 只能是 small / medium / large")
        cfg["card_size"] = size
    ratio = body.get("card_ratio")
    if ratio is not None:
        if ratio not in ("16:9", "21:9", "4:3", "3:4", "9:16"):
            raise HTTPException(400, "card_ratio 只能是 16:9 / 21:9 / 4:3 / 3:4 / 9:16")
        cfg["card_ratio"] = ratio
    if body.get("card_title") is not None:
        cfg["card_title"] = bool(body.get("card_title"))
    if body.get("lan_mode") is not None:
        cfg["lan_mode"] = bool(body.get("lan_mode"))
    save_config(cfg)
    if root != old_root:
        start_rescan()  # 目录变化才重新扫描
    return {
        "ok": True, "media_root": root,
        "player_mode": cfg["player_mode"],
        "external_player": cfg["external_player"],
        "player_path": cfg.get("player_path", ""),
        "card_size": cfg["card_size"],
        "card_ratio": cfg["card_ratio"],
        "card_title": cfg.get("card_title", False),
        "lan_mode": cfg.get("lan_mode", False),
    }


def _find_player(name: str):
    """查找 VLC / MPV 可执行文件。"""
    exe = shutil.which(name)
    if exe:
        return exe
    candidates = {
        "vlc": [
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        ],
        "mpv": [
            r"C:\Program Files\mpv\mpv.exe",
            r"C:\Program Files (x86)\mpv\mpv.exe",
            str(Path.home() / "scoop" / "apps" / "mpv" / "current" / "mpv.exe"),
            str(Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Links" / "mpv.exe"),
        ],
    }.get(name, [])
    for c in candidates:
        if Path(c).is_file():
            return c
    return None


@app.post("/api/open-external")
def api_open_external(id: str, req: Request):
    """按设置用外部播放器打开视频文件（系统默认 / VLC / MPV / 自定义）。"""
    if not _is_local(req.client.host if req.client else ""):
        raise HTTPException(403, "局域网客户端无法使用系统播放器")
    with _lock:
        item = _by_id.get(id)
    if item is None:
        raise HTTPException(404, "视频不存在")
    path = _root / PurePosixPath(item["relpath"])
    if not path.is_file():
        raise HTTPException(404, "文件已被移动或删除")
    cfg = load_config()
    choice = cfg.get("external_player", "default")
    try:
        if choice in ("vlc", "mpv"):
            exe = _find_player(choice)
            if not exe:
                raise HTTPException(400, f"未找到 {choice.upper()}，请安装后重试，或在设置中改用其它播放器")
            subprocess.Popen([exe, str(path)])
        elif choice == "custom":
            exe = (cfg.get("player_path") or "").strip()
            if not exe or not Path(exe).is_file():
                raise HTTPException(400, "自定义播放器路径无效，请在设置中重新选择")
            subprocess.Popen([exe, str(path)])
        else:
            startfile = getattr(os, "startfile", None)
            if startfile is not None:  # Windows
                startfile(str(path))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"无法启动播放器：{e}")
    return {"ok": True}


def _serve_thumb(item: dict):
    """返回视频封面（优先缓存，否则即时抽帧并写入缓存）。"""
    cache = thumb_cache_path(item)
    headers = {"Cache-Control": "public, max-age=604800"}
    if cache.exists():
        return FileResponse(cache, media_type="image/jpeg", headers=headers)
    if cache.with_suffix(".bad").exists():
        raise HTTPException(404, "无法生成封面")
    with _thumb_lock:
        if cache.exists():
            return FileResponse(cache, media_type="image/jpeg", headers=headers)
        THUMB_DIR.mkdir(exist_ok=True)
        try:
            frame = extract_frame(_root / PurePosixPath(item["relpath"]))
        except Exception:
            frame = None
        if frame is None:
            try:
                cache.with_suffix(".bad").write_bytes(b"")
            except OSError:
                pass
            raise HTTPException(404, "无法生成封面")
        ih, iw = frame.shape[:2]
        if iw > 640:
            frame = cv2.resize(frame, (640, int(ih * 640 / iw)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if not ok:
            raise HTTPException(500, "封面编码失败")
        cache.write_bytes(buf.tobytes())
    return FileResponse(cache, media_type="image/jpeg", headers=headers)


@app.get("/api/thumb")
def api_thumb(id: str):
    with _lock:
        item = _by_id.get(id)
    if item is None:
        raise HTTPException(404, "视频不存在")
    return _serve_thumb(item)


def _custom_cover_path(show_key: str) -> Path:
    return THUMB_DIR / "custom" / (base64.urlsafe_b64encode(show_key.encode()).decode("ascii")[:96] + ".jpg")


@app.get("/api/poster")
def api_poster(show_key: str, first: str = ""):
    """剧目封面：优先自定义封面，否则回退到第一集的自动封面。"""
    custom = _custom_cover_path(show_key)
    if custom.is_file():
        return FileResponse(custom, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=604800"})
    with _lock:
        item = _by_id.get(first)
    if item is None:
        raise HTTPException(404, "视频不存在")
    return _serve_thumb(item)


@app.post("/api/custom-cover")
async def api_custom_cover(req: Request):
    """为剧目（类别/影片名）设置自定义封面图片。"""
    body = await req.json()
    show_key = str(body.get("show_key", "")).strip()
    image_path = str(body.get("image_path", "")).strip()
    if not show_key or "/" not in show_key:
        raise HTTPException(400, "show_key 无效")
    p = Path(image_path)
    if not p.is_file():
        raise HTTPException(400, "图片文件不存在")
    try:
        img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        img = None
    if img is None:
        raise HTTPException(400, "无法读取图片，请使用 JPG / PNG / WebP / BMP")
    h, w = img.shape[:2]
    if h > 720:
        img = cv2.resize(img, (max(1, int(w * 720 / h)), 720), interpolation=cv2.INTER_AREA)
    out = _custom_cover_path(show_key)
    out.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise HTTPException(500, "图片编码失败")
    out.write_bytes(buf.tobytes())
    return {"ok": True}


@app.delete("/api/custom-cover")
def api_delete_custom_cover(show_key: str):
    """删除自定义封面，恢复自动封面。"""
    try:
        _custom_cover_path(show_key).unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True}


# ---------------------------------------------------------------------------
# 观看历史 / 自定义栏目（JSON 持久化）
# ---------------------------------------------------------------------------

DATA_DIR = BASE_DIR / ".data"
HISTORY_PATH = DATA_DIR / "history.json"
COLLECTIONS_PATH = DATA_DIR / "collections.json"

_data_lock = threading.Lock()


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return default


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


@app.get("/api/history")
def api_history():
    """观看历史（按播放时间倒序，附带媒体库条目详情）。"""
    entries = _load_json(HISTORY_PATH, [])
    with _lock:
        items = {it["id"]: it for it in _items}
    out = []
    for e in entries:
        it = items.get(e.get("id"))
        if it:
            d = dict(it)
            d["played_at"] = e.get("ts")
            out.append(d)
    return {"items": out}


@app.post("/api/history")
async def api_add_history(req: Request):
    body = await req.json()
    vid = str(body.get("id", ""))
    with _lock:
        exists = vid in _by_id
    if not exists:
        raise HTTPException(404, "视频不存在")
    with _data_lock:
        entries = _load_json(HISTORY_PATH, [])
        entries = [e for e in entries if e.get("id") != vid]
        entries.insert(0, {"id": vid, "ts": time.time()})
        _save_json(HISTORY_PATH, entries[:200])
    return {"ok": True}


@app.delete("/api/history")
def api_clear_history():
    """清空全部观看历史。"""
    with _data_lock:
        _save_json(HISTORY_PATH, [])
    return {"ok": True}


@app.get("/api/collections")
def api_collections():
    """自定义栏目列表：[{name, shows:[cat/show]}]。"""
    return {"items": _load_json(COLLECTIONS_PATH, [])}


@app.post("/api/collections")
async def api_add_collection(req: Request):
    name = str((await req.json()).get("name", "")).strip()
    if not name:
        raise HTTPException(400, "栏目名称不能为空")
    with _data_lock:
        cols = _load_json(COLLECTIONS_PATH, [])
        if any(c["name"] == name for c in cols):
            raise HTTPException(400, f"栏目「{name}」已存在")
        cols.append({"name": name, "shows": []})
        _save_json(COLLECTIONS_PATH, cols)
    return {"ok": True}


@app.delete("/api/collections")
def api_del_collection(name: str):
    with _data_lock:
        cols = _load_json(COLLECTIONS_PATH, [])
        _save_json(COLLECTIONS_PATH, [c for c in cols if c["name"] != name])
    return {"ok": True}


@app.post("/api/collections/item")
async def api_collection_item(req: Request):
    """向栏目加入/移除剧集：{name, show_key, action: add|remove}。"""
    body = await req.json()
    name = str(body.get("name", "")).strip()
    show_key = str(body.get("show_key", "")).strip()
    action = body.get("action", "add")
    if not name or "/" not in show_key:
        raise HTTPException(400, "参数无效")
    with _data_lock:
        cols = _load_json(COLLECTIONS_PATH, [])
        col = next((c for c in cols if c["name"] == name), None)
        if col is None:
            raise HTTPException(404, "栏目不存在")
        if action == "add":
            if show_key not in col["shows"]:
                col["shows"].insert(0, show_key)
        else:
            col["shows"] = [s for s in col["shows"] if s != show_key]
        _save_json(COLLECTIONS_PATH, cols)
    return {"ok": True}


# ---------------------------------------------------------------------------
# 个人数据导出 / 导入（观看历史 + 自定义栏目）
# ---------------------------------------------------------------------------

@app.get("/api/data/export")
def api_export_data():
    """导出个人数据为 JSON 文件下载（设置 + 观看历史 + 自定义栏目）。"""
    with _data_lock:
        history = _load_json(HISTORY_PATH, [])
        collections = _load_json(COLLECTIONS_PATH, [])
    payload = {
        "app": "stream",
        "version": 1,
        "exported_at": time.time(),
        "config": load_config(),
        "history": history,
        "collections": collections,
    }
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return JSONResponse(
        payload,
        headers={"Content-Disposition": f'attachment; filename="stream_data_{stamp}.json"'},
    )


@app.post("/api/data/import")
async def api_import_data(req: Request):
    """导入个人数据：整体替换观看历史与自定义栏目（自动清洗无效条目）。"""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "JSON 解析失败")
    if not isinstance(body, dict) or body.get("app") != "stream":
        raise HTTPException(400, "不是有效的 STREAM 数据文件")
    history, collections = body.get("history"), body.get("collections")
    if not isinstance(history, list) or not isinstance(collections, list):
        raise HTTPException(400, "数据格式无效")

    with _lock:
        valid_ids = set(_by_id.keys())
        valid_keys = {f"{it['category']}/{it['show']}" for it in _items}

    history_clean, seen = [], set()
    for e in history:
        if not isinstance(e, dict):
            continue
        vid = str(e.get("id", ""))
        if vid in valid_ids and vid not in seen:
            seen.add(vid)
            try:
                ts = float(e.get("ts"))
            except (TypeError, ValueError):
                ts = time.time()
            history_clean.append({"id": vid, "ts": ts})
    history_clean.sort(key=lambda x: -x["ts"])

    cols_clean, names = [], set()
    for c in collections:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        if not name or name in names:
            continue
        raw_shows = c.get("shows")
        shows, sseen = [], set()
        for k in raw_shows if isinstance(raw_shows, list) else []:
            k = str(k)
            if k in valid_keys and k not in sseen:
                sseen.add(k)
                shows.append(k)
        names.add(name)
        cols_clean.append({"name": name, "shows": shows})

    with _data_lock:
        _save_json(HISTORY_PATH, history_clean[:200])
        _save_json(COLLECTIONS_PATH, cols_clean)

    # 可选：应用设置数据（与 /api/config 相同的校验规则，无效项忽略）
    config_applied = False
    cfg_in = body.get("config")
    if isinstance(cfg_in, dict):
        cfg = load_config()
        old_root = str(get_media_root())
        root = str(cfg_in.get("media_root", "")).strip()
        if root and Path(root).is_dir():
            cfg["media_root"] = root
        mode = cfg_in.get("player_mode")
        if mode in ("web", "system"):
            cfg["player_mode"] = mode
        ext = cfg_in.get("external_player")
        if ext in ("default", "vlc", "mpv", "custom"):
            cfg["external_player"] = ext
        pp = cfg_in.get("player_path")
        if isinstance(pp, str):
            cfg["player_path"] = pp.strip()
        if cfg.get("external_player") == "custom" and not cfg.get("player_path"):
            cfg["external_player"] = "default"  # 导入数据不硬性报错，回退默认
        size = cfg_in.get("card_size")
        if size in ("small", "medium", "large"):
            cfg["card_size"] = size
        ratio = cfg_in.get("card_ratio")
        if ratio in ("16:9", "21:9", "4:3", "3:4", "9:16"):
            cfg["card_ratio"] = ratio
        if cfg_in.get("card_title") is not None:
            cfg["card_title"] = bool(cfg_in.get("card_title"))
        save_config(cfg)
        config_applied = True
        if str(cfg.get("media_root")) != old_root:
            start_rescan()  # 目录变化才重新扫描

    return {"ok": True, "history": len(history_clean),
            "collections": len(cols_clean), "config": config_applied}


@app.post("/api/regen-thumbs")
def api_regen_thumbs():
    """删除全部自动生成的封面缓存并重新提取（后台进行，不阻塞界面）。"""
    _enrich_cancel.set()  # 中断正在运行的封面生成
    time.sleep(0.3)       # 给在途条目一点收尾时间
    removed = 0
    try:
        for f in THUMB_DIR.iterdir():
            if f.is_file() and re.fullmatch(r"[0-9a-f]{40}\.(jpg|bad)", f.name):
                f.unlink(missing_ok=True)
                removed += 1
    except OSError:
        pass
    start_rescan()
    return {"ok": True, "removed": removed}


def _chunk_iter(f, start: int, end: int, chunk: int = 1024 * 1024):
    f.seek(start)
    remaining = end - start + 1
    while remaining > 0:
        data = f.read(min(chunk, remaining))
        if not data:
            break
        remaining -= len(data)
        yield data


@app.get("/api/video")
def api_video(request: Request, id: str):
    with _lock:
        item = _by_id.get(id)
    if item is None:
        raise HTTPException(404, "视频不存在")
    path = _root / PurePosixPath(item["relpath"])
    if not path.is_file():
        raise HTTPException(404, "文件已被移动或删除")
    size = path.stat().st_size
    ctype = MIME_MAP.get(item["ext"] and ("." + item["ext"]), "application/octet-stream")
    range_header = request.headers.get("range")
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        start = int(m.group(1)) if (m and m.group(1)) else 0
        end = int(m.group(2)) if (m and m.group(2)) else size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        headers = {
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "Cache-Control": "no-store",
        }
        f = open(path, "rb")
        return StreamingResponse(_chunk_iter(f, start, end), status_code=206,
                                 media_type=ctype, headers=headers)
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(size), "Cache-Control": "no-store"}
    f = open(path, "rb")
    return StreamingResponse(_chunk_iter(f, 0, size - 1), media_type=ctype, headers=headers)


_TK_SNIPPETS = {
    "folder": ("import tkinter as tk;from tkinter import filedialog;"
               "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
               "print(filedialog.askdirectory())"),
    "image": ("import tkinter as tk;from tkinter import filedialog;"
              "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
              "print(filedialog.askopenfilename("
              "filetypes=[('图片','*.jpg *.jpeg *.png *.webp *.bmp'),('所有文件','*.*')]))"),
    "exe": ("import tkinter as tk;from tkinter import filedialog;"
            "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
            "print(filedialog.askopenfilename("
            "filetypes=[('程序','*.exe'),('所有文件','*.*')]))"),
}

_PS_DIALOGS = {
    "folder": (
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description = '选择媒体文件夹';"
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [IO.File]::WriteAllText($env:STREAM_PICK_OUT, $d.SelectedPath, [Text.Encoding]::UTF8) }"
    ),
    "image": (
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        "$d.Filter = '图片 (*.jpg;*.jpeg;*.png;*.webp;*.bmp)|*.jpg;*.jpeg;*.png;*.webp;*.bmp|所有文件 (*.*)|*.*';"
        "$d.Title = '选择封面图片';"
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [IO.File]::WriteAllText($env:STREAM_PICK_OUT, $d.FileName, [Text.Encoding]::UTF8) }"
    ),
    "exe": (
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        "$d.Filter = '程序 (*.exe)|*.exe|所有文件 (*.*)|*.*';"
        "$d.Title = '选择播放器程序';"
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [IO.File]::WriteAllText($env:STREAM_PICK_OUT, $d.FileName, [Text.Encoding]::UTF8) }"
    ),
}


def _tk_dialog(code: str) -> dict:
    """开发模式：在独立子进程里跑 tkinter 对话框，避免 Tk 主线程限制与服务器线程冲突。"""
    try:
        out = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return {"canceled": True}
    path = (out.stdout or "").strip()
    if not path:
        return {"canceled": True}
    return {"path": path.replace("/", "\\")}


def _ps_dialog(script: str) -> dict:
    """客户端模式：用 PowerShell 弹系统对话框（结果经临时文件回传，避免中文编码问题）。"""
    fd, tmp = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    env = {**os.environ, "STREAM_PICK_OUT": tmp}
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command",
             "Add-Type -AssemblyName System.Windows.Forms | Out-Null;" + script],
            capture_output=True, timeout=300, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        with open(tmp, encoding="utf-8") as f:
            path = f.read().replace("\ufeff", "").strip()  # 剥掉 PowerShell 写入的 UTF-8 BOM
    except (subprocess.TimeoutExpired, OSError):
        return {"canceled": True}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not path:
        return {"canceled": True}
    return {"path": path.replace("/", "\\")}


def _pick_dialog(kind: str) -> dict:
    """弹出系统原生选择对话框；开发模式用 tkinter 子进程，客户端模式用 PowerShell。"""
    if IS_FROZEN:
        return _ps_dialog(_PS_DIALOGS[kind])
    return _tk_dialog(_TK_SNIPPETS[kind])


@app.post("/api/pick-folder")
def api_pick_folder():
    """弹出系统原生文件夹选择对话框（浏览器与服务器同机时可用）。"""
    return _pick_dialog("folder")


@app.post("/api/pick-image")
def api_pick_image():
    """弹出图片文件选择对话框（用于自定义封面）。"""
    return _pick_dialog("image")


@app.post("/api/pick-exe")
def api_pick_exe():
    """弹出程序文件选择对话框（用于自定义播放器路径）。"""
    return _pick_dialog("exe")


@app.exception_handler(HTTPException)
async def http_exc_handler(_req: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# 客户端窗口（Win11 原生窗口 + DWM 深色标题栏）
# ---------------------------------------------------------------------------

def _style_titlebar():
    """把系统标题栏染成页面同款深色，与网页顶栏无缝衔接。

    全部走 DWM 属性，拖动/Snap/圆角/阴影等系统行为不受影响：
    20/19 深色模式（按钮图标变亮色）；35 标题栏底色、36 文字色
    （与底色相同 → "STREAM" 字样隐入背景）、34 窗口边框色。
    """
    import ctypes
    import webview
    dwm = ctypes.windll.dwmapi
    ink = ctypes.c_int(0x00141414)  # COLORREF 0x00BBGGRR = #141414，与页面背景同色
    on = ctypes.c_int(1)
    err = None
    for _ in range(40):  # 句柄可能创建较晚或被重建，最多重试 20 秒
        try:
            hwnd = ctypes.c_void_p(webview.windows[0].native.Handle.ToInt64())
            dark = dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), 4) == 0
            if not dark:
                dark = dwm.DwmSetWindowAttribute(hwnd, 19, ctypes.byref(on), 4) == 0
            # 35/36/34 仅 Win11 支持，失败忽略（Win10 回退为深灰色标题栏）
            dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(ink), 4)  # DWMWA_CAPTION_COLOR
            dwm.DwmSetWindowAttribute(hwnd, 36, ctypes.byref(ink), 4)  # DWMWA_TEXT_COLOR
            dwm.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(ink), 4)  # DWMWA_BORDER_COLOR
            if dark:
                return
            err = "DwmSetWindowAttribute(20/19) != S_OK"
        except Exception as e:
            err = repr(e)
        time.sleep(0.5)
    try:  # 20 秒仍未生效才记日志，平时保持 stream.log 干净
        with open(BASE_DIR / "stream.log", "a", encoding="utf-8") as f:
            f.write(f"[titlebar] styling failed: {err}\n")
    except OSError:
        pass


if __name__ == "__main__":
    cfg = load_config()
    port = int(cfg.get("port") or 8501)
    host = "0.0.0.0" if cfg.get("lan_mode") else "127.0.0.1"  # 局域网模式广播到所有网卡
    log_kwargs = {}
    if IS_FROZEN:
        # 客户端模式（无控制台）：日志与崩溃 traceback 写到 exe 旁的 stream.log，便于排查
        log_path = BASE_DIR / "stream.log"
        try:
            log_f = open(log_path, "a", encoding="utf-8", buffering=1)
            log_cfg = dict(uvicorn.config.LOGGING_CONFIG)
            log_cfg["handlers"] = {
                "default": {"class": "logging.StreamHandler", "stream": log_f, "formatter": "default"},
                "access": {"class": "logging.StreamHandler", "stream": log_f, "formatter": "access"},
            }
            # 窗口模式 sys.stdout 为 None，uvicorn 的彩色格式器会调 isatty() 崩溃 → 换普通格式
            log_cfg["formatters"] = {
                "default": {"format": "%(asctime)s [%(levelname)s] %(message)s"},
                "access": {"format": "%(asctime)s %(message)s"},
            }
            log_kwargs["log_config"] = log_cfg
        except OSError:
            pass

    def _serve():
        uvicorn.run(app, host=host, port=port, log_level="warning", **log_kwargs)

    try:
        get_media_root()  # 确保默认媒体目录存在
        start_rescan()    # 启动时扫描媒体库
        if not IS_FROZEN or Path(sys.executable).stem.upper().endswith("WEB"):
            # STREAM_Web 浏览器版 / 开发模式：起服务器，跳系统浏览器打开
            if not os.environ.get("STREAM_NO_BROWSER"):
                threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
            _serve()
        else:
            # STREAM 客户端版：起服务器线程 → 等端口就绪 → Win11 原生窗口
            threading.Thread(target=_serve, daemon=True).start()
            for _ in range(75):  # 最多等 15 秒端口就绪再开窗
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                        break
                except OSError:
                    time.sleep(0.2)
            import webview
            webview.create_window("STREAM", f"http://127.0.0.1:{port}",
                                  width=1440, height=880, min_size=(960, 600))
            webview.start(_style_titlebar)
            os._exit(0)  # 关窗即退出，不等待后台线程
    except BaseException:
        if IS_FROZEN:
            import traceback
            try:
                with open(BASE_DIR / "stream.log", "a", encoding="utf-8") as f:
                    traceback.print_exc(file=f)
            except OSError:
                pass
        raise
