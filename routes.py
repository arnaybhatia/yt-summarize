import os
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile

import yt_dlp
from flask import Blueprint, jsonify, request, send_file

api = Blueprint("api", __name__)

MEDIA_URL_RE = re.compile(r"https://[^\"'<>\\]+")
VSCO_MEDIA_HINT_RE = re.compile(r"\.(?:jpg|jpeg|png|webp|mp4)(?:\?|$)", re.IGNORECASE)
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
DIRECT_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}


def _cleanup_dir(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _find_files(directory: str) -> list[str]:
    return [
        os.path.join(directory, fname)
        for fname in sorted(os.listdir(directory))
        if os.path.isfile(os.path.join(directory, fname))
    ]


def _sanitize_filename(value: str, fallback: str) -> str:
    safe = "".join(c for c in (value or fallback) if c.isalnum() or c in " ._-").strip()
    return safe or fallback


def _guess_platform(url: str, extractor_key: str | None = None) -> str:
    lower_url = url.lower()
    lower_key = (extractor_key or "").lower()
    if "vsco" in lower_url or "vsco" in lower_key:
        return "vsco"
    if "instagram" in lower_url or "instagram" in lower_key:
        return "instagram"
    if "tiktok" in lower_url or "tiktok" in lower_key:
        return "tiktok"
    if "youtube" in lower_url or "youtu.be" in lower_url or "youtube" in lower_key:
        return "youtube"
    return "media"


def _base_ydl_opts() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "extract_flat": False,
        "http_headers": {"User-Agent": DEFAULT_UA},
    }


def _fetch_yt_info(url: str) -> dict:
    with yt_dlp.YoutubeDL(_base_ydl_opts()) as ydl:
        return ydl.extract_info(url, download=False)


def _pick_best_format(formats: list[dict], *, ext: str | None = None, height: int | None = None) -> dict | None:
    candidates = []
    for fmt in formats:
        if fmt.get("vcodec") in {None, "none"}:
            continue
        if ext and fmt.get("ext") != ext:
            continue
        fmt_height = fmt.get("height") or 0
        if height and fmt_height != height:
            continue
        candidates.append(fmt)

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda fmt: (
            fmt.get("height") or 0,
            fmt.get("fps") or 0,
            fmt.get("tbr") or 0,
            fmt.get("filesize") or 0,
        ),
    )


def _build_video_options(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    heights = sorted(
        {
            fmt.get("height")
            for fmt in formats
            if fmt.get("vcodec") not in {None, "none"} and fmt.get("height")
        },
        reverse=True,
    )
    options = []
    seen = set()

    for height in heights:
        selector = (
            f"bestvideo[ext=mp4][height<={height}]+bestaudio[ext=m4a]/"
            f"best[ext=mp4][height<={height}]/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        )
        key = ("mp4", height)
        if key in seen:
            continue
        seen.add(key)
        options.append(
            {
                "id": f"video-mp4-{height}",
                "kind": "video",
                "container": "mp4",
                "label": f"MP4 {height}p",
                "selector": selector,
                "height": height,
            }
        )

    best_overall = _pick_best_format(formats)
    if best_overall:
        ext = best_overall.get("ext") or "video"
        height = best_overall.get("height") or "best"
        options.append(
            {
                "id": f"video-best-{ext}-{height}",
                "kind": "video",
                "container": ext,
                "label": f"Best available ({ext.upper()} {height}p)" if isinstance(height, int) else f"Best available ({ext.upper()})",
                "selector": "bestvideo+bestaudio/best",
                "height": best_overall.get("height"),
            }
        )

    return options[:8]


def _build_audio_options() -> list[dict]:
    bitrates = [320, 192, 128]
    return [
        {
            "id": f"audio-mp3-{bitrate}",
            "kind": "audio",
            "container": "mp3",
            "bitrate": bitrate,
            "label": f"MP3 {bitrate} kbps",
            "selector": "bestaudio/best",
        }
        for bitrate in bitrates
    ]


def _entry_ext(entry: dict) -> str:
    url = entry.get("url", "")
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    if "." in path:
        return path.rsplit(".", 1)[-1]
    return (entry.get("ext") or "").lower()


def _extract_vsco_media(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else "VSCO media"

    raw_urls = []
    for match in MEDIA_URL_RE.findall(html):
        cleaned = match.replace("\\u002F", "/").replace("\\/", "/")
        cleaned = cleaned.replace("&amp;", "&")
        if "vsco" not in cleaned.lower():
            continue
        if VSCO_MEDIA_HINT_RE.search(cleaned):
            raw_urls.append(cleaned)

    seen = set()
    entries = []
    for media_url in raw_urls:
        normalized = media_url.split('"')[0]
        normalized = normalized.split("'")[0]
        if normalized in seen:
            continue
        seen.add(normalized)

        ext = _entry_ext({"url": normalized})
        if ext in DIRECT_IMAGE_EXTENSIONS:
            media_type = "image"
        elif ext == "mp4":
            media_type = "video"
        else:
            continue

        entries.append(
            {
                "url": normalized,
                "ext": ext,
                "media_type": media_type,
            }
        )

    if not entries:
        raise ValueError("No downloadable VSCO media found on this page.")

    return {
        "title": title,
        "platform": "vsco",
        "extractor_key": "VSCO",
        "entries": entries,
    }


def _get_media_info(url: str) -> dict:
    if "vsco.co" in url.lower():
        return _extract_vsco_media(url)

    info = _fetch_yt_info(url)
    info["platform"] = _guess_platform(url, info.get("extractor_key"))
    return info


def _build_media_options(url: str) -> dict:
    info = _get_media_info(url)
    platform = info.get("platform") or _guess_platform(url, info.get("extractor_key"))
    entries = info.get("entries") or []
    has_gallery = bool(entries)

    options = []
    if platform != "vsco":
        options.extend(_build_audio_options())
        if info.get("formats"):
            options.extend(_build_video_options(info))

    if platform == "vsco":
        image_count = sum(1 for entry in entries if entry.get("media_type") == "image")
        video_count = sum(1 for entry in entries if entry.get("media_type") == "video")
        if image_count:
            options.append(
                {
                    "id": "vsco-images-original",
                    "kind": "image",
                    "container": "zip" if image_count > 1 else "jpg",
                    "label": "Original image" if image_count == 1 else f"Original images ({image_count})",
                }
            )
        if video_count:
            options.append(
                {
                    "id": "vsco-videos-original",
                    "kind": "video",
                    "container": "zip" if video_count > 1 else "mp4",
                    "label": "Original video" if video_count == 1 else f"Original videos ({video_count})",
                }
            )
    elif has_gallery:
        options.append(
            {
                "id": "post-original",
                "kind": "mixed",
                "container": "zip",
                "label": f"Original post media ({len(entries)})",
            }
        )

    return {
        "title": info.get("title") or "Media",
        "platform": platform,
        "is_gallery": has_gallery,
        "options": options,
        "transcription_recommendation": (
            "Run Whisper in your browser/computer. Let the Raspberry Pi focus on downloads and API work."
        ),
    }


def _download_direct_file(url: str, destination: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_UA})
    with urllib.request.urlopen(req, timeout=60) as resp, open(destination, "wb") as f:
        shutil.copyfileobj(resp, f)


def _zip_files(files: list[str], archive_path: str) -> str:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in files:
            zf.write(file_path, arcname=os.path.basename(file_path))
    return archive_path


def _build_download_filename(title: str, suffix: str, ext: str) -> str:
    base = _sanitize_filename(title, "download")
    suffix_part = f"_{suffix}" if suffix else ""
    return f"{base}{suffix_part}.{ext}"


def _download_with_ytdlp(url: str, option: dict, title: str) -> tuple[str, str, str]:
    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "download.%(ext)s")
    kind = option.get("kind")
    container = option.get("container")

    ydl_opts = {
        **_base_ydl_opts(),
        "outtmpl": output_template,
        "format": option.get("selector") or "best",
        "merge_output_format": "mp4" if kind == "video" and container == "mp4" else None,
    }

    if kind == "audio":
        bitrate = str(option.get("bitrate") or 320)
        ydl_opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": bitrate,
            }
        ]
        ydl_opts["keepvideo"] = False
    elif option.get("id") == "post-original":
        ydl_opts["format"] = "best"

    ydl_opts = {k: v for k, v in ydl_opts.items() if v is not None}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(url, download=True)

    files = _find_files(tmp_dir)
    if not files:
        _cleanup_dir(tmp_dir)
        raise ValueError("Download produced no files.")

    if len(files) == 1:
        file_path = files[0]
        ext = os.path.splitext(file_path)[1].lstrip(".").lower() or container or "bin"
        return tmp_dir, file_path, _build_download_filename(title, option.get("id", kind), ext)

    archive_path = os.path.join(tmp_dir, "bundle.zip")
    _zip_files(files, archive_path)
    return tmp_dir, archive_path, _build_download_filename(title, option.get("kind", "media"), "zip")


def _download_vsco_media(url: str, option: dict, title: str) -> tuple[str, str, str]:
    info = _extract_vsco_media(url)
    entries = info["entries"]

    if option["kind"] == "image":
        entries = [entry for entry in entries if entry["media_type"] == "image"]
    elif option["kind"] == "video":
        entries = [entry for entry in entries if entry["media_type"] == "video"]

    if not entries:
        raise ValueError("No matching VSCO media found for that option.")

    tmp_dir = tempfile.mkdtemp()
    downloaded = []
    for idx, entry in enumerate(entries, start=1):
        ext = entry["ext"] or ("jpg" if entry["media_type"] == "image" else "mp4")
        dest = os.path.join(tmp_dir, f"{idx:02d}.{ext}")
        _download_direct_file(entry["url"], dest)
        downloaded.append(dest)

    if len(downloaded) == 1:
        ext = os.path.splitext(downloaded[0])[1].lstrip(".").lower()
        suffix = "image" if option["kind"] == "image" else "video"
        return tmp_dir, downloaded[0], _build_download_filename(title, suffix, ext)

    archive_path = os.path.join(tmp_dir, "vsco-media.zip")
    _zip_files(downloaded, archive_path)
    suffix = "images" if option["kind"] == "image" else "videos"
    return tmp_dir, archive_path, _build_download_filename(title, suffix, "zip")


def _send_temp_file(tmp_dir: str, path: str, download_name: str):
    response = send_file(path, as_attachment=True, download_name=download_name, conditional=True, etag=False)
    response.call_on_close(lambda: _cleanup_dir(tmp_dir))
    return response


@api.route("/api/media-options", methods=["POST"])
def media_options():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    try:
        return jsonify(_build_media_options(url))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api.route("/api/fetch-audio", methods=["POST"])
def fetch_audio():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "audio.%(ext)s")

    ydl_opts = {
        **_base_ydl_opts(),
        "format": "bestaudio[abr<=96]/bestaudio/best",
        "outtmpl": output_template,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "64",
            }
        ],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "audio")

        audio_files = _find_files(tmp_dir)
        if not audio_files:
            raise ValueError("Audio download produced no file.")

        audio_path = audio_files[0]
        ext = os.path.splitext(audio_path)[1].lstrip(".").lower() or "mp3"
        mime_map = {
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "ogg": "audio/ogg",
            "opus": "audio/ogg",
            "webm": "audio/webm",
            "wav": "audio/wav",
        }
        response = send_file(
            audio_path,
            mimetype=mime_map.get(ext, "application/octet-stream"),
            as_attachment=False,
            download_name=_build_download_filename(title, "audio", ext),
            conditional=True,
            etag=False,
        )
        response.headers["X-Video-Title"] = title.encode("ascii", "replace").decode()
        response.headers["Access-Control-Expose-Headers"] = "X-Video-Title"
        response.call_on_close(lambda: _cleanup_dir(tmp_dir))
        return response
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/download-media", methods=["POST"])
def download_media():
    data = request.get_json() or {}
    url = data.get("url", "").strip()
    option = data.get("option") or {}
    title = data.get("title", "download")

    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option:
        return jsonify({"error": "No download option provided."}), 400

    try:
        platform = _guess_platform(url)
        if platform == "vsco":
            tmp_dir, file_path, filename = _download_vsco_media(url, option, title)
        else:
            tmp_dir, file_path, filename = _download_with_ytdlp(url, option, title)
        return _send_temp_file(tmp_dir, file_path, filename)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
